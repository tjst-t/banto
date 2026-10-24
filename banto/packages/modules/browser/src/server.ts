#!/usr/bin/env node
// docs/specs/v4-modules.md §4.1 Browser——人と AI が同じブラウザを触り、通信を調べる。
// Project ごと・Project のコンテナの中で動く。ブラウザは普通のブラウザ（x86_64 は Google Chrome）を仮想の画面で画面ありで
// 起こし、CDP で使う（chrome.ts）。
// 人の画面は `ui://banto-browser/view`（view-app.ts）で、絵と入力は流れ「browser」（view-stream.ts、アーキ仕様 §5.8）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, MODULE_META_KEY, STREAMS_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { join } from "node:path";
import { NetworkLog } from "./network-log.js";
import { BrowserSession, DEFAULT_VIEWPORT, type AudioRoute } from "./session.js";
import { StateFile } from "./state.js";
import { searchHome } from "./search.js";
import { TOOLS, callTool, type ToolContext } from "./tools.js";
import { BROWSER_VIEW_URI, browserViewHtml } from "./view-app.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { BrowserView } from "./view-stream.js";
import type { VideoSupport } from "./video.js";
import type { AudioSupport } from "./audio.js";

const UI_APP_MIME = "text/html;profile=mcp-app";
/** 人の画面が開く流れの名前 */
export const BROWSER_STREAM = "browser";

/** この Module の申告。目録（core の BUNDLED_CATALOG）の宣言と同じ */
export const BROWSER_MODULE_META = {
  satisfies: ["browser"],
  dependsOn: [],
  isolation: "subprocess",
  scope: "project",
  // ブラウザ（子プロセス）を走らせる。コンテナの中の localhost に届く
  confinement: { kind: "landlock", root: "project", profile: "exec" },
} as const;

export function createBrowserServer(ctx: ToolContext) {
  const server = new Server({ name: "banto-module-browser", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "browser://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: "admin", [MODULE_META_KEY]: BROWSER_MODULE_META },
      },
      {
        // **入口**（launcher）——Command Palette の「Module の入口」から開く。browserOpen のカードからも開く
        uri: BROWSER_VIEW_URI,
        name: "ブラウザ",
        description: "この Project のコンテナの中のブラウザを映して触る。AI と同じブラウザで、通信とコンソールも見られる",
        mimeType: UI_APP_MIME,
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [CANVAS_META_KEY]: "launcher",
          [STREAMS_META_KEY]: [BROWSER_STREAM],
          ui: { prefersBorder: false },
        },
      },
      {
        // 設定 Canvas——人の新しいタブと URL 欄が使う検索エンジン（v4-modules.md §4.1「新しいタブと URL 欄の検索」）
        uri: CONFIG_APP_URI,
        name: "ブラウザ",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === BROWSER_VIEW_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: browserViewHtml() }] };
    if (uri === CONFIG_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
    if (uri === "browser://module") {
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(BROWSER_MODULE_META) }] };
    }
    throw new Error(`知らない資源です: ${uri}`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const progressToken = extra._meta?.progressToken;
    // ブラウザを入れる間（初回）は時間がかかる——進捗を送り、呼び手が諦めないようにする
    const onProgress =
      progressToken !== undefined
        ? (message: string) => {
            void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 0, message } });
          }
        : undefined;
    return callTool(ctx, request.params.name, request.params.arguments, onProgress, request.params._meta as Record<string, unknown> | undefined);
  });

  return server;
}

/** Module の置き場の中の置き場所 */
export function browserPaths(dataDir: string) {
  return {
    browsers: join(dataDir, "browsers"),
    profile: join(dataDir, "profile"),
    network: join(dataDir, "network"),
    state: join(dataDir, "state.json"),
    /** 立てた仮想の画面（Xvfb）の pid（Module が消えた後に残ったものを、次に起こすときに止める——chrome.ts） */
    displayPid: join(dataDir, "xvfb.pid"),
    /** 立てた PulseAudio の pid と置き場（Xvfb と同じく、Module が消えた後に残ったものを次に止める） */
    audioPid: join(dataDir, "pulseaudio.pid"),
    /** ブラウザにだけ効かせる fontconfig の設定（起こすたびに書く——fonts.ts） */
    fontconfig: join(dataDir, "fontconfig", "fonts.conf"),
  };
}

/**
 * 置き場から Module の中身を組み立てる。**playwright-core はここで初めて読み込む**——ブラウザの置き場
 * （`PLAYWRIGHT_BROWSERS_PATH`）は読み込むときに決まるので、先に環境へ置く
 */
