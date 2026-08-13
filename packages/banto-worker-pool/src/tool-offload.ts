/**
 * tool-offload の中核——職人のツール結果をファイルへ退避し、文脈には栞だけを残す。
 *
 * **なぜ要るか**（2026-08-10 実機・task-0089 で3回連続で踏んだ）:
 * 職人のツール結果は加工されずそのままモデルへ渡る。番頭には「ファイル退避＋栞」機構
 * （banto-host の `withArtifactOffload`・閾値2000字）があるのに、職人経路には無かった。
 * pi の切り詰めは 2000行/50KB なので、50KB（数万トークン）がそのまま文脈へ入る。その直後の
 * 継続応答が opencode-go ゲートウェイで返らず、職人は `agent_exited_without_report` で落ちる。
 * モデルを変えても（deepseek-v4-flash → kimi-k3）同じ形で止まった＝モデル固有ではない。
 *
 * **やること**は番頭と同じ発想を職人プロセス内で行うだけ:
 * 閾値を超えたツール結果を差し替え、本文はファイルへ、モデルへは栞（出所・大きさ・見出し・
 * **読み返し方**）だけを渡す。情報は失われない——職人は読み返しの道具で必要な箇所だけ戻せる。
 *
 * **ここはランタイム中立**（task-0102）。task-0090 の実装は pi 拡張の中に置いてあったので、
 * `extensionPaths` を読まない Claude Agent SDK の職人には**1行も効いていなかった**
 * ——実運用の職人はほぼ全部そちらである。判断（何を・いつ・どこへ退避するか）はこのファイルに
 * 1つだけ置き、経路ごとの繋ぎ込みは薄い層（`pi-extension/tool-offload.ts` /
 * `claude-agent/tool-offload.ts`）に閉じる。**同じ判断を2箇所に書かない**（D3）。
 *
 * 経路で違うのは「道具の名前」だけなので、それは `OffloadDialect` に押し込む
 * （pi は `read({ path })`、Claude Code は `Read({ file_path })`）。閾値・退避先・栞の書式は
 * **共通**——職人から見た挙動が経路で変わらないこと自体が、この機構の要件である。
 *
 * 環境変数:
 *   BANTO_WORKER_OFFLOAD_THRESHOLD - 退避に回す大きさ（文字数）。既定 2000（番頭と同じ）
 *   BANTO_WORKER_OFFLOAD_DIR       - 退避先。既定 os.tmpdir()/banto-worker-offload/<taskId>-<pid>
 *   BANTO_WORKER_OFFLOAD           - "0" / "off" で退避を止める（切り分け用）
 *
 * D5: ここに判断は無い。大きいか小さいかで置き換えるだけで、中身は解釈しない。
 * D6: node 標準（fs/os/path）だけ。**要約しない**ので LLM も呼ばない。
 * I2: 退避に失敗したら黙って本文を通さない——栞に失敗を書いて、職人に見える形で残す。
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
 * **読み返しにも上限が要る。** 上限が無いと退避したものを1回の読み返しで全部戻せてしまい、
 * 退避した意味が消える（番頭の `artifact.read` と同じ理由）。
 */
export const READBACK_MAX_CHARS = 6000;

/**
 * これより短い文字列は退避しない（構造を保つ経路での下限）。
 *
 * 栞そのものが数百字ある。それと同じくらいの文字列を退避しても文脈は縮まず、
 * 職人には読み返しの手間だけが増える——**縮まないなら触らない**。
 */
export const MIN_OFFLOAD_LEAF_CHARS = 500;

// ── 経路ごとの言葉（道具の名前だけが違う）──────────────────────────────────

/**
 * 職人のランタイムごとに変わる道具の名前。
 *
 * **ここに入れてよいのは名前だけ。** 閾値も退避先も栞の書式も共通で、経路によって
 * 職人の体験が変わってはならない（変わると「pi では読み返せたのに」が起きる）。
 */
