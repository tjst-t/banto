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
    await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });
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
    await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });

    expect((await log.read()).length).toBe(1);
    // 2回目も同じ件数。カーソルを持っていれば 0 件になるはず。
    expect((await log.read()).length).toBe(1);

    await log.append({ type: 'channel.created', channelId: 'c2', channelName: 'other' });
    expect((await log.read()).length).toBe(2);

    // 別のインスタンスでも同じ。プロセス内の状態に依存していない。
    expect((await new EventLog(dataDir).read()).length).toBe(2);
  });

  it('並行に追記しても行が混ざらない', async () => {
    const dataDir = await tempDataDir();
    const log = new EventLog(dataDir);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.append({ type: 'channel.created', channelId: `c${i}`, channelName: `n${i}` }),
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
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', channelName: 'ok' }),
      JSON.stringify({ v: LOG_VERSION + 1, id: 'b', at: '2026-08-20T00:00:01.000Z', type: 'channel.created', channelId: 'c2', channelName: '未来' }),
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
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', channelName: 'ok' }),
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
    await writeRawLines(dataDir, [JSON.stringify({ type: 'channel.created', channelId: 'c1', channelName: 'x' })]);

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
      JSON.stringify({ v: LOG_VERSION, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', channelName: 'ok' }),
      '',
      '   ',
    ]);
    expect((await new EventLog(dataDir).read()).length).toBe(1);
  });
});

/**
 * 決定7 は「読めない版で止まる」と同時に「上げたら古い版を読む道を書く」と定めている。
 * **本物のログを版1で書いて、版2の実装で読み戻す**——道が在ることを、実際に通して確かめる。
 */
describe('版を上げても古いログが読める（ADR-0001 決定7）', () => {
  const v1 = (event: Record<string, unknown>): string =>
    JSON.stringify({ v: 1, id: `e-${String(event['type'])}`, at: '2026-08-20T00:00:00.000Z', ...event });

  it('版1 の run.step は query.step / queryId になって読める', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      v1({ type: 'run.step', runId: 'r1', threadId: 't1', step: 'query', state: 'succeeded' }),
    ]);

    const [event] = await new EventLog(dataDir).read();
    expect(event?.type).toBe('query.step');
    expect(event).toMatchObject({ queryId: 'r1', threadId: 't1', status: 'succeeded' });
    expect(event).not.toHaveProperty('state');
    expect(event).not.toHaveProperty('runId');
    // 常に 'query' で情報を持たない項目。残すと Factory の「段」と重なる。
    expect(event).not.toHaveProperty('step');
  });

  // 改名したのは type だけではない。runId は3つの type に載っていた。
  it('版1 の turn.usage / thread.session の runId も付け替わる', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      v1({
        type: 'turn.usage',
        runId: 'r1',
        threadId: 't1',
        turnIndex: 0,
        usage: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 },
      }),
      v1({ type: 'thread.session', runId: 'r1', threadId: 't1', handle: 's1' }),
    ]);

    const events = await new EventLog(dataDir).read();
    expect(events.map((e) => (e as unknown as Record<string, unknown>)['queryId'])).toEqual(['r1', 'r1']);
    expect(events.some((e) => 'runId' in e)).toBe(false);
  });

  // 環境モジュールも handle を返すので、鍵になる項目は名前だけで一意にする。
  it('版1 の thread.session.handle は sessionHandle になる', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      v1({ type: 'thread.session', runId: 'r1', threadId: 't1', handle: 'sess-abc' }),
    ]);

    const [event] = await new EventLog(dataDir).read();
    expect(event).toMatchObject({ type: 'thread.session', sessionHandle: 'sess-abc' });
    expect(event).not.toHaveProperty('handle');
  });

  // 読んだ後の形は現行版なので、版印も現行版でなければ形と版が食い違う。
  it('読み戻したイベントの版印は現行版になる', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [v1({ type: 'channel.created', channelId: 'c1', name: 'banto' })]);

    const [event] = await new EventLog(dataDir).read();
    expect(event?.v).toBe(LOG_VERSION);
    // 名前で引かれる項目なので、鍵と同じ扱いにする。
    expect(event).toMatchObject({ channelName: 'banto' });
    expect(event).not.toHaveProperty('name');
  });

  /**
   * 版2 は選択肢の無い世界なので、そこで出た答えは全部「自由文」である。
   * **推測して id を作らない**——何を選んだかは、そこに無い情報（規則3）。
   */
  it('版2 の答えは、選択肢を選んでいない答えとして読める', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({
        v: 2,
        id: 'e-1',
        at: '2026-08-20T00:00:00.000Z',
        type: 'decision.resolved',
        decisionId: 'd1',
        answer: 'APPROVE',
      }),
    ]);

    const [event] = await new EventLog(dataDir).read();
    expect(event).toMatchObject({ type: 'decision.resolved', optionId: null, answer: 'APPROVE' });
  });

  // 版1 のログは2段（1→2→3）通る。**途中の段を飛ばさない。**
  it('版1 の答えも、2段通って読める', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [v1({ type: 'decision.resolved', decisionId: 'd1', answer: 'x' })]);

    const [event] = await new EventLog(dataDir).read();
    expect(event).toMatchObject({ optionId: null, v: LOG_VERSION });
  });

  // 道が在ることと、止まるべきときに止まることは両立していないといけない。
  it('未来の版ではやはり止まる', async () => {
    const dataDir = await tempDataDir();
    await writeRawLines(dataDir, [
      JSON.stringify({ v: LOG_VERSION + 1, id: 'a', at: '2026-08-20T00:00:00.000Z', type: 'channel.created', channelId: 'c1', channelName: 'x' }),
    ]);

    const error = await new EventLog(dataDir).read().then(
      (events) => {
        throw new Error(`止まらずに ${events.length} 件返した`);
      },
      (e: unknown) => e,
    );
    expect((error as EventLogError).failure).toBe('unreadable-version');
  });
});
