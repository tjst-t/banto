/**
 * HTTP API server for banto-daemon.
 *
 * Routes (minimum per story S654396-3):
 *   GET  /api/v1/health
 *   GET  /api/v1/projects
 *   POST /api/v1/projects                              → 201
 *   GET  /api/v1/projects/:proj/tasks
 *   GET  /api/v1/projects/:proj/tasks/:id
 *   GET  /api/v1/projects/:proj/tasks/:id/events
 *   POST /api/v1/projects/:proj/tasks                  → task_created (draft)
 *   POST /api/v1/projects/:proj/tasks/:id/transition   → state transition
 *   GET  /api/v1/tasks/:proj/:id                       → global reference (spec §2)
 *
 * Error responses: JSON { "error": "..." }
 *
 * **原則として認証は持たない。守るのは前段と待ち受けアドレス**（ADR-0010 決定40、task-0061）。
 * この口は帳簿を書き換えられる（状態遷移・監査判定）ので、**既定では 127.0.0.1 だけ**が
 * 届く（`DaemonConfig.bindHost`）。広げるのは明示のときだけで、そのときは起動ログに
 * 警告が出る——番頭側を 127.0.0.1 に閉じた隣で、無認証の口が黙って開いている状態を作らない。
 *
 * **例外は1つだけ**（PO裁定 2026-08-11・第0波 0-3）：
 *   POST {KOBO_MODULE_PATH}/projects/:proj/tasks/:id/approve   → PO 専用（合言葉が要る）
 * ここは「番頭ではなく PO が通した」を帳簿に書く口なので、届くこと＝名乗れることでは困る。
 * 合言葉は `BANTO_PO_TOKEN`（`DaemonConfig.poToken`）。未設定なら口は閉じたまま（503）。
 *
 * D5: all logic delegated to Daemon class; this file is pure routing.
 * D6: node:http (no framework dependency).
 * I2: errors thrown from handlers propagate to 500 response.
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import { MODULE_TOOL_PATH, createSettingsTools } from "@banto/core";
import type { Daemon } from "./daemon.js";
import { createKoboTools } from "./kobo-tools.js";
import { createKoboSettings } from "./kobo-settings.js";

/** モジュールとしての到達先（`{baseUrl}/tools/{名前}`）。決定27b。 */
export const KOBO_MODULE_PATH = "/api/kobo";

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  match: RegExpMatchArray
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

/** Sentinel error class to distinguish client-caused parse errors from server errors. */
class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

/**
 * PO が名乗れているか（PO裁定 2026-08-11・第0波 0-3）。
 *
 * **決定40 の唯一の例外**。この口は「番頭ではなく PO が通した」を帳簿に書くので、
 * 待ち受けアドレスだけでは足りない——同じ機械に届く者はみな PO を名乗れてしまう。
 *
 * 合言葉が未設定なら口は**閉じたまま**（`unconfigured`）。無設定を「素通し」にすると、
 * 設定し忘れた本番で誰でも承認できる状態が黙って出来上がる（I2）。
 */
