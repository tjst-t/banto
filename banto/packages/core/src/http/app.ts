// docs/specs/v4-frontend.md向けの最小API面。core↔frontend通信はHTTP+SSE
// （決定・2026-09-03）。1ターン=1回のquery()呼び出しに対応して、会話の
// ストリーミングはSSEで、操作（承認・設定変更等）は通常のHTTP POST。
//
// フレームワークを足さない（規則10）——Node標準のhttpモジュールと、
// このファイルの薄いルータで足りる規模。
//
// フロントエンド（apps/frontend、Next.js）はhostとは別オリジン（別ポート）
// で動く——host自身は静的ファイルを配信しない（決定・2026-09-03、
// mock/をそのままコピーして実データに配線する方針に伴い訂正。旧実装は
// hostが/apps/frontendのHTML/JSを配信していたが、Next.jsは自分のサーバを
// 要るためこの形は成立しない）。別オリジンからのfetch()を通すためCORSを返す。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  MemoryLimitExceededError,
  normalizeProjectRoot,
  InvalidProjectRootError,
  NotFoundError,
  type ProjectThreadStore,
} from "../project-thread/store.js";
import type { GlobalMemoryStore } from "../global-memory/store.js";
import type { InboxStore } from "../inbox/store.js";
import type { ThreadState } from "../project-thread/types.js";
import type { ThreadPermissionMode } from "../project-thread/types.js";
import type { HostRelayEndpoint } from "../relay/host-relay-endpoint.js";
import type { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { runThreadTurn, type ModuleEndpoint, type RunThreadTurnInput } from "./turn-runner.js";
import {
  ModuleDeclarationError,
  listProjectModules,
  setProjectModuleSelection,
} from "../modules/declaration.js";
import { describeRootScope } from "../modules/root-scope.js";
import { listDirectories } from "./directories.js";
import type { TurnEventBus } from "./turn-events.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import type { ModuleCallTracker } from "../relay/module-calls.js";
import { CALLER_META_KEY, visibilityOf } from "@banto/module-contract";

/**
 * Module の画面（MCP Apps）のために host が Module へ問い合わせる分だけ
 * （決定・2026-09-06）。**MCP の Client をそのまま渡せる形**にしてある
 * ——独自の入れ物を作らない（規則12）。
 */
export interface ModuleClientLike {
  listTools(): Promise<{ tools: unknown[] }>;
  listResources(): Promise<{ resources: unknown[] }>;
  readResource(params: { uri: string; _meta?: Record<string, unknown> }): Promise<{ contents: unknown[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<unknown>;
}

/**
 * **画面からの呼び出しは、人を待つことがある**（追加・2026-09-12）。
 *
 * その tool が内部で他 Module を呼べば、host は**人に承認を聞く**——
 * MCP の既定タイムアウト（60秒）のままだと、人が答える前にこの呼び出しが
 * 切れる。中継側は「後から許可されたことは記録に残す」作りなので、結果は
 * **画面にだけ失敗が出て、次に押すと通る**という分かりにくい形になる
 * （規則2——静かに別の経路へ落ちない）。人の返事を待てる長さにする。
 */
const UI_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const UI_CALL_OPTIONS = { timeout: UI_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true } as const;

export interface AppDeps {
  projectThread: ProjectThreadStore;
  /** banto全体で覚えていること（§2.2 Global Memory、決定・2026-09-05）。 */
  globalMemory: GlobalMemoryStore;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  /** 設定（層2）。いまは `defaultPermissionMode` の解決に使う（§2.6・§6.4）。 */
  runtimeConfig?: RuntimeConfigStore;
  /** ターンの外で起きた判断待ち（host の中継ゲート）を走行中の SSE へ流す口。 */
  turnEvents?: TurnEventBus;
  /** 画面からの tool 呼び出しも「どのターンの仕事か」を台帳に置く——その tool が
   *  内部で他 Module を呼ぶとき、承認をどの会話に出すかがこれで決まる。 */
  moduleCalls?: ModuleCallTracker;
  relayEndpoint: HostRelayEndpoint;
  /** Runner向け（/agent-relay/<module名>）。resolveModulesForThreadが返すModuleを実際に配信する。 */
  agentRelayEndpoint: AgentRelayEndpoint;
  authToken: string;
  /** そのThreadで使えるModule（名前とRunner接続先URL）の一覧を返す（Project単位の配線）。
   *  Shell/FileSystemはProject単位で遅延spawnするため非同期。 */
  resolveModulesForThread(threadId: string): Promise<ModuleEndpoint[]>;
  /** そのThreadで繋がっているModuleそのもの（画面を出すために中身を読む）。
   *  Runner向けの中継URL（resolveModulesForThread）とは用途が別——
   *  こちらは**人の画面**のための経路で、Runnerは通らない。 */
  resolveModuleClientsForThread?(
    threadId: string,
  ): Promise<Array<{ name: string; client: ModuleClientLike; connName?: string }>>;
  /** Project 単位（設定画面は Thread ではなく Project のもの、決定・2026-09-07）。
   *  `scope` は**設定をどちらの画面に出すか**を決めるのに使う。 */
  resolveModuleClientsForProject?(
    projectId: string,
  ): Promise<
    Array<{ name: string; client: ModuleClientLike; connName?: string; scope?: "instance" | "project" }>
  >;
  /** banto 全体（instance）で1本の Module（決定・2026-09-07、ユーザー指摘）。
   *  その設定は Project ごとではなく、全体の設定画面に出す。 */
  resolveInstanceModuleClients?(): Promise<
    Array<{ name: string; client: ModuleClientLike; connName?: string }>
  >;
  /** Project を畳んだときに、その Project のために立てたもの（Module の
   *  プロセス・合言葉・セッション）を落とす（決定・2026-09-10）。 */
  releaseProjectModules?(projectId: string): Promise<string[]>;
  /** 画面から見たサンドボックスの住所（§6.2）。画面に推測させない（規則3）。 */
  sandboxPublicUrl?: string;
  /**
   * **いま繋がっているか・繋げなかった理由**（追補・2026-09-11、ユーザー報告）。
   * 設定の一覧が「使う」と言っている Module でも、立たないことがある
   * （閉じ込めが成立しない根など）——**立っていないことと理由を画面に出す**（規則13）。
   * **ここで起こさない**（見ただけで副作用を作らない）。
   */
  moduleStatusForProject?(projectId: string): Array<{ name: string; connected: boolean; error?: string }>;
  /** banto 自身の置き場（根の広さを判断するのに使う、`/api/config/root-scope`）。 */
  dataDir?: string;
  configDir?: string;
  /** Runner の差し替え口（試験用）。`runThreadTurn` がそのまま受け取る。 */
  runTurn?: Parameters<typeof runThreadTurn>[0]["runTurn"];
}

/**
 * **人が画面から直接触っている**ことの刻印（追加・2026-09-13）。
 *
 * 中継（`host-relay-endpoint`）と AI の代理（`agent-proxy`）は刻んでいたのに、
 * **画面 API だけ刻んでいなかった**——この経路は host が Module と直接話すので
 * 中継を通らない。刻まないと、受け手（Vault）は「誰のための呼び出しか
 * 分からない」として fail closed で止まる：実際、管理画面から公開鍵を
 * 読もうとして「どの Vault にもありません」になった。
 *
 * **Project ではなく `admin`**——人の管理面は Project を跨いで見える（`unbound`
 * のものも直せる必要がある）。
 */
const HUMAN_ADMIN_CALLER = { [CALLER_META_KEY]: { admin: true } };

/**
 * **画面から呼んでよい tool か**を host 自身が検査する（決定・2026-09-10、
 * `docs/specs/v4-security.md`「中継が縛らないもの」）。
 *
 * 画面 API は合言葉さえあれば任意の tool 名を呼べたので、`module` 可視性
 * （部品間専用——Vault の `resolveAlias` 等）まで届き、**秘密の値がブラウザに
 * 返っていた**。可視性の強制がフロントエンドの自制だけに乗っていた形。
 *
 * 通すのは `agent`（AI に見せている）と `admin`（人の管理操作）だけ。
 * **一覧に無い名前も通さない**（fail closed）——「その Module が名乗っている
 * tool」以外を host が代理で呼ぶ理由が無い。
 */
async function checkUiCallable(
  client: ModuleClientLike,
  toolName: string,
): Promise<{ status: number; body: unknown } | undefined> {
  const { tools } = await client.listTools();
  const tool = tools.find((t) => (t as { name?: string }).name === toolName);
  if (!tool) return { status: 404, body: { error: "unknown tool", tool: toolName } };
  const visibility = visibilityOf(tool as { _meta?: Record<string, unknown> });
  if (visibility === "module") {
    return {
      status: 403,
      body: {
        error: "この tool は画面からは呼べません（Module 間専用）",
        tool: toolName,
        visibility,
      },
    };
  }
  return undefined;
}

/** MCP Apps が tool に付ける印（`_meta.ui.resourceUri`）を読む。 */
function uiResourceUriOf(tool: unknown): string | undefined {
  const meta = (tool as { _meta?: { ui?: { resourceUri?: unknown } } })._meta;
  const uri = meta?.ui?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * その資源が**どの面として名乗っているか**（決定・2026-09-07）。
 *
 * 設定 Canvas（`config`）と、人が直接開ける入口（`launcher`）を**同じ1つの
 * 仕組み**で表す（§6.2——増やさない）。投機的に `ui://<id>/config` のような
 * URI を試さない——**Module が名乗ったものだけ**（無いのか壊れているのかを
 * 曖昧にしない、規則2）。
 */
function canvasKindOf(resource: unknown): string | undefined {
  const meta = (resource as { _meta?: Record<string, unknown> })._meta;
  const kind = meta?.["dev.banto/canvas"];
  return typeof kind === "string" ? kind : undefined;
}

function isSettingsCanvas(resource: unknown): boolean {
  return canvasKindOf(resource) === "config";
}

/** MCP Apps の画面資源かどうか。MIMEは仕様で決まっている。 */
function isUiResourceMime(mimeType: unknown): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("text/html") && mimeType.includes("profile=mcp-app");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function withCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  // PATCH（名前を変える）・PUT（並び順）を足した（2026-09-11）——**画面から
  // 呼べない口を足しても、何も起きない**。実測：preflight で弾かれ、画面には
  // 「Failed to fetch」だけが出ていた
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id");
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers["authorization"];
  return typeof header === "string" && header === `Bearer ${token}`;
}

const THREAD_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

/**
 * このターンをどの permissionMode で走らせるか（決定・2026-09-06、見直し起点）。
 *
 * **真実は host が持つ**——以前はHTTPボディの値だけを見て、無ければ Runner の
 * 既定（`"auto"`）へ黙って落ちていた。Fork Thread は host 側に値を持たないので
 * 毎回 auto に戻り、**親で `default` にして承認ゲートを効かせていた人が、
 * fork した瞬間に自動承認で走らせる**ことになっていた（規則2——安全側に倒れない
 * 既定への転落）。ボディの値は「このターンだけの上書き」として扱う。
 */
export function resolvePermissionMode(
  fromRequest: unknown,
  thread: { permissionMode?: ThreadPermissionMode } | undefined,
  /** Configuration の既定（Project 上書き → instance 既定の順で解決済みの値）。 */
  configured?: unknown,
): ThreadPermissionMode {
  if (isThreadPermissionMode(fromRequest)) return fromRequest;
  if (thread?.permissionMode) return thread.permissionMode;
  // **設定の既定**（`docs/specs/v4-frontend.md` §6.4、実装・2026-09-10）。
  // 壊れた値は黙って使わない——既定に落とす（設定は人が書き換えうる）
  if (isThreadPermissionMode(configured)) return configured;
  // **最後は auto**（同 §6.4「既定値は auto」）。ここが唯一の落ち先（規則3）
  return DEFAULT_PERMISSION_MODE;
}

/** 何も選ばれていないときのモード（`docs/specs/v4-frontend.md` §6.4）。 */
export const DEFAULT_PERMISSION_MODE: ThreadPermissionMode = "auto";
/** Configuration の鍵。instance 既定・Project 上書きの両方に置ける。 */
export const DEFAULT_PERMISSION_MODE_KEY = "defaultPermissionMode";

function isThreadPermissionMode(value: unknown): value is (typeof THREAD_PERMISSION_MODES)[number] {
  return typeof value === "string" && (THREAD_PERMISSION_MODES as readonly string[]).includes(value);
}

/** SDKの`PermissionResult`の形かを確かめる（sdk.d.tsのallow/deny）。 */
function isPermissionResult(value: unknown): value is Parameters<PendingApprovalRegistry["resolve"]>[1] {
  if (typeof value !== "object" || value === null) return false;
  const behavior = (value as { behavior?: unknown }).behavior;
  if (behavior === "allow") return true;
  return behavior === "deny" && typeof (value as { message?: unknown }).message === "string";
}

/** そのThreadで**画面を持つ tool**の一覧。受け皿の口とターンの記録が
 *  同じ答えを見るように、算出はここ1箇所に置く（規則3）。 */
async function listUiToolsForThread(
  deps: AppDeps,
  threadId: string,
): Promise<Array<{ server: string; tool: string; resourceUri: string }>> {
  const modules = (await deps.resolveModuleClientsForThread?.(threadId)) ?? [];
  const result: Array<{ server: string; tool: string; resourceUri: string }> = [];
  for (const { name, client } of modules) {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const resourceUri = uiResourceUriOf(t);
      if (!resourceUri) continue;
      result.push({ server: name, tool: (t as { name: string }).name, resourceUri });
    }
  }
  return result;
}

/** その Module 群が名乗っている**設定 Canvas**を集める（instance/Project で共通）。 */
async function listSettingsCanvases(
  modules: Array<{ name: string; client: ModuleClientLike }>,
): Promise<Array<{ server: string; resourceUri: string; name?: string }>> {
  const result: Array<{ server: string; resourceUri: string; name?: string }> = [];
  for (const { name, client } of modules) {
    const { resources } = await client.listResources();
    for (const r of resources) {
      // **Module が名乗ったものだけ**——投機的に探しにいかない（§6.2）
      if (!isSettingsCanvas(r)) continue;
      const uri = (r as { uri?: unknown }).uri;
      if (typeof uri !== "string" || !isUiResourceMime((r as { mimeType?: unknown }).mimeType)) continue;
      result.push({ server: name, resourceUri: uri, name: (r as { name?: string }).name });
    }
  }
  return result;
}

/**
 * **人が直接開ける入口**として名乗っている Canvas を集める（§6.2）。
 *
 * 人に見せる名前と説明は、**仕様の `name` / `description` をそのまま使う**
 * ——banto 独自のフィールドを足さない（規則11・12）。
 */
async function listLauncherCanvases(
  modules: Array<{ name: string; client: ModuleClientLike }>,
): Promise<Array<{ server: string; resourceUri: string; name?: string; description?: string }>> {
  const result: Array<{ server: string; resourceUri: string; name?: string; description?: string }> = [];
  for (const { name, client } of modules) {
    const { resources } = await client.listResources();
    for (const r of resources) {
      if (canvasKindOf(r) !== "launcher") continue;
      const uri = (r as { uri?: unknown }).uri;
      if (typeof uri !== "string" || !isUiResourceMime((r as { mimeType?: unknown }).mimeType)) continue;
      result.push({
        server: name,
        resourceUri: uri,
        name: (r as { name?: string }).name,
        description: (r as { description?: string }).description,
      });
    }
  }
  return result;
}

/**
 * その Project の**主の会話**（Base Thread）。
 *
 * Project の Canvas 発の呼び出しが中継の承認を要するとき、**どの会話で聞くか**
 * がこれ（決定・2026-09-07「承認はその Project の Base Thread に載せる」）。
 * **別の索引を持たない**（規則3）——並び順は store が既に決めている
 * （Base が先頭、`listThreadsForProject`）。
 */
function baseThreadIdOf(deps: { projectThread: ProjectThreadStore }, projectId: string): string | undefined {
  return deps.projectThread.listThreadsForProject(projectId).find((t) => t.kind !== "fork")?.id;
}

/** 画面から渡された引数を、そのまま渡してよい形にする。 */
function toolArguments(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 画面の中身と、Module が申告した CSP 等を返す（Thread/Project で共通）。 */
async function readUiResource(
  modules: Array<{ name: string; client: ModuleClientLike }>,
  serverName: string,
  uri: string,
): Promise<{ status: number; body: unknown }> {
  const found = modules.find((m) => m.name === serverName);
  if (!found) return { status: 404, body: { error: "unknown module", server: serverName } };

  const { resources } = await found.client.listResources();
  const declared = resources.find((r) => (r as { uri?: unknown }).uri === uri) as
    | { mimeType?: unknown; _meta?: { ui?: Record<string, unknown> } }
    | undefined;
  if (!declared || !isUiResourceMime(declared.mimeType)) {
    // **画面でないものを画面として出さない**（規則2——曖昧なら出さない）
    return { status: 404, body: { error: "unknown ui resource", uri } };
  }
  let contents: unknown[];
  try {
    // 画面の HTML も、人が開いたものとして刻む（経路ごとに刻み方を変えない）
    ({ contents } = await found.client.readResource({ uri, _meta: HUMAN_ADMIN_CALLER }));
  } catch {
    return { status: 404, body: { error: "unknown ui resource", uri } };
  }
  const html = contents.find((c) => isUiResourceMime((c as { mimeType?: unknown }).mimeType)) as
    | { text?: unknown }
    | undefined;
  if (typeof html?.text !== "string") {
    return { status: 404, body: { error: "ui resource has no html", uri } };
  }
  const ui = declared._meta?.ui ?? {};
  return {
    status: 200,
    body: { html: html.text, csp: ui.csp, permissions: ui.permissions, prefersBorder: ui.prefersBorder },
  };
}

/** 一覧に出す分だけ（決定・2026-09-07）。**中身（messages/markers/usage）は返さない**
 *  ——閉じた Thread の概要に要る「件数・最初と最後の発言」は、ここで数えて渡す
 *  （画面が全文を持たずに済む。AI 要約はしない、§2.2 と同じ姿勢）。 */
function toThreadSummary(thread: ThreadState) {
  const texts = thread.messages.map((m) => m.text);
  const cut = (t: string | undefined) => (t === undefined ? null : t.length > 200 ? `${t.slice(0, 200)}…` : t);
  // **一覧に要るものだけを、名前で挙げる**（改訂・2026-09-07、実測）。
  // 「中身以外ぜんぶ」だと、走行の内部事情（resume-point・捨てたセッション・
  // 文脈使用量の内訳）まで一覧に乗り、要約なのに 1 Project で 166KB あった。
  // 会話の中身も走行の事情も `/api/threads/:id` が返す——一覧は目次に徹する
  return {
    id: thread.id,
    projectId: thread.projectId,
    kind: thread.kind,
    /** 人が付けた名前（決定・2026-09-11）。付けていなければ無い——既定の呼び名は
     *  画面側がその Project の中の連番から出す（規則3） */
    title: thread.title,
    parentThreadId: thread.parentThreadId,
    /** 親の会話の**どのメッセージから**分けたか（決定・2026-09-11）。
     *  「この Fork を開く」をその場所に置くのに使う */
    forkedFromSeq: thread.forkedFromSeq,
    /** 親の会話のどこで分岐したか（Fork の入口をその場所に置くのに使う） */
    createdSeq: thread.createdSeq,
    status: thread.status,
    permissionMode: thread.permissionMode,
    createdAt: thread.createdAt,
    /** 閉じた Thread の概要（AI 要約はしない——数えられるものだけ、§2.2 と同じ姿勢） */
    messageCount: thread.messages.length,
    firstMessage: cut(texts[0]),
    lastMessage: texts.length > 1 ? cut(texts[texts.length - 1]) : null,
  };
}

export function createApp(deps: AppDeps) {
  return createServer(async (req, res) => {
    withCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // 起動確認用（E2Eのwebサーバ待受チェック等）。合言葉を知らなくても
      // プロセスが立ち上がっているかは分かってよい——中身は返さない。
      if (url.pathname === "/healthz" && req.method === "GET") {
        json(res, 200, { status: "ok" });
        return;
      }

      // Module→hostの中継は別の合言葉（Moduleプロセスごとのbearer token）で
      // 認証する——フロントエンド用の認証とは別の経路（決定・2026-09-03）。
      if (url.pathname === "/relay") {
        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        await deps.relayEndpoint.handleRequest(req, res, body);
        return;
      }

      // Runner（Agent SDK）が代理サーバに繋ぐ側。認証はしない
      // （localhost限定・hostが自分でspawnしたRunnerからの接続であることが境界、
      // §2.5「Runner は実 Module に直接繋がない」）。
      const agentRelayMatch = url.pathname.match(/^\/agent-relay\/([^/]+)$/);
      if (agentRelayMatch) {
        const body = req.method === "POST" ? await readJsonBody(req) : undefined;
        await deps.agentRelayEndpoint.handleRequest(agentRelayMatch[1]!, req, res, body);
        return;
      }

      if (!isAuthorized(req, deps.authToken)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (url.pathname === "/api/projects" && req.method === "GET") {
        json(res, 200, deps.projectThread.listProjects());
        return;
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { name: string; root: string };
        const project = await deps.projectThread.createProject(body.name, body.root);
        json(res, 201, project);
        return;
      }

      // **この Project で使う Module**（`phase1-project-modules-ui`、2026-09-11、
      // Phase 2 の入口）。宣言は banto 全体の既定なので、1本足すと全 Project に
      // 繋がる——増やす前に、Project ごとに選べるようにする
      const projectModulesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/modules$/);
      if (projectModulesMatch && req.method === "GET") {
        const projectId = projectModulesMatch[1]!;
        if (!deps.projectThread.getProject(projectId)) return json(res, 404, { error: "not found" });
        if (!deps.runtimeConfig) return json(res, 200, []);
        const status = new Map(
          (deps.moduleStatusForProject?.(projectId) ?? []).map((s) => [s.name, s]),
        );
        json(
          res,
          200,
          listProjectModules(deps.runtimeConfig, projectId).map((m) => ({
            ...m,
            // 使うと言っていても立つとは限らない——立っているか、理由は何か
            connected: status.get(m.name)?.connected ?? false,
            ...(status.get(m.name)?.error ? { error: status.get(m.name)!.error } : {}),
          })),
        );
        return;
      }
      if (projectModulesMatch && req.method === "PUT") {
        const projectId = projectModulesMatch[1]!;
        if (!deps.projectThread.getProject(projectId)) return json(res, 404, { error: "not found" });
        if (!deps.runtimeConfig) return json(res, 503, { error: "runtime config is not available" });
        const body = (await readJsonBody(req)) as { names: unknown };
        if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== "string")) {
          return json(res, 400, { error: "names must be an array of module names" });
        }
        try {
          await setProjectModuleSelection(deps.runtimeConfig, projectId, body.names as string[]);
        } catch (err) {
          if (err instanceof ModuleDeclarationError) return json(res, 400, { error: err.message });
          throw err;
        }
        // **外したものは落とす**——次のターンを待たずにプロセスを止める。
        // 繋いだものは、次に要るときに立ち上がる（遅延起動のまま、規則3）
        const released = (await deps.releaseProjectModules?.(projectId)) ?? [];
        json(res, 200, { ok: true, released });
        return;
      }

      // **人が決めた並び**（決定・2026-09-11、ユーザー要望）。順番そのものを
      // 1件で受け取る——各 Project に番号を振ると、1つ動かすたびに全件を
      // 書き直すことになる（規則3）
      if (url.pathname === "/api/projects/order" && req.method === "PUT") {
        const body = (await readJsonBody(req)) as { ids: unknown };
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
          return json(res, 400, { error: "ids must be an array of project ids" });
        }
        try {
          await deps.projectThread.setProjectOrder(body.ids as string[]);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      // **Project を開いたら、その Project の Module を先に用意する**
      // （決定・2026-09-07、ユーザー）。返事を待たずに投げる想定の口だが、
      // 用意できたかどうかは返す——画面が「繋がっていない」を出せるように。
      // 仕組みは遅延起動のまま（同じものは single-flight で1本に潰れる）で、
      // **きっかけを1つ足しただけ**（規則3——別の起動経路を作らない）
      const prepareMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/modules\/prepare$/);
      if (prepareMatch && req.method === "POST") {
        const clients = (await deps.resolveModuleClientsForProject?.(prepareMatch[1]!)) ?? [];
        json(res, 200, { connected: clients.map((c) => c.name) });
        return;
      }

      // 名前を変える（決定・2026-09-11、ユーザー要望）。作るときに付けた名前を
      // 後から直せなかった
      const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && req.method === "PATCH") {
        const projectId = projectMatch[1]!;
        const body = (await readJsonBody(req)) as { name?: unknown; root?: unknown };
        const hasName = body.name !== undefined;
        const hasRoot = body.root !== undefined;
        if (!hasName && !hasRoot) return json(res, 400, { error: "name or root is required" });
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (hasName && !name) return json(res, 400, { error: "name is required" });
        if (hasName && name.length > 120) return json(res, 400, { error: "name is too long" });
        const root = typeof body.root === "string" ? body.root.trim() : "";
        if (hasRoot && !root) return json(res, 400, { error: "root is required" });
        try {
          let project = deps.projectThread.getProject(projectId);
          if (!project) return json(res, 404, { error: "not found" });
          if (hasName) project = await deps.projectThread.renameProject(projectId, name);
          if (hasRoot && root !== project.root) {
            project = await deps.projectThread.setProjectRoot(projectId, root);
            // **根は閉じ込めの範囲そのもの**——変えたら立て直す（決定・2026-09-11）。
            // 落としておけば、次に要るときに新しい根で立ち上がる（遅延起動のまま）
            await deps.releaseProjectModules?.(projectId);
          }
          json(res, 200, project);
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          if (err instanceof InvalidProjectRootError) return json(res, 400, { error: err.message });
          throw err;
        }
        return;
      }

      // その Project の Fork の並び
      const forkOrderMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/fork-order$/);
      if (forkOrderMatch && req.method === "PUT") {
        const body = (await readJsonBody(req)) as { ids: unknown };
        if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
          return json(res, 400, { error: "ids must be an array of thread ids" });
        }
        try {
          await deps.projectThread.setForkOrder(forkOrderMatch[1]!, body.ids as string[]);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const projectThreadsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/threads$/);
      if (projectThreadsMatch && req.method === "GET") {
        // **一覧は要約だけ返す**（改訂・2026-09-07、実測）。会話の中身まで返して
        // いたため、画面は起動時に**開いてもいない Project の全会話**を受け取って
        // いた（実測：API 転送 2.88MB のうち 2.875MB がこの一覧）。
        // 中身が要るのは開いた Thread だけで、それは `/api/threads/:id` が返す
        // ——同じものを2つの口から返さない（規則3）
        json(res, 200, deps.projectThread.listThreadsForProject(projectThreadsMatch[1]!).map(toThreadSummary));
        return;
      }
      if (projectThreadsMatch && req.method === "POST") {
        const thread = await deps.projectThread.createBaseThread(projectThreadsMatch[1]!);
        json(res, 201, thread);
        return;
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
      if (threadMatch && req.method === "PATCH") {
        const body = (await readJsonBody(req)) as { title: unknown };
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) return json(res, 400, { error: "title is required" });
        if (title.length > 120) return json(res, 400, { error: "title is too long" });
        try {
          json(res, 200, toThreadSummary(await deps.projectThread.renameThread(threadMatch[1]!, title)));
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }
      if (threadMatch && req.method === "GET") {
        const thread = deps.projectThread.getThread(threadMatch[1]!);
        if (!thread) return json(res, 404, { error: "not found" });
        json(res, 200, thread);
        return;
      }

      // **どの面に出したか**を記録する（決定・2026-09-07、ユーザー指摘）。
      // 決めるのは画面（`ui/request-display-mode`）なので、決まってから届く
      // ——これが記録に無いと、リロード後に「inline は埋め直す・fullscreen は
      // 入口だけ残す」の区別ができず、**毎回 Canvas が勝手に開いていた**。
      const displayModeMatch = url.pathname.match(
        /^\/api\/threads\/([^/]+)\/ui-tool-calls\/([^/]+)\/display-mode$/,
      );
      if (displayModeMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { displayMode?: unknown };
        if (body.displayMode !== "inline" && body.displayMode !== "fullscreen") {
          return json(res, 400, { error: "displayMode must be inline or fullscreen" });
        }
        try {
          await deps.projectThread.recordUiToolCallDisplayMode(
            displayModeMatch[1]!,
            decodeURIComponent(displayModeMatch[2]!),
            body.displayMode,
          );
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      // 人が選んだpermissionModeを残す（決定・2026-09-06）——UI側だけに置くと
      // リロードで消え、「いまどのモードで会話しているか」を見失う（§6.4）
      const permissionModeMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/permission-mode$/);
      if (permissionModeMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { mode?: unknown };
        // 境界で形を検める——通すと型の嘘がEvent Storeへ永続化される（規則9）
        if (!isThreadPermissionMode(body.mode)) {
          return json(res, 400, { error: "unknown permissionMode", mode: body.mode });
        }
        await deps.projectThread.setPermissionMode(permissionModeMatch[1]!, body.mode);
        json(res, 204, null);
        return;
      }

      const forkMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/fork$/);
      if (forkMatch && req.method === "POST") {
        // **過去のメッセージの時点からも分けられる**（決定・2026-09-11、ユーザー要望）。
        // `fromSeq` はそのメッセージの seq——無ければ「いまの続き」から分ける
        const body = (await readJsonBody(req).catch(() => ({}))) as { fromSeq?: unknown };
        if (body.fromSeq !== undefined && typeof body.fromSeq !== "number") {
          return json(res, 400, { error: "fromSeq must be a number" });
        }
        try {
          const thread = await deps.projectThread.forkThread(forkMatch[1]!, {
            fromSeq: body.fromSeq as number | undefined,
          });
          json(res, 201, thread);
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const turnMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
      if (turnMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as {
          prompt: string;
          permissionMode?: RunThreadTurnInput["permissionMode"];
        };
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const modules = await deps.resolveModulesForThread(turnMatch[1]!);
        const thread = deps.projectThread.getThread(turnMatch[1]!);
        const project = thread && deps.projectThread.getProject(thread.projectId);
        // root は作成時に正規化される（store.ts）が、その正規化より前に作られた
        // 既存イベントは生文字列（例："~/"）のまま残りうる——ここでも防御的に
        // 正規化する（真実は一箇所だが、コードの前後関係でデータが逸脱しうる
        // ことが実際にあった、2026-09-05）。失敗したらSSEのerrorイベントとして
        // 返す——ここは既にヘッダを書いた後なのでres.writeHead(500,...)は使えない。
        let cwd: string | undefined;
        if (project) {
          try {
            cwd = normalizeProjectRoot(project.root);
          } catch (err) {
            res.write(
              `data: ${JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) })}\n\n`,
            );
            res.end();
            return;
          }
        }
        // 画面つき tool は**記録にも残す**（決定・2026-09-07）——リロード後に
        // Module の画面を出し直すため。取れなくてもターンは止めない
        let uiTools: Array<{ toolName: string; server: string; resourceUri: string }> = [];
        try {
          uiTools = (await listUiToolsForThread(deps, turnMatch[1]!)).map((t) => ({
            toolName: `mcp__${t.server}__${t.tool}`,
            server: t.server,
            resourceUri: t.resourceUri,
          }));
        } catch (err) {
          console.warn("[host] 画面つき tool の一覧を取れませんでした:", err);
        }

        for await (const event of runThreadTurn(deps, {
          threadId: turnMatch[1]!,
          uiTools,
          prompt: body.prompt,
          permissionMode: resolvePermissionMode(
            body.permissionMode,
            deps.projectThread.getThread(turnMatch[1]!),
            deps.runtimeConfig?.resolve(DEFAULT_PERMISSION_MODE_KEY, thread?.projectId),
          ),
          modules,
          cwd,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }

      // **走行中のターンに、あとから繋ぎ直す口**（決定・2026-09-10、
      // `turn-stream-reattach`）。ターンのイベント列は `POST …/messages` の応答の
      // 中にしか無く、**リロードすると出力どころか「走っている」ことすら画面から
      // 消えていた**（実測）。走行中なら**そのターンの最初から**流し直し、続きも
      // そのまま渡す。走行中でなければ `idle` を1つ返して閉じる
      // ——「いま走っていない」と「繋がらない」を人にも機械にも区別させる（規則2）。
      const streamMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/stream$/);
      if (streamMatch && req.method === "GET") {
        const threadId = streamMatch[1]!;
        if (!deps.projectThread.getThread(threadId)) return json(res, 404, { error: "not found" });
        const snapshot = deps.turnEvents?.snapshot(threadId);
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (!snapshot) {
          res.write(`data: ${JSON.stringify({ type: "idle" })}\n\n`);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ type: "attached", startedAt: snapshot.startedAt })}\n\n`);
        for (const event of snapshot.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
        await new Promise<void>((resolve) => {
          const unsubscribe = deps.turnEvents!.subscribeStream(threadId, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            // `done`／`error` でそのターンは終わり——ここで閉じる
            if (event.type === "done" || event.type === "error") finish();
          });
          const finish = () => {
            unsubscribe();
            res.end();
            resolve();
          };
          // 画面が先に切れることもある（別の画面へ移った・閉じた）
          req.on("close", finish);
          // 覚えている途中経過が既に終わっていた場合（競走）——取りこぼさない
          if (!deps.turnEvents!.isRunning(threadId)) finish();
        });
        return;
      }

      const clearMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/clear$/);
      if (clearMatch && req.method === "POST") {
        try {
          await deps.projectThread.clearThread(clearMatch[1]!);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const threadCloseMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/close$/);
      if (threadCloseMatch && req.method === "POST") {
        try {
          await deps.projectThread.closeThread(threadCloseMatch[1]!);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const threadReopenMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/reopen$/);
      if (threadReopenMatch && req.method === "POST") {
        try {
          await deps.projectThread.reopenThread(threadReopenMatch[1]!);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const projectCloseMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/close$/);
      if (projectCloseMatch && req.method === "POST") {
        try {
          await deps.projectThread.closeProject(projectCloseMatch[1]!);
          // **畳んだら、その Project のために立てたものも落とす**（決定・2026-09-10）
          // ——記録だけ閉じてプロセスが残ると、鍵を持ったものまで生き残る
          const released = (await deps.releaseProjectModules?.(projectCloseMatch[1]!)) ?? [];
          json(res, 200, { ok: true, released });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      const projectReopenMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/reopen$/);
      if (projectReopenMatch && req.method === "POST") {
        try {
          await deps.projectThread.reopenProject(projectReopenMatch[1]!);
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      // MemoryはProjectが持つ（§1.1・§2.2、決定・2026-09-05）。Thread配下の
      // 旧経路は残さない——繋がっていない入口を画面の裏に残さない（規則13）。
      const memoryMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/memory$/);
      if (memoryMatch && req.method === "GET") {
        const project = deps.projectThread.getProject(memoryMatch[1]!);
        if (!project) return json(res, 404, { error: "not found" });
        json(
          res,
          200,
          project.memory.map((m) => ({
            seq: m.seq,
            text: m.text,
            invalidated: m.invalidatedAtSeq !== undefined,
            originThreadId: m.originThreadId,
          })),
        );
        return;
      }
      if (memoryMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { text: string };
        try {
          await deps.projectThread.appendMemory(memoryMatch[1]!, body.text);
          json(res, 201, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          if (err instanceof MemoryLimitExceededError) return json(res, 400, { error: err.message });
          throw err;
        }
        return;
      }

      const memoryInvalidateMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/memory\/(\d+)\/invalidate$/,
      );
      if (memoryInvalidateMatch && req.method === "POST") {
        try {
          await deps.projectThread.invalidateMemory(memoryInvalidateMatch[1]!, Number(memoryInvalidateMatch[2]));
          json(res, 200, { ok: true });
        } catch (err) {
          if (err instanceof NotFoundError) return json(res, 404, { error: "not found" });
          throw err;
        }
        return;
      }

      // Global Memory（§2.2、決定・2026-09-05）。Phase 0 では人が書くだけ
      // ——AIから書くtoolは開けない。
      if (url.pathname === "/api/global/memory" && req.method === "GET") {
        json(
          res,
          200,
          deps.globalMemory.list().map((m) => ({
            seq: m.seq,
            text: m.text,
            invalidated: m.invalidatedAtSeq !== undefined,
          })),
        );
        return;
      }
      if (url.pathname === "/api/global/memory" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { text: string };
        try {
          await deps.globalMemory.append(body.text);
          json(res, 201, { ok: true });
        } catch (err) {
          if (err instanceof MemoryLimitExceededError) return json(res, 400, { error: err.message });
          throw err;
        }
        return;
      }
      const globalMemoryInvalidateMatch = url.pathname.match(/^\/api\/global\/memory\/(\d+)\/invalidate$/);
      if (globalMemoryInvalidateMatch && req.method === "POST") {
        await deps.globalMemory.invalidate(Number(globalMemoryInvalidateMatch[1]));
        json(res, 200, { ok: true });
        return;
      }

      // ---- Module の画面（MCP Apps、決定・2026-09-06、§6.2）----------------
      //
      // banto は「どこに出すか」だけを決め、**中身は Module 発**。だから host は
      // 「どの tool が画面を持つか」「その画面の中身は何か」を中継するだけで、
      // 画面の作り方は知らない。

      // 画面を組み立てるのに要る住所。**推測ではなく host が答える**（規則3）
      if (url.pathname === "/api/ui-config" && req.method === "GET") {
        json(res, 200, { sandboxUrl: deps.sandboxPublicUrl ?? null });
        return;
      }

      const uiToolsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/ui-tools$/);
      if (uiToolsMatch && req.method === "GET") {
        json(res, 200, await listUiToolsForThread(deps, uiToolsMatch[1]!));
        return;
      }

      const uiResourceMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/ui-resource$/);
      if (uiResourceMatch && req.method === "GET") {
        const serverName = url.searchParams.get("server");
        const uri = url.searchParams.get("uri");
        if (!serverName || !uri) return json(res, 400, { error: "server と uri が要ります" });
        const modules = (await deps.resolveModuleClientsForThread?.(uiResourceMatch[1]!)) ?? [];
        const { status, body } = await readUiResource(modules, serverName, uri);
        json(res, status, body);
        return;
      }

      // **画面が自分の Module の tool を呼ぶときは、承認を求めない**
      // （改訂・2026-09-07、ユーザー指示。前は必ず承認を通していた）。
      //
      // 理由：**その画面を開いたのは人**である。人が開いた画面の中のボタンが、
      // その画面を出している Module 自身の tool を呼ぶのは、画面が仕事をして
      // いるだけで、「人の知らないうちに何かが起きる」ではない。設定を見るたびに
      // 承認を求めるのは、承認の意味を薄めるほうに働く。
      //
      // **AI からの tool 呼び出しは今までどおり承認ゲートを通る**（§6.0）
      // ——そちらは人が見ていないところで起きるので、性質が違う。
      //
      // **他の Module は呼べない。** 呼び先はその画面がどの Module のものかで
      // 決まる（フロントエンドが握っていて、画面は指定できない）。画面から
      // banto の API を直接叩くこともできない（別オリジン・合言葉を持たない）。
      //
      // 残る risk として記録する：Module 自身の画面が、その Module の危ない tool
      // （削除など）を黙って呼ぶことはできる。**Module を繋ぐこと自体が信頼の
      // 線引き**で、その手前は閉じ込め（Landlock）と可視性で守る。
      const uiCallMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/ui-tool-call$/);
      if (uiCallMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as {
          server?: unknown;
          tool?: unknown;
          arguments?: unknown;
        };
        if (typeof body.server !== "string" || typeof body.tool !== "string") {
          return json(res, 400, { error: "server と tool が要ります" });
        }
        const modules = (await deps.resolveModuleClientsForThread?.(uiCallMatch[1]!)) ?? [];
        const found = modules.find((m) => m.name === body.server);
        if (!found) return json(res, 404, { error: "unknown module", server: body.server });
        const refusal = await checkUiCallable(found.client, body.tool);
        if (refusal) return json(res, refusal.status, refusal.body);
        // 画面からの呼び出しでも、その tool が内部で他 Module を呼べば中継の承認が
        // 要る（§「Module 間中継の承認」）。**どの会話に出すか**をここで台帳に置く
        const endCall =
          deps.moduleCalls && found.connName
            ? deps.moduleCalls.begin(found.connName, uiCallMatch[1]!, "canvas")
            : undefined;
        try {
          json(
            res,
            200,
            await found.client.callTool(
              { name: body.tool, arguments: toolArguments(body.arguments), _meta: HUMAN_ADMIN_CALLER },
              undefined,
              UI_CALL_OPTIONS,
            ),
          );
        } finally {
          endCall?.();
        }
        return;
      }

      // ---- Project 単位の Canvas（設定画面、決定・2026-09-07）----------------
      //
      // **設定は Thread のものではない**（§6.2「iOS でアプリの設定が OS の設定に
      // 出てくるのと同じ形」）。Module は Project 単位で繋がっているので、
      // ここも Project 単位で開く。

      const projectSettingsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ui-settings$/);
      if (projectSettingsMatch && req.method === "GET") {
        const modules = (await deps.resolveModuleClientsForProject?.(projectSettingsMatch[1]!)) ?? [];
        // **Project ごとに立つ Module の設定だけ**（決定・2026-09-07、ユーザー指摘）
        // ——instance に1本の Module（Vault 等）の設定を Project ごとに出すのは
        // おかしい。置き場は**その Module の scope が決める**（規則3——別の
        // 判断基準を持たず、既にある scope から導く）
        json(res, 200, await listSettingsCanvases(modules.filter((m) => m.scope !== "instance")));
        return;
      }

      // **人が直接開ける入口**（launcher、§6.2、決定・2026-09-07）。
      // 「まずファイルを見たい」は AI に頼む用事ではない（要件C3）。
      // **その Project に繋がっている Module の入口だけ**——一覧は Module 集合から
      // 導出する（別の一覧を持たない、規則3）。
      const projectLaunchersMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ui-launchers$/);
      if (projectLaunchersMatch && req.method === "GET") {
        const modules = (await deps.resolveModuleClientsForProject?.(projectLaunchersMatch[1]!)) ?? [];
        json(res, 200, await listLauncherCanvases(modules));
        return;
      }

      // banto 全体（instance）の設定に出る Canvas——instance に1本の Module の分
      if (url.pathname === "/api/ui-settings" && req.method === "GET") {
        json(res, 200, await listSettingsCanvases((await deps.resolveInstanceModuleClients?.()) ?? []));
        return;
      }
      if (url.pathname === "/api/ui-resource" && req.method === "GET") {
        const serverName = url.searchParams.get("server");
        const uri = url.searchParams.get("uri");
        if (!serverName || !uri) return json(res, 400, { error: "server と uri が要ります" });
        const modules = (await deps.resolveInstanceModuleClients?.()) ?? [];
        const { status, body } = await readUiResource(modules, serverName, uri);
        json(res, status, body);
        return;
      }
      if (url.pathname === "/api/ui-tool-call" && req.method === "POST") {
        const body = (await readJsonBody(req)) as { server?: unknown; tool?: unknown; arguments?: unknown };
        if (typeof body.server !== "string" || typeof body.tool !== "string") {
          return json(res, 400, { error: "server と tool が要ります" });
        }
        const modules = (await deps.resolveInstanceModuleClients?.()) ?? [];
        const found = modules.find((m) => m.name === body.server);
        if (!found) return json(res, 404, { error: "unknown module", server: body.server });
        const refusal = await checkUiCallable(found.client, body.tool);
        if (refusal) return json(res, refusal.status, refusal.body);
        // 自分の Module を呼ぶのに承認は求めない（上の Thread 版と同じ理由）。
        // **ここも台帳に載せる**（追加・2026-09-12、実機で発覚）——Thread 版・
        // Project 版だけ載せていたので、banto 全体の設定画面から Module を呼び、
        // その Module が依存先を呼ぶと「どのターンからの呼び出しか特定できません」で
        // 必ず拒否されていた。**この口には載せるべき Thread が無い**ので出所だけ記録する
        const instanceModule = modules.find((m) => m.name === body.server) as
          | { connName?: string }
          | undefined;
        const endInstanceCall =
          deps.moduleCalls && instanceModule?.connName
            ? deps.moduleCalls.begin(instanceModule.connName, undefined, "canvas")
            : undefined;
        try {
          json(
            res,
            200,
            await found.client.callTool(
              { name: body.tool, arguments: toolArguments(body.arguments), _meta: HUMAN_ADMIN_CALLER },
              undefined,
              UI_CALL_OPTIONS,
            ),
          );
        } finally {
          endInstanceCall?.();
        }
        return;
      }

      const projectUiResourceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ui-resource$/);
      if (projectUiResourceMatch && req.method === "GET") {
        const serverName = url.searchParams.get("server");
        const uri = url.searchParams.get("uri");
        if (!serverName || !uri) return json(res, 400, { error: "server と uri が要ります" });
        const modules = (await deps.resolveModuleClientsForProject?.(projectUiResourceMatch[1]!)) ?? [];
        const { status, body } = await readUiResource(modules, serverName, uri);
        json(res, status, body);
        return;
      }

      const projectUiCallMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/ui-tool-call$/);
      if (projectUiCallMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { server?: unknown; tool?: unknown; arguments?: unknown };
        if (typeof body.server !== "string" || typeof body.tool !== "string") {
          return json(res, 400, { error: "server と tool が要ります" });
        }
        const modules = (await deps.resolveModuleClientsForProject?.(projectUiCallMatch[1]!)) ?? [];
        const found = modules.find((m) => m.name === body.server);
        if (!found) return json(res, 404, { error: "unknown module", server: body.server });
        const refusal = await checkUiCallable(found.client, body.tool);
        if (refusal) return json(res, refusal.status, refusal.body);
        // 設定画面も同じ——**自分の Module を呼ぶのに承認は求めない**
        // （改訂・2026-09-07、上の Thread 版と同じ理由）
        //
        // **ただし、その tool が内部で他 Module を呼ぶなら中継の承認は要る**
        // （追加・2026-09-12）。Thread 版は既に台帳へ置いていたが、Project 版は
        // 置いていなかったので、**Project の Canvas 発の中継は必ず
        // 「どのターンからの呼び出しか特定できません」で拒否されていた**
        // ——人が画面で操作しているのに、その先が構造的に通らない。
        // 出す先は**その Project の Base Thread**（決定・2026-09-07 と同じ
        // 場所。答える場所を増やさない）
        // 会話がまだ1本も無いなら台帳に置かない——**空の宛先を置くくらいなら
        // 置かない**（中継は「決められない」として拒否され、理由が人に出る）
        const baseThreadId = baseThreadIdOf(deps, projectUiCallMatch[1]!);
        const endCall =
          deps.moduleCalls && found.connName && baseThreadId
            ? deps.moduleCalls.begin(found.connName, baseThreadId, "canvas")
            : undefined;
        try {
          json(
            res,
            200,
            await found.client.callTool(
              { name: body.tool, arguments: toolArguments(body.arguments), _meta: HUMAN_ADMIN_CALLER },
              undefined,
              UI_CALL_OPTIONS,
            ),
          );
        } finally {
          endCall?.();
        }
        return;
      }

      // **フォルダを選べるようにする**（決定・2026-09-11、ユーザー要望）。
      // 返すのはフォルダの名前だけ——人が Root を選ぶための窓（`directories.ts`）
      if (url.pathname === "/api/fs/directories" && req.method === "GET") {
        try {
          json(res, 200, await listDirectories(url.searchParams.get("path") ?? undefined));
        } catch (err) {
          // **読めなかったことを、読めたように見せない**（規則2）
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // **その根を選ぶと何が見えるようになるか**（決定・2026-09-11、ユーザー）。
      // 広い根（home 等）を選ぶこと自体は止めない——**選ぶ前に見せる**ために、
      // 判断を host が1箇所で持つ（画面が home の場所を推測しない、規則3）
      if (url.pathname === "/api/config/root-scope" && req.method === "GET") {
        const path = url.searchParams.get("path");
        if (!path) return json(res, 400, { error: "path is required" });
        json(res, 200, describeRootScope(path, { dataDir: deps.dataDir ?? "", configDir: deps.configDir ?? "" }));
        return;
      }

      // **何も選ばれていないときのモード**（§6.4）。instance 既定と Project 上書きの
      // 2階層（§6.1）。**画面がまだ繋がっていない**ので、いまはこの口だけが入口
      const permissionDefaultMatch = url.pathname.match(/^\/api\/config\/default-permission-mode$/);
      if (permissionDefaultMatch && req.method === "GET") {
        const projectId = url.searchParams.get("projectId") ?? undefined;
        json(res, 200, {
          effective: resolvePermissionMode(
            undefined,
            undefined,
            deps.runtimeConfig?.resolve(DEFAULT_PERMISSION_MODE_KEY, projectId),
          ),
          instance: deps.runtimeConfig?.layerValue(DEFAULT_PERMISSION_MODE_KEY) ?? null,
          project: projectId
            ? (deps.runtimeConfig?.layerValue(DEFAULT_PERMISSION_MODE_KEY, projectId) ?? null)
            : null,
        });
        return;
      }
      if (permissionDefaultMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { mode?: unknown; projectId?: unknown };
        if (!deps.runtimeConfig) return json(res, 501, { error: "設定を保存できません" });
        const projectId = typeof body.projectId === "string" ? body.projectId : undefined;
        // **壊れた値は入れない**（規則2——黙って既定へ落とさない）
        if (body.mode === null) {
          if (!projectId) return json(res, 400, { error: "instance 既定は空にできません" });
          await deps.runtimeConfig.unsetProjectOverride(projectId, DEFAULT_PERMISSION_MODE_KEY);
          return json(res, 200, { ok: true });
        }
        if (!isThreadPermissionMode(body.mode)) {
          return json(res, 400, { error: `permissionMode の値が不正です: ${JSON.stringify(body.mode)}` });
        }
        if (projectId) await deps.runtimeConfig.setProjectOverride(projectId, DEFAULT_PERMISSION_MODE_KEY, body.mode);
        else await deps.runtimeConfig.setInstanceDefault(DEFAULT_PERMISSION_MODE_KEY, body.mode);
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/inbox" && req.method === "GET") {
        json(res, 200, deps.inbox.listOpen());
        return;
      }
      // お知らせを「見た」ことにする（決定・2026-09-07）。答えるものではないので
      // answer とは別の口——「決着させる」のと「読んだ」を混ぜない
      const inboxAckMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/acknowledge$/);
      if (inboxAckMatch && req.method === "POST") {
        const item = deps.inbox.get(inboxAckMatch[1]!);
        if (!item || item.kind !== "notice") return json(res, 404, { error: "not found" });
        await deps.inbox.acknowledgeNotice(item.id);
        json(res, 200, { ok: true });
        return;
      }

      const inboxAnswerMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/answer$/);
      if (inboxAnswerMatch && req.method === "POST") {
        const id = inboxAnswerMatch[1]!;
        const body = (await readJsonBody(req)) as { answer: unknown };
        // **決着させる前に、決着できるかを確かめる**（改訂・2026-09-06、見直し起点）。
        // 以前は無条件に answered を追記して 200 を返していたため、
        // host 再起動後の幽霊・二重回答・Elicitation由来のいずれでも
        // 「答えたのに何も起きない」のに人には成功に見えた（規則2）。
        const item = deps.inbox.get(id);
        if (!item || item.kind !== "judgment") return json(res, 404, { error: "not found" });
        if (item.liveness !== "live") {
          return json(res, 409, { error: "already settled", reason: item.liveness });
        }
        if (!isPermissionResult(body.answer)) {
          return json(res, 400, { error: "invalid answer" });
        }
        if (!deps.pendingApprovals.resolve(id, body.answer)) {
          // 待っている呼び出しがもう無い——hostの再起動でその走行が消えたか、
          // Elicitation由来（解決対象を持たない、§2.4.1）。
          // **決着させない**——「答えた」という嘘の記録を残さない
          return json(res, 409, { error: "no pending call", reason: "unresolvable" });
        }
        await deps.inbox.answerJudgment(id, body.answer);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      // **ヘッダを送った後は 500 を書けない**（決定・2026-09-06、見直し起点）。
      // SSEでターンを流し始めた後に例外が出ると、以前はここで writeHead が
      // ERR_HTTP_HEADERS_SENT を投げ、createServer の async ハンドラだったため
      // unhandled rejection で**host プロセスごと落ちていた**——1ターンの失敗が
      // 全 Project を道連れにする（規則2）。
      const message = err instanceof Error ? err.message : String(err);
      console.error("[host] リクエスト処理で例外:", message);
      if (res.headersSent) {
        // 流している途中なら、SSEのerrorイベントとして伝えてから閉じる
        if (!res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
          } catch {
            // 相手が既に切っている——ここで落とさない
          }
          res.end();
        }
        return;
      }
      json(res, 500, { error: message });
    }
  });
}
