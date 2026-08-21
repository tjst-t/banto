/**
 * 本物の SDK を通す確認。**課金が要るので既定では走らせない。**
 *
 *   BANTO_E2E=1 npx vitest run modules/fs
 *
 * 偽の Runner で代用しない（教訓1）。型が通っても実プロセスで壊れる境界なので、
 * ここだけは本物で叩く（教訓16）。走らせない日があってよいが、消さない。
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';
import { describe, expect, it } from 'vitest';

const enabled = process.env['BANTO_E2E'] === '1';

describe.skipIf(!enabled)('fs モジュールを本物の SDK で叩く', () => {
  it('モデルが in-process の MCP ツール経由でファイルを読む', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'banto-fs-e2e-'));
    await writeFile(path.join(root, 'note.txt'), '合言葉は MIKAN。', 'utf8');
    process.env['BANTO_FS_ROOT'] = root;

    const { fsModule } = await import('./index.js');
    const spec: McpServerSpec = {
      name: fsModule.manifest.id,
      kind: 'in-process',
      server: fsModule.createServer(),
    };

    let answer = '';
    for await (const event of new AgentSdkRunner().query({
      threadId: 't1',
      queryId: 'q1',
      systemPrompt: 'Use the fs tools. Be terse.',
      mcpServers: [spec],
      skills: [],
      model: 'claude-haiku-4-5',
      // 明示的に許した範囲に限られる（要件 D4）。渡さないと権限で断られる。
      allowedTools: allowedToolNames([spec], new Map([['fs', ['read', 'list', 'write']]])),
      maxTurns: 6,
      prompt: 'Read note.txt with the fs read tool and report the passphrase only.',
    })) {
      if (event.type === 'query.step' && event.status === 'succeeded') answer = event.detail ?? '';
    }

    expect(answer).toContain('MIKAN');
  }, 300_000);
});
