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
 * 画面の静的ファイルを返す。見つからなければ index.html
 * ——単一ページなので、経路の解決はブラウザ側でやる。
 *
 * **root の外へは出さない。** fs モジュールと同じ理由で、正規化してから確かめる。
 */
async function serveStatic(webRoot: string, pathname: string, res: ServerResponse): Promise<void> {
  const root = path.resolve(webRoot);
  const wanted = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  const inside = !path.relative(root, wanted).startsWith('..');
  const target = inside ? wanted : path.join(root, 'index.html');

  const body = await readFile(target).catch(() => readFile(path.join(root, 'index.html')));
  res.writeHead(200, {
    'content-type': CONTENT_TYPES.get(path.extname(target)) ?? 'application/octet-stream',
  });
  res.end(body);
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
  const state = fold(await new EventLog(dataDir).read());
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

    if (req.method === 'POST' && url.pathname === '/api/threads') {
      const body = (await readBody(req)) as { channelName?: string; title?: string };
      const state = fold(await log.read());
      const channelName = body.channelName ?? 'banto-v3';
      let channelId = [...state.channels.values()].find((c) => c.name === channelName)?.id;
      if (channelId === undefined) {
        channelId = randomUUID();
        await log.append({ type: 'channel.created', channelId, name: channelName });
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

      const runId = randomUUID();
      // **毎回畳んで決める。写しを持たない**（規則3）。
      // セッション識別子があれば続きから、無ければ base から新しく始まる。
      const before = fold(await log.read());
      const thread = before.threads.get(body.threadId);
      const baseText = effectiveBase(before, body.threadId).join('\n');

      await log.append({ type: 'thread.status', threadId: body.threadId, status: 'working' });
      let failed = false;

      try {
        for await (const event of new AgentSdkRunner().run({
          threadId: body.threadId,
          runId,
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
          if (event.type === 'run.step' && event.state === 'failed') failed = true;
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
      const events = threadId === null
        ? all
        : all.filter((e) => 'threadId' in e && e.threadId === threadId);
      json(res, 200, { events });
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
