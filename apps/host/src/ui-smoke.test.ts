/**
 * 画面が本当に描けているかを、**本物のブラウザで**測る（要件 E1）。
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
 * ## 何を測るか
 *
 * **見た目の良し悪しは測らない。** 測るのは「壊れていないこと」だけ：
 * コンソールのエラーが 0、失敗した通信が 0、そして
 * **知らないイベントに落ちた印（「未対応のイベント」）が 0**。
 */

import { access, mkdtemp, writeFile } from 'node:fs/promises';
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
  await log.append({
    type: 'decision.requested',
    decisionId: 'd-free',
    source: 'thread',
    threadId: 't1',
    question: '選択肢の無い判断',
  });
  // **2本目**。1本目から fork しているので、決まったことを継承している（要件 R4）。
  await log.append({
    type: 'thread.forked',
    threadId: 't2',
    channelId: 'c1',
    title: '2本目',
    from: { threadId: 't1', baseVersion: 1 },
    mode: 'base',
  });
  await log.append({ type: 'base.appended', threadId: 't2', baseVersion: 2, text: '2本目で決めたこと' });
  // **AI が「これを見て」と指した**（要件 C14・決定19）。中身は持たない。
  await log.append({
    type: 'reference.recorded',
    threadId: 't1',
    uri: 'banto://fs/file/note.md',
    name: 'note.md',
    mimeType: 'text/markdown',
    note: '書き足しました',
  });
  await log.append({ type: 'thread.status', threadId: 't1', status: 'done' });

  // **fs を本物で載せる。** 指された URI を実際に読ませないと、
  // 「指しは出るが開けない」を見逃す（要件 C14）。
  const fsRoot = await mkdtemp(path.join(tmpdir(), 'banto-ui-fs-'));
  await writeFile(path.join(fsRoot, 'note.md'), 'みかんと書いてある\n', 'utf8');
  process.env['BANTO_FS_ROOT'] = fsRoot;
  const { fsModule } = await import('@banto/module-fs');

  server = startServer({
    dataDir,
    port: 0,
    modules: [{ name: fsModule.manifest.id, kind: 'in-process', server: fsModule.createServer() }],
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
      // 既定で開くのは直近の会話。**1本目を見たいので明示的に開く。**
      await openThread(page, '煙試験');
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
   * **選んだ答えが、実際に会話に着くところまで測る**（要件 A6）。
   *
   * 「ボタンが描けている」では足りない——押した先が繋がっていない画面は、
   * 見た目には壊れていないので、人が押してみるまで分からない。
   */
  it('選択肢を押すと、答えが会話に返る', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, '煙試験');
      // 選択肢の無い判断でも、自由に書く欄は出ている。
      await page.waitForSelector('text=選択肢の無い判断', { timeout: 15_000 });
      expect(await page.locator('input[placeholder="答えを書く"]').count()).toBe(1);

      const approve = page.getByRole('button', { name: '取り込む', exact: true });
      await approve.click();

      // 判断待ちの列から消える（答えが出たものは残らない）。
      // **問いの文面では見ない**——会話にも同じ文が残るので、消えたことにならない。
      await approve.waitFor({ state: 'detached', timeout: 15_000 });
      // **会話に返っている。** 押した先が繋がっていることの、唯一の証拠。
      await page.waitForSelector('text=取り込む（approve）', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **並べられることを、並べて確かめる**（要件 A2・A3）。
   * 「会話を開く」が1本ずつの切り替えに戻っていたら、ここで落ちる。
   */
  it('会話を2本開くと、横に並ぶ', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForSelector('text=2本目', { timeout: 15_000 });

      // 1本開いている状態から、もう1本開く。
      expect(await page.locator('[data-thread-column]').count()).toBe(1);
      await openThread(page, '煙試験');

      // **2列になり、左右に並ぶ。**
      await expect
        .poll(async () => page.locator('[data-thread-column]').count(), { timeout: 15_000 })
        .toBe(2);
      const columns = page.locator('[data-thread-column]');
      const boxes = await Promise.all(
        (await columns.all()).map(async (c) => (await c.boundingBox()) ?? { x: 0, y: 0 }),
      );
      expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
      expect(boxes[1]!.y).toBe(boxes[0]!.y);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **狭い画面では横に並べない**（要件 E2）。
   * 列の数を inline style で書くと画面幅に関わらず効いて、3列に潰れる。
   */
  it('狭い画面では、2本開いても横に潰れない', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await page.waitForSelector('text=2本目', { timeout: 15_000 });
      await openThread(page, '煙試験');
      await expect
        .poll(async () => page.locator('[data-thread-column]').count(), { timeout: 15_000 })
        .toBe(2);

      // **縦に並ぶ**（左右ではない）。横に潰れていたら left がずれる。
      const columns = page.locator('[data-thread-column]');
      const boxes = await Promise.all(
        (await columns.all()).map(async (c) => (await c.boundingBox()) ?? { x: 0, y: 0, width: 0 }),
      );
      expect(boxes).toHaveLength(2);
      expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
      expect(boxes[1]!.x).toBe(boxes[0]!.x);
      // 幅は画面いっぱい（3列に潰れていない）。
      for (const b of boxes) expect(b.width).toBeGreaterThan(300);
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **いま決まっていることが読める**（要件 R2・R4・R6・R8）。
   * ここまで base は年表の点でしか見えず、**読む手段が画面に無かった。**
   */
  it('決まったことが読めて、足せて、継承が分かる', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      // 既定で開くのは直近＝fork した2本目。**継承した行と自分の行が両方見える。**
      await page.waitForSelector('text=2本目', { timeout: 15_000 });
      await page.getByRole('tab', { name: /決まったこと/ }).first().click();
      await page.waitForSelector('text=依頼: 煙を出す', { timeout: 15_000 });
      await page.waitForSelector('text=2本目で決めたこと', { timeout: 15_000 });
      // **残りを常に見せる**（要件 R8）。拒否されて初めて知る、を避ける。
      await page.waitForSelector('text=/\\/ 20,000 文字/', { timeout: 15_000 });
      await page.waitForSelector('text=/1 行は fork 元から/', { timeout: 15_000 });

      // 足せる。**足したものがその場に出る。**
      await page.getByPlaceholder('決まったことを1行で足す').fill('画面から足した決まりごと');
      await page.getByRole('button', { name: '足す' }).click();
      await page.waitForSelector('text=画面から足した決まりごと', { timeout: 15_000 });
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
      await page.getByRole('tab', { name: /決まったこと/ }).click();
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
   * 中身は指した時点の写しではなく、そのとき持ち主に聞いたものである（規則3）。
   */
  it('AI が指したものを、押すと開ける', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, '煙試験');
      await page.waitForSelector('[data-reference]', { timeout: 15_000 });

      // **押すまでは中身を読みに行っていない。**
      expect(await page.locator('[data-resource-viewer]').count()).toBe(0);

      await page.locator('[data-reference]').click();
      await page.waitForSelector('[data-resource-viewer]', { timeout: 15_000 });
      // fs モジュールが本当に読んだ中身が出る（seed で書いたファイル）。
      await page.waitForSelector('text=みかんと書いてある', { timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);

  /**
   * **画面から分岐できる**（要件 A3）。
   *
   * イベントも継承の解きかたも在ったのに、**作る口が画面に無かった**
   * ——A3 は要件なので、機構だけ在って触れないのは満たしていないのと同じである。
   */
  it('分岐すると、決まったことを引き継いだ枝が横に並ぶ', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');

    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    try {
      await page.goto(origin, { waitUntil: 'networkidle' });
      await openThread(page, '煙試験');
      await expect
        .poll(async () => page.locator('[data-thread-column]').count(), { timeout: 15_000 })
        .toBe(2);

      // 「煙試験」（base v1）から分岐する。
      await page.locator('[data-fork]').first().click();

      // **枝が開いて並ぶ**（切って隠すのでは、見比べられない）。
      await expect
        .poll(async () => page.locator('[data-thread-column]').count(), { timeout: 15_000 })
        .toBe(3);
      await page.waitForSelector('text=/煙試験 から分岐/', { timeout: 15_000 });

      // **決まったことを引き継いでいる**（要件 R4）。継承分として出る。
      await page.getByRole('tab', { name: /決まったこと/ }).first().click();
      await page.waitForSelector('text=/1 行は fork 元から/', { timeout: 15_000 });
      await page.waitForSelector('text=依頼: 煙を出す', { timeout: 15_000 });
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

/** 会話を1本開く。**選ぶのではなく開く**ので、開いたものは並ぶ（要件 A2）。 */
async function openThread(page: import('playwright').Page, title: string): Promise<void> {
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(title) }).click();
  await page.waitForTimeout(200);
}
