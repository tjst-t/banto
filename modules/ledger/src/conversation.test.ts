import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';

import { ConversationCore, type ResolveReference } from './conversation.js';

async function fresh(
  resolve: ResolveReference,
  baseLimit = 100,
): Promise<{ log: EventLog; core: ConversationCore }> {
  const log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-conversation-')));
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto' });
  await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '一本目' });
  return { log, core: new ConversationCore(log, 't1', resolve, baseLimit) };
}

describe('show（AI が指す・要件 C14・決定19）', () => {
  it('実在する uri は記録される', async () => {
    const { log, core } = await fresh(async () => ({ text: '中身', mimeType: 'text/plain' }));
    await core.show({ uri: 'banto://fs/file/note.md' });
    const shown = (await log.read()).filter((e) => e.type === 'reference.recorded');
    expect(shown).toMatchObject([{ uri: 'banto://fs/file/note.md', threadId: 't1' }]);
  });

  /**
   * **AI が作文した uri を黙って記録しない**（規則1・2、実測 2026-08-22）。
   * 実際に起きた壊れ方：`banto://banto-v3/README.md` という、どのモジュールも
   * 持っていない uri が `show` に渡され、そのまま会話に残っていた。
   */
  it('存在しない uri は断り、記録しない', async () => {
    const { log, core } = await fresh(async () => {
      throw new Error('banto-v3 は繋がっていない');
    });
    await expect(core.show({ uri: 'banto://banto-v3/README.md' })).rejects.toThrow(/実在しない/);
    expect((await log.read()).filter((e) => e.type === 'reference.recorded')).toHaveLength(0);
  });

  it('banto:// 以外は断る', async () => {
    const { log, core } = await fresh(async () => ({ text: '', mimeType: null }));
    await expect(core.show({ uri: 'https://example.com' })).rejects.toThrow(/banto:\/\//);
    expect((await log.read()).filter((e) => e.type === 'reference.recorded')).toHaveLength(0);
  });
});

/**
 * AI が base へ自分で書き込む（バックログ「AI が base へ自分で書き込む」・2026-08-22）。
 * **ゲートは `appendBase` に1本化されている**——ここでは、その入口へ正しく
 * 繋がっていること（スレッドを取り違えない・二重の入口を作っていない）だけを測る。
 * 閾値判定そのものの試験（境界・decision.requested が立つこと等）は
 * `packages/core/src/base.test.ts` が持っている（規則3：同じことを2箇所で測らない）。
 */
describe('append_base（AI が決まったことに書き込む）', () => {
  it('閾値の内側なら追記され、base.appended が残る', async () => {
    const { log, core } = await fresh(async () => ({ text: '', mimeType: null }));
    const gate = await core.appendToBase({ text: '合言葉はもも' });
    expect(gate.ok).toBe(true);
    const appended = (await log.read()).filter((e) => e.type === 'base.appended');
    expect(appended).toMatchObject([{ threadId: 't1', text: '合言葉はもも', baseVersion: 1 }]);
  });

  it('閾値を超えると断り、base.appended を残さない', async () => {
    const { log, core } = await fresh(async () => ({ text: '', mimeType: null }), 10);
    const gate = await core.appendToBase({ text: '10文字を超える長さの文章' });
    expect(gate.ok).toBe(false);
    expect((await log.read()).filter((e) => e.type === 'base.appended')).toHaveLength(0);
  });
});

/**
 * 訂正は無効化で行う（PO指摘 2026-08-22）。ゲート自体の試験（境界・自分のスレッド
 * にしか効かない等）は `packages/core/src/base.test.ts` が持っている——ここでは
 * `ConversationCore` から正しい入口（自分の threadId）へ繋がっていることだけを測る。
 */
describe('invalidate_base / reactivate_base（AI が訂正する）', () => {
  it('自分が追記した行を無効化でき、base.invalidated が残る', async () => {
    const { log, core } = await fresh(async () => ({ text: '', mimeType: null }));
    await core.appendToBase({ text: '間違えた決定' });
    const gate = await core.invalidateBase({ baseVersion: 1 });
    expect(gate.ok).toBe(true);
    const invalidated = (await log.read()).filter((e) => e.type === 'base.invalidated');
    expect(invalidated).toMatchObject([{ threadId: 't1', baseVersion: 1 }]);
  });

  it('無効化してから再有効化すると、また効くようになる', async () => {
    const { log, core } = await fresh(async () => ({ text: '', mimeType: null }));
    await core.appendToBase({ text: 'X' });
    await core.invalidateBase({ baseVersion: 1 });
    const gate = await core.reactivateBase({ baseVersion: 1 });
    expect(gate.ok).toBe(true);
    expect((await log.read()).filter((e) => e.type === 'base.reactivated')).toHaveLength(1);
  });

  it('存在しない版は断る', async () => {
    const { core } = await fresh(async () => ({ text: '', mimeType: null }));
    const gate = await core.invalidateBase({ baseVersion: 99 });
    expect(gate.ok).toBe(false);
  });
});
