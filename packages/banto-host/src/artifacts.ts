/**
 * ツール出力の退避（提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.1）。
 *
 * ## なぜ要るか
 *
 * 番頭の文脈を膨らませているのは会話ではなく**ツール出力**である。`file.read` が
 * ADR を1本返せば4万字が文脈に入り、`git.diff` も職人の報告も同じ。ここに手を入れずに
 * 会話の畳み方だけ変えても、増え続ける観測の後追いになる。
 *
 * ## どうするか
 *
 * 一定の大きさを超えたツール結果は**ファイルへ書き、文脈には栞だけ返す**。
 * これは要約ではないので**情報を失わない**——全文はいつでも `artifact.read` で取り戻せる。
 * 真実はファイル、文脈にあるのは参照（D3）。
 *
 * ## 挿入時にやる。過去は書き換えない
 *
 * 既に文脈へ入ったメッセージを後から削ると、プロンプトのプレフィックスキャッシュが飛ぶ。
 * だから「入ってから消す」のではなく「**そもそも大きいものを入れない**」で達成する。
 * Anthropic の context editing API がサーバ側でキャッシュ順序を考慮してやっていることを、
 * pi / OpenAI 互換の経路では書き込み時の判断で置き換える。
 *
 * ## 何を退避するか
 *
 * `content`（LLM に渡る本文）だけ。`details`（GUI 向けの構造化データ）は触らない——
 * あちらは文脈に入らないので、退避しても文脈は減らず、画面の情報だけが減る。
 *
 * D6: 依存は node:fs / node:path のみ。
 * I2: 読めない・無い artifact は黙って空を返さずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AnyBantoTool, BantoToolResult, NamespacedToolDefinition } from "@banto/core";

/** 退避した1件。 */
export interface ArtifactRef {
  /** `a-0001` 形式。会話の中で番頭が指すのに使う。 */
  id: string;
  /** 書き出した先の絶対パス。 */
  filePath: string;
  /** 元の文字数。 */
  chars: number;
  /** 元の行数。 */
  lines: number;
}

/** 一覧に出す1件（本文は含まない）。 */
export interface ArtifactSummary {
  id: string;
  filePath: string;
  /** 元の文字数（ファイルのバイト数から。厳密でなくてよい——大きさの目安） */
  chars: number;
  /** 見出し数行。中身の当たりを付けるためだけのもの */
  outline: string;
}

/** `artifact.read` の結果。 */
export interface ArtifactSlice {
  id: string;
  text: string;
  /** 全体の行数。 */
  totalLines: number;
  /** 返した範囲（1始まり・両端含む）。`grep` のときは省略。 */
  from?: number;
  to?: number;
  /** 大きすぎて切り詰めたか。 */
  truncated: boolean;
}

/**
 * 退避先。**会話ごとに1つ**——別の会話の観測を引けてしまうと、スレッドごとに
 * 文脈を分けている意味（決定35a）が崩れる。
 */
export class ArtifactStore {
  private readonly dir: string;
  private counter: number | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * 次の番号。**ディレクトリから導く**（D3：採番の台帳を別に持たない）。
   * 一度数えたら覚えておく——1ターンに何度も走るので、毎回 readdir はしない。
   */
  private nextId(): string {
    if (this.counter === undefined) {
      let max = 0;
      if (fs.existsSync(this.dir)) {
        for (const name of fs.readdirSync(this.dir)) {
          const m = /^a-(\d+)\.md$/u.exec(name);
          if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
        }
      }
      this.counter = max;
    }
    this.counter += 1;
    return `a-${String(this.counter).padStart(4, "0")}`;
  }

  /** 本文を退避して栞を返す。 */
  write(text: string): ArtifactRef {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = this.nextId();
    const filePath = path.join(this.dir, `${id}.md`);
    fs.writeFileSync(filePath, text, "utf-8");
    return { id, filePath, chars: text.length, lines: countLines(text) };
  }

