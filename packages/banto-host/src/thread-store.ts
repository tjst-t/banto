/**
 * 会話をホストの再起動を越えて残す（task-0036・決定2）。
 *
 * **2つの別々のものを残す必要がある。**
 *
 * 1. **POに見えていた会話**（誰が何を言ったか・知らせ・Tool の実行）。再接続で `history` として
 *    描き直しているもの。これは導出できない事実なので、ここが持つ。
 * 2. **番頭の文脈**（LLM が覚えている中身）。こちらは pi のセッションファイルが持つ——
 *    `SessionManager.create()` で書き出し、`SessionManager.open()` で読み戻す。
 *
 * **どちらか片方だけでは足りない。** 1 だけだと画面には会話が戻るのに番頭は何も覚えて
 * おらず、2 だけだと番頭は覚えているのに画面が空になる。だから両方を紐づけて残す
 * ——スレッドの索引が pi のセッションファイルの場所を持つ。
 *
 * D3: 索引と記録は導出できない事実なので持つ。開いている／畳んだの別も同じ。
 * I2: 壊れた記録で黙って空から始めない——気づかないまま過去の会話を失うのが一番困る。
 * D6: node:fs / node:path のみ。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptEntry } from "./protocol.js";

/** スレッド1本ぶんの索引。中身（発言）は別ファイル。 */
export interface StoredThread {
  id: string;
  title: string;
  /**
   * 幹か枝か（ADR-0017 決定77）。**古い索引には無い**——読み戻す側が先頭を幹として扱う。
   */
  kind?: "trunk" | "branch";
  /** 帳場（メインの幹）か。店にただ1つで、終えない（PO裁定 2026-08-10）。 */
  isMain?: boolean;
  /** 枝の親（常に幹）。 */
  parentId?: string;
  /** 還す条件。枝には必ずある（決定77）。 */
  returnCondition?: string;
  /** 誰が開いたか。 */
  openedBy?: "banto" | "po";
  /** 開いた理由。 */
  openReason?: string;
  /** 畳んだときの結論。 */
  conclusion?: string;
  state: "open" | "closed";
  createdAt: string;
  closedAt?: string;
  /** pi のセッションファイル。**番頭の文脈はこちらが持つ**（会話の記録とは別物）。 */
  sessionFile?: string;
  /** この会話で使っていたモデル。再起動しても同じモデルで再開する。 */
  model?: { provider: string; id: string };
  /** キャンバスに開いていたもの。畳んで開き直したときに元の面へ戻す。 */
  canvasTabs?: Array<{ kind: string; params: Record<string, unknown>; title?: string }>;
}

interface IndexFile {
  version: 1;
  /** 次に振る番号。再起動しても id が衝突しないように持つ。 */
  counter: number;
  threads: StoredThread[];
}

const EMPTY: IndexFile = { version: 1, counter: 0, threads: [] };

export class ThreadStore {
  private readonly dir: string;
  private index: IndexFile;

  constructor(dir: string) {
    this.dir = dir;
    this.index = this.readIndex();
  }

  /** 索引ファイル。 */
  private get indexPath(): string {
    return path.join(this.dir, "index.json");
  }

  /** 会話の記録（1行1発言の JSONL）。 */
  private transcriptPath(threadId: string): string {
    return path.join(this.dir, `${threadId}.jsonl`);
  }

  /** 保存されているスレッド（開いている・畳んだの両方）。 */
  threads(): StoredThread[] {
    return this.index.threads.map((t) => ({ ...t }));
  }

  /** 次に振る番号。再起動を越えて続きから振る。 */
  counter(): number {
    return this.index.counter;
  }

  setCounter(value: number): void {
    if (value <= this.index.counter) return;
    this.index.counter = value;
    this.writeIndex();
  }

  /** スレッドの索引を足す・更新する。 */
  upsert(thread: StoredThread): void {
    const at = this.index.threads.findIndex((t) => t.id === thread.id);
    if (at === -1) this.index.threads.push(thread);
    else this.index.threads[at] = { ...this.index.threads[at], ...thread };
    const number = Number.parseInt(thread.id.replace(/^thread-/, ""), 10);
    if (Number.isFinite(number) && number > this.index.counter) this.index.counter = number;
    this.writeIndex();
  }

  /**
   * スレッドを保存先から消す（PO要望 2026-08-05：何も無いまま閉じた会話は残さない）。
   *
   * **索引・記録・番頭の文脈をまとめて消す。** 索引だけ消すと、記録の JSONL と pi の
   * セッションファイルが誰にも参照されないまま溜まり続ける。
   *
   * I2 の例外ではない: ファイルが既に無いのは失敗ではない（冪等）。消せなかったときは
   * 黙らず知らせるが、索引からは外す——参照が残っているほうが困る。
   */
  remove(threadId: string): void {
    const stored = this.index.threads.find((t) => t.id === threadId);
    this.index.threads = this.index.threads.filter((t) => t.id !== threadId);
    this.writeIndex();
    for (const file of [this.transcriptPath(threadId), stored?.sessionFile]) {
      if (!file) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        console.error(`[banto] ${file} を消せませんでした: ${String(err)}`);
      }
    }
  }

  /**
   * 発言を1行足す。
   *
   * **追記だけ**にしてあるのが要点——1発話ごとに全文を書き直すと、長い会話ほど重くなり、
   * 途中で落ちたときに壊れる範囲も広がる。
   */
  append(threadId: string, entry: TranscriptEntry): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.transcriptPath(threadId), `${JSON.stringify(entry)}\n`, "utf-8");
  }

  /**
   * 記録を丸ごと書き直す。
   *
   * `Thread.record` は直前の発言に連結したり実行中の行を更新したりする（画面と同じ形に
   * 揃えるため）。**追記だけでは表現できない更新**があるので、その場合はここで揃える。
   */
  replace(threadId: string, entries: readonly TranscriptEntry[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(this.transcriptPath(threadId), body.length > 0 ? `${body}\n` : "", "utf-8");
  }

  /** 記録を読む。 */
  transcript(threadId: string): TranscriptEntry[] {
    const file = this.transcriptPath(threadId);
    if (!fs.existsSync(file)) return [];
    const entries: TranscriptEntry[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as TranscriptEntry);
      } catch {
        // I2 の例外ではない: 1行壊れても残りは読める。1行のために会話全部を失わない
        console.error(`[banto] ${threadId} の記録に読めない行があります（その行は飛ばします）`);
      }
    }
    return entries;
  }

  private readIndex(): IndexFile {
    if (!fs.existsSync(this.indexPath)) return { ...EMPTY, threads: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf-8"));
    } catch (err) {
      // I2: 黙って空から始めない。過去の会話を失ったことに気づけなくなる
      throw new Error(`${this.indexPath} を読めません（会話の索引が壊れています）: ${String(err)}`);
    }
    const file = parsed as Partial<IndexFile>;
    return {
      version: 1,
      counter: typeof file.counter === "number" ? file.counter : 0,
      threads: Array.isArray(file.threads) ? file.threads : [],
    };
  }

  private writeIndex(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexPath, `${JSON.stringify(this.index, null, 2)}\n`, "utf-8");
  }
}
