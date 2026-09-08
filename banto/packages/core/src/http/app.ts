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
  NotFoundError,
  type ProjectThreadStore,
} from "../project-thread/store.js";
import type { GlobalMemoryStore } from "../global-memory/store.js";
import type { InboxStore } from "../inbox/store.js";
import type { ThreadPermissionMode } from "../project-thread/types.js";
import type { HostRelayEndpoint } from "../relay/host-relay-endpoint.js";
import type { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { runThreadTurn, type ModuleEndpoint, type RunThreadTurnInput } from "./turn-runner.js";

/**
 * Module の画面（MCP Apps）のために host が Module へ問い合わせる分だけ
 * （決定・2026-09-06）。**MCP の Client をそのまま渡せる形**にしてある
 * ——独自の入れ物を作らない（規則12）。
 */
export interface ModuleClientLike {
  listTools(): Promise<{ tools: unknown[] }>;
  listResources(): Promise<{ resources: unknown[] }>;
  readResource(params: { uri: string }): Promise<{ contents: unknown[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
}

export interface AppDeps {
  projectThread: ProjectThreadStore;
  /** banto全体で覚えていること（§2.2 Global Memory、決定・2026-09-05）。 */
  globalMemory: GlobalMemoryStore;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
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
  ): Promise<Array<{ name: string; client: ModuleClientLike }>>;
  /** Project 単位（設定画面は Thread ではなく Project のもの、決定・2026-09-07）。
   *  `scope` は**設定をどちらの画面に出すか**を決めるのに使う。 */
  resolveModuleClientsForProject?(
    projectId: string,
  ): Promise<Array<{ name: string; client: ModuleClientLike; scope?: "instance" | "project" }>>;
  /** banto 全体（instance）で1本の Module（決定・2026-09-07、ユーザー指摘）。
   *  その設定は Project ごとではなく、全体の設定画面に出す。 */
  resolveInstanceModuleClients?(): Promise<Array<{ name: string; client: ModuleClientLike }>>;
  /** 画面から見たサンドボックスの住所（§6.2）。画面に推測させない（規則3）。 */
  sandboxPublicUrl?: string;
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
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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
): ThreadPermissionMode | undefined {
  if (isThreadPermissionMode(fromRequest)) return fromRequest;
  return thread?.permissionMode;
}

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
    ({ contents } = await found.client.readResource({ uri }));
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

      const projectThreadsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/threads$/);
      if (projectThreadsMatch && req.method === "GET") {
        json(res, 200, deps.projectThread.listThreadsForProject(projectThreadsMatch[1]!));
        return;
      }
      if (projectThreadsMatch && req.method === "POST") {
        const thread = await deps.projectThread.createBaseThread(projectThreadsMatch[1]!);
        json(res, 201, thread);
        return;
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
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
        try {
          const thread = await deps.projectThread.forkThread(forkMatch[1]!);
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
          ),
          modules,
          cwd,
        })) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
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
          json(res, 200, { ok: true });
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
        json(res, 200, await found.client.callTool({ name: body.tool, arguments: toolArguments(body.arguments) }));
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
        // 自分の Module を呼ぶのに承認は求めない（上の Thread 版と同じ理由）
        json(res, 200, await found.client.callTool({ name: body.tool, arguments: toolArguments(body.arguments) }));
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
        // 設定画面も同じ——**自分の Module を呼ぶのに承認は求めない**
        // （改訂・2026-09-07、上の Thread 版と同じ理由）
        json(res, 200, await found.client.callTool({ name: body.tool, arguments: toolArguments(body.arguments) }));
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
