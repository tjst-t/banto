// FileSystem Module の **PDF の画面**の入口（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」）。
//
// テキストの画面（`app.ts`）とは束を分ける——こちらは pdf.js を読み込んだ HTML に入る（`ui-app.ts`）。
// banto を知らない。MCP Apps の約束（`protocol.ts`）だけで親と話す。

import { PdfDocumentView } from "./pdf-viewer.js";
import { onNotification, notify, request, errorMessage, type CallToolResult, type HostContext, type InitializeResult } from "./protocol.js";
import { applyHostStyles, applyTheme, installStyles } from "./styles.js";

async function main(): Promise<void> {
  installStyles();
  const root = document.getElementById("app") ?? document.body;

  // 通知は initialize の返事より先に届きうるので、面ができるまで溜めておく
  let view: PdfDocumentView | undefined;
  const early: Array<(v: PdfDocumentView) => void> = [];
  const deliver = (fn: (v: PdfDocumentView) => void) => (view ? fn(view) : early.push(fn));

  onNotification("ui/notifications/tool-input", (params) => {
    const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<string, unknown>;
    deliver((v) => v.setToolInput(args));
  });
  onNotification("ui/notifications/tool-result", (params) => deliver((v) => v.setToolResult(params as CallToolResult)));
  onNotification("ui/notifications/tool-cancelled", () => deliver((v) => v.setCancelled()));
  onNotification("ui/notifications/host-context-changed", (params) => {
    const ctx = params as HostContext;
    applyTheme(ctx.theme);
    applyHostStyles(ctx.styles?.variables);
    if (ctx.displayMode) view?.setDisplayMode(ctx.displayMode);
  });

  let init: InitializeResult;
  try {
    init = await request<InitializeResult>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-filesystem-document", version: "0.1.0" },
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

  // **「AI に返す」は、host が `ui/message` を受けると名乗ったときだけ**（banto は会話の中で開いた画面にだけ名乗る）。
  // 受けない host（会話の外）では、コメントは「コピー」で持ち出す
  const canReturnComments = init.hostCapabilities?.message?.text !== undefined;
  view = new PdfDocumentView(root, { displayMode, canReturnComments });
  for (const fn of early.splice(0)) fn(view);
  notify("ui/notifications/initialized");
}

void main();
