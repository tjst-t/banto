/**
 * 設定面のブラウザ試験が使う偽ホスト。
 *
 * **常駐している番頭ホストには繋がない**（`layoutHost.ts` と同じ理由）。ビルド済みのUIを
 * 配り、設定面が要る口だけを喋る：区画の宣言（`settings.describe`）と、そこに埋まる
 * LLM の面が読むデータ（`llm.list`）。
 *
 * 見たいのは**埋まったビューの中でホイールが効くか**なので、LLM のデータは
 * 「器より確実に高くなる件数」であれば足りる。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");

export interface SettingsHost {
  readonly port: number;
  close(): Promise<void>;
}

/** 縦に溢れさせるためのモデル一覧（採用済み＝画面に並ぶ）。 */
const MODELS = Array.from({ length: 40 }, (_, i) => ({
  providerId: "demo-provider",
  id: `demo-model-${String(i).padStart(2, "0")}`,
  name: `見本モデル ${i}`,
  tier: (["reasoning", "standard", "fast"] as const)[i % 3],
  vision: i % 2 === 0,
  contextWindow: 128_000,
  cost: { input: 1, output: 5 },
  free: false,
  hostUsable: true,
  workerUsable: true,
}));

const CATALOG = {
  // 器より高くするために数を並べる（畳まれた行でも縦は伸びる）
  providers: Array.from({ length: 30 }, (_, i) => ({
    id: i === 0 ? "demo-provider" : `demo-provider-${i}`,
    name: `見本プロバイダ ${i}`,
    baseUrl: "https://example.invalid",
    hasAuth: true,
    modelCount: i === 0 ? MODELS.length : 0,
    canFetchModels: true,
    local: false,
    keys: [{ name: `demo-provider-${i}`, host: true, worker: true, state: "ok" }],
  })),
  models: MODELS,
  tiers: [
    { tier: "reasoning", label: "高精度", description: "難しい判断" },
    { tier: "standard", label: "通常", description: "ふだんの実装" },
    { tier: "fast", label: "高速", description: "短い仕事" },
  ],
  defaults: { workerTier: "standard" },
  files: { changed: false, loadedAt: "", loadedHash: "a", currentHash: "a" },
};

/** 職人の区画の値（`WorkerSettings` がそのまま描く形）。 */
const WORKER_VALUES = {
  idleTimeoutMinutes: 15,
  defaultTier: "standard",
  tiers: ["reasoning", "standard", "fast"],
  assignments: { reasoning: "opus" },
  fallbacks: { standard: "demo-provider/demo-model-01" },
  backends: [
    {
      id: "pi-rpc",
      title: "pi",
      enabled: true,
      isDefault: true,
      modelCount: 40,
      available: true,
      detail: "使えます",
    },
    {
      id: "claude-agent-sdk",
      title: "Claude Code",
      description: "Claude Code（Agent SDK）",
      enabled: true,
      isDefault: false,
      modelCount: 3,
      available: false,
      detail: "認証が見つかりません",
    },
  ],
  models: [
    { name: "opus", label: "opus（いちばん賢い）", runtime: "claude-agent-sdk", runtimeTitle: "Claude Code" },
    { name: "demo-provider/demo-model-01", label: "見本モデル 1（demo-provider）", runtime: "pi-rpc", runtimeTitle: "pi" },
  ],
};

/** 受け取った `settings.update` の中身（試験が確かめる）。 */
export const updates: Array<{ section: string; values: Record<string, unknown> }> = [];

export async function startSettingsHost(): Promise<SettingsHost> {
  if (!fs.existsSync(WEB_DIST)) {
    throw new Error(`UIのビルドが要る: ${WEB_DIST}（npm run build:web）`);
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const json = (details: unknown): void => {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ content: [{ type: "text", text: "ok" }], details }));
    };

    if (url === "/api/settings/tools/settings.describe") {
      return json({
        storedAt: "/tmp/banto/settings.json",
        sections: [
          {
            // 職人の区画は**モジュールが GUI を宣言する**（決定43 の開放）
            id: "worker-pool",
            title: "職人",
            description: "バックエンドと等級ごとのモデル。",
            origin: "worker-pool",
            originTitle: "職人",
            fields: [],
            view: "WorkerSettings",
            values: WORKER_VALUES,
          },
          {
            id: "llm",
            title: "LLM・モデル",
            description: "番頭と職人が使うモデル。",
            origin: "core",
            originTitle: "Banto 本体",
            fields: [],
            // 決定43: 項目で表せない中核の区画は、描き先だけを宣言する
            view: "LlmRegistryViewer",
            values: {},
          },
        ],
      });
    }
    if (url === "/api/core/tools/llm.list") return json(CATALOG);
    if (url === "/api/settings/tools/settings.update") {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        const args = (JSON.parse(body || "{}") as { args?: Record<string, unknown> }).args ?? {};
        updates.push({
          section: String(args["section"] ?? ""),
          values: (args["values"] ?? {}) as Record<string, unknown>,
        });
        json({ applied: true, message: "変えました。" });
      });
      return;
    }
    if (url.startsWith("/api/core/tools/") || url.startsWith("/api/settings/tools/")) {
      return json({});
    }

    const rel = url === "/" ? "index.html" : url.replace(/^\//, "");
    const file = path.join(WEB_DIST, rel);
    if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : file.endsWith(".html")
          ? "text/html"
          : "application/octet-stream";
    res.writeHead(200, { "Content-Type": type }).end(fs.readFileSync(file));
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets = new Set<WebSocket>();

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // 設定面は会話に依らないので、開けるだけの最小限を返す
    socket.send(
      JSON.stringify({
        type: "welcome",
        sessionId: "fake",
        threads: [
          {
            threadId: "t-1",
            title: "帳場",
            sessionId: "fake",
            isDefault: true,
            kind: "trunk",
            state: "open",
            streaming: false,
          },
        ],
        defaultThreadId: "t-1",
        tools: [],
        catalog: [],
        modules: [{ name: "settings", title: "設定", description: "設定", baseUrl: "/api/settings" }],
      })
    );
  });

  return {
    port,
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
