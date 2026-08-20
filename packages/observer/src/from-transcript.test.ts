import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanTranscripts } from './from-transcript.js';

/** usage のある assistant 行。message.id を指定できるようにして重複を作れる。 */
function assistantLine(messageId: string, cacheRead: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: messageId,
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: 5,
      },
    },
  });
}

async function fixture(files: Record<string, string[]>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'banto-tx-'));
  for (const [name, lines] of Object.entries(files)) {
    await writeFile(path.join(root, name), `${lines.join('\n')}\n`, 'utf8');
  }
  return root;
}

describe('scanTranscripts', () => {
  it('同じ message.id の行を1ターンに畳み、生の行数も併せて返す', async () => {
    const root = await fixture({
      'a.jsonl': [
        assistantLine('msg_1', 100),
        assistantLine('msg_1', 100), // streaming で分かれた同じメッセージ
        assistantLine('msg_1', 100),
        assistantLine('msg_2', 200),
      ],
    });

    const scan = await scanTranscripts(root);
    expect(scan.turns).toHaveLength(2);
    expect(scan.rawAssistantLines).toBe(4);
    expect(scan.duplicateLines).toBe(2);
    // index は畳んだ後の並び。行の位置ではない。
    expect(scan.turns.map((t) => t.index)).toEqual([0, 1]);
  });

  it('4項目とも 0 の合成行は usage 無しとして数える', async () => {
    const root = await fixture({
      'a.jsonl': [
        assistantLine('msg_1', 100),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'local_1',
            usage: {
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          },
        }),
      ],
    });

    const scan = await scanTranscripts(root);
    // 文脈サイズ 0 のターンが混じると、そこへの下降を圧縮の発火と誤検出する。
    expect(scan.turns).toHaveLength(1);
    expect(scan.skippedNoUsage).toBe(1);
  });

  it('壊れた行は投げずに数える（第三者のファイルなので止まらない）', async () => {
    const root = await fixture({ 'a.jsonl': [assistantLine('msg_1', 100), '{"type":"assist'] });
    const scan = await scanTranscripts(root);
    expect(scan.turns).toHaveLength(1);
    expect(scan.malformedLines).toBe(1);
  });

  // 期間で絞る機構が黙って全部落とすと、「圧縮 0 回」のような嘘の結論が静かに出る。
  describe('期間で絞る', () => {
    const files = {
      'old.jsonl': [
        JSON.stringify({ type: 'user', timestamp: '2026-08-10T00:00:00.000Z' }),
        assistantLine('msg_old', 100),
      ],
      'new.jsonl': [
        JSON.stringify({ type: 'user', timestamp: '2026-08-20T09:00:00.000Z' }),
        assistantLine('msg_new', 200),
      ],
      'undated.jsonl': [assistantLine('msg_undated', 300)],
    };

    it('指定が無ければ全部読む', async () => {
      const scan = await scanTranscripts(await fixture(files));
      expect(scan.turns).toHaveLength(3);
      expect(scan.filesOutOfRange).toBe(0);
    });

    it('until は境界を含まない', async () => {
      const scan = await scanTranscripts(await fixture(files), { until: '2026-08-20' });
      expect(scan.turns.map((t) => t.seriesId)).toEqual(['old']);
      // 日付の分からないファイルも除くが、除いた数は必ず出す。
      expect(scan.filesOutOfRange).toBe(2);
    });

    it('since は境界を含む', async () => {
      const scan = await scanTranscripts(await fixture(files), { since: '2026-08-20' });
      expect(scan.turns.map((t) => t.seriesId)).toEqual(['new']);
      expect(scan.filesOutOfRange).toBe(2);
    });

    it('範囲外なら 0 件になるが、除いた数で理由が分かる', async () => {
      const scan = await scanTranscripts(await fixture(files), { since: '2030-01-01' });
      expect(scan.turns).toHaveLength(0);
      expect(scan.filesOutOfRange).toBe(3);
    });
  });
});
