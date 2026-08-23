/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * 画面が本当に描けているかを、**本物のブラウザで**測る（要件 E1）。
 *
 * **`lib="dom"` をこのファイルにだけ足している。** `apps/host` は Node のサービスで
 * DOM を持たない（`tsconfig.base.json` の `lib` は `ES2023` のみ）——正しい既定である。
 * ここだけ例外なのは、`page.evaluate(() => ...)` の中身が**このプロセスでは動かず、
 * ブラウザの中で動く**ため。型検査のためだけに、このファイルに限って足す。
 *
 * ## なぜ要るか
 *
 * この試験が無かった間に、同じ壊れ方を**3回**見逃した：
 *
 * 1. サーバを新しくして `run.step` が `query.step` になった日、画面の一番下が
 *    「当たらなかったものは全部エラー」だったので**会話が真っ赤になった**
 * 2. 直したつもりで `thread.session` が残り、**空のエラー枠**が並んだ
 * 3. 古い形の本文を出す判定を「会話ごと」にしたら、形が混ざった会話で
 *    **古い本文が丸ごと消えた**
 *
 * どれも**型検査も単体試験も緑のまま**通り抜けた。人が画面を見て気づくまで
 * 分からない類で、その「人が見る」を毎回お願いしていた。
 *
 * > **完了条件は「要件を満たす」ではなく「計測が実際に走り、数値を返す」**（CLAUDE.md）。
 *
 * ## 画面を作り直した（決定22・2026-08-22）
 *
 * サイドバー＋会話パネル＋層で重なる作業パネルへ作り直したので、
 * ここも新しい構えの言葉（`data-conversation-panel`・`data-work-panel`・
 * `data-open-item` 等）で全シナリオを引き直した。
 */

import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EventLog } from '@banto/core';

import { startServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(here, '../../web/dist');

let server: ReturnType<typeof startServer> | null = null;
let origin = '';
let built = false;

/** 書式つきの返事（要件 E4）。**LLM の出力は Markdown なので、描けないのは読めないのと同じ。** */
const MARKDOWN_REPLY = `直しました。

## 直したところ

1. 変換確定の Enter で送らない
2. 末尾に追従する

| ファイル | 内容 |
|---|---|
| Composer.tsx | isComposing を見る |

\`\`\`typescript
if (e.nativeEvent.isComposing) return;
\`\`\`
`;

beforeAll(async () => {
  built = await access(path.join(WEB_ROOT, 'index.html')).then(
    () => true,
    () => false,
  );
  if (!built) return;

  const dataDir = await mkdtemp(path.join(tmpdir(), 'banto-ui-smoke-'));
  const log = new EventLog(dataDir);

  // **本物のログを、いま在るイベント種で埋める。** 種を1つ足したのに画面が
  // 知らない、という壊れ方をここで捕まえたいので、**全部の種を1つずつ置く**。
  await log.append({ type: 'channel.created', channelId: 'c1', channelName: 'smoke' });
  await log.append({ type: 'thread.created', threadId: 't1', channelId: 'c1', title: '煙試験' });
  await log.append({ type: 'base.appended', threadId: 't1', baseVersion: 1, text: '依頼: 煙を出す' });
  await log.append({ type: 'thread.status', threadId: 't1', status: 'working' });
  await log.append({ type: 'thread.session', threadId: 't1', queryId: 'q1', sessionHandle: 's1' });
  await log.append({
    type: 'message.recorded',
    threadId: 't1',
    queryId: 'q1',
    role: 'user',
    text: 'ユーザーの発言',
  });
  await log.append({
    type: 'turn.usage',
    threadId: 't1',
    queryId: 'q1',
    turnIndex: 0,
    usage: {
      inputTokens: 10,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1000,
      outputTokens: 5,
    },
  });
  await log.append({
    type: 'message.recorded',
    threadId: 't1',
    queryId: 'q1',
    role: 'assistant',
    text: 'アシスタントの発言',
  });
  await log.append({ type: 'query.step', queryId: 'q1', threadId: 't1', status: 'succeeded', detail: 'アシスタントの発言' });
  // **古い形**：文面の記録が無い問い合わせ。ここは detail から読めないといけない。
  await log.append({ type: 'query.step', queryId: 'q0', threadId: 't1', status: 'succeeded', detail: '古い形の本文' });
  await log.append({ type: 'compaction.reported', threadId: 't1', queryId: 'q1', detail: 'trigger=auto' });
  await log.append({
    type: 'run.requested',
    runId: 'r1',
    channelId: 'c1',
    threadId: 't1',
    branch: 'factory/smoke',
    request: '依頼: 煙を出す',
  });
  await log.append({ type: 'run.tested', runId: 'r1', commit: 'a'.repeat(40), passed: true, detail: 'ok' });
  await log.append({ type: 'run.failed', runId: 'r1', stage: 'merge', detail: '衝突した' });
  await log.append({
    type: 'decision.requested',
    decisionId: 'd-options',
    source: 'factory',
    threadId: 't1',
    question: 'factory/smoke を main に入れてよいか',
    options: [
      { id: 'approve', label: '取り込む', detail: 'merge して畳む' },
      { id: 'reject', label: '取り込まない', detail: '畳んで終える' },
    ],
  });
  await log.append({ type: 'thread.status', threadId: 't1', status: 'waiting-on-human' });
  // **AI が「これを見て」と指した**（要件 C14・決定19）。中身は持たない。
  await log.append({
    type: 'reference.recorded',
    threadId: 't1',
    uri: 'banto://fs/file/note.md',
    name: 'note.md',
    mimeType: 'text/markdown',
    note: '書き足しました',
  });
  // **TypeScript でないモジュールが指したもの**（要件 C6・決定20）。
  await log.append({
    type: 'reference.recorded',
    threadId: 't1',
    uri: 'banto://hello-py/greeting/banto',
    name: 'banto への挨拶',
    mimeType: 'text/plain',
    note: 'Python から返している',
  });
  // **書式つきの返事**（要件 E4）。素の文字列で出していると、ここが記号のまま並ぶ。
  await log.append({
    type: 'message.recorded',
    threadId: 't1',
    queryId: 'q2',
    role: 'user',
    text: '書式つきで答えてください',
  });
  await log.append({
    type: 'message.recorded',
    threadId: 't1',
    queryId: 'q2',
    role: 'assistant',
    text: MARKDOWN_REPLY,
  });

  // **2本目**。1本目からフォークしているので、決まったことを継承している（要件 R4）。
  await log.append({
    type: 'thread.forked',
    threadId: 't2',
    channelId: 'c1',
    title: '2本目',
    from: { threadId: 't1', baseVersion: 1 },
    mode: 'base',
  });
  await log.append({ type: 'base.appended', threadId: 't2', baseVersion: 2, text: '2本目で決めたこと' });
  // **フォーク側にも指しを持たせる**（決定26の試験用）。作業パネルをフォーク側から
  // 開いたときの背表紙（`Spine`）を試すには、フォーク自身の会話に指しが要る。
  await log.append({
    type: 'reference.recorded',
    threadId: 't2',
    uri: 'banto://fs/file/note.md',
    name: 'note.md',
    mimeType: 'text/markdown',
    note: '2本目からも同じファイルを見る',
  });
  // **受信箱の試験専用。** 「会話の最後尾」の試験が d-options に答えてしまうので、
  // ログを共有する試験どうしが同じ判断を取り合わないよう、別の判断を1件立てる。
  await log.append({
    type: 'decision.requested',
    decisionId: 'd-inbox',
    source: 'factory',
    threadId: 't1',
    question: '受信箱からの判断待ち',
    options: [
      { id: 'approve', label: '取り込む', detail: 'merge して畳む' },
      { id: 'reject', label: '取り込まない', detail: '畳んで終える' },
    ],
  });
  await log.append({ type: 'thread.status', threadId: 't2', status: 'done' });

  // **fs を本物で載せる。** 指された URI を実際に読ませないと、
  // 「指しは出るが開けない」を見逃す（要件 C14）。
  const fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-ui-fs-'));
  await writeFile(path.join(fsRoot, 'note.md'), 'みかんと書いてある\n', 'utf8');
  process.env['BANTO_FS_ROOT'] = fsRoot;
  const { fsModule } = await import('@banto/module-fs');
  const helloPyManifest = JSON.parse(
    await readFile(path.resolve('modules/hello-py/manifest.json'), 'utf8'),
  ) as Parameters<typeof startServer>[0]['manifests'] extends readonly (infer M)[] | undefined
    ? M
    : never;

  server = startServer({
    dataDir,
    port: 0,
    modules: [
      { name: fsModule.manifest.id, kind: 'in-process', createServer: () => fsModule.createServer() },
      // **本物の Python を繋ぐ**（要件 C6）。偽物だと、この試験は何も証明しない。
      { name: 'hello-py', kind: 'subprocess', command: 'python3', args: ['modules/hello-py/server.py'] },
    ],
    // 画面の割り当ては台帳から導く（決定20）。渡さないと汎用の面に落ちる。
    manifests: [fsModule.manifest, helloPyManifest],
    toolsByModule: new Map(),
    model: 'claude-haiku-4-5',
    webRoot: WEB_ROOT,
  });
  await new Promise((r) => server?.once('listening', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  server?.close();
});

describe('画面の煙試験（本物のブラウザ）', () => {
  it('会話が描け、壊れた印がどこにも出ない', async () => {
    if (!built) {
      // **黙って飛ばさない**（規則2）。何をすれば走るかまで言う。
      throw new Error(
        `画面がビルドされていないので測れない: ${WEB_ROOT}。先に \`npm run build:web\` を走らせる`,
      );
    }

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      // 既定で開くのは最新（＝「2本目」）。**1本目を見たいので明示的に開く。**
      await openThread(page, 't1');
      // 会話を開くと履歴を読みに行く（要件 A8）。描き終わるのを待つ。
      await page.waitForSelector('text=アシスタントの発言', { timeout: 15_000 });
      const body = await page.innerText('body');

      // **知らないイベントに落ちていない。** ここが 0 でないと、
      // 「画面が真っ赤なのに理由が分からない」があの日と同じ形で戻ってくる。
      expect(body).not.toContain('未対応のイベント');

      // 人の発言も相手の発言も残っている（要件 A8）。
      expect(body).toContain('ユーザーの発言');
      expect(body).toContain('アシスタントの発言');

      // **形が混ざっていても、古いほうが消えない**（3回目に踏んだところ）。
      expect(body).toContain('古い形の本文');

      // 文面が記録されている問い合わせでは、同じ本文が2度出ない。
      expect(body.split('アシスタントの発言').length - 1).toBe(1);

      // base への追記と、Factory の記録が読める。
      expect(body).toContain('決まったことに追記');
      expect(body).toContain('merge で止まりました');

      expect(problems).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **判断待ちは、会話の最後尾にそのまま出る**（要件 A6・E10）。常設の列は無い。
   *
   * 「ボタンが描けている」では足りない——押した先が繋がっていない画面は、
   * 見た目には壊れていないので、人が押してみるまで分からない。
   */
  it('会話の最後尾に判断待ちが出て、選ぶと会話に答えが返る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-decision-card]', { timeout: 15_000 });

      // **同じスレッドにもう1件（受信箱の試験用）判断待ちがあり、選択肢の文言も同じ**
      // （どちらも「取り込む」）。**カードごと文面で絞る**——ボタンの名前だけで
      // `.first()` を取ると、答えた瞬間に「残ったほうの取り込むボタン」を
      // 指すようになって detached を待ち続ける（実際に踏んだ）。
      const card = page.locator('[data-decision-card]', {
        hasText: 'factory/smoke を main に入れてよいか',
      });
      await card.getByRole('button', { name: '取り込む', exact: true }).click();

      // 答えたら、**そのカードごと**消える（会話には残るが、押せる形は無くなる）。
      await card.waitFor({ state: 'detached', timeout: 15_000 });
      // **会話に返っている。** 答えは `message.recorded` としてそのまま吹き出しになる
      // （`decision.resolved` は `threadId` を持たないので、ここには届かない——実測）。
      await page.waitForSelector('text=取り込む（approve）', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **横断で見る受信箱**（要件 A5・A6・E11）。会話の中と同じ見た目（`DecisionCard`）で答えられる。
   */
  it('受信箱から判断待ちに答えられる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '受信箱' }).click();
      await page.waitForSelector('[role=dialog] [data-decision-card]', { timeout: 15_000 });
      // 出所・滞留時間・スレッド名が読める（実データにある項目だけ）。
      await page.waitForSelector('text=FACTORY', { timeout: 15_000 });
      await page.waitForSelector('text=/「煙試験」を開く/', { timeout: 15_000 });

      await page.getByRole('button', { name: '取り込まない', exact: true }).click();
      // 答えたら、**そのカードが受信箱から消える**（ダイアログは開いたまま——
      // 他に待っているものを見続けられる。閉じるのは人が決めること）。
      await page.waitForSelector('[role=dialog] [data-decision-card]', {
        state: 'detached',
        timeout: 15_000,
      });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **サイドバーの「開いているもの」**（要件 A2）。押さなくても本数と状態が点で分かり、
   * 押すと開き直せる。
   */
  it('サイドバーの点で、開いている会話を切り替えられる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-open-item="t1"]', { timeout: 15_000 });
      await page.waitForSelector('[data-open-item="t2"]', { timeout: 15_000 });

      await openThread(page, 't1');
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });

      await openThread(page, 't2');
      await page.waitForSelector('[data-conversation-panel="t2"]', { timeout: 15_000 });
      // t2 は t1 からのフォーク。頭の見出しにそれが出る（決まったことの中身は別試験で見る）。
      await page.waitForSelector('text=煙試験 から', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **狭い画面で崩れない**（要件 E2）。サイドバーが上端の横帯になる。
   */
  it('狭い画面では、サイドバーが横帯になり1列で読める', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });

      const sidebarBox = await page.locator('[data-sidebar]').boundingBox();
      const panelBox = await page.locator('[data-conversation-panel]').boundingBox();
      expect(sidebarBox).not.toBeNull();
      expect(panelBox).not.toBeNull();
      // **横帯**（幅いっぱい・高さが低い）になっている。縦のレールのままなら幅が狭いはず。
      expect(sidebarBox!.width).toBeGreaterThan(300);
      expect(sidebarBox!.height).toBeLessThan(80);
      // 会話パネルは画面いっぱいの幅（3列に潰れていない）。
      expect(panelBox!.width).toBeGreaterThan(300);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **いま決まっていることが読める**（要件 R2・R4・R6・R8）。
   * タブの置き場ではなく、頭の「v{N}」を押すと**作業パネルとして層で開く**。
   */
  it('決まったことが読めて、足せて、継承が分かる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't2');
      await page.waitForSelector('[data-open-base="t2"]', { timeout: 15_000 });
      await page.locator('[data-open-base="t2"]').click();

      await page.waitForSelector('[data-base-panel="t2"]', { timeout: 15_000 });
      // **継承した行と自分の行が両方見える**（要件 R4）。
      await page.waitForSelector('text=依頼: 煙を出す', { timeout: 15_000 });
      await page.waitForSelector('text=2本目で決めたこと', { timeout: 15_000 });
      // **残りを常に見せる**（要件 R8）。拒否されて初めて知る、を避ける。
      await page.waitForSelector('text=/\\/ 20,000 文字/', { timeout: 15_000 });
      await page.waitForSelector('text=/1 行は fork 元から/', { timeout: 15_000 });

      // 足せる。**足したものがその場に出る。**
      await page.getByPlaceholder('決まったことを1行で足す').fill('画面から足した決まりごと');
      await page.getByRole('button', { name: '足す' }).click();
      await page.waitForSelector('text=画面から足した決まりごと', { timeout: 15_000 });

      // **層で重なっている。** 会話パネルは帯に縮み、作業パネルが右に全幅で開く。
      const conv = await page.locator('[data-conversation-panel="t2"]').boundingBox();
      const work = await page.locator('[data-base-panel="t2"]').boundingBox();
      expect(conv).not.toBeNull();
      expect(work).not.toBeNull();
      expect(work!.x).toBeGreaterThan(conv!.x);
      expect(work!.width).toBeGreaterThan(conv!.width);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **訂正は無効化で行う**（PO裁定 2026-08-22）。上書きではなく、自分の行だけ
   * 無効化・有効化を切り替えられる——削除ではないので何度でも戻せる。
   *
   * あわせて：既定では無効化済みを隠す・チェックボックスで呼び出せる・
   * 検索で絞れる・21行以上でページングが出る（要件、PO裁定）。
   */
  it('決まったことを無効化・有効化でき、既定は隠れて検索・ページングできる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    // 専用の隔離ホスト。**21行**（PAGE_SIZE=20 を1行超える）用意して、
    // ページングが実際に出ることも一緒に測る。
    const dir = await mkdtemp(path.join(tmpdir(), 'banto-ui-invalidate-'));
    const invLog = new EventLog(dir);
    await invLog.append({ type: 'channel.created', channelId: 'c1', channelName: 'inv' });
    await invLog.append({ type: 'thread.created', threadId: 'b1', channelId: 'c1', title: '無効化試験' });
    for (let i = 1; i <= 21; i += 1) {
      await invLog.append({
        type: 'base.appended',
        threadId: 'b1',
        baseVersion: i,
        text: `決定 第${i}版`,
      });
    }

    const server = startServer({
      dataDir: dir,
      port: 0,
      modules: [],
      toolsByModule: new Map(),
      model: 'claude-haiku-4-5',
      webRoot: WEB_ROOT,
    });
    await new Promise((r) => server.once('listening', r));
    const invOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });

    try {
      await page.goto(invOrigin, { waitUntil: 'networkidle' });
      await openThread(page, 'b1');
      await page.locator('[data-open-base="b1"]').click();
      await page.waitForSelector('[data-base-panel="b1"]', { timeout: 15_000 });

      // **21行あるので2ページに分かれる。**
      await page.waitForSelector('text=/1 \\/ 2 ページ/', { timeout: 15_000 });
      await page.waitForSelector('text=決定 第1版', { timeout: 15_000 });

      // 第1版を無効化する。
      const row = page.locator('li', { hasText: '決定 第1版' });
      await row.locator('button[title="無効化する"]').click();

      // **既定では隠れる。** 版数の表示にも「無効化」が出る。
      await page.waitForSelector('text=/無効化 1 行/', { timeout: 15_000 });
      expect(await row.count()).toBe(0);

      // チェックボックスを入れると、取り消し線つきで出てくる。
      await page.getByText('無効化済みも表示').click();
      await page.waitForSelector('text=決定 第1版', { timeout: 15_000 });
      await page.waitForSelector('text=無効化済み', { timeout: 15_000 });

      // 有効化すると、取り消し線が外れて既定表示にも戻る。
      const restoredRow = page.locator('li', { hasText: '決定 第1版' });
      await restoredRow.locator('button[title="有効化する"]').click();
      await page.waitForSelector('text=/無効化 1 行/', { state: 'detached', timeout: 15_000 });

      // 検索で絞り込める。
      await page.getByPlaceholder('決まったことを検索').fill('第20版');
      await page.waitForSelector('text=決定 第20版', { timeout: 15_000 });
      expect(await page.locator('li', { hasText: '決定 第19版' }).count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **ゲートに当たったことが画面に出る**（要件 R8・決定4）。
   *
   * 断られたのに何も出ないと、「足したつもりで足さっていない」になる。
   * **黙って新しい会話へ切り替えない**——切り替えは人が決めること。
   */
  it('上限を超える追記は断られ、理由が画面に出る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    // 上限を小さくした別のホストを立てる。**同じ画面を、違うゲートで見る。**
    const tightDir = await mkdtemp(path.join(tmpdir(), 'banto-ui-r8-'));
    const tightLog = new EventLog(tightDir);
    await tightLog.append({ type: 'channel.created', channelId: 'c1', channelName: 'r8' });
    await tightLog.append({ type: 'thread.created', threadId: 'g1', channelId: 'c1', title: 'ゲート' });
    await tightLog.append({
      type: 'base.appended',
      threadId: 'g1',
      baseVersion: 1,
      text: 'あ'.repeat(95),
    });

    const tight = startServer({
      dataDir: tightDir,
      port: 0,
      modules: [],
      toolsByModule: new Map(),
      model: 'claude-haiku-4-5',
      webRoot: WEB_ROOT,
      baseLimit: 100,
    });
    await new Promise((r) => tight.once('listening', r));
    const tightOrigin = `http://127.0.0.1:${(tight.address() as AddressInfo).port}`;

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

    try {
      await page.goto(tightOrigin, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-open-base="g1"]', { timeout: 15_000 });
      await page.locator('[data-open-base="g1"]').click();
      // **残りが常に見えている**（拒否されて初めて存在を知る、を避ける）。
      await page.waitForSelector('text=/95 \\/ 100 文字/', { timeout: 15_000 });

      await page.getByPlaceholder('決まったことを1行で足す').fill('これは上限を超える');
      await page.getByRole('button', { name: '足す' }).click();

      // 断られた理由がその場に出る。**409 の中身をそのまま見せる。**
      await page.waitForSelector('text=/409/', { timeout: 15_000 });
      // **足さっていない。** 版も文字数も動いていない。
      await page.waitForSelector('text=/95 \\/ 100 文字/', { timeout: 15_000 });
      expect(await page.innerText('body')).not.toContain('これは上限を超える');
    } finally {
      await browser.close();
      tight.close();
    }
  }, 120_000);

  /**
   * **AI が指し、人が開くまでを通す**（要件 C14・決定19）。
   *
   * 指しただけでは開かない——**押して初めて中身を読みに行く。**
   * 開くのは「パネルを開くカード」で、押すと**作業パネルとして層で開く**。
   */
  it('AI が指したものを、押すと作業パネルで開ける', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-reference="banto://fs/file/note.md"]', { timeout: 15_000 });

      // **押すまでは中身を読みに行っていない。**
      expect(await page.locator('[data-work-panel]').count()).toBe(0);

      await page.locator('[data-reference="banto://fs/file/note.md"]').click();
      await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
      await page.waitForSelector('[data-resource-viewer]', { timeout: 15_000 });
      // fs モジュールが本当に読んだ中身が出る（seed で書いたファイル）。
      await page.waitForSelector('text=みかんと書いてある', { timeout: 15_000 });

      // **モジュールが持ち込んだ面で描かれている**（要件 C1・決定20）。
      // 汎用の面に落ちていたら、ここで落ちる。
      await page.waitForSelector('[data-module-view="fs/FileView"]', { timeout: 15_000 });
      await page.waitForSelector('text=/fs の面（in-page）/', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **作業パネルを閉じる3つの手（PO指摘 2026-08-22）**——閉じる(X)は左端、
   * ESC、会話側（ボタン以外）のクリック。フォーク側から開いたときは、
   * 幹が背表紙（`Spine`）に畳まれ、背表紙を押しても両方閉じる。
   */
  it('作業パネルは、X・ESC・会話側クリック・背表紙のどれでも閉じる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');

      // **閉じる(X)は左端**（PO指摘 2026-08-22）——読み直すより左に居る。
      await page.locator('[data-conversation-panel="t1"] [data-reference="banto://fs/file/note.md"]').click();
      await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
      const closeBox = await page.locator('[data-work-panel] [title="閉じる"]').boundingBox();
      const reloadBox = await page.locator('[data-work-panel] [title="読み直す"]').boundingBox();
      if (closeBox === null || reloadBox === null) throw new Error('ヘッダーのボタンが見つからない');
      expect(closeBox.x).toBeLessThan(reloadBox.x);

      // **ESC で閉じる。**
      await page.keyboard.press('Escape');
      await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 15_000 });

      // **幹から開いたときは背表紙が出ない**（隣に畳むフォークが無いので）。
      await page.locator('[data-conversation-panel="t1"] [data-reference="banto://fs/file/note.md"]').click();
      await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
      expect(await page.locator('[data-spine]').count()).toBe(0);

      // **会話側（見出しなど、ボタン以外）をクリックしても閉じる。**
      await page.locator('[data-conversation-panel="t1"] h1').click();
      await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 15_000 });

      // **フォークから開くと、幹が背表紙に畳まれる。**
      await openThread(page, 't2');
      await page.waitForSelector('[data-conversation-panel="t2"]', { timeout: 15_000 });
      await page.locator('[data-conversation-panel="t2"] [data-reference="banto://fs/file/note.md"]').click();
      await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
      await page.waitForSelector('[data-spine]', { timeout: 15_000 });
      // 幹（t1）はもう会話パネルとしては描かれていない——背表紙に畳まれている。
      expect(await page.locator('[data-conversation-panel="t1"]').count()).toBe(0);

      // **背表紙を押すと、作業パネルとフォークが両方閉じて幹だけに戻る。**
      await page.locator('[data-spine]').click();
      await page.waitForSelector('[data-work-panel]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-conversation-panel="t2"]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **フォークできる**（要件 A3）。
   *
   * イベントも継承の解きかたも在ったのに、**作る口が画面に無かった**
   * ——A3 は要件なので、機構だけ在って触れないのは満たしていないのと同じである。
   * フォークした先は**開いた元（幹）の横に並んで開く**（決定26）。
   * 頭の「戻る」を押すと、フォークが閉じて幹だけの表示に戻る。
   */
  it('フォークすると、決まったことを引き継いだ会話が幹の横に並ぶ', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-fork="t1"]', { timeout: 15_000 });
      await page.locator('[data-fork="t1"]').click();

      // **幹（t1）を消さず、横に並んで開く。**
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });
      const fork = page.locator('[data-conversation-panel]:not([data-conversation-panel="t1"])');
      await fork.waitFor({ timeout: 15_000 });
      // **素性が題の上に出る**（PO裁定 2026-08-22：スレッドとフォークを見分けられるように）。
      await page.waitForSelector('text=煙試験 から', { timeout: 15_000 });

      // **決まったことを引き継いでいる**（要件 R4）。継承分として出る。
      const id = await fork.getAttribute('data-conversation-panel');
      await page.locator(`[data-open-base="${id}"]`).click();
      await page.waitForSelector('text=/1 行は fork 元から/', { timeout: 15_000 });
      await page.waitForSelector('text=依頼: 煙を出す', { timeout: 15_000 });

      // **サイドバーの点も、フォークだけ縁取りを持つ**（見た目の見分け）。
      const dataFork = await page.locator(`[data-open-item="${id}"]`).getAttribute('data-fork-item');
      expect(dataFork).toBe('true');
      const dataThread = await page.locator('[data-open-item="t1"]').getAttribute('data-fork-item');
      expect(dataThread).toBe('false');

      // **戻ると、フォークが閉じて幹だけの表示に戻る。**
      await page.getByLabel('戻る').click();
      await fork.waitFor({ state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **フォークを畳んで閉じられる**（PO裁定 2026-08-22：フォークが増えすぎて分かりにくい）。
   *
   * 削除ではなく「開いているもの」から外れるだけ——マージすると親に戻り、
   * 畳んだフォークのサイドバーの点は消える。
   */
  it('フォークをマージすると、開いているものから消えて親に戻る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-fork="t1"]', { timeout: 15_000 });
      await page.locator('[data-fork="t1"]').click();

      const fork = page.locator('[data-conversation-panel]:not([data-conversation-panel="t1"])');
      await fork.waitFor({ timeout: 15_000 });
      const forkId = await fork.getAttribute('data-conversation-panel');
      if (forkId === null) throw new Error('フォークの id が取れない');

      // 畳む前は「開いているもの」に居る。
      await page.waitForSelector(`[data-open-item="${forkId}"]`, { timeout: 15_000 });

      await page.locator(`[data-merge="${forkId}"]`).click();

      // **フォークが閉じて、親（幹）だけの表示に戻る。**
      await fork.waitFor({ state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-conversation-panel="t1"]', { timeout: 15_000 });
      // **削除ではないが、開いているものからは外れる。**
      expect(await page.locator(`[data-open-item="${forkId}"]`).count()).toBe(0);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **第三者と同じ立場のモジュールが、画面を持ち込む**（要件 C6・決定20）。
   *
   * `hello-py` は subprocess で TypeScript でもないので、規則上 `in-page` を
   * 名乗れない。**閉じ込めた iframe の中で走り、それでも中身を描ける**
   * ——ここが C6（第三者が中核無変更で画面を持てる）の実物である。
   */
  it('sandboxed な面が、閉じ込められたまま描かれる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-reference="banto://hello-py/greeting/banto"]', {
        timeout: 15_000,
      });
      await page.locator('[data-reference="banto://hello-py/greeting/banto"]').click();
      await page.waitForSelector('[data-sandboxed-view="hello-py"]', { timeout: 15_000 });

      const frame = page.frameLocator('[data-sandboxed-view="hello-py"] iframe');
      // Python が返した中身が、モジュールの面で描かれている。
      await frame.locator('text=Hello, banto!').waitFor({ timeout: 15_000 });
      await frame.locator('text=/hello-py の面（sandboxed）/').waitFor({ timeout: 15_000 });

      // **閉じ込めが効いていることを、中から見せる**（決定20）。
      // `allow-same-origin` を渡していないので、cookie は届かない。
      await frame.locator('text=/cookie は 見えない/').waitFor({ timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **台帳と、外したときの影響**（要件 C1・C8c・C12・C4）。設定は被さるダイアログ。
   *
   * C12 の中身は「押す前に分かる」ことなので、**画面に出ているか**で測る。
   */
  it('設定に台帳が出て、外したら何が壊れるかが読める', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '設定' }).click();

      await page.waitForSelector('[data-module-row="fs"]', { timeout: 15_000 });
      await page.waitForSelector('[data-module-row="hello-py"]', { timeout: 15_000 });

      // **境界を常時見せる**（要件 C8c）。折りたたまない。
      const py = page.locator('[data-module-row="hello-py"]');
      await py.locator('text=subprocess').waitFor({ timeout: 15_000 });
      await py.locator('text=/画面 sandboxed/').waitFor({ timeout: 15_000 });

      // **外したら何が壊れるか**（要件 C12）。押す前に読める。
      await page.locator('[data-impact="fs"]').waitFor({ timeout: 15_000 });
      expect(await page.locator('[data-impact="fs"]').innerText()).toContain('無効化すると');

      // **モジュール自身の設定の区画**（要件 C4）。押すとダイアログが閉じ、作業パネルで開く。
      await page.locator('[data-settings-of="fs"]').click();
      await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-work-panel]', { timeout: 15_000 });
      await page.waitForSelector('text=/fs モジュールの設定/', { timeout: 15_000 });
      await page.waitForSelector('text=/作業範囲の根/', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **履歴（要件 A8）。** 終わったスレッドは消えない、読み返せる。
   */
  it('履歴から、終わったスレッドを開ける', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '履歴' }).click();
      await page.waitForSelector('[data-history-thread="t2"]', { timeout: 15_000 });

      await page.locator('[data-history-thread="t2"]').click();
      await page.waitForSelector('[role=dialog]', { state: 'detached', timeout: 15_000 });
      await page.waitForSelector('[data-conversation-panel="t2"]', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **相手の言葉が Markdown として描かれる**（要件 E4）。
   *
   * ここまでは素の文字列で出していたので、**見出しも箇条も表も記号のまま**並んでいた。
   * 「`##` という字が見えない」ではなく、**要素になっているか**で測る
   * ——字面が消えるだけなら、消し方を間違えても気づけない。
   */
  it('相手の言葉が Markdown の要素になる（見出し・箇条・表・コード）', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('.markdown h2', { timeout: 15_000 });

      const md = page.locator('.markdown').last();
      expect(await md.locator('h2').innerText()).toContain('直したところ');
      // **番号つきの箇条**。印を消してしまうと、手順が「短い段落の列」になる。
      expect(await md.locator('ol > li').count()).toBe(2);
      expect(
        await md.locator('ol').evaluate((el) => getComputedStyle(el).listStyleType),
      ).toBe('decimal');
      expect(await md.locator('table th').count()).toBe(2);

      // コードに色が付いている（要件 E4）。shiki が描くと span が並ぶ。
      await page.waitForSelector('.markdown pre.shiki', { timeout: 15_000 });
      expect(await md.locator('pre.shiki span').count()).toBeGreaterThan(1);

      // **写せる。** 押す口が在ることまで見る（色だけ付いても写せないと使えない）。
      expect(await page.getByLabel('コードをコピー').count()).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **誰の言葉かが分かる**（要件 E6）。
   *
   * いまの意匠は書体を1つに統一し、**印と置き方**で声を分ける
   * （前回の「書体で分ける」からの変更・決定22）。
   */
  it('相手の言葉には印が付き、人の言葉は右寄せの吹き出しになる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('[data-from="banto"]', { timeout: 15_000 });

      // 印が在る（器を持たせない代わりに、誰の言葉かはこれが言う）。
      expect(await page.locator('[data-from="banto"]').first().innerText()).toContain('番');

      // 人の言葉は右寄せの吹き出し（印は付かない）。
      const mine = page.locator('text=ユーザーの発言').first();
      const mineBox = await mine.boundingBox();
      const bantoBox = await page.locator('[data-from="banto"]').first().boundingBox();
      expect(mineBox).not.toBeNull();
      expect(bantoBox).not.toBeNull();
      // 人の言葉のほうが右にある（右寄せの吹き出し）。
      expect(mineBox!.x).toBeGreaterThan(bantoBox!.x);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **会話は末尾に追従する**（要件 E5）。
   *
   * 開いた瞬間に**いちばん新しい発言が見えている**ことを測る。
   * 追従が無いと、開くたびに自分でいちばん下まで運ぶことになる。
   *
   * **限界**：「遡って読んでいる間は飛ばない」の側は、ここでは測れていない
   * ——途中でイベントを差し込む口が画面の外に無いため。仕掛け（`use-stick-to-bottom`）
   * がその判定を持っている、というところまでしか言えない（規則1：測っていないことは言わない）。
   */
  it('開いた時点で、いちばん新しい発言が見えている', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    // **わざと低い窓**にして、会話が確実に溢れるようにする。
    const page = await browser.newPage({ viewport: { width: 1280, height: 600 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('.markdown pre.shiki', { timeout: 15_000 });
      await page.waitForTimeout(600);

      // 溢れていること自体を先に確かめる（溢れていなければ、この試験は何も言っていない）。
      //
      // **仕掛けのクラス名に頼らない。** 巻ける祖先を上へ辿って自分で見つける
      // ——ライブラリが名前を変えても、この試験が測っているものは変わらない。
      const overflow = await page.evaluate(() => {
        let el: HTMLElement | null = document.querySelector<HTMLElement>('.markdown');
        while (el !== null) {
          const style = getComputedStyle(el);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight
          ) {
            return {
              scrollTop: el.scrollTop,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
            };
          }
          el = el.parentElement;
        }
        return null;
      });
      expect(overflow).not.toBeNull();
      expect(overflow!.scrollHeight).toBeGreaterThan(overflow!.clientHeight);
      // 下端に居る（数 px の誤差は許す）。
      expect(overflow!.scrollHeight - overflow!.clientHeight - overflow!.scrollTop).toBeLessThan(8);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **変換確定の Enter で送らない**（要件 E8）。
   *
   * ここは不具合に近かった——**日本語を打つと、変換を確定するたびに送信されていた。**
   * 「送信が始まったか」で測る（`/api/prompt` を叩いたか）。
   */
  it('変換中の Enter では送らない。確定後の Enter では送る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const prompts: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/prompt')) prompts.push(r.url());
    });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      const box = page.getByPlaceholder('メッセージを送る').first();
      await box.fill('にほんご');

      // **変換中の Enter**（IME が確定するときの押下）。
      await box.evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
        ),
      );
      await page.waitForTimeout(400);
      expect(prompts).toEqual([]);
      // **文面も消えていない**（消えていたら、送っていなくても打ち直しになる）。
      expect(await box.inputValue()).toBe('にほんご');

      // 確定後の Enter では送る。
      await box.evaluate((el) =>
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: false }),
        ),
      );
      await expect.poll(() => prompts.length, { timeout: 15_000 }).toBe(1);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **明暗を切り替えられ、選択が残る**（要件 E7）。
   *
   * 開き直しても暗いままであること（＝覚えていること）まで測る。
   * 覚えないなら、暗いほうを選んでいる人は毎回選び直すことになる。
   */
  it('明暗を切り替えられ、開き直しても残る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-sidebar]', { timeout: 15_000 });

      const themeOf = () => page.evaluate(() => document.documentElement.dataset['theme']);
      const before = await themeOf();
      const bgBefore = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

      const toggle = page.getByRole('button', { name: /明るくする|暗くする/ });
      await toggle.click();
      const after = await themeOf();
      expect(after).not.toBe(before);
      // **属性だけでなく、実際に地の色が変わっている。**
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
        bgBefore,
      );

      await page.reload({ waitUntil: 'networkidle' });
      expect(await themeOf()).toBe(after);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **字の段を数える**（要件 E9）。
   *
   * これは好みの話ではない。前の実装は自分の失敗を
   * **「字 17 段・枠 107 箇所・色 39 種」**と記録しており、
   * 「製品に見えない」の正体がそれだった。**段の数は数えられる。**
   * 数えられるものは、目視ではなく試験で守る。
   *
   * いまの意匠見本（`ideal.css`）は**7段**（xs/sm/md/lg/xl/2xl/3xl）を持つ
   * ——これが決めた段数で、6ではない（決定22で採用した意匠見本の実際の段数）。
   */
  it('画面に出ている字の段が、決めた7段を超えない', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, 't1');
      await page.waitForSelector('.markdown h2', { timeout: 15_000 });

      const sizes = await page.evaluate(() => {
        const found = new Map<string, number>();
        for (const el of document.querySelectorAll<HTMLElement>('body *')) {
          // 文字が実際に出ているものだけ数える（空の器の段は誰にも見えない）。
          const text = Array.from(el.childNodes).some(
            (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
          );
          if (!text || el.offsetParent === null) continue;
          const size = getComputedStyle(el).fontSize;
          found.set(size, (found.get(size) ?? 0) + 1);
        }
        return [...found.entries()].sort((a, b) => b[1] - a[1]);
      });

      // **数値を出す**（完了条件は「計測が走り、数値を返す」）。
      console.log('字の段:', sizes.map(([s, n]) => `${s}×${n}`).join(' '));
      expect(sizes.length).toBeLessThanOrEqual(7);
    } finally {
      await browser.close();
    }
  }, 120_000);

  it('無い静的ファイルは 404。index.html にすり替えない（規則2）', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');
    const res = await fetch(`${origin}/assets/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

/**
 * サイドバーの「開いているもの」の点で、会話を開く（要件 A2）。
 * **選ぶのではなく開く**——列やタブではなく、点を押すと開く。
 */
async function openThread(page: import('playwright').Page, threadId: string): Promise<void> {
  await page.locator(`[data-open-item="${threadId}"]`).click();
  await page.waitForTimeout(200);
}
