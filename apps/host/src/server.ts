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
  effectiveBaseEntries,
  effectiveWorkspaceRoot,
  ensureSharedBaseThread,
  fold,
  SHARED_BASE_THREAD_ID,
  invalidateBase,
  pendingQueue,
  reactivateBase,
  type NewEvent,
} from '@banto/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AgentSdkRunner, allowedToolNames, type McpServerSpec } from '@banto/runner';
import { foldRuns, type Factory } from '@banto/factory';
import { LedgerCore, conversationModule } from '@banto/module-ledger';
import {
  connectInProcess,
  connectSubprocess,
  describeImpact,
  impactOfDisabling,
  type BantoModule,
  type ToolCaller,
} from '@banto/module-kit';

/**
 * in-process モジュールは、いつ・誰が使うかで**別のインスタンス**を要る
 * （実測 2026-08-22）。MCP の `Server.connect()` は「1インスタンス=1接続」しか
 * 許さず、2回目は `Already connected to a transport` で断る。
 * `resourceCallers`（起動時に1回）と、会話ごとの Agent SDK 問い合わせが
 * **同じ `McpServer` を取り合うと、後から繋いだ方が常に断られる**——
 * 実際に `fs` の道具が会話から一度も見えなくなっていた（AI 自身は
 * 「道具が無い」と正直に言っていたので、壊れ方は静かだった）。
 *
 * **だから固定インスタンスではなく、作る関数を渡す。** 使うたびに
 * `createServer()` を呼び、独立した接続にする。
 *
 * `createServer` は `writeRoot` を受け取れる（決定29）。**そのスレッドが
 * 書き込みを許される範囲**——`fs` はこれで書き込みだけを狭める。
 * 使わないモジュールは無視してよい。呼び手が省いたときは `undefined` になる
 * （起動時の読み取り専用接続など、スレッドの文脈が無い場面）。
 */
export type ModuleFactory =
  | {
      readonly name: string;
      readonly kind: 'in-process';
      readonly createServer: (writeRoot?: string | null) => McpServer;
    }
  | {
      readonly name: string;
      readonly kind: 'subprocess';
      readonly command: string;
      readonly args?: readonly string[];
    };

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
  readonly modules: readonly ModuleFactory[];
  /** モジュール id → ツール名。許可の一覧を組み立てるのに使う（要件 D4）。 */
  readonly toolsByModule: ReadonlyMap<string, readonly string[]>;
  /**
   * 載っているモジュールの台帳（要件 C1・C14）。**画面の割り当てはここから導く**——
   * 「どの URI をどの面で開くか」を別表で持たない（規則3）。
   */
  readonly manifests?: readonly BantoModule[];
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
   *
   * **複数リポジトリぶん持てる**（決定29）。`factoryFor(repo)` がリポジトリごとに
   * 1つだけ組み立てて使い回す——単一リポジトリ運用では `repo` を省き（`'.'`）、
   * 今までどおり1つだけが立つ。
   */
  readonly factory?: FactoryPool;
}

