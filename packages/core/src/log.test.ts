import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog, EventLogError } from './log.js';
import { LOG_VERSION } from './event.js';

async function tempDataDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'banto-log-'));
}

/** ログを一切通さず、生の行を直接置く。壊れた入力を作るために必要。 */
async function writeRawLines(dataDir: string, lines: string[]): Promise<void> {
  const dir = path.join(dataDir, 'events');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'log.jsonl'), lines.map((l) => `${l}\n`).join(''), 'utf8');
}

describe('EventLog', () => {
  it('ログが無ければ空を返す（存在しないことと壊れていることを区別する）', async () => {
    const log = new EventLog(await tempDataDir());
    expect(await log.read()).toEqual([]);
  });

  it('追記した順に読み戻せる', async () => {
    const log = new EventLog(await tempDataDir());
    await log.append({ type: 'channel.created', channelId: 'c1', name: 'banto' });
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '最初' });

    const events = await log.read();
    expect(events.map((e) => e.type)).toEqual(['channel.created', 'thread.created']);
    expect(events[0]?.v).toBe(LOG_VERSION);
    // 封筒はログ側が埋める。呼び手は id も時刻も与えない。
    expect(events[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('毎回 0 から読み直す（どこまで読んだかを保存しない）', async () => {
    const dataDir = await tempDataDir();
    const log = new EventLog(dataDir);
    await log.append({ type: 'channel.created', channelId: 'c1', name: 'banto' });

    expect((await log.read()).length).toBe(1);
    // 2回目も同じ件数。カーソルを持っていれば 0 件になるはず。
    expect((await log.read()).length).toBe(1);

    await log.append({ type: 'channel.created', channelId: 'c2', name: 'other' });
    expect((await log.read()).length).toBe(2);

    // 別のインスタンスでも同じ。プロセス内の状態に依存していない。
    expect((await new EventLog(dataDir).read()).length).toBe(2);
  });

  it('並行に追記しても行が混ざらない', async () => {
    const dataDir = await tempDataDir();
    const log = new EventLog(dataDir);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.append({ type: 'channel.created', channelId: `c${i}`, name: `n${i}` }),
      ),
    );
    const events = await log.read();
    expect(events.length).toBe(50);
    expect(new Set(events.map((e) => e.id)).size).toBe(50);
  });

  // --- ここから下はガードの試験。
  // 「弾かれること」だけを見ると、ガードを外しても通ってしまう書き方になりやすい（教訓2）。
  // そこで **何が返るはずだったか** まで書く：止まらなければ read() は値を返してしまう。

  it('読めない版に当たったら止まる（黙って読み進めない）', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', name: 'ok' }),
      JSON.stringify({ v: LOG_VERSION + 1, id: 'b', at: '2026-08-20T00:00:01.000Z', type: 'channel.created', channelId: 'c2', name: '未来' }),
    ]);

    const error = await new EventLog(dataDir).read().then(
      (events) => {
        // ガードが無いとここへ来る。件数まで書いて、素通りを検知できるようにする。
        throw new Error(`止まらずに ${events.length} 件返した`);
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EventLogError);
    expect((error as EventLogError).failure).toBe('unreadable-version');
    expect((error as EventLogError).line).toBe(2);
  });

  it('JSON として読めない行で止まる（落ちた書き込みの残骸を勝手に捨てない）', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', name: 'ok' }),
      '{"v":1,"type":"channel.created"',
    ]);

    const error = await new EventLog(dataDir).read().then(
      (events) => {
        throw new Error(`止まらずに ${events.length} 件返した`);
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EventLogError);
    expect((error as EventLogError).failure).toBe('malformed-line');
    expect((error as EventLogError).line).toBe(2);
  });

  it('知らない type で止まる（将来の版かもしれないので飛ばさない）', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'factory.merged', runId: 'r1' }),
    ]);

    const error = await new EventLog(dataDir).read().then(
      (events) => {
        throw new Error(`止まらずに ${events.length} 件返した`);
      },
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(EventLogError);
    expect((error as EventLogError).failure).toBe('unknown-type');
  });

  it('版印が無い行で止まる', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [JSON.stringify({ type: 'channel.created', channelId: 'c1', name: 'x' })]);

    const error = await new EventLog(dataDir).read().then(
      (events) => {
        throw new Error(`止まらずに ${events.length} 件返した`);
      },
      (e: unknown) => e,
    );

    expect((error as EventLogError).failure).toBe('malformed-line');
  });

  it('空行は読み飛ばす（末尾の改行で止まってはいけない）', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', name: 'ok' }),
      '',
      '   ',
    ]);
    expect((await new EventLog(dataDir).read()).length).toBe(1);
  });
});
