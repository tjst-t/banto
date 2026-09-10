// docs/specs/v4-architecture.md §2.1 Event Store の実装。
// 追記のみのログ＋fold で状態を作る（event sourcing、ただしCQRSまでは採らない
// ——docs/lessons.mdの既知の答え）。ログが唯一の真実（規則3）。

import { mkdir, open, stat } from "node:fs/promises";
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
    // **書きかけの最終行は「無い」とみなす**（アーキ仕様§2.1、crash-torn の回復）。
    // 残したままだと、次回以降の起動で毎回 JSON.parse が同じ行で失敗し、
    // host が二度と立ち上がらない。切り詰めは append の前に済ませる。
    const torn = await this.truncateTornLine();
    if (existsSync(this.logPath)) {
      this.seqCounter = await this.readLastSeq();
    }
    // ファイルの存在自体もディレクトリ側の更新なので、ここで確定させておく
    await (await open(this.logPath, "a")).close();
    await this.syncDir();
    this.initialized = true;
    // **黙って捨てない**（規則2）——切り詰めたこと自体をログに残す。
    // 中身は残さない（秘密が混ざりうる）——落とした量と、どこまで残ったか
    if (torn) {
      await this.append("event_store.torn_line_truncated", {
        droppedBytes: torn.droppedBytes,
        keptThroughSeq: this.seqCounter,
      });
    }
  }

  /**
   * `\n` で終わっていない最終レコードを切り詰める。落としたバイト数を返す
   * （何も落とさなかったら undefined）。**ファイル全体を読まない**——
   * 後ろから塊で遡って最後の `\n` を探す（1GB のログでも起動を遅くしない）。
   */
  private async truncateTornLine(): Promise<{ droppedBytes: number } | undefined> {
    if (!existsSync(this.logPath)) return undefined;
    const { size } = await stat(this.logPath);
    if (size === 0) return undefined;

    const fh = await open(this.logPath, "r+");
    try {
      const lastByte = Buffer.alloc(1);
      await fh.read(lastByte, 0, 1, size - 1);
      if (lastByte[0] === 0x0a) return undefined;

      const CHUNK = 64 * 1024;
      let searchEnd = size;
      let keep = -1;
      while (searchEnd > 0 && keep < 0) {
        const start = Math.max(0, searchEnd - CHUNK);
        const buf = Buffer.alloc(searchEnd - start);
        await fh.read(buf, 0, buf.length, start);
        const idx = buf.lastIndexOf(0x0a);
        if (idx >= 0) keep = start + idx + 1; // `\n` の直後まで残す
        searchEnd = start;
      }
      const keptBytes = keep < 0 ? 0 : keep; // 1行も完結していなければ空にする
      await fh.truncate(keptBytes);
      await fh.sync();
      return { droppedBytes: size - keptBytes };
    } finally {
      await fh.close();
    }
  }

  /** ディレクトリ側の更新（ファイルの作成・rename）を確定させる。 */
  private async syncDir(): Promise<void> {
    const dh = await open(this.dataDir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  }

  private async readLastSeq(): Promise<number> {
    // **最後の seq を知るためだけに、全行を JSON に戻さない**（実測・2026-09-07
    // ——起動時、各 store が独立にログ全文を読み直しており、3.2万件で
    // 数百 ms〜1秒が seq を数えるためだけに費やされていた）
    let last = 0;
    for await (const line of this.readLines()) {
      const seq = seqOfLine(line);
      last = seq ?? (JSON.parse(line) as StoredEvent).seq;
    }
    return last;
  }

  private async *readLines(): AsyncIterable<string> {
    if (!existsSync(this.logPath)) return;
    const rl = createInterface({
      input: createReadStream(this.logPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        if (line.trim() === "") continue;
        yield line;
      }
    } finally {
      rl.close();
    }
  }

  /**
   * イベントを1件追記する。返り値は実際に書き込んだ seq 付きイベント。
   * **fsync が終わってから解決する**（アーキ仕様§2.1）——crash で消える状態を
   * 画面や購読者に見せない。
   */
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
      // **追記ごとに開いて閉じる。** fd を持ち回すと、閉じ忘れ（GC 任せ）と
      // 「閉じた後に追記される」という別の壊れ方を抱え込む——追記の頻度
      // （1ターンで数件）に対して open/close の代金は fsync に埋もれる
      const fh = await open(this.logPath, "a");
      try {
        await fh.write(line, null, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
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
    for await (const line of this.readLines()) {
      // **要らない行は JSON にしない**（改訂・2026-09-07、実測）。
      // スナップショットがある起動では読み飛ばす行のほうが圧倒的に多く、
      // その全部を JSON.parse してから捨てていた。seq は行の先頭に書かれて
      // いるので、そこだけ見て判断する——形が違う行は今までどおり parse する
      const seq = seqOfLine(line);
      if (seq !== null && seq <= afterSeq) continue;
      const event = JSON.parse(line) as StoredEvent;
      if (event.seq > afterSeq) yield event;
    }
  }

  currentSeq(): number {
    return this.seqCounter;
  }
}

/** 1行の先頭にある `seq`。この形で書いていない行（手で足したもの等）は null。 */
function seqOfLine(line: string): number | null {
  const m = /^\{"seq":(\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}
