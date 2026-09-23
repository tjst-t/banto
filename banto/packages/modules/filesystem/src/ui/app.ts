// FileSystem Module の画面の入口（MCP Apps、決定・2026-09-06）。
//
// **1つの JS で2つの面を描く**——どちらを描くかは HTML の `data-surface` が決める
// （`ui-app.ts`）：
//   - `browser`   … ファイルブラウザ（listDirectory の画面・人が直接開く入口）
//   - `edit-diff` … editFile の結果の差分
//
// banto を知らない。MCP Apps の約束（`protocol.ts`）だけで親と話す。

import { FileBrowser } from "./browser.js";
import { EditDiffView } from "./edit-diff.js";
import { onNotification, notify, request, reportSize, errorMessage, type CallToolResult, type HostContext, type InitializeResult } from "./protocol.js";
import { applyHostStyles, applyTheme, installStyles } from "./styles.js";

interface Surface {
  setToolInput(args: Record<string, unknown>): void;
  setToolResult(result: CallToolResult): void;
}

async function main(): Promise<void> {
  installStyles();
  const root = document.getElementById("app") ?? document.body;
  const surfaceName = document.body.dataset.surface;

  // 通知は initialize の返事より先に届きうるので、面ができるまで溜めておく
  let surface: Surface | undefined;
  let browser: FileBrowser | undefined;
  let diff: EditDiffView | undefined;
  const early: Array<(s: Surface) => void> = [];
  const deliver = (fn: (s: Surface) => void) => (surface ? fn(surface) : early.push(fn));

  onNotification("ui/notifications/tool-input", (params) => {
    const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<string, unknown>;
    deliver((s) => s.setToolInput(args));
  });
  onNotification("ui/notifications/tool-result", (params) => {
    // この通知の params は **CallToolResult そのもの**（仕様 McpUiToolResultNotification）
    deliver((s) => s.setToolResult(params as CallToolResult));
  });
  onNotification("ui/notifications/tool-cancelled", () => diff?.setCancelled());
  onNotification("ui/notifications/host-context-changed", (params) => {
    const ctx = params as HostContext;
    applyTheme(ctx.theme);
    applyHostStyles(ctx.styles?.variables);
    if (ctx.displayMode) browser?.setDisplayMode(ctx.displayMode);
  });

  let init: InitializeResult;
  try {
    init = await request<InitializeResult>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-filesystem", version: "0.2.0" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
  } catch (err) {
    root.textContent = `画面を初期化できませんでした：${errorMessage(err)}`;
    return;
  }
  const ctx = init.hostContext ?? {};
  applyTheme(ctx.theme);
  applyHostStyles(ctx.styles?.variables);
  const displayMode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
  document.body.dataset.mode = displayMode;

  if (surfaceName === "edit-diff") {
    diff = new EditDiffView(root);
    surface = diff;
  } else {
    browser = new FileBrowser(root, {
      displayMode,
      canDownload: Boolean(init.hostCapabilities?.downloadFile),
      // **人が入口から直接開いたとき**は、起こした tool 呼び出しが無い（host は toolInfo を
      // 渡さない）。渡されるのを待たず、自分で取りに行く（§6.2）
      openedByHuman: !ctx.toolInfo,
    });
    surface = browser;
  }
  for (const fn of early.splice(0)) fn(surface);
  notify("ui/notifications/initialized");

  // inline のカードは中身の高さに合わせてもらう（描き直しのたびに伝える）
  if (displayMode === "inline") new ResizeObserver(() => reportSize()).observe(document.body);
}

void main();
