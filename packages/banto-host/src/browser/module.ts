/**
 * 共有ブラウザ モジュール（組み込み・ADR-0010 決定25・27）。
 *
 * **AI（番頭）と人（PO）が同じブラウザを触る。** 実体は1つで、口が2つ——
 * 人は canvas の面（`browser.viewer`）から見て触り、番頭は Tool から起こす・落とす。
 *
 * 2026-08-15 の判定（`docs/proposals/2026-08-15-shared-browser-module-assessment.md`）で
 * noVNC による画面共有と mitmproxy による復号は**両方とも捨てた**。ここは **CDP だけ**で
 * 組んである：画面は `Page.startScreencast`、操作は `Input.*`。追加依存はゼロ。
 *
 * 面で見て、面から触れる（K1）・本物の chromium を起こす（K2・`chromium-launcher.ts`）
 * ところまでは入っている。番頭が操作する Tool（navigate・click・snapshot 等）・通信の記録は
 * それぞれ別の作業で積む（混ぜない）。
 *
 * D5: 判断は無い。Tool と面の登録、経路の受け口だけ。中身は `session.ts`。
 */

import { Type } from "typebox";
import { WebSocketServer } from "ws";
import type * as http from "node:http";
import type { Duplex } from "node:stream";
import type { BantoModule } from "../module.js";
import type { CanvasViewSpec } from "../canvas.js";
import { defineNamespacedTool, type NamespacedToolDefinition } from "../tool-registry.js";
import type { BrowserLauncher } from "./launcher.js";
import { createChromiumLauncher } from "./chromium-launcher.js";
import { createBrowserSession, type BrowserSession, type ScreencastOptions } from "./session.js";

/** 組み込みモジュールの到達先は Banto ホスト自身。UI は自分のオリジンに解決する。 */
export const BROWSER_BASE_URL = "/api/browser";

/** 面が繋ぐ先。ホストは `BROWSER_BASE_URL` の下の upgrade をここへ回してくる。 */
export const BROWSER_VIEWER_WS_PATH = `${BROWSER_BASE_URL}/viewer`;

export interface BrowserModuleOptions {
  /** ブラウザの起こし手。省略すると本物の chromium を起こす既定（K2）が入る。 */
  launcher?: BrowserLauncher;
  screencast?: ScreencastOptions;
}

const browserViews: CanvasViewSpec[] = [
  {
    kind: "browser.viewer",
    title: "ブラウザ",
    description:
      "番頭と同じブラウザの画面を映し、POがその場で触れる面。番頭に調べさせている途中で" +
      "「自分で見たい」「ログインだけ人がやる」ときに開く。**映るのはブラウザの窓の中だけ**で、" +
      "デスクトップ全体やブラウザ外のアプリは映らない。" +
      "文字入力は確定済みの文字列として送られる（面側の IME で確定してから届く）。",
    parameters: Type.Object({}),
    component: "BrowserViewer",
    category: "browser",
    icon: "🌐",
  },
];

function createBrowserTools(session: BrowserSession): NamespacedToolDefinition[] {
  const start = defineNamespacedTool({
    name: "browser.start",
    label: "Browser: Start",
    description:
      "共有ブラウザを起こす。既に起きていれば何もしない（同時に1つ）。" +
      "起こしたあと、POは canvas の browser.viewer で同じ画面を見て触れる。",
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "最初に開く URL" })),
      width: Type.Optional(Type.Number({ description: "画面の幅（CSS px）" })),
      height: Type.Optional(Type.Number({ description: "画面の高さ（CSS px）" })),
    }),
    async execute(params) {
      const status = await session.start({
        ...(params.url !== undefined ? { url: params.url } : {}),
        ...(params.width !== undefined ? { width: params.width } : {}),
        ...(params.height !== undefined ? { height: params.height } : {}),
      });
      return {
        content: [{ type: "text" as const, text: `ブラウザは ${status.state} です。` }],
        details: status,
      };
    },
  });

  const stop = defineNamespacedTool({
    name: "browser.stop",
    label: "Browser: Stop",
    description: "共有ブラウザを落とす。起きていなければ何もしない。開いている面は閉じる。",
    parameters: Type.Object({}),
    async execute() {
      const status = await session.stop();
      return {
        content: [{ type: "text" as const, text: `ブラウザは ${status.state} です。` }],
        details: status,
      };
    },
  });

  const status = defineNamespacedTool({
    name: "browser.status",
    label: "Browser: Status",
    description: "共有ブラウザの状態（起きているか・面を何人が見ているか）を返す。",
    parameters: Type.Object({}),
    async execute() {
      const current = session.status();
      return {
        content: [
          {
            type: "text" as const,
            text: `${current.state}（面 ${current.viewers} / 配信 ${current.streaming ? "中" : "停止"}）`,
          },
        ],
        details: current,
      };
    },
  });

  return [start, stop, status] as NamespacedToolDefinition[];
}

export function createBrowserModule(options: BrowserModuleOptions = {}): BantoModule {
  const session = createBrowserSession({
    launcher: options.launcher ?? createChromiumLauncher(),
    ...(options.screencast ? { screencast: options.screencast } : {}),
  });

  // ホストの upgrade を受けるだけなので noServer。ws に server を持たせると
  // 自分のパス以外の upgrade まで蹴ってしまう（server.ts の /ws と同じ理由）
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  return {
    name: "browser",
    title: "共有ブラウザ",
    description:
      "番頭とPOが同じブラウザを触るためのモジュール。画面と操作は CDP だけで往復する" +
      "（VNC も MITM も使わない）。",
    endpoint: { baseUrl: BROWSER_BASE_URL },
    tools: createBrowserTools(session),
    views: browserViews,
    skills: [],

    handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
      const pathname = ((req.url ?? "").split("?")[0] ?? "").replace(/\/$/, "");
      if (pathname !== BROWSER_VIEWER_WS_PATH) return false;
      wss.handleUpgrade(req, socket, head, (ws) => {
        session.attachViewer(ws);
      });
      return true;
    },
  };
}
