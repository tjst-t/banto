/**
 * レイアウトの試験が使う偽ホスト（`desktop-layout` / `mobile-layout` の共有）。
 *
 * **常駐している番頭ホストに繋がない**——以前は `http://localhost:4100` を直に叩いていたので、
 * 手元で `banto serve` を上げている間しか通らなかった（上げていなければ全滅する）。
 * 他の試験（`chat-ux` / `view-restore`）と同じく、ビルド済みのUIを配る小さなサーバと、
 * Banto のプロトコルを喋るだけの偽ホストをその場で立てる。
 *
 * 見たいのは**器の組み方**（道具立てが居座るか・境界を掴めるか）だけなので、
 * キャンバスには「縦に長い中身」が1枚出ていれば足りる。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(here, "..", "packages", "banto-web", "dist");
const THREAD_ID = "t-1";

/** キャンバスを縦に溢れさせるための一覧（送れる高さが無いと「居座る」を確かめられない）。 */
const ENTRIES = Array.from({ length: 200 }, (_, i) => ({
  name: `file-${String(i).padStart(3, "0")}.ts`,
  type: "file",
  size: 100 + i,
}));

export interface LayoutHost {
  readonly port: number;
  close(): Promise<void>;
}

/** 持ち込みのテーマの見本（`/api/themes`）。渡さなければ 404（＝置いていない）。 */
export interface UserThemeFixture {
  /** `themes.json` が返す家の一覧（そのまま JSON にする）。 */
  families: Array<Record<string, unknown>>;
  /** ファイル名 → 中身。 */
  css: Record<string, string>;
}

export async function startLayoutHost(themes?: UserThemeFixture): Promise<LayoutHost> {
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
    if (url === "/api/file/tools/place.list") {
      return json({
        places: [{ id: "demo", label: "デモ", path: "/tmp/demo", writable: [] }],
        total: 1,
      });
    }
    if (url === "/api/file/tools/file.stat") return json({ type: "dir", path: "." });
    if (url === "/api/file/tools/file.list") return json({ entries: ENTRIES });

    // 持ち込みのテーマ。ホストは配るだけで、濾すのは画面側（D5）
    if (url === "/api/themes") {
      if (!themes) {
        res.writeHead(404).end("not found");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ families: themes.families }));
      return;
    }
    if (url.startsWith("/api/themes/")) {
      const name = decodeURIComponent(url.slice("/api/themes/".length));
      const css = themes?.css[name];
      if (css === undefined) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/css" }).end(css);
      return;
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
    const send = (event: unknown): void => socket.send(JSON.stringify(event));
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
          model: { provider: "huihui", id: "qwen3.6-35b", vision: false },
        },
      ],
      defaultThreadId: THREAD_ID,
      tools: [],
      catalog: [
        {
          kind: "file.browser",
          title: "ファイル",
          description: "見る",
          component: "FileBrowser",
          category: "テスト",
          module: "file",
          endpoint: "/api/file",
        },
      ],
      modules: [{ name: "file", title: "ファイル", description: "見る", baseUrl: "/api/file" }],
    });
    /* 会話の中身。**家の形（発話・思考・道具・外部リンク）を見る**ときに要る */
    send({
      type: "history",
      threadId: THREAD_ID,
      entries: [
        { role: "po", text: "画面の意匠がプロダクトらしくない。何が効いているか教えて" },
        { role: "reasoning", text: "記憶を引く", durationMs: 12000 },
        { role: "tool", name: "memory.search", state: "ok", input: { q: "意匠" }, output: "3件" },
        {
          role: "banto",
          text: "効いているのは三つです。詳しくは [店舗ページ](https://example.com/x) を。",
        },
      ],
    });
    send({
      type: "canvas_state",
      threadId: THREAD_ID,
      /* 2枚開けておく。タブの区切りと符牒の札は、1枚だけだと確かめられない */
      tabs: [
        { id: "tab-1", kind: "file.browser", title: "ファイル", params: {}, rev: 1 },
        { id: "tab-2", kind: "file.browser", title: "もう一枚", params: {}, rev: 1 },
      ],
      activeTabId: "tab-1",
    });
  });

  return {
    port,
    async close(): Promise<void> {
      for (const socket of sockets) socket.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
