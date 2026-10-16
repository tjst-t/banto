// FileSystem Module の **PDF・Office の文書と表の画面**の入口（`ui://banto-filesystem/document`、v4-modules.md §2.2「PDF・Office…」）。
//
// テキストの画面（`app.ts`）とは束を分ける——こちらは pdf.js・docx-preview・SheetJS を読み込んだ HTML に入る（`ui-app.ts`）。
// banto を知らない。MCP Apps の約束（`protocol.ts`）だけで親と話す。
// どれで描くかは見せるファイルの拡張子で決める（`document-screen.ts`。host がこの画面を選んだのと同じ物差し）。パスは tool の引数で
// 先に届くが、届かないこともある（記録から開き直したとき等）ので、そのときは結果のパスで決める。

import { DocumentScreen } from "./document-screen.js";
import { onNotification, notify, request, errorMessage, textOf, type CallToolResult, type HostContext, type InitializeResult } from "./protocol.js";
import { applyHostStyles, applyTheme, installStyles } from "./styles.js";

/** showFile の結果に入っているパス（読めなければ空） */
function resultPath(result: CallToolResult): string {
  try {
    const path = (JSON.parse(textOf(result)) as { path?: unknown }).path;
    return typeof path === "string" ? path : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  installStyles();
  const root = document.getElementById("app") ?? document.body;

  // 通知は initialize の返事より先に届きうる。面は initialize が済み、見せるファイルのパスが分かってから作るので、それまで溜めておく
  let displayMode: "inline" | "fullscreen" | undefined;
  let canReturnComments: boolean | undefined;
  let path: string | undefined;
  let view: DocumentScreen | undefined;
  const early: Array<(v: DocumentScreen) => void> = [];
  const deliver = (fn: (v: DocumentScreen) => void) => (view ? fn(view) : early.push(fn));
  const choose = () => {
    if (view || !displayMode || canReturnComments === undefined || path === undefined) return;
    view = new DocumentScreen(root, displayMode, canReturnComments, path);
    for (const fn of early.splice(0)) fn(view);
  };

  onNotification("ui/notifications/tool-input", (params) => {
    const args = ((params as { arguments?: Record<string, unknown> }).arguments ?? {}) as Record<string, unknown>;
    deliver((v) => v.setToolInput(args));
    if (typeof args.path === "string" && args.path) path ??= args.path;
    choose();
  });
  onNotification("ui/notifications/tool-result", (params) => {
    const result = params as CallToolResult;
    deliver((v) => v.setToolResult(result));
    // 引数が届かなかったときは結果のパスで選ぶ
    path ??= resultPath(result);
    choose();
  });
  onNotification("ui/notifications/tool-cancelled", () => {
    deliver((v) => v.setCancelled());
    path ??= "";
    choose();
  });
  onNotification("ui/notifications/host-context-changed", (params) => {
    const ctx = params as HostContext;
    applyTheme(ctx.theme);
    applyHostStyles(ctx.styles?.variables);
    if (ctx.displayMode) view?.setDisplayMode(ctx.displayMode);
    if (!view && displayMode && (ctx.displayMode === "inline" || ctx.displayMode === "fullscreen")) {
      displayMode = ctx.displayMode;
      document.body.dataset.mode = displayMode;
    }
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
  displayMode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
  document.body.dataset.mode = displayMode;
  // **「AI に返す」は、host が `ui/message` を受けると名乗ったときだけ**（banto は会話の中で開いた画面にだけ名乗る）。
  // 受けない host（会話の外）では、コメントは「コピー」で持ち出す
  canReturnComments = init.hostCapabilities?.message?.text !== undefined;
  root.textContent = "ファイルを待っています…";
  choose();
  notify("ui/notifications/initialized");
}

void main();
