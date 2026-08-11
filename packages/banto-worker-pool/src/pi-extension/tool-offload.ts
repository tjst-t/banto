/**
 * tool-offload: 職人のツール結果もファイルへ退避し、文脈には栞だけを残す pi Extension。
 *
 * **なぜ要るか**（2026-08-10 実機・task-0089 で3回連続で踏んだ）:
 * 職人のツール結果は加工されずそのままモデルへ渡る。番頭には「ファイル退避＋栞」機構
 * （banto-host の `withArtifactOffload`・閾値2000字）があるのに、職人経路には無かった。
 * pi の切り詰めは 2000行/50KB なので、50KB（数万トークン）がそのまま文脈へ入る。その直後の
 * 継続応答が opencode-go ゲートウェイで返らず、職人は `agent_exited_without_report` で落ちる。
 * モデルを変えても（deepseek-v4-flash → kimi-k3）同じ形で止まった＝モデル固有ではない。
 *
 * **やること**は番頭と同じ発想を職人プロセス内で行うだけ:
 * 閾値を超えたツール結果を `tool_result` イベントで差し替え、本文はファイルへ、モデルへは
 * 栞（出所・大きさ・見出し・**読み返し方**）だけを渡す。情報は失われない——職人は `read` で
 * 必要な箇所だけ読み返せる。
 *
 * 環境変数:
 *   BANTO_WORKER_OFFLOAD_THRESHOLD - 退避に回す大きさ（文字数）。既定 2000（番頭と同じ）
 *   BANTO_WORKER_OFFLOAD_DIR       - 退避先。既定 os.tmpdir()/banto-worker-offload/<taskId>-<pid>
 *   BANTO_WORKER_OFFLOAD           - "0" / "off" で退避を止める（切り分け用）
 *
 * D5: ここに判断は無い。大きいか小さいかで置き換えるだけで、中身は解釈しない。
 * D6: node 標準（fs/os/path）だけ。**要約しない**ので LLM も呼ばない。
 * I2: 退避に失敗したら黙って本文を通さない——栞に失敗を書いて、職人に見える形で残す。
 * I4: pi の型は import しない（worker-report.ts と同じ判断。実行時に渡される）。
 *
 * 番頭の `artifacts.ts` を再利用しないのは層の都合: Worker Pool は banto-host に依存しない
 * （職人は番頭ホスト無しでも動く）。共有するには banto-core へ上げる必要があり、それは
 * このタスクの範囲外。ここでは見出し抽出（数行）の重複を選ぶ。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── 設定 ────────────────────────────────────────────────────────────────────

/** 退避に回す大きさの既定（文字数）。番頭の `DEFAULT_ARTIFACT_THRESHOLD_CHARS` と同じ。 */
export const DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS = 2000;

/** 閾値を変える環境変数。 */
export const OFFLOAD_THRESHOLD_ENV = "BANTO_WORKER_OFFLOAD_THRESHOLD";
/** 退避先を変える環境変数。 */
export const OFFLOAD_DIR_ENV = "BANTO_WORKER_OFFLOAD_DIR";
/** 退避そのものを止める環境変数（切り分け用）。 */
export const OFFLOAD_ENABLED_ENV = "BANTO_WORKER_OFFLOAD";

/**
 * 退避したものを読み返すときの上限（文字数）。
 *
 * **読み返しにも上限が要る。** 上限が無いと退避したものを1回の `read` で全部戻せてしまい、
 * 退避した意味が消える（番頭の `artifact.read` と同じ理由）。
 */
export const READBACK_MAX_CHARS = 6000;

/**
 * 退避しない Tool の wire名の接頭辞。
 *
 * `worker__report` / `worker__ask` は報告経路そのもの。返るのは "ok" 程度で退避する意味が無く、
 * 万一ここを栞にすると報告の成否が読み取れなくなる。
 */
export const EXEMPT_TOOL_PREFIXES: readonly string[] = ["worker__"];

type EnvLike = Readonly<Record<string, string | undefined>>;

