/**
 * 画面を**見る**ための道具（開発用）。
 *
 * 試験は「壊れていないこと」しか測らない。**「考えられた見た目か」は人が見るしかない**
 * ——実際、markdown の `**` が字面のまま出ていたのは、試験が全部緑のまま撮って初めて分かった。
 *
 * 使い方: `node scripts/shot.mjs [出力先ディレクトリ]`
 */

import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventLog } from '../packages/core/dist/index.js';
import { startServer } from '../apps/host/dist/server.js';

const outDir = process.argv[2] ?? '/tmp/banto-shots';
await mkdir(outDir, { recursive: true });

const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-shot-'));
const log = new EventLog(dataDir);

const ASSISTANT = `依頼のとおり、**3箇所**を直しました。

## 直したところ

1. \`Composer\` の Enter 判定（変換中は送らない）
2. 会話の追従（遡って読んでいる間は飛ばない）
3. 相手の言葉を Markdown で描く

| ファイル | 行 | 内容 |
|---|---|---|
| Composer.tsx | 58 | isComposing を見る |
| MessageList.tsx | 62 | StickToBottom |

\`\`\`typescript
const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.nativeEvent.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) submit();
};
\`\`\`

> 変換確定で送信されるのは不具合に近い。毎日使う道では致命的です。

次は残りの標準モジュールに進みます。`;

await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto-v3' });
await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '画面をv2に合わせる' });
await log.append({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼: UX を v2 に合わせる' });
await log.append({
  type: 'message.recorded',
  threadId: 't1',
  queryId: 'q1',
  role: 'user',
  text: '機能はいったんおいておいても、今実装した機能についての UX も v2 にしっかり合わせてもらえないでしょうか。',
});
await log.append({
  type: 'turn.usage',
  threadId: 't1',
  queryId: 'q1',
  turnIndex: 0,
  usage: { inputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 42000, outputTokens: 640 },
});
await log.append({ type: 'message.recorded', threadId: 't1', queryId: 'q1', role: 'assistant', text: ASSISTANT });
await log.append({
  type: 'reference.recorded',
  threadId: 't1',
  uri: 'banto://fs/file/note.md',
  name: 'note.md',
  mimeType: 'text/markdown',
  note: '書き足しました',
});
await log.append({
  type: 'decision.requested',
  decisionId: 'd1',
  source: 'factory',
  threadId: 't1',
  question: 'factory/ux を main に入れてよいか',
  options: [
    { id: 'approve', label: '取り込む', detail: 'merge して畳む' },
    { id: 'reject', label: '取り込まない', detail: '畳んで終える' },
  ],
});
await log.append({ type: 'thread.status', threadId: 't1', status: 'waiting-on-human' });

const fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-shot-fs-'));
await writeFile(path.join(fsRoot, 'note.md'), '# みかん\n\nと書いてあります。\n', 'utf8');
process.env.BANTO_FS_ROOT = fsRoot;
const { fsModule } = await import('../modules/fs/dist/index.js');
const helloPy = JSON.parse(await readFile('modules/hello-py/manifest.json', 'utf8'));

const server = startServer({
  dataDir,
  port: 0,
  modules: [{ name: 'fs', kind: 'in-process', server: fsModule.createServer() }],
  manifests: [fsModule.manifest, helloPy],
  toolsByModule: new Map(),
  model: 'claude-haiku-4-5',
  webRoot: path.resolve('apps/web/dist'),
});
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import('playwright');
const browser = await chromium.launch();

for (const [name, width, height] of [
  ['wide', 1440, 900],
  ['narrow', 390, 844],
]) {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.addInitScript((t) => localStorage.setItem('banto.theme', t), theme);
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-from="banto"]', { timeout: 15_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}.png`), fullPage: false });
    // 会話の頭（人の発言と、相手の印）も見る。末尾だけ見ていると頭の崩れを見逃す。
    await page.mouse.move(500, 400);
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${name}-${theme}-top.png`) });
    if (name === 'wide' && theme === 'light') {
      await page.getByRole('tab', { name: '設定' }).click();
      await page.waitForSelector('[data-module-row="fs"]', { timeout: 15_000 });
      await page.screenshot({ path: path.join(outDir, 'settings.png') });
    }
    await page.close();
  }
}

await browser.close();
server.close();
console.log(`撮った: ${outDir}`);
