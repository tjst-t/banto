// Backlog Module の画面の入口（MCP Apps）。どの面を描くかは HTML の `data-surface` が決める（`ui-app.ts`）：
//   - `board`  … 一覧（人が入口から開く）
//   - `config` … 設定 Canvas（tasks.json の場所）
// banto を知らない。MCP Apps の約束（`protocol.ts`）だけで親と話す。

import { BacklogBoard } from "./board.js";
import { mountConfig } from "./config.js";
import { errorMessage, notify, onNotification, reportSize, request, type HostContext, type InitializeResult } from "./protocol.js";
import { applyHostStyles, applyTheme, installStyles } from "./styles.js";

async function main(): Promise<void> {
  installStyles();
  const root = document.getElementById("app") ?? document.body;
  const surface = document.body.dataset.surface;

  onNotification("ui/notifications/host-context-changed", (params) => {
    const ctx = params as HostContext;
    applyTheme(ctx.theme);
    applyHostStyles(ctx.styles?.variables);
    if (ctx.displayMode) document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";
  });

  let init: InitializeResult;
  try {
    init = await request<InitializeResult>("ui/initialize", {
      protocolVersion: "2026-01-26",
      appInfo: { name: "banto-backlog", version: "0.1.0" },
      appCapabilities: { availableDisplayModes: surface === "config" ? ["inline"] : ["inline", "fullscreen"] },
    });
  } catch (err) {
    root.textContent = `画面を初期化できませんでした：${errorMessage(err)}`;
    return;
  }
  const ctx = init.hostContext ?? {};
  applyTheme(ctx.theme);
  applyHostStyles(ctx.styles?.variables);
  document.body.dataset.mode = ctx.displayMode === "fullscreen" ? "fullscreen" : "inline";

  if (surface === "config") mountConfig(root);
  else new BacklogBoard(root);
  notify("ui/notifications/initialized");

  // inline の面は中身の高さに合わせてもらう
  if (document.body.dataset.mode !== "fullscreen") new ResizeObserver(() => reportSize()).observe(document.body);
}

void main();