export interface OffloadDialect {
  /** 読み返しに使う道具（栞に書き、読み返しかどうかの判定にも使う）。 */
  readTool: string;
  /** その道具でファイルを指す引数の名前。 */
  pathArg: string;
  /** 語で絞る道具。 */
  grepTool: string;
  /**
   * 退避しない Tool の接頭辞。
   *
   * 報告経路（pi の `worker__*` / Claude の `mcp__banto__*`）そのもの。返るのは "ok" 程度で
   * 退避する意味が無く、万一ここを栞にすると報告の成否が読み取れなくなる。
   */
  exemptPrefixes: readonly string[];
}

/** pi 職人の言葉（組み込みの `read` / `grep`）。 */
export const PI_OFFLOAD_DIALECT: OffloadDialect = {
  readTool: "read",
  pathArg: "path",
  grepTool: "grep",
  exemptPrefixes: ["worker__"],
};

/** Claude Agent SDK の職人の言葉（`Read` / `Grep`・報告は MCP 経由）。 */
export const CLAUDE_OFFLOAD_DIALECT: OffloadDialect = {
  readTool: "Read",
  pathArg: "file_path",
  grepTool: "Grep",
  exemptPrefixes: ["mcp__banto__"],
};

/**
 * 退避しない Tool の wire名の接頭辞（pi 経路の既定。互換のために残す）。
 */
export const EXEMPT_TOOL_PREFIXES: readonly string[] = PI_OFFLOAD_DIALECT.exemptPrefixes;

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
 * 既定は職人ごとに閉じた一時ディレクトリ（taskId + pid）。**職人が読み返せる場所**
 * であることが条件で、`/tmp` は cwd の外だが read は絶対パスをそのまま開ける
 * （pi も Claude Code も同じ）。
 */
export function resolveOffloadDir(env: EnvLike, pid: number): string {
  const explicit = env[OFFLOAD_DIR_ENV];
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
  const taskId = (env["BANTO_TASK_ID"] ?? "worker").replace(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(os.tmpdir(), "banto-worker-offload", `${taskId}-${pid}`);
}

/** 退避しない Tool か。 */
export function isExemptTool(toolName: string, dialect: OffloadDialect = PI_OFFLOAD_DIALECT): boolean {
  return dialect.exemptPrefixes.some((prefix) => toolName.startsWith(prefix));
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
  /** 読み返しの道具の名前（省略すると pi の言葉）。 */
  dialect?: OffloadDialect;
}

/**
 * 栞の本文。
 *
 * **読み返しの手立てを必ず書く**（a2）。ここが無いと職人は「消えた」と受け取り、
 * 同じ結果を取り直そうとして同じ大きさをもう一度文脈へ積む。
 */
export function renderOffloadStub(params: OffloadStubParams): string {
  const args = summarizeInput(params.input);
  const dialect = params.dialect ?? PI_OFFLOAD_DIALECT;
  return [
    `${params.toolName}${args} → ${params.chars.toLocaleString("en-US")}字 / ${params.lines.toLocaleString("en-US")}行 を退避しました`,
    "",
    params.outline,
    "",
    `全文はここに残っている: ${params.filePath}`,
    `読み返し: ${dialect.readTool}({ ${dialect.pathArg}: "${params.filePath}", offset, limit }) ／ 語で絞るなら ${dialect.grepTool}`,
    "**この出力は文脈に載せていない。必要な箇所だけ読み返すこと。**",
  ].join("\n");
}

/** 読み返しが上限を超えたときに末尾へ添える断り。 */
const READBACK_CUT_NOTE = "\n…（以降は省略。offset / limit で続きを読むこと）";

// ── 差し替え ────────────────────────────────────────────────────────────────

interface TextBlock {
  type: "text";
  text: string;
}

type ContentBlock = TextBlock | { type: string; [key: string]: unknown };

/** `tool_result` イベントのうち、この機構が見る分だけ（pi 経路）。 */
export interface ToolResultLike {
  toolName: string;
  input?: Record<string, unknown> | undefined;
  content: readonly ContentBlock[];
}

/** 差し替えの指示。`undefined` は「触らない」。 */
export interface OffloadPatch {
  content: ContentBlock[];
}

/** ツール結果そのもの（構造は Tool ごとに違う。Claude Agent SDK 経路）。 */
export interface ToolOutputLike {
  toolName: string;
  input?: unknown;
  output: unknown;
}

/** 構造を保ったままの差し替え。`undefined` は「触らない」。 */
export interface OffloadOutputPatch {
  output: unknown;
}

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === "text" && typeof (block as TextBlock).text === "string";
}

