/**
 * 工場の面（`kobo.board` / `kobo.review`）を**実物として描かせる**ための偽ホスト。
 *
 * PO 報告 2026-08-07：「キャンバスの工場のUIもレビューのUIも壊れていて使い物にならない」。
 * 直したかどうかは**見て確かめる**しかないので、ビルド済みのUIを配り、
 * `kobo.*` の Tool にだけ答えるホストをその場で立てる。
 *
 * **常駐している番頭ホストには繋がない**（`layoutHost.ts` と同じ理由）。
 *
 * 前提: `npm run build:web` 済み（`packages/banto-web/dist`）。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");
const THREAD_ID = "t-1";

export interface KoboHost {
  readonly port: number;
  close(): Promise<void>;
}

/** 状態機械のひととおりを埋めた検体。**列が全部埋まっている状態**を見たい。 */
const TASKS = [
  { taskId: "task-0101", projectTag: "loamium", status: "queued", title: "検索の索引を貼り直す" },
  { taskId: "task-0102", projectTag: "loamium", status: "ready", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認と ROADMAP 更新" },
  { taskId: "task-0103", projectTag: "loamium", status: "planning", title: "エディタの折り返しを直す" },
  { taskId: "task-0104", projectTag: "loamium", status: "implementing", title: "同期のリトライを指数後退にする" },
  { taskId: "task-0105", projectTag: "loamium", status: "auditing", title: "画像の貼り付けを Electron でも通す" },
  { taskId: "task-0106", projectTag: "loamium", status: "review-ready", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認（監査再試行・task-0001 引き継ぎ）" },
  { taskId: "task-0107", projectTag: "loamium", status: "in-review", title: "設定画面の言葉遣いを揃える" },
  { taskId: "task-0108", projectTag: "loamium", status: "approved", title: "起動時のマイグレーションを冪等にする" },
  { taskId: "task-0109", projectTag: "loamium", status: "merging", title: "リンク解決のキャッシュを足す" },
  { taskId: "task-0110", projectTag: "loamium", status: "failed", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認と ROADMAP 更新" },
  { taskId: "task-0111", projectTag: "loamium", status: "failed", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認（監査再試行・task-0001 引き継ぎ）" },
  { taskId: "task-0112", projectTag: "loamium", status: "merged", title: "vault の走査を打ち切れるようにする" },
  { taskId: "task-0113", projectTag: "loamium", status: "closed", title: "ノートの並び替えを安定にする" },
];

const HISTORY = [
  { at: "2026-08-07T02:40:46.998Z", type: "task_created" },
  { at: "2026-08-07T02:40:46.999Z", type: "state_transitioned", detail: "draft → queued（watcher-ingest）" },
  { at: "2026-08-07T02:40:47.006Z", type: "gate_evaluated", detail: "通過" },
  { at: "2026-08-07T02:40:58.773Z", type: "agent_spawned", sessionId: "sess-abc123" },
  { at: "2026-08-07T03:01:56.016Z", type: "state_transitioned", detail: "implementing → auditing" },
  { at: "2026-08-07T03:19:47.171Z", type: "audit_verdict", detail: "pass" },
];

function taskDetail(taskId: string, rows: typeof TASKS): Record<string, unknown> {
  // 一覧が空でも `kobo.task` は呼ばれうる（開きっぱなしのまま列が空になった等）
  const row = rows.find((t) => t.taskId === taskId) ?? rows[0] ?? TASKS[0]!;
  return {
    task: {
      id: row.taskId,
      projectTag: row.projectTag,
      status: row.status,
      title: row.title,
      kind: "improvement",
      originRef: "PO から「Tauri の骨格が本当に揃っているか確かめて」と言われた",
      scope: { paths: ["packages/app-tauri/**", "docs/ROADMAP.json"] },
      acceptance: [
        { id: "a1", text: "packages/app-tauri/ が存在し、src-tauri/ 配下に Cargo.toml・tauri.conf.json・src/main.rs がある", verify: "test -f packages/app-tauri/src-tauri/Cargo.toml" },
        { id: "a2", text: "tauri.conf.json に externalBin が設定されている", verify: "grep -q externalBin packages/app-tauri/src-tauri/tauri.conf.json" },
        { id: "a3", text: "既存のテスト（vitest）が全件通る", verify: "npm test" },
      ],
    },
    reviewStage: "banto",
    history: HISTORY,
    // **落ちているなら理由が付く**（task-0081）。番号だけでは直せないので、
    // 検証ログの末尾まで返るのが本物の形——偽ホストもそこを真似る
    ...(row.status === "failed"
      ? {
          failure: {
            reason: "merge_gate_failed: verify_failed:a4(exit=1)",
            gateReasons: ["verify_failed:a4(exit=1)"],
            logs: [
              {
                acId: "a4",
                dir: "/var/lib/banto/data/gate-logs/task-0110/a4",
                tail: "FAIL tests/acceptance/export.spec.ts\nError: 期待した値と違います\nexit 1",
              },
            ],
            reopenCount: 2,
          },
        }
      : {}),
    envUrl: row.status === "in-review" ? "https://env-abc123.ndev.example.net/" : undefined,
    audit: { verdict: "pass", findings: [] },
  };
}

/**
 * 本物の `kobo.list` と同じ既定（prop-0001 第1段）。
 *
 * **偽ホストでも既定を本物に合わせる。** ここで全件返してしまうと、
 * 「既定では片が付いたものが出ない」という肝心の振る舞いを面の検体が確かめられない。
 */
const DEFAULT_LIST_STATES = new Set([
  "queued", "ready", "planning", "implementing", "auditing",
  "review-ready", "in-review", "approved", "merging", "paused",
  // 終端だが放っておいてよいものではない（→ kobo-tools.ts の同名の集合）
  "failed",
]);

function listRows(rows: typeof TASKS, args: Record<string, unknown>): typeof TASKS {
  const state = args["state"];
  if (state === "all") return rows;
  if (typeof state === "string") return rows.filter((t) => t.status === state);
  return rows.filter((t) => DEFAULT_LIST_STATES.has(t.status));
}

const TOOLS: Record<string, (args: Record<string, unknown>) => Record<string, unknown>> = {
  "kobo.list": (args) => {
    const rows = listRows(TASKS, args);
    return { tasks: rows, total: rows.length, truncated: false };
  },
  "kobo.projects": () => ({ projects: [{ id: "loamium", repoPath: "/home/ubuntu/ghq/github.com/tjst-t/loamium" }] }),
  "kobo.task": (args) => taskDetail(String(args["taskId"] ?? ""), TASKS),
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * @param options.tasks 差し替える一覧（空にすると「判断待ちなし」の面が見られる）
 */
export async function startKoboHost(
  options: { tasks?: typeof TASKS; active?: "board" | "review" } = {}
): Promise<KoboHost> {
  const rows = options.tasks ?? TASKS;
  TOOLS["kobo.task"] = (args) => taskDetail(String(args["taskId"] ?? ""), rows);
  TOOLS["kobo.list"] = (args) => {
    const shown = listRows(rows, args);
    return { tasks: shown, total: shown.length, truncated: false };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // モジュールの Tool の口（決定25：人はGUI→モジュールのデータAPI）
    const toolMatch = /^\/api\/kobo\/tools\/(.+)$/.exec(url.pathname);
    if (toolMatch) {
      let body = "";
      req.on("data", (c) => (body += String(c)));
      req.on("end", () => {
        const name = decodeURIComponent(toolMatch[1]!);
        const args = (JSON.parse(body || "{}") as { args?: Record<string, unknown> }).args ?? {};
        const handler = TOOLS[name];
        if (!handler) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `no tool: ${name}` }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [], details: handler(args) }));
      });
      return;
    }

    // ビルド済みのUIを配る
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const file = path.join(WEB_DIST, rel);
    if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end(fs.readFileSync(path.join(WEB_DIST, "index.html")));
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;

  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    const send = (msg: unknown): void => socket.send(JSON.stringify(msg));
    send({
      type: "welcome",
      sessionId: "fake",
      threads: [
        {
          threadId: THREAD_ID,
          title: "会話",
          sessionId: "fake",
          isDefault: true,
          state: "open",
          streaming: false,
          model: { provider: "fake", id: "fake", vision: false },
        },
      ],
      defaultThreadId: THREAD_ID,
      tools: [],
      catalog: [
        {
          kind: "kobo.board",
          title: "工場",
          description: "工場のボード",
          component: "KoboBoard",
          category: "workspace",
          module: "kobo",
          endpoint: "/api/kobo",
        },
        {
          kind: "kobo.review",
          title: "レビュー",
          description: "判断待ち",
          component: "KoboReview",
          category: "workspace",
          module: "kobo",
          endpoint: "/api/kobo",
        },
      ],
    });
    send({ type: "history", threadId: THREAD_ID, entries: [] });
    send({
      type: "canvas_state",
      threadId: THREAD_ID,
      tabs: [
        { id: "tab-board", kind: "kobo.board", title: "工場", params: {}, rev: 1 },
        { id: "tab-review", kind: "kobo.review", title: "レビュー", params: {}, rev: 1 },
      ],
      activeTabId: options.active === "review" ? "tab-review" : "tab-board",
    });
  });

  return {
    port,
    async close(): Promise<void> {
      for (const s of sockets) s.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