export interface FactoryPool {
  readonly factoryFor: (repo: string) => Promise<Factory>;
  readonly allBuilt: () => Promise<Factory[]>;
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

/**
 * `sandboxed` な面の入れ物（決定20）。**モジュールの JS をそのまま埋める。**
 *
 * ここに置くのは器だけで、描くのはモジュールの側である
 * ——器が中身を知ると、モジュールごとに器が要ることになる。
 */
function sandboxShell(source: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 12px; font: 12px/1.6 ui-monospace, monospace; color: #24211d; }
  .head { margin: 0 0 8px; font-size: 11px; color: #6b645c; }
  .proof { margin: 8px 0 0; font-size: 11px; color: #6b645c; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
</style></head>
<body><div id="root"></div><script>${source}</script></body></html>`;
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
    // フロントは Node パッケージを持てないので、固定id（決定30）は値として渡す
    // ——ハードコードして2箇所で持つと、いつか食い違う（規則3）。
    sharedBaseThreadId: SHARED_BASE_THREAD_ID,
    // 削除されたスレッドは、フロントのどの一覧にも出さない（決定30）——
    // 「開いているもの」からも「履歴」からも外れる、`mergedInto` より一段強い扱い。
    threads: [...state.threads.values()]
      .filter((t) => !t.deleted)
      .map((t) => ({
      id: t.id,
      channelId: t.channelId,
      title: t.title,
      status: t.status,
      turnCount: t.turnCount,
      baseVersion: t.baseVersion,
      forkedFrom: t.forkedFrom,
      mergedInto: t.mergedInto,
      workspaceRoot: effectiveWorkspaceRoot(state, t.id),
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

/**
 * 会話に渡す指示（要件 C14・決定19）。
 *
 * **モジュールの道具を使うことと、見せたいものを指すことを、明示的に言う。**
 * 測って分かった（2026-08-21）：言わないと、モデルは**組み込みの道具**に手を伸ばす
 * ——`fs` モジュールに `write` があるのに、素の `Write` で `/home/ubuntu/note.md` を
 * 書こうとして権限で止まった。許可の一覧に無いものは通らないので実害は無いが、
 * **仕事が進まない。** 道具の説明だけでは足りず、**どちらを使うかは方針**である。
 *
 * `show` も同じで、**「見せたいものは指す」と言わないと指さない。**
 * 契約が伝わらないなら、契約の側を直す（説明を足す）のが筋である。
 *
 * **「作った・変えたもの」だけでは足りなかった**（実測 2026-08-22）。人が
 * 「開いて」「見せて」と直接頼んだときに、道具で読んでその中身を本文へ
 * 書き写すだけで `show` を呼ばない、という壊れ方があった——指示が
 * 「自分から見せたくなったとき」しか想定しておらず、「頼まれて開くとき」を
 * 書いていなかった。両方を明示した。
 *
 * **文章での説明だけでは、それも直らなかった**（実測 2026-08-22、2回目）。
 * PO 裁定：read/write と show は別の判断のまま保つ（自動連動はしない）。
 * その上で、指示は**具体例で見せる**——抽象的な規則の言い換えを重ねるより、
 * 正しい振る舞いを1つの対話例として示すほうが効くというのは、tool use の
 * 一般的な知見（Anthropic の設計指針。Claude Code 自体の内部プロンプトの
 * 生の文面は検証していない——確かめていないことを確かめたことにしない）。
 */
export const SYSTEM_PROMPT = [
  'You are banto. Answer in the user’s language. Be concise.',
  '',
  '# Tools',
  'Use the mcp__ tools you are given, not the built-in file or shell tools —',
  'the mcp__ ones are scoped to what this person allowed. If a task needs',
  'something you have no mcp__ tool for, say so instead of reaching elsewhere.',
  '',
  '# Showing your work',
  'Two cases call for the show tool, using the uri another tool gave you:',
  '(1) the person asks you to open, show, or look at something, and',
  '(2) you produce or change something, unprompted, that they would likely want to see.',
  '',
  'These are two separate tool calls, not one — reading something does not show it.',
  'Describing the content in your reply is not a substitute for calling show either;',
  'the person cannot open what you only describe in words. show is what puts something',
  'on their screen for them to open.',
  '',
  'Example — the person asks you to open something:',
  '  person: "Open README.txt"',
  '  you: call the read tool with path "README.txt" -> it returns {content, uri}',
  '  you: call show with that uri -> now it is in the conversation for them to open',
  '  you: "Opened README.txt — it describes ..."',
  'Both tool calls happen before you answer in words. Skipping the second one is the',
  'most common mistake here — notice the request was to open it, not just to summarize it.',
  '',
  'show does not open anything by itself — the person still decides whether to look.',
  '',
  '# Remembering decisions',
  'This conversation may run for a very long time — long past what fits in context.',
  'append_base is how a fact or decision survives that: call it when you and the person',
  'settle something later turns (or forks of this conversation) need to know. Do not call it',
  'for things only useful right now, or for anything still being discussed — this is a ledger',
  'of conclusions, not a scratchpad.',
  '',
  'It can decline (there is a size limit) — check the ok field, and if it is false, tell the',
  'person instead of quietly retrying or dropping the fact.',
  '',
  'If an entry turns out wrong, call invalidate_base on it (reactivate_base undoes that) —',
  'do not append a correction on top. A correction still leaves the wrong text counting',
  'against the size limit; invalidating frees it.',
  '',
  '# Shared vs conversation-specific',
  'append_base records facts scoped to this conversation (and its forks). Separately,',
  'append_shared_base records facts that hold everywhere, regardless of conversation or',
  'project — durable things about the person themselves (their role, standing preferences,',
  'constraints that always apply), not this task. It is shown to every conversation, not',
  'just this one. When unsure which one fits, use append_base — writing something',
  'conversation-specific to the shared one leaks it into unrelated conversations, which is',
  'harder to undo than missing a genuinely general fact. You cannot retract or edit shared',
  'entries yourself; only the person can, from the shared base view.',
].join('\n');

export function startServer(options: ServerOptions): ReturnType<typeof createServer> {
  const log = new EventLog(options.dataDir);
  const allowed = allowedToolNames(options.modules, options.toolsByModule);
  const baseLimit = options.baseLimit ?? DEFAULT_BASE_LIMIT_CHARACTERS;

  /**
   * モジュール id → その URI 空間を読む口（要件 C14）。
   *
   * **境界に関わらず繋ぐ。** 契約は MCP なので、in-process でも subprocess でも
   * 同じ `readResource` で読める（要件 C8b）——**TypeScript でないモジュールが
   * 自分の URI 空間を持てる**ことが、要件 C6 の中身の半分である。
   *
   * 繋げなかったものは黙って落とさず、**理由を覚えておいて 404 に載せる**（規則2）。
   */
  const resourceCallers = new Map<string, ToolCaller>();
  const resourceFailures = new Map<string, string>();
  for (const spec of options.modules) {
    const connect =
      spec.kind === 'in-process'
        ? connectInProcess(spec.createServer())
        : connectSubprocess(spec.command, spec.args ?? []);
    void connect.then(
      (caller) => resourceCallers.set(spec.name, caller),
      (cause: unknown) =>
        resourceFailures.set(spec.name, cause instanceof Error ? cause.message : String(cause)),
    );
  }

  /**
   * その問い合わせ**専用**の `McpServerSpec[]` を作る（同じコメントの理由）。
   * `resourceCallers` が起動時に繋いだインスタンスとは別物——ここで毎回
   * `createServer()` を呼ぶので、Agent SDK が `.connect()` するのは
   * 常に「一度も繋いだことのない」新品の `McpServer` になる。
   *
   * `writeRoot` はそのスレッドの `effectiveWorkspaceRoot` を渡す（決定29）。
   * 使わないモジュールは無視する——`createServer` の引数は任意。
   */
  function freshModuleSpecs(writeRoot: string | null): McpServerSpec[] {
    return options.modules.map((spec) =>
      spec.kind === 'in-process'
        ? { name: spec.name, kind: 'in-process' as const, server: spec.createServer(writeRoot) }
        : spec,
    );
  }

  /**
   * banto:// URI を、持ち主のモジュールに読みに行く（要件 C14）。
   *
   * **`/api/resource` と `show` の両方がここを通る**（規則3、実測 2026-08-22）。
   * `show` がこれを通さずに記録すると、実在しない URI がそのまま会話に残り、
   * 人が開いたときに初めて壊れていたと分かる——実際に AI が
   * `banto://banto-v3/README.md` という、どのモジュールも持たない URI を
   * 作文して `show` に渡していた。**指す前に確かめる**——存在を検証してから記録する。
   */
  async function resolveResource(
    uri: string,
  ): Promise<{ readonly text: string; readonly mimeType: string | null }> {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'banto:') throw new Error(`banto:// ではない: ${uri}`);
    const owner = parsed.hostname;

    const caller = resourceCallers.get(owner);
    if (caller === undefined) {
      const why = resourceFailures.get(owner);
      throw new Error(
        why === undefined
          ? `${owner} は繋がっていない（この banto に載っていないモジュールの uri）`
          : `${owner} に繋がらなかった: ${why}`,
      );
    }
    return caller.readResource(uri);
  }

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

    /**
     * いまこのスレッドで**決まっていること**（要件 R2・R6・A8）。
     *
     * **fork の継承をここで解く。** 継承した行は親スレッドの `base.appended` なので、
     * `/api/events?threadId=` では出てこない——画面側で継ぎ合わせると、
     * **継承の規則が2箇所に書かれる**ことになる（規則3）。導出は `effectiveBase` に1つ。
     */
    if (req.method === 'GET' && url.pathname === '/api/base') {
      const threadId = url.searchParams.get('threadId');
      if (threadId === null) {
        json(res, 400, { error: 'threadId が要る' });
        return;
      }
      // 共有baseは、AIがまだ一度も書いていなくても人が開ける（0件として見える）。
      if (threadId === SHARED_BASE_THREAD_ID) {
        await ensureSharedBaseThread(log, fold(await log.read()));
      }
      const state = fold(await log.read());
      const thread = state.threads.get(threadId);
      if (thread === undefined) {
        json(res, 404, { error: `知らないスレッド: ${threadId}` });
        return;
      }
      // **行ごとの詳細をそのまま返す。** 継承したか（own）・無効化されているかを
      // 画面側で作らない——導出は `effectiveBaseEntries` に1つ（規則3）。
      json(res, 200, {
        threadId,
        baseVersion: thread.baseVersion,
        entries: effectiveBaseEntries(state, threadId),
        characters: baseCharacters(state, threadId),
        limit: baseLimit,
      });
      return;
    }

    /**
     * base の1行を無効化／有効化する（PO指摘 2026-08-22）。**削除ではない**——
     * `POST /api/base` と同じく、人の操作もゲート（`invalidateBase`/`reactivateBase`）
     * を1本だけ通る。AI 側の入口（`invalidate_base`/`reactivate_base` tool）も
     * 同じ関数を呼ぶ——迂回できる場所に置くと迂回される（決定4と同じ考え）。
     */
    if (req.method === 'POST' && (url.pathname === '/api/base/invalidate' || url.pathname === '/api/base/reactivate')) {
      const body = (await readBody(req)) as { threadId?: string; baseVersion?: number };
      if (typeof body.threadId !== 'string' || typeof body.baseVersion !== 'number') {
        json(res, 400, { error: 'threadId と baseVersion が要る' });
        return;
      }
      const state = fold(await log.read());
      if (!state.threads.has(body.threadId)) {
        json(res, 404, { error: `知らないスレッド: ${body.threadId}` });
        return;
      }
      const gate =
        url.pathname === '/api/base/invalidate'
          ? await invalidateBase(log, state, body.threadId, body.baseVersion)
          : await reactivateBase(log, state, body.threadId, body.baseVersion);
      json(res, gate.ok ? 200 : 409, gate);
      return;
    }

    /**
     * モジュールの台帳と、**外したら何が壊れるか**（要件 C1・C11・C12）。
     *
     * **影響は台帳から導く**（規則3）。別表を持たないので、モジュールを足したときに
     * 更新し忘れる場所が無い。**押す前に分かる**ことが要件 C12 の中身である。
     *
     * 境界（`isolation` と `gui.kind`）も一緒に返す——**台帳に常時表示する**（要件 C8c）。
     */
    if (req.method === 'GET' && url.pathname === '/api/modules') {
      const manifests = options.manifests ?? [];
      json(res, 200, {
        modules: manifests.map((m) => {
          const impact = impactOfDisabling(manifests, m.id);
          return {
            id: m.id,
            description: m.description,
            isolation: m.isolation,
            handlesSecrets: m.handles?.includes('secrets') === true,
            provides: m.provides ?? [],
            gui: m.gui === undefined ? null : { kind: m.gui.kind, views: m.gui.views.length },
            settingsUri:
              m.gui?.views.find((v) => v.slot === 'settings')?.uriPrefix ?? null,
            impact: {
              summary: describeImpact(impact),
              breakages: impact.breakages,
              orphanedCapabilities: impact.orphanedCapabilities,
            },
          };
        }),
      });
      return;
    }

    /**
     * `sandboxed` な面の中身を配る（要件 C1・C6、決定20）。
     *
     * **JS を丸ごと HTML に入れて返す。** 別ファイルにすると、iframe の側が
     * それを取りに来ることになるが、**`allow-same-origin` を渡していない iframe は
     * 生成元が不透明**なので、素直に取れない。入れてしまえば取りに行く必要が無い。
     *
     * **CSP でも縛る。** iframe の `sandbox` 属性と二重になるが、
     * 片方が外れたときにもう片方が残る——安全は1枚では持たない。
     */
    if (req.method === 'GET' && url.pathname.startsWith('/api/modules/')) {
      const [, , , moduleId, tail] = url.pathname.split('/');
      if (tail !== 'view' || moduleId === undefined) {
        json(res, 404, { error: `見つからない: ${url.pathname}` });
        return;
      }
      const manifest = (options.manifests ?? []).find((m) => m.id === moduleId);
      if (manifest?.gui === undefined) {
        json(res, 404, { error: `${moduleId} は画面を持ち込んでいない` });
        return;
      }
      if (manifest.gui.kind !== 'sandboxed') {
        // in-page のものは束ねの中に在る。**ここから配らない**（配ると経路が2つになる）。
        json(res, 400, { error: `${moduleId} の面は ${manifest.gui.kind}——ここからは配らない` });
        return;
      }

      const source = await readFile(path.resolve(manifest.gui.entry), 'utf8').catch(() => null);
      if (source === null) {
        // 握りつぶさない（規則2）。**空の面を返さない**——何も出ない画面になる。
        json(res, 404, { error: `面の実体が読めない: ${manifest.gui.entry}` });
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // 取りに行ける先を1つも持たせない。**渡されたものだけを描く。**
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      });
      res.end(sandboxShell(source));
      return;
    }

    /**
     * どの URI をどの面で開くか（要件 C1・C14、決定20）。
     *
     * **台帳から導くだけ。** 画面側が自分で表を持つと、載っているモジュールと
     * 割り当てが食い違う（規則3）。**境界も一緒に返す**——
     * 画面は `in-page` と `sandboxed` を区別して描かなければならない。
     */
    if (req.method === 'GET' && url.pathname === '/api/views') {
      json(res, 200, {
        views: (options.manifests ?? []).flatMap((m) =>
          (m.gui?.views ?? []).map((v) => ({
            moduleId: m.id,
            kind: m.gui?.kind ?? null,
            entry: m.gui?.entry ?? null,
            uriPrefix: v.uriPrefix,
            title: v.title,
            slot: v.slot ?? 'canvas',
          })),
        ),
      });
      return;
    }

    /**
     * AI が指したものを読む（要件 C14・決定19）。
     *
     * **持ち主は URI の先頭で決まる**（`banto://<モジュール id>/…`）ので、
     * 「どの URI を誰が持っているか」の表を別に持たない（規則3）。
     * **中身をここに写さない**——読むたびに持ち主へ聞くので、いつでも現物である。
     */
    if (req.method === 'GET' && url.pathname === '/api/resource') {
      const uri = url.searchParams.get('uri');
      if (uri === null) {
        json(res, 400, { error: 'uri が要る' });
        return;
      }
      try {
        const { text, mimeType } = await resolveResource(uri);
        json(res, 200, { uri, text, mimeType });
      } catch (cause) {
        // 握りつぶさない（規則2）。繋がらなかった／読めなかった理由をそのまま返す。
        json(res, 404, { error: cause instanceof Error ? cause.message : String(cause) });
      }
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
      if (body.threadId === SHARED_BASE_THREAD_ID) {
        await ensureSharedBaseThread(log, fold(await log.read()));
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
      const body = (await readBody(req)) as {
        request?: string;
        channelName?: string;
        branch?: string;
        repo?: string;
      };
      if (typeof body.request !== 'string' || body.request.trim() === '') {
        json(res, 400, { error: 'request が要る' });
        return;
      }
      const channelId = await ensureChannel(body.channelName ?? 'banto-v3');
      const runId = randomUUID();
      // ブランチ名は Run から決まる。**覚えないので、再開しても同じ名前に着く。**
      const branch = body.branch ?? `factory/${runId.slice(0, 8)}`;
      // **`repo` を省くと `'.'`**（決定29）——`--repo` に渡した1本だけを扱う、
      // 今までどおりの単一リポジトリ運用。
      let factory: Factory;
      try {
        factory = await options.factory.factoryFor(body.repo ?? '.');
      } catch (cause) {
        json(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
        return;
      }
      await factory.request({
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
      // **これまでに要求されたリポジトリぶんだけ**進める。まだ一度も
      // `factoryFor` を呼ばれていないリポジトリは、先回りして繋がない。
      for (const factory of await options.factory.allBuilt()) await factory.advanceAll();
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

    /**
     * 会話を分岐する（要件 A3・R4、決定3）。
     *
     * **既定は base から切る**（決定3）。「いまの続き」から切ると、
     * 枝も肥えたまま始まるので、分岐が安いという前提（要件 A4）が壊れる。
     * `mode: 'tip'` は明示したときだけ。
     *
     * **決まったことは切った時点の版まで引き継ぐ**（要件 R4）。
     * その後の親の追記は入らない——継承の解きかたは `effectiveBase` に1つだけある（規則3）。
     */
    if (req.method === 'POST' && url.pathname === '/api/threads/fork') {
      const body = (await readBody(req)) as {
        fromThreadId?: string;
        title?: string;
        mode?: string;
      };
      if (typeof body.fromThreadId !== 'string') {
        json(res, 400, { error: 'fromThreadId が要る' });
        return;
      }
      if (body.mode !== undefined && body.mode !== 'base' && body.mode !== 'tip') {
        // 知らない値を黙って既定へ落とさない（規則2）。
        json(res, 400, { error: `知らない mode: ${body.mode}（base か tip）` });
        return;
      }

      const state = fold(await log.read());
      const parent = state.threads.get(body.fromThreadId);
      if (parent === undefined) {
        json(res, 404, { error: `知らないスレッド: ${body.fromThreadId}` });
        return;
      }
      /**
       * フォークからのフォークは作らせない（決定31）。**想定していない状態**
       * ——実際に本番で、幹の解決が1階層しか遡らない箇所があり、フォークの
       * フォークを開くと幹側のパネルまでフォーク扱いに見える壊れ方が起きた。
       * 表示側も直したが（`apps/web` の `trueRootId`）、そもそも作れないように
       * 根から断つ。**フロント（ボタンを出さない）とここの両方で断る**
       * ——フロントだけだと、直接APIを叩けば素通りする（規則1と同じ考え）。
       */
      if (parent.forkedFrom !== null) {
        json(res, 400, {
          error: 'フォークからのフォークは作れない（幹からだけフォークできる）',
        });
        return;
      }

      const threadId = randomUUID();
      await log.append({
        type: 'thread.forked',
        threadId,
        channelId: parent.channelId,
        title: body.title ?? `${parent.title} から分岐`,
        // **切った時点の版を鍵にする。** 親がこの後で追記しても、この枝には入らない。
        from: { threadId: parent.id, baseVersion: parent.baseVersion },
        mode: body.mode ?? 'base',
      });
      json(res, 200, { threadId, channelId: parent.channelId });
      return;
    }

    /**
     * フォークを閉じて親に畳む（PO裁定 2026-08-22：フォークが増えすぎて分かりにくい）。
     *
     * **このスレッド自身の ownBase（継承分は含まない）だけを、親の base に
     * 通常の追記として流し込んでから閉じる。** 空でもよい——BasePanel を一度も
     * 使っていないフォークも畳める。親の base が上限に達していて追記が断られたら、
     * **畳むのも進めない**（規則2）——見えなくなった決まったことが記録されないまま
     * 消えることを避ける。理由は 409 でそのまま返す。
     *
     * 既に畳んだスレッドをもう一度畳もうとすると、ownBase をまるごと
     * 二重に親へ流し込むことになるので断る。
     */
    if (req.method === 'POST' && url.pathname === '/api/threads/merge') {
      const body = (await readBody(req)) as { threadId?: string };
      if (typeof body.threadId !== 'string') {
        json(res, 400, { error: 'threadId が要る' });
        return;
      }

      const state = fold(await log.read());
      const thread = state.threads.get(body.threadId);
      if (thread === undefined) {
        json(res, 404, { error: `知らないスレッド: ${body.threadId}` });
        return;
      }
      if (thread.forkedFrom === null) {
        json(res, 400, { error: 'ルートのスレッドには畳む先の親が無い' });
        return;
      }
      if (thread.mergedInto !== null) {
        json(res, 400, { error: 'すでに畳んである' });
        return;
      }

      const parentId = thread.forkedFrom.threadId;
      // 無効化した行は畳んで戻すときにも運ばない——もう効いていないものを
      // 親へ持ち込むと、無効化した意味が無くなる。
      const mergedText = thread.ownBase
        .filter((e) => !e.invalidated)
        .map((e) => e.text)
        .join('\n');
      if (mergedText !== '') {
        const gate = await appendBase(log, state, parentId, mergedText, baseLimit);
        if (!gate.ok) {
          json(res, 409, gate);
          return;
        }
      }

      await log.append({ type: 'thread.merged', threadId: body.threadId, into: parentId });
      json(res, 200, { threadId: body.threadId, into: parentId });
      return;
    }

    /**
     * スレッドを削除する（決定30）。**トゥームストーン**——`thread.merged` と同じく、
     * ログからは何も消えない。「開いているもの」「履歴」のどちらからも外れるだけ。
     *
     * 1. **未マージのフォークを先に自動でマージする**（PO裁定）。`/api/threads/merge`
     *    と同じ経路（`appendBase`のゲートを通す）を、子フォークの数だけ繰り返す
     * 2. **共有baseへ持ち出す行があれば、削除の前に共有baseへ追記する**（決定30）。
     *    `shareToSharedBase` は、このスレッド自身の `ownBase` の `baseVersion` の一覧
     *    ——人が事前にBasePanelで選ぶ
     * 3. `thread.deleted` を積む
     *
     * どこかでゲートに断られたら、そこで止めて理由を返す——**部分的に削除された
     * 状態を残さない**わけではないが（フォークのマージまでは進んでいてよい）、
     * 削除の印だけは、共有baseへの持ち出しが成功してから立てる。
     */
    if (req.method === 'POST' && url.pathname === '/api/threads/delete') {
      const body = (await readBody(req)) as { threadId?: string; shareToSharedBase?: number[] };
      if (typeof body.threadId !== 'string') {
        json(res, 400, { error: 'threadId が要る' });
        return;
      }
      if (body.threadId === SHARED_BASE_THREAD_ID) {
        json(res, 400, { error: '共有baseスレッドは削除できない' });
        return;
      }

      let state = fold(await log.read());
      const thread = state.threads.get(body.threadId);
      if (thread === undefined) {
        json(res, 404, { error: `知らないスレッド: ${body.threadId}` });
        return;
      }
      if (thread.deleted) {
        json(res, 400, { error: 'すでに削除されている' });
        return;
      }

      // 1. 未マージのフォークを先に畳む。
      const liveForks = [...state.threads.values()].filter(
        (t) => t.forkedFrom?.threadId === body.threadId && t.mergedInto === null && !t.deleted,
      );
      for (const fork of liveForks) {
        const mergedText = fork.ownBase
          .filter((e) => !e.invalidated)
          .map((e) => e.text)
          .join('\n');
        if (mergedText !== '') {
          const gate = await appendBase(log, state, body.threadId, mergedText, baseLimit);
          if (!gate.ok) {
            json(res, 409, { error: `フォーク「${fork.title}」の自動マージで断られた: ${gate.reason}` });
            return;
          }
          state = fold(await log.read());
        }
        await log.append({ type: 'thread.merged', threadId: fork.id, into: body.threadId });
        state = fold(await log.read());
      }

      // 2. 選ばれた行を、削除の前に共有baseへ持ち出す。
      const shareVersions = body.shareToSharedBase ?? [];
      if (shareVersions.length > 0) {
        await ensureSharedBaseThread(log, state);
        state = fold(await log.read());
        const current = state.threads.get(body.threadId);
        const toShare = (current?.ownBase ?? []).filter((e) => shareVersions.includes(e.baseVersion));
        for (const entry of toShare) {
          const gate = await appendBase(log, state, SHARED_BASE_THREAD_ID, entry.text, baseLimit);
          if (!gate.ok) {
            json(res, 409, { error: `共有baseへの持ち出しで断られた: ${gate.reason}` });
            return;
          }
          state = fold(await log.read());
        }
      }

      // 3. 削除の印を立てる。
      await log.append({ type: 'thread.deleted', threadId: body.threadId });
      json(res, 200, { threadId: body.threadId, mergedForks: liveForks.length, shared: shareVersions.length });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/threads') {
      const body = (await readBody(req)) as {
        channelName?: string;
        title?: string;
        workspaceRoot?: string;
      };
      const state = fold(await log.read());
      const channelName = body.channelName ?? 'banto-v3';
      let channelId = [...state.channels.values()].find((c) => c.name === channelName)?.id;
      if (channelId === undefined) {
        channelId = randomUUID();
        await log.append({ type: 'channel.created', channelId, channelName });
      }
      const threadId = randomUUID();
      const workspaceRoot =
        typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim() !== ''
          ? body.workspaceRoot.trim()
          : undefined;
      await log.append({
        type: 'thread.created',
        threadId,
        channelId,
        title: body.title ?? '新しい会話',
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      });
      json(res, 200, { threadId, channelId, workspaceRoot: workspaceRoot ?? null });
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
        /**
         * **その会話に束ねた面**（要件 C14・決定19）。スレッドを引数にせず束ねるので、
         * AI は他人の会話を指せない（要件 D4 と同じ考え）。
         * 会話ごとに立てるので、`options.modules` の固定分とは別に足す。
         */
        const face = conversationModule(log, body.threadId, resolveResource, baseLimit);
        const faceSpec: McpServerSpec = {
          name: face.manifest.id,
          kind: 'in-process',
          server: face.createServer(),
        };
        // このスレッドが向いているリポジトリ（決定29）。フォークは根まで遡って解く。
        // fs の書き込みだけがこれを境界に使う——読み取りは今までどおり広いまま。
        const writeRoot = effectiveWorkspaceRoot(before, body.threadId);

        for await (const event of new AgentSdkRunner().query({
          threadId: body.threadId,
          queryId,
          // base はシステムプロンプトに入る。**走行中は変えられない**（決定6）ので、
          // 追記があった場合に効くのは次のスレッド／次の fork から（要件 R2・R4）。
          systemPrompt: SYSTEM_PROMPT + (baseText === '' ? '' : `\n\n# この会話で決まっていること\n${baseText}`),
          // **`options.modules` を直接は渡さない**（実測 2026-08-22）。固定インスタンスを
          // 使い回すと、2回目以降の問い合わせが「already connected」で断られ、
          // `fs` の道具が会話から静かに消える。`freshModuleSpecs()` が毎回新品を作る。
          mcpServers: [...freshModuleSpecs(writeRoot), faceSpec],
          skills: [],
          model: options.model,
          allowedTools: [
            ...allowed,
            `mcp__${faceSpec.name}__show`,
            `mcp__${faceSpec.name}__append_base`,
            `mcp__${faceSpec.name}__append_shared_base`,
            `mcp__${faceSpec.name}__invalidate_base`,
            `mcp__${faceSpec.name}__reactivate_base`,
          ],
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