/**
 * 文字列の葉を、辿った順に集める。
 *
 * 構造を保ったまま差し替えるために要る（Claude Agent SDK 経路）。ツール結果の形は
 * Tool ごとに違う（`Read` は `{type,file:{content,…}}`、`Bash` は `{stdout,stderr,…}`、
 * MCP は `[{type:"text",text}]`）ので、**形を知らないまま長い文字列だけ差し替える**。
 */
function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(item, out);
    }
  }
  return out;
}

/**
 * 集めたときと同じ順で文字列の葉を差し替え、**構造はそのまま**組み直す。
 *
 * 形を変えてはいけない。Claude Code は差し替えたツール結果を元の Tool の出力スキーマで
 * 検証し、合わなければ**黙って元の全文に戻す**（実機で確認：平文の文字列を返すと
 * モデルには元の 7,623 字がそのまま渡っていた）。退避したつもりで効いていない、が一番たちが悪い。
 */
function replaceStringLeaves(
  value: unknown,
  replacements: ReadonlyMap<number, string>,
  cursor: { index: number }
): unknown {
  if (typeof value === "string") {
    const replaced = replacements.get(cursor.index);
    cursor.index += 1;
    return replaced ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringLeaves(item, replacements, cursor));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replaceStringLeaves(item, replacements, cursor);
    }
    return out;
  }
  return value;
}

/**
 * ツール結果を退避して栞に置き換える器。
 *
 * 状態は「どこへ書くか」と「何番まで書いたか」だけ。番号は**ディスクから導く**ので、
 * 同じディレクトリを指した職人が再開しても既存を上書きしない（D3）。
 *
 * 入口は2つあるが判断は1つ:
 *   - `apply`         … pi の `tool_result`（内容ブロックの並び）
 *   - `applyToOutput` … Claude Agent SDK の `PostToolUse`（Tool ごとに形が違う生の出力）
 */
export class ToolResultOffloader {
  private readonly dir: string;
  private readonly thresholdChars: number;
  private readonly dialect: OffloadDialect;

