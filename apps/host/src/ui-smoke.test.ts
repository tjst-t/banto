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

import { access, mkdtemp } from 'node:fs/promises';
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
  await log.append({ type: 'thread.status', threadId: 't1', status: 'done' });

  server = startServer({
    dataDir,
    port: 0,
    modules: [],
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

  it('無い静的ファイルは 404。index.html にすり替えない（規則2）', async () => {
    if (!built) throw new Error('画面がビルドされていないので測れない');
    const res = await fetch(`${origin}/assets/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