  /**
   * この会話で退避したものを古い順に返す。
   *
   * **見出しを取るのに全文は読まない**——退避したものは大きいから退避したのであって、
   * 一覧のたびに全部読んだら意味がない。先頭だけ読んで見出しを拾う。
   */
  list(): ArtifactSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: ArtifactSummary[] = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      const m = /^(a-\d+)\.md$/u.exec(name);
      if (!m) continue;
      const filePath = path.join(this.dir, name);
      const chars = fs.statSync(filePath).size;
      out.push({ id: m[1]!, filePath, chars, outline: outlineOf(readHead(filePath), 3) });
    }
    return out;
  }

  /** 退避した本文を読む。 */
  read(
    id: string,
    options: { grep?: string; offset?: number; limit?: number; maxChars?: number } = {}
  ): ArtifactSlice {
    const filePath = path.join(this.dir, `${sanitizeId(id)}.md`);
    // I2: 無いものを黙って空文字にしない。番頭が「中身が無かった」と読み違える
    if (!fs.existsSync(filePath)) {
      throw new Error(`artifact "${id}" はこの会話にありません`);
    }
    const body = fs.readFileSync(filePath, "utf-8");
    const all = body.split("\n");
    const maxChars = options.maxChars ?? DEFAULT_READ_MAX_CHARS;

    if (options.grep !== undefined && options.grep !== "") {
      const needle = options.grep.toLowerCase();
      const hits: string[] = [];
      for (const [i, line] of all.entries()) {
        if (line.toLowerCase().includes(needle)) hits.push(`${i + 1}: ${line}`);
      }
      const joined = hits.join("\n");
      const truncated = joined.length > maxChars;
      return {
        id,
        text: truncated ? `${joined.slice(0, maxChars)}\n…（以降は省略）` : joined,
        totalLines: all.length,
        truncated,
      };
    }

    const from = Math.max(1, options.offset ?? 1);
    const limit = options.limit ?? DEFAULT_READ_LINES;
    const slice = all.slice(from - 1, from - 1 + limit);
    const joined = slice.join("\n");
    const tooLong = joined.length > maxChars;
    return {
      id,
      text: tooLong ? `${joined.slice(0, maxChars)}\n…（以降は省略）` : joined,
      totalLines: all.length,
      from,
      to: from + slice.length - 1,
      truncated: tooLong || from - 1 + slice.length < all.length,
    };
  }
}

/** 1回の `artifact.read` が返す既定の行数。 */
const DEFAULT_READ_LINES = 200;
/**
 * 1回の `artifact.read` が返す最大の文字数。
 *
 * **読み戻しにも上限が要る。** 上限が無いと、退避したものを1回の read で全部戻せてしまい、
 * 退避した意味が消える。
 */
const DEFAULT_READ_MAX_CHARS = 6000;

/** 退避に回す大きさの既定（文字数）。`BANTO_ARTIFACT_THRESHOLD` で変えられる。 */
export const DEFAULT_ARTIFACT_THRESHOLD_CHARS = 2000;