  constructor(options: { dir: string; thresholdChars?: number; dialect?: OffloadDialect }) {
    this.dir = path.resolve(options.dir);
    this.thresholdChars = options.thresholdChars ?? DEFAULT_WORKER_OFFLOAD_THRESHOLD_CHARS;
    this.dialect = options.dialect ?? PI_OFFLOAD_DIALECT;
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
  isReadback(event: { toolName: string; input?: unknown }): boolean {
    if (event.toolName !== this.dialect.readTool) return false;
    const input = event.input;
    if (input === null || typeof input !== "object") return false;
    const target = (input as Record<string, unknown>)[this.dialect.pathArg];
    if (typeof target !== "string" || target === "") return false;
    const resolved = path.resolve(target);
    return resolved === this.dir || resolved.startsWith(`${this.dir}${path.sep}`);
  }

  /** 1件のツール結果（内容ブロックの並び）を見て、差し替えるなら patch を返す。 */
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
          { type: "text", text: `${joined.slice(0, READBACK_MAX_CHARS)}${READBACK_CUT_NOTE}` },
          ...others,
        ],
      };
    }

    if (isExemptTool(event.toolName, this.dialect)) return undefined;
    if (joined.length <= this.thresholdChars) return undefined;

    let filePath: string;
    try {
      filePath = this.write(event.toolName, joined);
    } catch (err) {
      // I2: 退避に失敗したまま本文を通すと、防ぎたかった「長い文脈」がそのまま入る。
      // 職人には落ちた理由が見える形で渡し、必要なら取り直させる
      return {
        content: [{ type: "text", text: this.renderWriteFailure(event.toolName, joined, err) }, ...others],
      };
    }

    return { content: [{ type: "text", text: this.stubFor(event, joined, filePath) }, ...others] };
  }

  /**
   * 1件のツール結果を**形を保ったまま**見て、差し替えるなら patch を返す。
   *
   * 判断は `apply` と同じ（同じ閾値・同じ退避先・同じ栞）。違うのは置き換える先だけで、
   * ここでは長い文字列の葉を栞に差し替え、器（オブジェクトの形）はそのまま返す。
   *
   * 合計が閾値を超えていたら**大きい葉から順に**、合計が閾値以下になるまで退避する。
   * 短い葉（`MIN_OFFLOAD_LEAF_CHARS` 未満）は触らない——退避しても縮まないため。
   */
  applyToOutput(event: ToolOutputLike): OffloadOutputPatch | undefined {
    const leaves = collectStringLeaves(event.output);
    if (leaves.length === 0) return undefined;

    const replacements = new Map<number, string>();

    if (this.isReadback(event)) {
      // 読み返しは再退避しない。長すぎるときだけ上限で切る
      leaves.forEach((leaf, index) => {
        if (leaf.length > READBACK_MAX_CHARS) {
          replacements.set(index, `${leaf.slice(0, READBACK_MAX_CHARS)}${READBACK_CUT_NOTE}`);
        }
      });
      if (replacements.size === 0) return undefined;
      return { output: replaceStringLeaves(event.output, replacements, { index: 0 }) };
    }

    if (isExemptTool(event.toolName, this.dialect)) return undefined;

    let remaining = leaves.reduce((sum, leaf) => sum + leaf.length, 0);
    if (remaining <= this.thresholdChars) return undefined;

    const order = leaves
      .map((leaf, index) => ({ leaf, index }))
      .sort((a, b) => b.leaf.length - a.leaf.length);

    for (const { leaf, index } of order) {
      if (remaining <= this.thresholdChars) break;
      if (leaf.length < MIN_OFFLOAD_LEAF_CHARS) break; // 以降はもっと短い。これ以上は縮まない
      let stub: string;
      try {
        stub = this.stubFor(event, leaf, this.write(event.toolName, leaf));
      } catch (err) {
        stub = this.renderWriteFailure(event.toolName, leaf, err);
      }
      replacements.set(index, stub);
      remaining += stub.length - leaf.length;
    }

    if (replacements.size === 0) return undefined;
    return { output: replaceStringLeaves(event.output, replacements, { index: 0 }) };
  }

  /** 栞1枚。 */
  private stubFor(event: { toolName: string; input?: unknown }, text: string, filePath: string): string {
    return renderOffloadStub({
      toolName: event.toolName,
      input: event.input,
      filePath,
      chars: text.length,
      lines: text.split("\n").length,
      outline: outlineOf(text),
      dialect: this.dialect,
    });
  }

  /** 退避に失敗したときに渡すもの（I2: 黙って本文を通さない）。 */
  private renderWriteFailure(toolName: string, text: string, err: unknown): string {
    return (
      `${toolName} の出力（${text.length.toLocaleString("en-US")}字）は大きすぎるため文脈に載せませんでしたが、` +
      `退避にも失敗しました: ${String(err)}\n` +
      `${outlineOf(text)}\n` +
      "必要なら範囲を絞って取り直してください。"
    );
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
export function renderWorkerOffloadPrompt(dialect: OffloadDialect = PI_OFFLOAD_DIALECT): string {
  return [
    "## Long tool results are offloaded",
    "",
    "Tool results larger than the offload threshold are written to a file and replaced with a note",
    "(source, size, outline, and the file path). The full text is not lost — read the file back with",
    `\`${dialect.readTool}({ ${dialect.pathArg}, offset, limit })\` or search it with \`${dialect.grepTool}\` when you need the details.`,
    "",
    "- Do not re-run the same tool hoping for the full text: you will get another note.",
    "- Narrow the request instead (offset/limit, a tighter pattern) when you only need a small part.",
  ].join("\n");
}

/** pi 職人に渡す作法（互換のために名前で持つ）。 */
export const WORKER_OFFLOAD_PROMPT = renderWorkerOffloadPrompt(PI_OFFLOAD_DIALECT);
