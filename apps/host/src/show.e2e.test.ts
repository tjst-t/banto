/**
 * **Phase 2.5 の完了条件を、本物で測る**（要件 C14・決定19）。
 *
 *   BANTO_E2E=1 npx vitest run apps/host/src/show.e2e.test.ts
 *
 * > **AI がファイルを更新し、それを指し、人がそれを画面で開ける。**
 *
 * ここで測るのは前半——**本物のモデルが `show` を呼ぶか**。後半（人が開ける）は
 * `ui-smoke.test.ts` が本物のブラウザで測っている。
 *
 * **偽物を置かない**（教訓1）。道具の説明を読んで、モデルが自分で
 * 「これは見せるものだ」と判断できるかどうかが、この契約の要である
 * ——説明で伝わらないなら、契約の側が悪い。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { EventLog, DEFAULT_BASE_LIMIT_CHARACTERS } from '@banto/core';
import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';
import { conversationModule } from '@banto/module-ledger';
import { connectInProcess } from '@banto/module-kit';

import { SYSTEM_PROMPT } from './server.js';

const enabled = process.env['BANTO_E2E'] === '1';

let dataDir: string;
let fsRoot: string;

beforeAll(async () => {
  if (!enabled) return;
  dataDir = await mkdtemp(path.join(tmpdir(), 'banto-show-'));
  fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-show-fs-'));
  await writeFile(path.join(fsRoot, 'note.md'), '# もとの中身\n', 'utf8');
  process.env['BANTO_FS_ROOT'] = fsRoot;
});

describe.skipIf(!enabled)('AI がファイルを更新して、それを指す（要件 C14）', () => {
  it('本物のモデルが show を呼び、指しがログに残る', async () => {
    const log = new EventLog(dataDir);
    await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'show' });
    await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '指す' });

    const { fsModule, manifest: fsManifest } = await import('@banto/module-fs');
    // server.ts と同じ検証を通す（`show` が実在しない uri を記録しないことも、
    // ここで一緒に確かめる）。
    const fsCaller = await connectInProcess(fsModule(fsRoot).createServer());
    const face = conversationModule(log, 't1', (uri) => fsCaller.readResource(uri), DEFAULT_BASE_LIMIT_CHARACTERS);

    const servers: McpServerSpec[] = [
      { name: fsManifest.id, kind: 'in-process', server: fsModule(fsRoot).createServer() },
      { name: face.manifest.id, kind: 'in-process', server: face.createServer() },
    ];
    const tools = new Map<string, readonly string[]>([
      ['fs', ['read', 'write', 'list']],
      ['conversation', ['show']],
    ]);

    for await (const event of new AgentSdkRunner().query({
      threadId: 't1',
      queryId: 'q1',
      // **ホストが本番で渡すのと同じ指示。** 別物を測らない（教訓1）。
      // 画面の名前は1つも書いていない——指すのは URI だけである（決定19）。
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: servers,
      skills: [],
      model: 'claude-haiku-4-5',
      allowedTools: [...allowedToolNames(servers, tools), 'ToolSearch'],
      maxTurns: 12,
      prompt: 'note.md の中身を「# みかん」に書き換えて、私がそれを見られるようにしてください。',
    })) {
      await log.append(event);
    }

    // **現物で確かめる**（規則1）。書けたか。
    expect(await readFile(path.join(fsRoot, 'note.md'), 'utf8')).toContain('みかん');

    // **指しがログに残ったか。** ここが契約の要。
    const shown = (await log.read()).filter((e) => e.type === 'reference.recorded');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ threadId: 't1', uri: 'banto://fs/file/note.md' });
  }, 600_000);
});
