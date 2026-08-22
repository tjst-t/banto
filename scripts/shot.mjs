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

const ASSISTANT = `依頼のとおり、UX を見本の意匠で作り直しました。

## 変えたところ

1. サイドバー（受信箱・プロジェクト・開いているもの）
2. 会話パネル＋層で重なる作業パネル
3. 判断待ちは会話の最後尾にそのまま出す

| 用途 | ライブラリ |
|---|---|
| ダイアログ | @radix-ui/react-dialog |
| 帯の幅 | react-resizable-panels |

\`\`\`typescript
const resolvedDecisions = new Set(
  items.flatMap((i) => (i.event.type === 'message.recorded' && i.event.queryId.startsWith('decision:')
    ? [i.event.queryId.slice(9)] : [])),
);
\`\`\`

> 用語は見本のものを持ち込まず、一般名に置き換えました。

次はバックログの項目に進みます。`;

await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'banto-v3' });
await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: 'UXをv2の見本に合わせる' });
await log.append({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼: UXを見本の意匠で作り直す' });
await log.append({
  type: 'message.recorded',
  threadId: 't1',
  queryId: 'q1',
  role: 'user',
  text: 'いまの GUI は全部一度捨てて、意匠見本の UX で作ってください。',
});
await log.append({
  type: 'turn.usage',
  threadId: 't1',
  queryId: 'q1',
  turnIndex: 0,
  usage: { inputTokens: 120, cacheCreationInputTokens: 0, cacheReadInputTokens: 58000, outputTokens: 900 },
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
  question: 'factory/ux-redesign を main に入れてよいか',
  options: [
    { id: 'approve', label: '取り込む', detail: 'merge して畳む' },
    { id: 'reject', label: '取り込まない', detail: '畳んで終える' },
  ],
});
await log.append({ type: 'thread.status', threadId: 't1', status: 'waiting-on-human' });

// 2本目（フォーク）。サイドバーの「開いているもの」に2点出る。
// **既定で幹の横に並ぶ**（決定26）——開き直すたびに片方を選ばせない。
await log.append({
  type: 'thread.forked',
  threadId: 't2',
  channelId: 'c1',
  title: 'モバイル幅の検証',
  from: { threadId: 't1', baseVersion: 1 },
  mode: 'base',
});
await log.append({
  type: 'message.recorded',
  threadId: 't2',
  queryId: 'q2',
  role: 'user',
  text: '390px でも壊れていないか見て',
});
await log.append({ type: 'message.recorded', threadId: 't2', queryId: 'q2', role: 'assistant', text: '確認しました。' });
await log.append({
  type: 'reference.recorded',
  threadId: 't2',
  uri: 'banto://fs/file/note.md',
  name: 'note.md',
  mimeType: 'text/markdown',
  note: '狭い画面での見え方',
});
await log.append({ type: 'thread.status', threadId: 't2', status: 'working' });

const fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-shot-fs-'));
await writeFile(path.join(fsRoot, 'note.md'), '# みかん\n\nと書いてあります。\n', 'utf8');
process.env.BANTO_FS_ROOT = fsRoot;
const { fsModule } = await import('../modules/fs/dist/index.js');
const helloPy = JSON.parse(await readFile('modules/hello-py/manifest.json', 'utf8'));

const server = startServer({
  dataDir,
  port: 0,
  modules: [{ name: 'fs', kind: 'in-process', createServer: () => fsModule.createServer() }],
  manifests: [fsModule.manifest, helloPy],
  toolsByModule: new Map(),
  model: 'claude-haiku-4-5',
  webRoot: path.resolve('apps/web/dist'),
});
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await import('playwright');
const browser = await chromium.launch();

for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => localStorage.setItem('banto.theme', t), theme);
  await page.goto(origin, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });
  await page.waitForTimeout(500);
  // **既定で幹（t1）とフォーク（t2）が横に並ぶ**（決定26）——開き直すたびに
  // 片方だけを選ばせない。
  await page.screenshot({ path: path.join(outDir, `wide-${theme}.png`) });

  if (theme === 'light') {
    // 幹から作業パネルを開く——開いていたフォークは表示から外れる（見本の workFrom）。
    await page.locator('[data-conversation-panel="t1"] [data-reference="banto://fs/file/note.md"]').click();
    await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'work-from-root.png') });
    // ESC で閉じる（PO指摘 2026-08-22）。
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 5_000 });

    // フォークを開き直し、フォーク側から作業パネルを開く——幹は背表紙に畳まれる。
    await page.locator('[data-open-item="t2"]').click();
    await page.waitForSelector('[data-conversation-panel="t2"]', { timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.locator('[data-conversation-panel="t2"] [data-reference="banto://fs/file/note.md"]').click();
    await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
    await page.waitForSelector('[data-spine]', { timeout: 15_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'work-from-fork.png') });
    // 背表紙を押すと、作業パネルとフォークが両方閉じて幹だけに戻る。
    await page.locator('[data-spine]').click();
    await page.waitForSelector('[data-conversation-panel="t2"]', { state: 'detached', timeout: 5_000 });
    await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 5_000 });

    // フォークを開き直し、会話側クリックで作業パネルが閉じることを確かめる。
    await page.locator('[data-open-item="t2"]').click();
    await page.waitForSelector('[data-conversation-panel="t2"]', { timeout: 15_000 });
    await page.locator('[data-conversation-panel="t2"] [data-reference="banto://fs/file/note.md"]').click();
    await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
    await page.locator('[data-conversation-panel="t2"] h1').click();
    await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 5_000 });

    // 受信箱。
    await page.locator('[data-open-item="t1"]').click();
    await page.getByRole('button', { name: '受信箱' }).click();
    await page.waitForSelector('[data-decision-card]', { timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'inbox.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // 設定。
    await page.getByRole('button', { name: '設定' }).click();
    await page.waitForSelector('[data-module-row="fs"]', { timeout: 15_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'settings.png') });
  }

  await page.close();
}

// 狭い画面。
const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
await narrow.goto(origin, { waitUntil: 'networkidle' });
await narrow.locator('[data-open-item="t1"]').click();
await narrow.waitForSelector('[data-from="banto"]', { timeout: 15_000 });
await narrow.waitForTimeout(500);
await narrow.screenshot({ path: path.join(outDir, 'narrow.png') });
await narrow.close();

await browser.close();
server.close();
console.log(`撮った: ${outDir}`);
