// docs/specs/v4-architecture.md §2.1 Event Store の実装。
// 追記のみのログ＋fold で状態を作る（event sourcing、ただしCQRSまでは採らない
// ——docs/lessons.mdの既知の答え）。ログが唯一の真実（規則3）。

import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface StoredEvent<T = unknown> {
  seq: number;
  type: string;
  payload: T;
  ts: string;
}

/**
 * 追記のみのイベントログ。1ファイル1行1JSON（JSONL）。
 * 書き込みは直列化する——複数の append が同時に来ても順序が壊れないように、
 * 1本のPromiseチェーンで直列化する（Node の fs 書き込みは並行だと順序保証が無い）。
 */
export class EventLog {
  private readonly logPath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private seqCounter = 0;
  private initialized = false;

  constructor(private readonly dataDir: string) {
    this.logPath = join(dataDir, "events.jsonl");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.logPath)) {
      this.seqCounter = await this.readLastSeq();
    }
    this.initialized = true;
  }

  private async readLastSeq(): Promise<number> {
    let last = 0;
    for await (const ev of this.readFrom(0)) {
      last = ev.seq;
    }
    return last;
  }

  /** イベントを1件追記する。返り値は実際に書き込んだ seq 付きイベント。 */
  async append<T>(type: string, payload: T): Promise<StoredEvent<T>> {
    if (!this.initialized) throw new Error("EventLog.init() を先に呼ぶ必要があります");

    const result = this.writeChain.then(async () => {
      this.seqCounter += 1;
      const event: StoredEvent<T> = {
        seq: this.seqCounter,
        type,
        payload,
        ts: new Date().toISOString(),
      };
      const line = JSON.stringify(event) + "\n";
      await appendFile(this.logPath, line, "utf8");
      return event;
    });
    // 後続の書き込みが失敗した書き込みを待たずに進めるよう、チェーン自体は
    // 常に resolve する形にする（失敗はこの呼び出しの返り値にだけ伝える）。
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** afterSeq より後のイベントを順に読む。ファイルが無ければ何も返さない。 */
  async *readFrom(afterSeq: number): AsyncIterable<StoredEvent> {
    if (!existsSync(this.logPath)) return;
    const rl = createInterface({
      input: createReadStream(this.logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as StoredEvent;
        if (event.seq > afterSeq) yield event;
      }
    } finally {
      rl.close();
    }
  }

  currentSeq(): number {
    return this.seqCounter;
  }
}
