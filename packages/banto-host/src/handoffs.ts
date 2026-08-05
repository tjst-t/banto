/**
 * 章の引き継ぎ資料（提案「コンパクションをやめ、退避と章立てで文脈を管理する」§3.2）。
 *
 * 会話が長くなったら、**番頭が選んだ区切りで章を閉じる**。閉じるときに詳細な引き継ぎ
 * 資料を書き出し、次の章へは**見出しだけ**を渡す。詳細が要るときは `handoff.read` で引く
 * ——SKILL と同じ段階的開示。
 *
 * ## コンパクションとの違い
 *
 * | | コンパクション | 章立て |
 * |---|---|---|
 * | タイミング | 文脈95%、タスクの中断点 | 番頭が選んだ区切り |
 * | 元の会話 | 文脈から消える | トランスクリプトは真実として残る（D3） |
 * | キャッシュ | 途中で無効化 | 新しい章＝新しい小さなプレフィックス |
 *
 * 資料は**導出値**（D3）——真実は pi のセッションファイルにあるトランスクリプトのままで、
 * 資料はいつでも捨てて作り直せる。
 *
 * D6: 依存は node:fs / node:path のみ。
 * I2: 無い資料は黙って空を返さずエラーにする。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 引き継ぎの見出し。**次の章の文脈に載るのはこれだけ**。 */
export interface HandoffSummary {
  /** 一行。「◯◯の続きから」に使う。 */
  topic: string;
  /** 決まったこと。 */
  decided: string[];
  /** 次の一手。 */
  next: string[];
  /** 保留・未決。 */
  open?: string[];
}

/** 書き出された1章分。 */
export interface HandoffRecord {
  /** `thread-1/ch-0001` の形。会話をまたいで一意。 */
  id: string;
  threadId: string;
  /** 何番目の章か（1始まり）。 */
  chapter: number;
  createdAt: string;
  summary: HandoffSummary;
  /** 資料の絶対パス。 */
  filePath: string;
}

/**
 * 引き継ぎ資料の置き場。**会話データとして置く**（リポジトリは汚さない）。
 *
 * `<dataDir>/handoffs/<threadId>/ch-0001.md`
 */
export class HandoffStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private threadDir(threadId: string): string {
    return path.join(this.dir, threadId);
  }

  /** その会話の次の章番号。**ディレクトリから導く**（D3：採番の台帳を持たない）。 */
  nextChapter(threadId: string): number {
    const dir = this.threadDir(threadId);
    if (!fs.existsSync(dir)) return 1;
    let max = 0;
    for (const name of fs.readdirSync(dir)) {
      const m = /^ch-(\d+)\.md$/u.exec(name);
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
    }
    return max + 1;
  }

  /** 章を書き出す。 */
  write(params: {
    threadId: string;
    summary: HandoffSummary;
    /** 詳細な本文（LLM が書いた引き継ぎ資料）。 */
    body: string;
  }): HandoffRecord {
    const chapter = this.nextChapter(params.threadId);
    const dir = this.threadDir(params.threadId);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${params.threadId}/ch-${String(chapter).padStart(4, "0")}`;
    const filePath = path.join(dir, `ch-${String(chapter).padStart(4, "0")}.md`);
    const createdAt = new Date().toISOString();

    const front = [
      "---",
      `id: ${id}`,
      `chapter: ${chapter}`,
      `createdAt: ${createdAt}`,
      "---",
      "",
      `# 第${chapter}章の引き継ぎ — ${params.summary.topic}`,
      "",
      renderSummary(params.summary),
      "",
      "## 詳細",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, front + params.body + "\n", "utf-8");

    return { id, threadId: params.threadId, chapter, createdAt, summary: params.summary, filePath };
  }

  /** 章の資料を読む。I2: 無いものは黙って空にしない。 */
  read(id: string): string {
    const filePath = this.resolve(id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`引き継ぎ資料 "${id}" はありません`);
    }
    return fs.readFileSync(filePath, "utf-8");
  }

  /** その会話の章を古い順に返す。 */
  list(threadId: string): string[] {
    const dir = this.threadDir(threadId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => /^ch-\d+\.md$/u.test(n))
      .sort()
      .map((n) => `${threadId}/${n.replace(/\.md$/u, "")}`);
  }

  /** 章の資料を捨てる（導出値なので作り直せる・D3）。 */
  remove(id: string): void {
    fs.rmSync(this.resolve(id), { force: true });
  }

  /** ID からパスへ。I2: `..` で外へ出させない。 */
  private resolve(id: string): string {
    const m = /^([A-Za-z0-9_-]+)\/(ch-\d+)$/u.exec(id);
    if (!m) {
      throw new Error(`引き継ぎ資料のIDは "thread-1/ch-0001" の形です: ${id}`);
    }
    return path.join(this.threadDir(m[1]!), `${m[2]!}.md`);
  }
}

/** 見出しを箇条書きにする。**次の章の文脈に載るのはこれだけ**なので短く保つ。 */
export function renderSummary(summary: HandoffSummary): string {
  const lines = [`**トピック**: ${summary.topic}`];
  const section = (label: string, items: readonly string[] | undefined): void => {
    if (!items || items.length === 0) return;
    lines.push("", `**${label}**`, ...items.map((i) => `- ${i}`));
  };
  section("決まったこと", summary.decided);
  section("次の一手", summary.next);
  section("保留", summary.open);
  return lines.join("\n");
}

/**
 * 次の章の先頭に置く文言を組み立てる。
 *
 * **ここが「段階的開示」の要**——載せるのは見出しと参照だけで、詳細は載せない。
 * 詳細が要ると番頭が判断したときに `handoff.read` で引く。
 */
export function renderChapterOpening(
  record: HandoffRecord,
  options: { artifactCount?: number } = {}
): string {
  const lines = [
    `# ここまでの続き（第${record.chapter}章から第${record.chapter + 1}章へ）`,
    "",
    `**この会話はここまでで一区切りとし、文脈を畳んだ。** 以下は前の章の引き継ぎ。`,
    "",
    renderSummary(record.summary),
    "",
    `詳細な経緯: \`handoff.read({ id: "${record.id}" })\``,
  ];

  // 退避した観測があることだけ知らせる。**一覧は載せない**——数が増えると章の頭が
  // 膨らみ、畳んだ意味が薄れる。ID は資料側（`handoff.read`）と `artifact.list` にある
  if (options.artifactCount && options.artifactCount > 0) {
    lines.push(
      "",
      `この会話では **${options.artifactCount} 件の観測を退避してある**` +
        "（ファイルの中身・差分・職人の報告など）。" +
        "一覧は `artifact.list`、中身は `artifact.read({ id })` で読める。" +
        "上の資料にも ID の索引がある。"
    );
  }

  lines.push(
    "",
    "前の章のやり取りは文脈に載っていないが、**失われてはいない**——" +
      "会話の記録として残っており、上の資料から辿れる。" +
      "前提が要るときは資料を読み、憶測で埋めないこと。"
  );
  return lines.join("\n");
}