/** ファイル名に使う前に検算する（I2：`../` で外へ出させない）。 */
function sanitizeId(id: string): string {
  if (!/^a-\d+$/u.test(id)) {
    throw new Error(`artifact のIDは "a-0001" の形です: ${id}`);
  }
  return id;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/** ファイルの先頭だけ読む（見出しを拾うのに全文は要らない）。 */
function readHead(filePath: string, bytes = 4096): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 退避したものの一覧を、引き継ぎ資料に載せる形にする（PO指摘 2026-08-05）。
 *
 * **要約器に書かせない。** 「参照すべきIDを書け」とプロンプトで頼むだけだと、
 * 書かれるかどうかがモデル任せになる——章を畳んだ番頭が、手元に引換券があるのに
 * 番号を忘れる。ここは持っている情報をそのまま並べる。
 */
export function renderArtifactIndex(artifacts: readonly ArtifactSummary[]): string {
  if (artifacts.length === 0) return "";
  const lines = artifacts.map((a) => {
    const head = a.outline.split("\n")[0]?.trim() ?? "";
    return `- \`${a.id}\`（${a.chars.toLocaleString("en-US")}字）${head ? ` — ${head}` : ""}`;
  });
  return [
    "## この章で退避した観測",
    "",
    "文脈には載せていないが、**中身は残っている**。`artifact.read({ id })` で読める。",
    "",
    ...lines,
  ].join("\n");
}

/**
 * 栞に載せる見出し。
 *
 * Markdown の見出しがあればそれを、無ければ先頭の数行を使う。**中身を要約しない**——
 * ここで LLM を呼ぶと、退避のたびにコストが載るうえ、要約の誤りが文脈に入る（§2.1）。
 * 機械的に抜けるものだけを載せる。
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

/** 栞の本文を組み立てる。 */
export function renderStub(params: {
  toolName: string;
  args: unknown;
  ref: ArtifactRef;
  outline: string;
}): string {
  const args = summarizeArgs(params.args);
  return [
    `${params.toolName}${args} → ${params.ref.chars.toLocaleString("en-US")}字 / artifact ${params.ref.id}`,
    "",
    params.outline,
    "",
    `全文・部分読み: artifact.read({ id: "${params.ref.id}", offset, limit }) / 語で絞るなら grep`,
    "**この出力は文脈に載せていない。必要な箇所だけ artifact.read で読むこと。**",
  ].join("\n");
}

/** 引数を1行に潰す。長いものは切る（栞が長くては意味がない）。 */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    // 循環参照など。栞は出せるので落とさない
    return "";
  }
  if (text === undefined || text === "{}") return "";
  return text.length > 120 ? `(${text.slice(0, 120)}…)` : `(${text})`;
}

export interface ArtifactOffloadOptions {
  /** 何文字を超えたら退避するか。既定 `DEFAULT_ARTIFACT_THRESHOLD_CHARS`。 */
  thresholdChars?: number;
  /** 退避しない Tool の論理名。記憶や栞そのものを退避すると意味が無い。 */
  exempt?: readonly string[];
}

/**
 * 退避しない Tool。
 *
 * - `artifact.*` 自分自身。退避した中身を読んだ結果をまた退避したら永久に読めない
 * - `memory.*` 記憶は予算で既に絞ってある（§3.3）。二重に絞ると番頭が自分の記憶を読めなくなる
 * - `skill.read` SKILL の本文は「必要になったときに読む」設計（段階的開示）そのもので、
 *   読んだ先でさらに退避されると開示が1段増えるだけ
 */
const DEFAULT_EXEMPT = ["artifact.read", "memory.", "skill."] as const;

/**
 * Tool の結果が大きければ退避する皮をかぶせる。
 *
 * 名前・説明・パラメータはそのまま——番頭から見た Tool の契約は変わらない。
 * 変わるのは「大きい結果が栞になる」ことだけ。
 */
export function withArtifactOffload(
  tools: readonly NamespacedToolDefinition[],
  store: ArtifactStore,
  options: ArtifactOffloadOptions = {}
): NamespacedToolDefinition[] {
  const threshold = options.thresholdChars ?? DEFAULT_ARTIFACT_THRESHOLD_CHARS;
  const exempt = options.exempt ?? DEFAULT_EXEMPT;

  return tools.map((tool) => {
    if (exempt.some((prefix) => tool.name.startsWith(prefix))) return tool;
    const neutral = tool as AnyBantoTool;
    return {
      ...tool,
      async execute(args: unknown, ctx?: unknown): Promise<BantoToolResult> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 皮は契約の型を
        // 消してから通す。ここで TParams を保つと、退避が Tool ごとの型に依存してしまう (I4)
        const result = (await neutral.execute(args as any, ctx as any)) as BantoToolResult;
        const text = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        if (text.length <= threshold) return result;

        const ref = store.write(text);
        const stub = renderStub({
          toolName: tool.name,
          args,
          ref,
          outline: outlineOf(text),
        });
        // details（GUI 向け）はそのまま通す。画面では今までどおり全部見える
        return {
          content: [{ type: "text" as const, text: stub }],
          ...(result.details !== undefined ? { details: result.details } : {}),
        };
      },
    } as NamespacedToolDefinition;
  });
}
