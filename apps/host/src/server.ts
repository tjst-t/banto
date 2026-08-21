/**
 * Banto Core の口（要件 E1）。
 *
 * **WS ではなく SSE を使う。** 要るのはサーバ→クライアントの一方向ストリームだけで、
 * クライアント→サーバは普通の POST で足りる。SSE は Node の標準ライブラリで書けるが、
 * WS は `ws` の追加が要る（規則10：依存を足す前に標準ライブラリを見る）。
 * ADR-0001 決定11 は「HTTP + WS」と書いているので、ここは意図的な差分である（規則8）。
 *
 * **観測はここに置かない。** 数値は @banto/observer が外から畳む（決定8）。
 * この口が返すのはイベントログの畳み込みだけで、写しは持たない（規則3）。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { passes } from './gate.js';

import {
  DEFAULT_BASE_LIMIT_CHARACTERS,
  EventLog,
  appendBase,
  baseCharacters,
  effectiveBase,
  fold,
  pendingQueue,
  type NewEvent,
} from '@banto/core';
import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';
import { foldRuns, type Factory } from '@banto/factory';
import { LedgerCore } from '@banto/module-ledger';

export interface ServerOptions {
  readonly dataDir: string;
  readonly port: number;
  /**
   * bind するアドレス。既定は 127.0.0.1。
   *
   * **外に出すときは前段（Caddy 等）に認証を置き、ここは localhost のままにする。**
   * この口は認証を持たず、叩けば Claude の枠を使い、fs のツールでファイルを触れる。
   * 全インターフェースに出すと、前段の認証を迂回されて直接叩ける。
   */
  readonly host?: string;
  /** そのスレッドに紐づけるモジュール。Phase 1.5 では起動時に固定。 */
  readonly modules: readonly McpServerSpec[];
  /** モジュール id → ツール名。許可の一覧を組み立てるのに使う（要件 D4）。 */
  readonly toolsByModule: ReadonlyMap<string, readonly string[]>;
  readonly model: string;
  /**
   * 合言葉。**指定すると門が立つ**（gate.ts）。
   * 前段に認証があるなら省いてよいが、外へ出すのに省いてはいけない。
   */
  readonly secret?: string;
  /** 画面の静的ファイルの置き場。省くと /api だけを出す。 */
  readonly webRoot?: string;
  /**
   * base の上限（文字数）。超えたら**追記を拒否する**（要件 R8・決定4）。
   * 省くと `DEFAULT_BASE_LIMIT_CHARACTERS`。**無効にする手段は置かない**——
   * 切れるゲートは、いつか切られたまま忘れられる（C8c と同じ理由）。
   */
  readonly baseLimit?: number;
  /**
   * Factory（要件 B）。**渡さなければ `/api/runs` は 501 を返す**——
   * 「エンドポイントは在るが黙って何もしない」を作らない（規則2）。
   *
   * **自動では進めない。** `advanceAll` は実際に Claude の枠を使うので、
   * 明示的に `POST /api/runs/advance` を叩いたときだけ動く。時計で回すと、
   * 画面を閉じている間に費用が増えることになる。
   */
  readonly factory?: Factory;
}

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webmanifest', 'application/manifest+json'],
]);

/**
 * 画面の静的ファイルを返す。
 *
 * **root の外へは出さない。** fs モジュールと同じ理由で、正規化してから確かめる。
 *
 * **無いファイルを index.html で置き換えない**（規則2）。以前はどんな経路でも
 * index.html に落としていて、**`/assets/index-OLD.js` を頼むと HTML が
 * `text/javascript` として返っていた**——ブラウザは HTML を JS として実行しようとし、
 * 何が起きているのか画面からは分からない。**黙って別の経路へ落ちる**の典型だった。
 *
 * 落とすのは**拡張子を持たない経路だけ**にする。単一ページなので、
 * `/threads/xxx` のような画面の経路はブラウザ側で解決される。
 */