function checkPoAuth(
  req: http.IncomingMessage,
  expected: string | undefined
): "ok" | "unconfigured" | "denied" {
  if (!expected) return "unconfigured";
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && /^Bearer\s+/i.test(header)
    ? header.replace(/^Bearer\s+/i, "")
    : undefined;
  const raw = req.headers["x-banto-po-token"];
  const presented = bearer ?? (typeof raw === "string" ? raw : undefined);
  if (!presented) return "denied";
  // 長さが違えば timingSafeEqual は投げる。先に長さで弾く（漏れるのは長さだけ）
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return "denied";
  return crypto.timingSafeEqual(a, b) ? "ok" : "denied";
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        // I2: reject with a typed error so callers can distinguish client
        // malformed-JSON (→ 400) from server errors (→ 500).
        reject(new BadRequestError("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function createHttpServer(daemon: Daemon): http.Server {
  // 決定27b の呼び出し規約で公開する Tool（番頭ホストはここへ繋ぐ）。
  // 設定の口（決定41）も同じ面に出す——工場は独立プロセスなので、設定画面は
  // `kobo.settings_read` / `kobo.settings_write` を HTTP で叩く（task-0066 と同じ形）
  const koboTools = [...createKoboTools(daemon), ...createSettingsTools(
      "kobo",
      createKoboSettings({
        roleAssignments: () => daemon.roleAssignments(),
        setRoleAssignments: (next) => daemon.setRoleAssignments(next),
        selectableModelNames: () => daemon.selectableModelNames(),
        selectableModels: () => daemon.selectableModels(),
      })
    )];

  const routes: Route[] = [
    // Health check
    {
      method: "GET",
      pattern: /^\/api\/v1\/health$/,
      handler: async (_req, res) => {
        sendJson(res, 200, { status: "ok" });
      },
    },

    // Daemon-wide event log (all events, including daemon-internal ones)
    {
      method: "GET",
      pattern: /^\/api\/v1\/events$/,
      handler: async (_req, res) => {
        const events = daemon.getAllEvents();
        sendJson(res, 200, { events });
      },
    },

    // いま着手できる仕事（task-0001・spec-daemon-core §6）。
    // **判定の真実は1つ**（D3）：番頭も CLI も自動着手も同じ導出を見る
    {
      method: "GET",
      pattern: /^\/api\/v1\/ready$/,
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const projectTag = url.searchParams.get("project") ?? undefined;
        if (projectTag && !daemon.projectExists(projectTag)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        sendJson(res, 200, { tasks: daemon.readyTasks(projectTag) });
      },
    },

    // List projects
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects$/,
      handler: async (_req, res) => {
        const projects = daemon.listProjects();
        sendJson(res, 200, { projects });
      },
    },

    // Register project
    {
      method: "POST",
      pattern: /^\/api\/v1\/projects$/,
      handler: async (req, res) => {
        const body = (await readBody(req)) as Record<string, unknown>;
        const id = body["id"];
        const repoPath = body["repoPath"];
        const profile = typeof body["profile"] === "string" ? body["profile"] : "default";
        if (typeof id !== "string" || typeof repoPath !== "string") {
          sendJson(res, 400, { error: "id and repoPath are required" });
          return;
        }
        try {
          const entry = daemon.registerProject(id, repoPath, profile);
          sendJson(res, 201, { id: entry.id });
        } catch (err) {
          sendJson(res, 409, { error: String(err instanceof Error ? err.message : err) });
        }
      },
    },

    // List tasks for a project
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const tasks = daemon.getTasksByProject(proj);
        sendJson(res, 200, { tasks });
      },
    },

    // Get task detail
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        const taskId = match[2];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        sendJson(res, 200, { task });
      },
    },

    // Get all events for a project (including daemon-internal tick_job_failed etc.)
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/events$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const events = daemon.getProjectEvents(proj);
        sendJson(res, 200, { events });
      },
    },

    // Get task events
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/events$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        const taskId = match[2];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const events = daemon.getTaskEvents(proj, taskId);
        sendJson(res, 200, { events });
      },
    },

    // Create task (→ draft)
    {
      method: "POST",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks$/,
      handler: async (req, res, match) => {
        const proj = match[1];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const body = (await readBody(req)) as Record<string, unknown>;
        const taskId = body["id"];
        const title = body["title"];
        if (typeof taskId !== "string" || typeof title !== "string") {
          sendJson(res, 400, { error: "id and title are required" });
          return;
        }
        try {
          const task = daemon.createTask(proj, taskId, title, body);
          sendJson(res, 201, { task });
        } catch (err) {
          sendJson(res, 409, { error: String(err instanceof Error ? err.message : err) });
        }
      },
    },

    // Transition task state
    {
      method: "POST",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/transition$/,
      handler: async (req, res, match) => {
        const proj = match[1];
        const taskId = match[2];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const body = (await readBody(req)) as Record<string, unknown>;
        const to = body["to"];
        if (typeof to !== "string") {
          sendJson(res, 400, { error: "to is required" });
          return;
        }
        const result = daemon.transition(proj, taskId, to, body["reason"] as string | undefined);
        if (!result.ok) {
          sendJson(res, 400, { error: result.reason });
          return;
        }
        const updatedTask = daemon.getTask(proj, taskId);
        sendJson(res, 200, { task: updatedTask });
      },
    },

    // Audit verdict report (S75f66b-3)
    // Called by the audit session's audit_report tool.
    // D5: all routing/rework logic in daemon.handleAuditVerdict; this is pure routing.
    {
      method: "POST",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/audit-report$/,
      handler: async (req, res, match) => {
        const proj = match[1];
        const taskId = match[2];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const body = (await readBody(req)) as Record<string, unknown>;
        const verdict = body["verdict"];
        if (verdict !== "pass" && verdict !== "fail") {
          sendJson(res, 400, { error: "verdict must be 'pass' or 'fail'" });
          return;
        }
        const rawFindings = body["findings"];
        const findings = Array.isArray(rawFindings)
          ? rawFindings.map(String)
          : [];
        try {
          const result = daemon.handleAuditVerdict(proj, taskId, verdict, findings);
          sendJson(res, 200, result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.startsWith("task_not_found")) {
            sendJson(res, 404, { error: msg });
          } else if (msg.startsWith("task_wrong_state")) {
            sendJson(res, 400, { error: msg });
          } else {
            throw err; // propagate to 500 handler (I2)
          }
        }
      },
    },

    // List all events for a project (includes task_ingest_rejected, etc.)
    {
      method: "GET",
      pattern: /^\/api\/v1\/projects\/([^/]+)\/events$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const events = daemon.getProjectEvents(proj);
        sendJson(res, 200, { events });
      },
    },

    // Global reference: GET /api/v1/tasks/:proj/:id (spec-multi-project §2)
    {
      method: "GET",
      pattern: /^\/api\/v1\/tasks\/([^/]+)\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const proj = match[1];
        const taskId = match[2];
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        sendJson(res, 200, { task });
      },
    },

    // PO が自分で通す口（PO裁定 2026-08-11・第0波 0-3）。
    //
    // **番頭の `kobo.approve` とは名乗る者が違う**。レビュー段が `po` と判定されたタスク
    // （統治コード・PO 必須の面）は番頭には通せず、いままで PO 自身がブラウザから通す経路が
    // 無かった——ここが `approvedBy: "po"` として帳簿に書く唯一の口になる。
    //
    // 通しても関所は飛ばない（決定57）。この後にマージ前ゲートが回るのは番頭経由と同じ。
    //
    // D5: 判断は `daemon.approveTask` にある。ここがするのは名乗りの照合と routing だけ。
    {
      method: "POST",
      pattern: new RegExp(`^${KOBO_MODULE_PATH}/projects/([^/]+)/tasks/([^/]+)/approve$`),
      handler: async (req, res, match) => {
        const auth = checkPoAuth(req, daemon.poToken());
        if (auth === "unconfigured") {
          sendJson(res, 503, {
            error: "po_token_not_configured",
            message:
              "PO の合言葉が設定されていないため、この口は閉じています。" +
              "BANTO_PO_TOKEN を設定して Kobo を起動し直してください",
          });
          return;
        }
        if (auth === "denied") {
          res.setHeader("WWW-Authenticate", 'Bearer realm="kobo-po"');
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        const proj = decodeURIComponent(match[1] ?? "");
        const taskId = decodeURIComponent(match[2] ?? "");
        if (!daemon.projectExists(proj)) {
          sendJson(res, 404, { error: "project_not_found" });
          return;
        }
        const task = daemon.getTask(proj, taskId);
        if (!task) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        const body = (await readBody(req)) as Record<string, unknown>;
        const note = typeof body["note"] === "string" ? body["note"] : undefined;

        const result = daemon.approveTask(proj, taskId, {
          by: "po",
          ...(note ? { note } : {}),
        });
        // I2: 通せなかったことを success:true で包まない。理由をそのまま返す
        if (!result.ok) {
          sendJson(res, 409, { error: "not_approvable", message: result.reason });
          return;
        }
        sendJson(res, 200, { success: true, state: result.status });
      },
    },

    // モジュール規約の口（決定27b・ADR-0013 の帰結）。`{baseUrl}/tools/{名前}` への POST で
    // `kobo.*` を公開する。番頭ホストはここへ繋いで積む・読む——REST を継ぎ足すのではなく、
    // **他のモジュールと同じ契約**（Tool）で話す。REST の /api/v1/* は既存の利用者
    // （kobo CLI・pi 拡張）のために残す
    {
      method: "POST",
      pattern: new RegExp(`^${KOBO_MODULE_PATH}${MODULE_TOOL_PATH}(.+)$`),
      handler: async (req, res, match) => {
        const toolName = decodeURIComponent(match[1] ?? "");
        const tool = koboTools.find((t) => t.name === toolName);
        if (!tool) {
          // I2: 知らない Tool を黙って空で返さない。持っているものを添える
          sendJson(res, 404, {
            error: `Kobo has no tool "${toolName}". Available: ${koboTools.map((t) => t.name).join(", ")}`,
          });
          return;
        }
        const body = (await readBody(req)) as { args?: Record<string, unknown> };
        try {
          const result = await tool.execute((body?.args ?? {}) as never, {
            toolCallId: `http-${Date.now()}`,
          });
          sendJson(res, 200, result);
        } catch (err) {
          // I2: Tool の失敗を 200 で包まない
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      },
    },

    // 検証環境の面（GET /environments・provision・teardown・run・collect・artifacts）は
    // **Environment Pool の Tool 面へ移した**（ADR-0013 決定58・60）。Kobo が自分の REST に
    // 環境の口を持つと、台帳を持たないのに操作だけ受ける中継役になり、決定27b が避けた
    // ブローカーと同じ形になる。番頭も UI も `env.*` を Environment Pool へ直接呼ぶ。
  ];

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url?.split("?")[0] ?? "/";

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = url.match(route.pattern);
      if (!match) continue;

      route.handler(req, res, match).catch((err: unknown) => {
        if (err instanceof BadRequestError) {
          // Client sent malformed JSON: return 400 with structured error (I2: not swallowed).
          if (!res.headersSent) {
            sendJson(res, 400, { error: err.message });
          }
          return;
        }
        // I2: all other internal errors are surfaced as 500 (not swallowed).
        process.stderr.write(`[banto-daemon] HTTP handler error: ${String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    // No route matched
    sendJson(res, 404, { error: "not_found" });
  });

  return server;
}
