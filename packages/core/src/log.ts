/**
 * append-only のイベントログ。真実はここに1つだけ（ADR-0001 決定7）。
 *
 * 守っている約束：
 *  - 追記しかしない。書き換えない
 *  - **どこまで読んだかを保存しない。** 起動のたびに 0 から読み直す
 *  - 版印を持ち、**読めない版に当たったら止まる**
 *  - 壊れた行を黙って飛ばさない（規則2）。回復できないなら止まる
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { LOG_VERSION, isKnownEventType, type BantoEvent, type NewEvent } from './event.js';
import { upgradeEvent } from './migrate.js';

export type LogFailure =
  /** この実装より新しい版のイベントが混じっていた。読めないので止まる。 */
  | 'unreadable-version'
  /** JSON として読めない行。落ちた書き込みの残骸かもしれないが、勝手に判断しない。 */
  | 'malformed-line'
  /** 知らない type。将来の版の可能性があるので、飛ばさず止まる。 */
  | 'unknown-type';

/**
 * ログが読めないときに投げる。
 * 握りつぶさず、どの行で何が起きたかを値で返す（教訓13：断るなら理由を値で返す）。
 */
export class EventLogError extends Error {
  constructor(
    readonly failure: LogFailure,
    readonly file: string,
    /** 1 から数えた行番号。 */
    readonly line: number,
    message: string,
  ) {
    super(`${message} (${file}:${line})`);
    this.name = 'EventLogError';
  }
}

/**
 * <data>/events/*.jsonl を扱う。
 *
 * 読むときは events/ 直下の .jsonl を名前順に全部読む。書くときは log.jsonl に足す。
 * 将来ファイルを分割しても読む側を変えずに済む形にしてあるが、分割はまだしない。
 */
export class EventLog {
  private readonly dir: string;
  private readonly writeTarget: string;
  /** 追記の直列化。同一プロセス内で行が混ざらないようにする。 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'events');
    this.writeTarget = path.join(this.dir, 'log.jsonl');
  }

  /** 1件追記して、封筒まで埋まったイベントを返す。 */
  async append(event: NewEvent): Promise<BantoEvent> {
    const stamped = {
      v: LOG_VERSION,
      id: randomUUID(),
      at: new Date().toISOString(),
      ...event,
    } as BantoEvent;

    const line = `${JSON.stringify(stamped)}\n`;
    const write = this.tail.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.writeTarget, line, 'utf8');
    });
    // 失敗しても後続の追記が詰まらないようにするが、失敗そのものは呼び手へ返す。
    this.tail = write.catch(() => undefined);
    await write;
    return stamped;
  }

  /**
   * 0 から読み直す。**途中から読む道は用意しない。**
   * 用意すると「どこまで読んだか」という第二の真実が生まれる。
   */
  async read(): Promise<BantoEvent[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.jsonl')).sort();
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }

    const events: BantoEvent[] = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (raw === undefined || raw.trim() === '') continue;
        events.push(parseLine(raw, name, i + 1));
      }
    }
    return events;
  }
}

function parseLine(raw: string, file: string, line: number): BantoEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EventLogError('malformed-line', file, line, 'JSON として読めない行がある');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new EventLogError('malformed-line', file, line, 'イベントが object でない');
  }

  const candidate = parsed as { v?: unknown; type?: unknown };

  if (typeof candidate.v !== 'number') {
    throw new EventLogError('malformed-line', file, line, '版印 v が無い');
  }
  // 読めない版に当たったら止まる。推測して読み進めない。
  if (candidate.v > LOG_VERSION) {
    throw new EventLogError(
      'unreadable-version',
      file,
      line,
      `版 ${candidate.v} は、この実装（版 ${LOG_VERSION}）では読めない`,
    );
  }

  // **type を確かめる前に版を上げる。** 順序が逆だと、旧版にしか無い type が
  // 「知らない type」に化けて、読める行を読めないと言うことになる。
  let event = parsed as Record<string, unknown>;
  if (candidate.v < LOG_VERSION) {
    try {
      event = upgradeEvent(event, candidate.v, LOG_VERSION);
    } catch (cause) {
      throw new EventLogError(
        'unreadable-version',
        file,
        line,
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  const type = event['type'];
  if (typeof type !== 'string' || !isKnownEventType(type)) {
    throw new EventLogError('unknown-type', file, line, `知らない type: ${String(type)}`);
  }

  return event as unknown as BantoEvent;
}