/** 閾値を決める。読めない値は既定に落とす（I2: 0や負で全部を栞にしない）。 */
export function resolveThresholdChars(env: EnvLike): number {
  const raw = env[OFFLOAD_THRESHOLD_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS;
  return parsed;
}

/** 退避が有効か。既定は有効で、明示的に切ったときだけ止める。 */
export function isOffloadEnabled(env: EnvLike): boolean {
  const raw = (env[OFFLOAD_ENABLED_ENV] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

/**
 * 退避先を決める。
 *
 * 既定は職人ごとに閉じた一時ディレクトリ（taskId + pid）。**職人が `read` で読み返せる場所**
 * であることが条件で、`/tmp` は cwd の外だが pi の read は絶対パスをそのまま開ける。
 */
export function resolveOffloadDir(env: EnvLike, pid: number): string {
  const explicit = env[OFFLOAD_DIR_ENV];
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const taskId = (env["BANTO_TASK_ID"] ?? "worker").replace(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(os.tmpdir(), "banto-worker-offload", `${taskId}-${pid}`);
}

/** 退避しない Tool か。 */
export function isExemptTool(toolName: string): boolean {
  return EXEMPT_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

// ── 栞の組み立て ────────────────────────────────────────────────────────────

/**
 * 栞に載せる見出し。
 *
 * Markdown の見出しがあればそれを、無ければ先頭の数行を使う。**中身を要約しない**——
 * 要約すると誤りが文脈に入るうえ、退避のたびにコストが載る。機械的に抜けるものだけ載せる。
 */
export function outlineOf(text: string, maxLines = 12): string {
  const headings = text
    .split("\n")
    .filter((line) => /^#{1,4}\s+\S/u.test(line))
    .slice(0, maxLines);
  if (headings.length > 0) return headings.map((h) => h.trim()).join("\n");
  const head = text.split("\n").slice(0, 3).join("\n");
  return head.length > 300 ? `${head.slice(0, 300)}…` : head;
}

/** 引数を1行に潰す。長いものは切る（栞が長くては意味がない）。 */
export function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    // 循環参照など。栞は出せるので落とさない
    return "";
  }
  if (text === undefined || text === "{}") return "";
  return text.length > 120 ? `(${text.slice(0, 120)}…)` : `(${text})`;
}

export interface OffloadStubParams {
  toolName: string;
  input: unknown;
  filePath: string;
  chars: number;
  lines: number;
  outline: string;
}

/**
 * 栞の本文。
 *
 * **読み返しの手立てを必ず書く**（a2）。ここが無いと職人は「消えた」と受け取り、
 * 同じ結果を取り直そうとして同じ大きさをもう一度文脈へ積む。
 */
export function renderOffloadStub(params: OffloadStubParams): string {
  const args = summarizeInput(params.input);
  return [
    `${params.toolName}${args} → ${params.chars.toLocaleString("en-US")}字 / ${params.lines.toLocaleString("en-US")}行 を退避しました`,
    "",
    params.outline,
    "",
    `全文はここに残っている: ${params.filePath}`,
    `読み返し: read({ path: "${params.filePath}", offset, limit }) ／ 語で絞るなら grep`,
    "**この出力は文脈に載せていない。必要な箇所だけ読み返すこと。**",
  ].join("\n");
}

// ── 差し替え ────────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text";
  text: string;
}

type ContentBlock = TextBlock | { type: string; [key: string]: unknown };

/** `tool_result` イベントのうち、この拡張が見る分だけ。 */
export interface ToolResultLike {
  toolName: string;
  input?: Record<string, unknown> | undefined;
  content: readonly ContentBlock[];
}

/** 差し替えの指示。`undefined` は「触らない」。 */
export interface OffloadPatch {
  content: ContentBlock[];
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text" && typeof (block as TextBlock).text === "string";
}

/**
 * ツール結果を退避して栞に置き換える器。
 *
 * 状態は「どこへ書くか」と「何番まで書いたか」だけ。番号は**ディスクから導く**ので、
 * 同じディレクトリを指した職人が再開しても既存を上書きしない（D3）。
 */
export class ToolResultOffloader {
  private readonly dir: string;
  private readonly thresholdChars: number;

  constructor(options: { dir: string; thresholdChars?: number }) {
    this.dir = path.resolve(options.dir);
    this.thresholdChars = options.thresholdChars ?? DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS;
  }

  /** 退避先（テスト・診断用）。 */
  get directory(): string {
    return this.dir;
  }

  /**
   * 退避した結果を読み返している最中か。
   *
   * 読み返した中身をまた退避すると、職人は永久に本文へ辿り着けない。代わりに上限で切る。
   */
  isReadback(event: ToolResultLike): boolean {
    if (event.toolName !== "read") return false;
    const target = event.input?.["path"];
    if (typeof target !== "string" || target === "") return false;
    const resolved = path.resolve(target);
    return resolved === this.dir || resolved.startsWith(`${this.dir}${path.sep}`);
  }

  /** 1件のツール結果を見て、差し替えるなら patch を返す。 */
  apply(event: ToolResultLike): OffloadPatch | undefined {
    const blocks = event.content ?? [];
    const textBlocks = blocks.filter(isTextBlock);
    if (textBlocks.length === 0) return undefined;
    const joined = textBlocks.map((b) => b.text).join("\n");
    const others = blocks.filter((b) => !isTextBlock(b));

    if (this.isReadback(event)) {
      if (joined.length <= READBACK_MAX_CHARS) return undefined;
      return {
        content: [
          {
            type: "text",
            text: `${joined.slice(0, READBACK_MAX_CHARS)}\n…（以降は省略。offset / limit で続きを読むこと）`,
          },
          ...others,
        ],
      };
    }

    if (isExemptTool(event.toolName)) return undefined;
    if (joined.length <= this.thresholdChars) return undefined;

    let filePath: string;
    try {
      filePath = this.write(event.toolName, joined);
    } catch (err) {
      // I2: 退避に失敗したまま本文を通すと、防ぎたかった「長い文脈」がそのまま入る。
      // 職人には落ちた理由が見える形で渡し、必要なら取り直させる
      return {
        content: [
          {
            type: "text",
            text:
              `${event.toolName} の出力（${joined.length.toLocaleString("en-US")}字）は大きすぎるため文脈に載せませんでしたが、` +
              `退避にも失敗しました: ${String(err)}\n` +
              `${outlineOf(joined)}\n` +
              "必要なら範囲を絞って取り直してください。",
          },
          ...others,
        ],
      };
    }

    const stub = renderOffloadStub({
      toolName: event.toolName,
      input: event.input,
      filePath,
      chars: joined.length,
      lines: joined.split("\n").length,
      outline: outlineOf(joined),
    });
    return { content: [{ type: "text", text: stub }, ...others] };
  }

  /** 本文をファイルへ書く。**1文字も変えずに**残す（読み返しが原本であること）。 */
  private write(toolName: string, text: string): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const seq = this.nextSequence();
    const safeTool = toolName.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 40);
    const filePath = path.join(this.dir, `t-${String(seq).padStart(4, "0")}-${safeTool}.txt`);
    fs.writeFileSync(filePath, text, "utf-8");
    return filePath;
  }

  /** 次の番号をディスクから導く（保存された値を別に持たない・D3）。 */
  private nextSequence(): number {
    let max = 0;
    for (const name of fs.readdirSync(this.dir)) {
      const matched = /^t-(\d+)-/u.exec(name);
      if (!matched) continue;
      const n = Number.parseInt(matched[1] as string, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }
}

/**
 * 職人に渡す作法。
 *
 * 栞は毎回「読み返し方」を書いているが、**最初に何が起きるかを知らせておく**方が、
 * 職人が「取得に失敗した」と誤解して取り直すのを防げる。
 */
export const WORKER_OFFLOAD_PROMPT = [
  "## Long tool results are offloaded",
  "",
  "Tool results larger than the offload threshold are written to a file and replaced with a note",
  "(source, size, outline, and the file path). The full text is not lost — read the file back with",
  "`read({ path, offset, limit })` or search it with `grep` when you need the details.",
  "",
  "- Do not re-run the same tool hoping for the full text: you will get another note.",
  "- Narrow the request instead (offset/limit, a tighter pattern) when you only need a small part.",
].join("\n");

/**
 * 拡張を pi に繋ぐ（default export の実体）。
 *
 * 名前付きでも出すのは、繋ぎ目そのものを検証できるようにするため——器が正しくても
 * `tool_result` に繋がっていなければ職人の文脈は何も変わらない。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pi API は実行時に渡される。
// 型を得るために @earendil-works/pi-coding-agent を import すると、この拡張が職人側の
// ランタイムに縛られる（worker-report.ts と同じ判断）。(I4)
export function installToolOffload(pi: any): void {
  if (!isOffloadEnabled(process.env)) return;

  const offloader = new ToolResultOffloader({
    dir: resolveOffloadDir(process.env, process.pid),
    thresholdChars: resolveThresholdChars(process.env),
  });

  pi.on(
    "before_agent_start",
    (event: { systemPrompt: string }, _ctx: unknown): { systemPrompt: string } => ({
      systemPrompt: `${event.systemPrompt}\n\n${WORKER_OFFLOAD_PROMPT}`,
    })
  );

  pi.on("tool_result", (event: ToolResultLike): OffloadPatch | undefined => {
    try {
      return offloader.apply(event);
    } catch (err) {
      // 退避の失敗でターンを壊すと、本来の作業結果まで失う。標準エラーに残して素通しする
      process.stderr.write(`[tool-offload] failed: ${String(err)}\n`);
      return undefined;
    }
  });
}

export default installToolOffload;