export async function createBrowserContextFromDataDir(
  dataDir: string,
  opts: {
    browsersPath?: string;
    executable?: string;
    /** 動画で流せるかを決め打つ（試験が JPEG に落ちる形を見るとき） */
    video?: VideoSupport;
    /** 音を流せるかを決め打つ（試験が音無しの形を見るとき） */
    audio?: AudioSupport;
  } = {},
): Promise<ToolContext> {
  const paths = browserPaths(dataDir);
  const browsersPath = opts.browsersPath ?? paths.browsers;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import("playwright-core");
  const { BROWSER_NAME, browserExecutablePath, launchWithInstall, playwrightInstaller } = await import("./install.js");
  const { acceptLanguages, readBrowserVersion } = await import("./identity.js");
  const { startChrome } = await import("./chrome.js");
  const { ensureCjkFont } = await import("./fonts.js");
  const { ensureVideo } = await import("./video.js");
  const { ensureAudio } = await import("./audio.js");
  const { ensurePasswordPolicy } = await import("./policy.js");
  const installer = playwrightInstaller(browsersPath);
  const log = new NetworkLog(paths.network);
  const state = new StateFile(paths.state);
  const session = new BrowserSession({
    profileDir: paths.profile,
    log,
    idleMs: () => state.get().idleMinutes * 60_000,
    launch: async (profileDir, onProgress, blank) => {
      const running = await launchWithInstall(
        async () => {
          // 入っていなければ Playwright と同じ文言で投げ、launchWithInstall が入れる（chrome.ts）
          const executable = opts.executable ?? browserExecutablePath();
          // 描く倍率は最後に映した人の画面の倍率（人の画面が開けばその前に覚え直す——view-stream.ts）
          const { locale, timezone, viewScale: scale } = state.get();
          // 日本語の字体が無ければ入れる（入れられなくても起こす——理由は状態とログに出す。fonts.ts）
          const fontNotice = await ensureCjkFont((p) => installer.installFonts(p), onProgress);
          if (fontNotice) {
            console.error(`[browser] ${fontNotice}`);
            onProgress?.(fontNotice);
          }
          // パスワードを保存しますか、の吹き出しと漏洩検出の警告を止める企業向けポリシー。Google Chrome（x64）でだけ
          // 確かめた——Playwright 同梱の Chromium（arm64）がこの仕組みを持つかは未確認なので chrome のときだけ（policy.ts）
          const policyNotice = BROWSER_NAME === "chrome" ? await ensurePasswordPolicy((p) => installer.installPasswordPolicy(p), onProgress) : undefined;
          if (policyNotice) {
            console.error(`[browser] ${policyNotice}`);
            onProgress?.(policyNotice);
          }
          // 人の画面を動画で流す GStreamer が無ければ入れる（入れられなくても起こす——人の画面は JPEG で映す。video.ts）
          const video = opts.video ?? (await ensureVideo((p) => installer.installVideo(p), onProgress));
          if (video.reason) console.error(`[browser] ${video.reason}`);
          // 音の行き先（PulseAudio）が無ければ入れる（入れられなくても起こす——人の画面は音無しで映す。audio.ts）。取り込みは
          // GStreamer なので、映像の GStreamer が無ければ音も無し
          const audio: AudioSupport =
            opts.audio ??
            (video.available
              ? await ensureAudio((p) => installer.installAudio(p), onProgress)
              : { available: false, reason: `GStreamer が無いので音も流せません（${video.reason ?? ""}）。音無しで映します` });
          if (audio.reason) console.error(`[browser] ${audio.reason}`);
          const chrome = await startChrome(
            {
              executable,
              profileDir,
              displayPidFile: paths.displayPid,
              audioPidFile: paths.audioPid,
              audio: audio.available,
              languages: acceptLanguages(locale),
              locale,
              timezone,
              fontconfigFile: paths.fontconfig,
              viewport: DEFAULT_VIEWPORT,
              scale,
              firstTab: blank ? "about:blank" : searchHome(state.get()),
            },
            (endpoint) => chromium.connectOverCDP(endpoint),
          );
          const route: AudioRoute = !audio.available
            ? { available: false, reason: audio.reason ?? "音を流せません" }
            : "server" in chrome.audio
              ? { available: true, server: chrome.audio.server }
              : { available: false, reason: chrome.audio.reason };
          const notice = [fontNotice, policyNotice].filter((n): n is string => Boolean(n)).join("\n");
          return { ...chrome, version: readBrowserVersion(executable), scale, video, audio: route, ...(notice ? { notice } : {}) };
        },
        installer,
        onProgress,
      );
      running.context.setDefaultTimeout(10_000);
      return running;
    },
  });
  return { session, log, state };
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  if (!dataDir) {
    console.error("BANTO_MODULE_DATA_DIR が必要です");
    process.exit(1);
  }
  const ctx = await createBrowserContextFromDataDir(dataDir);
  // 人の画面の流れ（アーキ仕様 §5.8）
  const view = new BrowserView({ session: ctx.session, state: ctx.state, log: ctx.log });
  ctx.view = view;
  const { listenStreams } = await import("@banto/stream-server");
  const streams = await listenStreams(
    { [BROWSER_STREAM]: view.handler() },
    { dataDir, onError: (err) => console.error("[browser]", err.message) },
  );
  const shutdown = async () => {
    await view.close();
    await streams.close();
    await ctx.session.stop("Module を止めました");
    ctx.log.saveNow();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  // host が繋がりを閉じたら（標準入力が閉じる）、ブラウザも止める——残すとコンテナの中に宙づりの Chromium が残る
  process.stdin.on("close", () => void shutdown());
  await createBrowserServer(ctx).connect(new StdioServerTransport());
}
