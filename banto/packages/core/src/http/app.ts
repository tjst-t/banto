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
import type { InboxStore } from "../inbox/store.js";
import type { HostRelayEndpoint } from "../relay/host-relay-endpoint.js";
import type { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { runThreadTurn, type ModuleEndpoint, type RunThreadTurnInput } from "./turn-runner.js";

export interface AppDeps {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  relayEndpoint: HostRelayEndpoint;
  /** Runner向け（/agent-relay/<module名>）。resolveModulesForThreadが返すModuleを実際に配信する。 */
  agentRelayEndpoint: AgentRelayEndpoint;
  authToken: string;
  /** そのThreadで使えるModule（名前とRunner接続先URL）の一覧を返す（Project単位の配線）。
   *  Shell/FileSystemはProject単位で遅延spawnするため非同期。 */
  resolveModulesForThread(threadId: string): Promise<ModuleEndpoint[]>;
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
        for await (const event of runThreadTurn(deps, {
          threadId: turnMatch[1]!,
          prompt: body.prompt,
          permissionMode: body.permissionMode,
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

      const memoryMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/memory$/);
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

      const memoryInvalidateMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/memory\/(\d+)\/invalidate$/);
      if (memoryInvalidateMatch && req.method === "POST") {
        await deps.projectThread.invalidateMemory(memoryInvalidateMatch[1]!, Number(memoryInvalidateMatch[2]));
        json(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/inbox" && req.method === "GET") {
        json(res, 200, deps.inbox.listOpen());
        return;
      }
      const inboxAnswerMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/answer$/);
      if (inboxAnswerMatch && req.method === "POST") {
        const body = (await readJsonBody(req)) as { answer: unknown };
        await deps.inbox.answerJudgment(inboxAnswerMatch[1]!, body.answer);
        // tool呼び出しの承認待ちなら、ここでcanUseToolのPromiseを解決する
        // ——Elicitation由来の判断待ちは解決対象を持たないため何もしない
        // （§2.4.1、PendingApprovalRegistry参照）。
        deps.pendingApprovals.resolve(inboxAnswerMatch[1]!, body.answer as Parameters<PendingApprovalRegistry["resolve"]>[1]);
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}