async function serveStatic(webRoot: string, pathname: string, res: ServerResponse): Promise<void> {
  const root = path.resolve(webRoot);
  const wanted = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (path.relative(root, wanted).startsWith('..')) {
    json(res, 404, { error: `範囲の外: ${pathname}` });
    return;
  }

  const body = await readFile(wanted).catch(() => null);
  if (body !== null) {
    res.writeHead(200, {
      'content-type': CONTENT_TYPES.get(path.extname(wanted)) ?? 'application/octet-stream',
    });
    res.end(body);
    return;
  }

  // ファイルらしい経路が無いなら、それは 404 である。**中身をすり替えない。**
  if (path.extname(pathname) !== '') {
    json(res, 404, { error: `見つからない: ${pathname}` });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(await readFile(path.join(root, 'index.html')));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** いまの状態。**畳んで作る。保存された「現在」は無い**（規則3）。 */
async function currentState(dataDir: string, baseLimit: number): Promise<unknown> {
  const events = await new EventLog(dataDir).read();
  const state = fold(events);
  return {
    channels: [...state.channels.values()],
    threads: [...state.threads.values()].map((t) => ({
      id: t.id,
      channelId: t.channelId,
      title: t.title,
      status: t.status,
      turnCount: t.turnCount,
      baseVersion: t.baseVersion,
      forkedFrom: t.forkedFrom,
      // ゲートの残りを**常に見せる**（要件 R8）。拒否されて初めて存在を知る、を避ける。
      baseCharacters: baseCharacters(state, t.id),
      baseLimit,
    })),
    // Run も畳んで作る。**保存された「いまの段」は無い**（仕様 §5.3）。
    runs: foldRuns(events).map((r) => ({
      runId: r.runId,
      threadId: r.threadId,
      branch: r.branch,
      request: r.request,
      failed: r.failed,
      testedCommits: [...r.tested.entries()].map(([commit, passed]) => ({ commit, passed })),
    })),
    queue: pendingQueue(state),
  };
}

export function startServer(options: ServerOptions): ReturnType<typeof createServer> {
  const log = new EventLog(options.dataDir);
  const allowed = allowedToolNames(options.modules, options.toolsByModule);
  const baseLimit = options.baseLimit ?? DEFAULT_BASE_LIMIT_CHARACTERS;

  const server = createServer((req, res) => {
    void handle(req, res).catch((cause: unknown) => {
      // 握りつぶさない（規則2）。理由を返してから閉じる。
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (!res.headersSent) json(res, 500, { error: detail });
      else res.end();
    });
  });

  /** その名前のチャンネルを1つに保つ。**二重に作らない。** */
  async function ensureChannel(channelName: string): Promise<string> {
    const found = [...fold(await log.read()).channels.values()].find(
      (c) => c.name === channelName,
    );
    if (found) return found.id;
    const channelId = randomUUID();
    await log.append({ type: 'channel.created', channelId, channelName });
    return channelId;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 門は何よりも先。ここを通らないものは /api にも静的にも触れない。
    if (options.secret !== undefined && !passes(req, res, options.secret)) return;

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, await currentState(options.dataDir, baseLimit));
      return;
    }

    // base への追記（要件 R2・R6）。**ゲートを通る唯一の入口**（要件 R8・決定4）。
    // 閾値を超えたら 409 で断り、選択肢としての R5 を判断待ちに立てる。
    // **ここで自動的に新しい会話へ切り替えない**——切り替えは規則2 に反する。
    if (req.method === 'POST' && url.pathname === '/api/base') {
      const body = (await readBody(req)) as { threadId?: string; text?: string };
      if (typeof body.threadId !== 'string' || typeof body.text !== 'string') {
        json(res, 400, { error: 'threadId と text が要る' });
        return;
      }
      const state = fold(await log.read());
      if (!state.threads.has(body.threadId)) {
        json(res, 404, { error: `知らないスレッド: ${body.threadId}` });
        return;
      }
      const gate = await appendBase(log, state, body.threadId, body.text, baseLimit);
      json(res, gate.ok ? 200 : 409, gate);
      return;
    }

    // 依頼を1件投げる（要件 B1・B2）。**投げるだけ。進めない**（要件 B4：人を待たせない）。
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      if (options.factory === undefined) {
        json(res, 501, { error: 'この banto に Factory が紐づいていない' });
        return;
      }
      const body = (await readBody(req)) as { request?: string; channelName?: string; branch?: string };
      if (typeof body.request !== 'string' || body.request.trim() === '') {
        json(res, 400, { error: 'request が要る' });
        return;
      }
      const channelId = await ensureChannel(body.channelName ?? 'banto-v3');
      const runId = randomUUID();
      // ブランチ名は Run から決まる。**覚えないので、再開しても同じ名前に着く。**
      const branch = body.branch ?? `factory/${runId.slice(0, 8)}`;
      await options.factory.request({
        runId,
        channelId,
        threadId: randomUUID(),
        branch,
        request: body.request,
      });
      json(res, 200, { runId, branch });
      return;
    }

    // 進める。**明示的に叩かれたときだけ**（Claude の枠を使うため）。
    if (req.method === 'POST' && url.pathname === '/api/runs/advance') {
      if (options.factory === undefined) {
        json(res, 501, { error: 'この banto に Factory が紐づいていない' });
        return;
      }
      await options.factory.advanceAll();
      json(res, 200, await currentState(options.dataDir, baseLimit));
      return;
    }

    /**
     * 判断に答える（要件 A6）。**選ぶことも、自由に書くこともできる。**
     *
     * 中身は ledger の core をそのまま使う——画面用に別の判定を書くと、
     * 「知らない選択肢を断る」が口ごとにずれる（規則3）。
     */
    if (req.method === 'POST' && url.pathname === '/api/decisions/resolve') {
      const body = (await readBody(req)) as {
        decisionId?: string;
        answer?: string;
        optionId?: string;
      };
      if (typeof body.decisionId !== 'string' || typeof body.answer !== 'string') {
        json(res, 400, { error: 'decisionId と answer が要る' });
        return;
      }
      try {
        const result = await new LedgerCore(log).resolveDecision(
          body.decisionId,
          body.answer,
          body.optionId,
        );
        json(res, 200, { ...result, state: await currentState(options.dataDir, baseLimit) });
      } catch (cause) {
        // 握りつぶさない（規則2）。断った理由をそのまま返す。
        json(res, 409, { error: cause instanceof Error ? cause.message : String(cause) });
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/threads') {
      const body = (await readBody(req)) as { channelName?: string; title?: string };
      const state = fold(await log.read());
      const channelName = body.channelName ?? 'banto-v3';
      let channelId = [...state.channels.values()].find((c) => c.name === channelName)?.id;
      if (channelId === undefined) {
        channelId = randomUUID();
        await log.append({ type: 'channel.created', channelId, channelName });
      }
      const threadId = randomUUID();
      await log.append({
        type: 'thread.created',
        threadId,
        channelId,
        title: body.title ?? '新しい会話',
      });
      json(res, 200, { threadId, channelId });
      return;
    }

    // 会話を1ターン進め、**流れてくるイベントをそのまま SSE で返す**。
    // ログに積むのと同じものを流す——画面用に別の形を作らない（規則3）。
    if (req.method === 'POST' && url.pathname === '/api/prompt') {
      const body = (await readBody(req)) as { threadId?: string; text?: string };
      if (typeof body.threadId !== 'string' || typeof body.text !== 'string') {
        json(res, 400, { error: 'threadId と text が要る' });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (event: unknown): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const queryId = randomUUID();
      // **毎回畳んで決める。写しを持たない**（規則3）。
      // セッション識別子があれば続きから、無ければ base から新しく始まる。
      const before = fold(await log.read());
      const thread = before.threads.get(body.threadId);
      const baseText = effectiveBase(before, body.threadId).join('\n');

      // **人の発言もログに残す**（要件 A8）。残さないと、画面を開き直した瞬間に
      // 会話の片側が消える。Runner が記録するのは相手の分だけである。
      send(
        await log.append({
          type: 'message.recorded',
          threadId: body.threadId,
          queryId,
          role: 'user',
          text: body.text,
        }),
      );

      await log.append({ type: 'thread.status', threadId: body.threadId, status: 'working' });
      let failed = false;

      try {
        for await (const event of new AgentSdkRunner().query({
          threadId: body.threadId,
          queryId,
          // base はシステムプロンプトに入る。**走行中は変えられない**（決定6）ので、
          // 追記があった場合に効くのは次のスレッド／次の fork から（要件 R2・R4）。
          systemPrompt:
            'You are banto. Answer in the user’s language. Be concise.' +
            (baseText === '' ? '' : `\n\n# この会話で決まっていること\n${baseText}`),
          mcpServers: options.modules,
          skills: [],
          model: options.model,
          allowedTools: allowed,
          maxTurns: 20,
          prompt: body.text,
          ...(thread?.sessionHandle == null ? {} : { resumeFrom: thread.sessionHandle }),
          startTurnIndex: thread?.turnCount ?? 0,
        })) {
          const stamped = await log.append(event as NewEvent);
          send(stamped);
          if (event.type === 'query.step' && event.status === 'failed') failed = true;
        }
      } catch (cause) {
        failed = true;
        send({ type: 'error', detail: cause instanceof Error ? cause.message : String(cause) });
      }

      const status = await log.append({
        type: 'thread.status',
        threadId: body.threadId,
        status: failed ? 'blocked' : 'done',
      });
      send(status);
      res.end();
      return;
    }

    // 会話を読み返す（要件 A8）。**イベントログを畳まずそのまま返す**
    // ——画面用に別の形を作らない（規則3）。並べ替えも解釈も画面側でやる。
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const threadId = url.searchParams.get('threadId');
      const all = await log.read();
      if (threadId === null) {
        json(res, 200, { events: all });
        return;
      }

      /**
       * **Run のイベントは `threadId` を持たない。** `runId` から導けるので
       * 持たせていない（規則3）。だが**導けるものを絞り込みで落とすと、
       * Factory の失敗が会話に一度も出ない**——要件 B6「何が起きたかを後から追える」が
       * そこで切れる。**保存する代わりに、ここで解く。**
       */
      const threadOfRun = new Map<string, string>();
      for (const e of all) {
        if (e.type === 'run.requested') threadOfRun.set(e.runId, e.threadId);
      }
      const belongs = (e: (typeof all)[number]): boolean => {
        if ('threadId' in e) return e.threadId === threadId;
        if ('runId' in e) return threadOfRun.get(e.runId) === threadId;
        return false;
      };

      json(res, 200, { events: all.filter(belongs) });
      return;
    }

    if (req.method === 'GET' && options.webRoot !== undefined && !url.pathname.startsWith('/api/')) {
      await serveStatic(options.webRoot, url.pathname, res);
      return;
    }

    json(res, 404, { error: `見つからない: ${req.method ?? '?'} ${url.pathname}` });
  }

  server.listen(options.port, options.host ?? '127.0.0.1');
  return server;
}
