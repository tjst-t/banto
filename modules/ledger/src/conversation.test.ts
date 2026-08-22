import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';

import { ConversationCore, type ResolveReference } from './conversation.js';

async function fresh(resolve: ResolveReference): Promise<{ log: EventLog; core: ConversationCore }> {
  const log = new EventLog(await mkdtemp(path.join(tmpdir(), 'banto-conversation-')));
  return { log, core: new ConversationCore(log, 't1', resolve) };
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
