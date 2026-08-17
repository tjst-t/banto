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
 * **例外は無くなった**（ADR-0023 決定113）。以前は
 *   POST {KOBO_MODULE_PATH}/projects/:proj/tasks/:id/approve
 * だけが合言葉（`BANTO_PO_TOKEN`）を要求していたが、PO からは「自分専用の画面でなぜ
 * 毎回名乗らされるのか」＝**OK を出せないのと同じ**と見えていた（imp-0034）。
 * 分ける境界を「合言葉の有無」から「**Tool の経路か、人が押した経路か**」へ移し、
 * 監査可能性は名乗りではなく**記録**（`via`）で担保する。
 * この口は他の口と同じく前段と待ち受けアドレスで守る。
 *
 * **PO の判断はこの1つの口に集める**：
 *   POST {KOBO_MODULE_PATH}/projects/:proj/tasks/:id/po-decision   {decision, via, ...}
 * 承認だけでなく差し戻しも通る——PO の意思表示の口を判断の種類ごとに増やさない（D3）。
 *
 * D5: all logic delegated to Daemon class; this file is pure routing.
 * D6: node:http (no framework dependency).
 * I2: errors thrown from handlers propagate to 500 response.
 */

import * as http from "node:http";
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
        toolCallProvenModelNames: () => daemon.toolCallProvenModelNames(),
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

    // **PO の判断を工場へ届ける口**（PO裁定 2026-08-11・第0波 0-3、ADR-0023 決定113）。
    //
    // **番頭の `kobo.*` とは名乗る者が違う**。レビュー段が `po` と判定されたタスク
    // （統治コード・PO 必須の面）は番頭には通せず、ここが `by: "po"` として帳簿に書く
    // 唯一の口になる。
    //
    // **承認専用にしない**（PO要望 2026-08-15）。届けたいのは「PO がどう答えたか」であって
    // 承認だけではない——差し戻しも同じ経路に乗る。`kobo.amend` のように `by: "banto"` を
    // 直書きしている道具にも、後から `decision` を足せばこの経路を再利用できる。
    //
    // **合言葉は要求しない**（決定113）。番頭（LLM）を分けているのは名乗りではなく
    // **経路**——番頭に渡っている Tool は `by: "banto"` しか渡さず、この口は Tool の
    // 名前空間（`/tools/*`）の外にあり、番頭ホストの中継はそこを通さない。合言葉を
    // 条件にすると PO にとっては「OK を出せない」のと同じだった（imp-0034）。
    //
    // 代わりに **`via` を要る形にする**——どの画面のどの操作から来た意思表示かを
    // 帳簿へ書く。監査可能性は名乗りではなく記録で担保する（決定113）。
    //
    // 通しても関所は飛ばない（決定57）。この後にマージ前ゲートが回るのは番頭経由と同じ。
    //
    // D5: 判断は `daemon.approveTask` / `daemon.sendBackTask` にある。ここは routing だけ。
    {
      method: "POST",
      pattern: new RegExp(`^${KOBO_MODULE_PATH}/projects/([^/]+)/tasks/([^/]+)/po-decision$`),
      handler: async (req, res, match) => {
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
        const via = typeof body["via"] === "string" ? body["via"].trim() : "";
        // I2: 出どころ不明の PO 判断を黙って受けない。合言葉をやめた以上、
        //     帳簿に何も残らない承認は「誰が通したか分からない」を作る
        if (!via) {
          sendJson(res, 400, {
            error: "via_required",
            message:
              "via（どの画面のどの操作から来た判断か）を添えてください" +
              "——PO の判断は出どころを帳簿に残します（決定113）",
          });
          return;
        }

        const decision = body["decision"];
        if (decision === "approve") {
          const note = typeof body["note"] === "string" ? body["note"] : undefined;
          const result = daemon.approveTask(proj, taskId, {
            by: "po",
            via,
            ...(note ? { note } : {}),
          });
          // I2: 通せなかったことを success:true で包まない。理由をそのまま返す
          if (!result.ok) {
            sendJson(res, 409, { error: "not_approvable", message: result.reason });
            return;
          }
          sendJson(res, 200, { success: true, state: result.status });
          return;
        }

        if (decision === "send_back") {
          const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
          // I2: 理由の無い差し戻しは職人に何も伝わらない。黙って戻さない
          if (!reason) {
            sendJson(res, 400, {
              error: "reason_required",
              message: "reason（何が駄目で、どう直すのか）を添えてください——職人にそのまま渡ります",
            });
            return;
          }
          const result = await daemon.sendBackTask(proj, taskId, { by: "po", via, reason });
          if (!result.ok) {
            sendJson(res, 409, { error: "not_sendable_back", message: result.reason });
            return;
          }
          sendJson(res, 200, { success: true, state: result.to });
          return;
        }

        // I2: 知らない判断を黙って承認に倒さない（緩い側へ落ちるのが一番たちが悪い）
        sendJson(res, 400, {
          error: "unknown_decision",
          message: `decision は "approve" か "send_back" です（受け取った値: ${String(decision)}）`,
        });
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
