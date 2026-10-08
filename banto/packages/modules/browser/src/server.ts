#!/usr/bin/env node
// docs/specs/v4-modules.md §4.1 Browser——人と AI が同じブラウザを触り、通信を調べる。
// Project ごと・Project のコンテナの中で動く。ブラウザは Playwright 同梱の chromium-headless-shell を CDP で使う。
// 人の画面（ui://banto-browser/view・screencast・流れの口）はまだ無い（#242）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { MODULE_META_KEY, VISIBILITY_META_KEY } from "@banto/module-contract";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { NetworkLog } from "./network-log.js";
import { BrowserSession, DEFAULT_VIEWPORT } from "./session.js";
import { StateFile } from "./state.js";
import { TOOLS, callTool, type ToolContext } from "./tools.js";

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
    ],
  }));

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
    return callTool(ctx, request.params.name, request.params.arguments, onProgress);
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
    /** 仕事の組で起こすときにブラウザを包む sh（起こすたびに書き直す——work-scope.ts） */
    scopeWrapper: join(dataDir, "chrome-in-work-scope.sh"),
  };
}

/**
 * 置き場から Module の中身を組み立てる。**playwright-core はここで初めて読み込む**——ブラウザの置き場
 * （`PLAYWRIGHT_BROWSERS_PATH`）は読み込むときに決まるので、先に環境へ置く
 */
export async function createBrowserContextFromDataDir(dataDir: string, opts: { browsersPath?: string } = {}): Promise<ToolContext> {
  const paths = browserPaths(dataDir);
  const browsersPath = opts.browsersPath ?? paths.browsers;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import("playwright-core");
  const { launchWithInstall, playwrightInstaller } = await import("./install.js");
  const { prepareScopedLaunch } = await import("./work-scope.js");
  const installer = playwrightInstaller(browsersPath);
  const log = new NetworkLog(paths.network);
  const state = new StateFile(paths.state);
  const session = new BrowserSession({
    profileDir: paths.profile,
    log,
    idleMs: () => state.get().idleMinutes * 60_000,
    launch: async (profileDir, onProgress) => {
      const context: BrowserContext = await launchWithInstall(
        async () => {
          // 入れられるなら仕事の組（banto-work-jobs.slice）に入れる。入れられなければそのまま
          const scoped = await prepareScopedLaunch(paths.scopeWrapper);
          return chromium.launchPersistentContext(profileDir, { headless: true, viewport: { ...DEFAULT_VIEWPORT }, ...(scoped ?? {}) });
        },
        installer,
        onProgress,
      );
      context.setDefaultTimeout(10_000);
      return context;
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
  const shutdown = async () => {
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
