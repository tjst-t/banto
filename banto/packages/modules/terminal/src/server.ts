#!/usr/bin/env node
// docs/specs/v4-modules.md §4.6 Terminal——人が画面から Project のコンテナでシェルを打つ。
//
// - 入口（launcher）「ターミナル」の画面だけを持ち、その画面が流れ「terminal」を開く（アーキ仕様 §5.8）
// - 道具（listSessions・createSession・renameSession・closeSession）は画面が使うもので、可視性は `admin`。
//   **人の画面からの呼び出し（host が刻む `{admin: true}`）だけを受ける。AI 向けの tool は出さない**
// - 打った中身・出力は会話の記録に積まない（流れの口も中身を残さない）

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { CANVAS_META_KEY, MODULE_META_KEY, STREAMS_META_KEY, VISIBILITY_META_KEY, callerOf } from "@banto/module-contract";
import { mkdir } from "node:fs/promises";
import { TERMINAL_APP_URI, terminalAppHtml } from "./app.js";
import { SessionStore } from "./store.js";
import { terminalStreamHandler } from "./stream.js";
import { Terminal } from "./terminal.js";
import { TerminalError, Tmux } from "./tmux.js";

const UI_APP_MIME = "text/html;profile=mcp-app";

/** Module の環境から、シェルに写すもの（Claude のログインの中継——人がターミナルで `claude` を打てる。v4-security.md §2） */
export const INHERITED_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
];

/** 自分の申告（宣言と突き合わせられる。目録の meta と同じもの） */
export const TERMINAL_MODULE_META = {
  satisfies: ["terminal"],
  dependsOn: [],
  isolation: "subprocess",
  scope: "project",
  confinement: { kind: "landlock", root: "project", profile: "exec" },
} as const;

const NAME_DESC = "セッションの名前（文字・数字・「_」「-」で 40 字まで）";

export function createTerminalServer(terminal: Terminal): Server {
  const server = new Server({ name: "banto-module-terminal", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "terminal://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: { [VISIBILITY_META_KEY]: "admin", [MODULE_META_KEY]: TERMINAL_MODULE_META },
      },
      {
        // **入口**（launcher）——Command Palette の「Module の入口」から、AI を介さずに開く
        uri: TERMINAL_APP_URI,
        name: "ターミナル",
        description: "この Project のコンテナでシェルを打つ（tmux のセッション。閉じても残る）",
        mimeType: UI_APP_MIME,
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [CANVAS_META_KEY]: "launcher",
          [STREAMS_META_KEY]: ["terminal"],
          ui: { prefersBorder: false },
        },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (uri === TERMINAL_APP_URI) return { contents: [{ uri, mimeType: UI_APP_MIME, text: terminalAppHtml() }] };
    if (uri === "terminal://module") {
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(TERMINAL_MODULE_META) }] };
    }
    throw new Error(`知らない資源です: ${uri}`);
  });

  const admin = { [VISIBILITY_META_KEY]: "admin" };
  const name = { type: "string", description: NAME_DESC };
  const size = {
    cols: { type: "number", description: "端末の幅（文字数）" },
    rows: { type: "number", description: "端末の高さ（行数）" },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "listSessions",
        description: "セッションの一覧。lost は前にあったが、いまは無いもの（コンテナを起こし直した・シェルを終えた）",
        inputSchema: { type: "object", properties: {} },
        _meta: admin,
      },
      {
        name: "createSession",
        description: "セッションを足す。cwd を書かなければ、消えたセッションの控えの作業ディレクトリか、Project の根",
        inputSchema: { type: "object", properties: { name, cwd: { type: "string" }, ...size }, required: ["name"] },
        _meta: admin,
      },
      {
        name: "renameSession",
        description: "セッションの名前を変える",
        inputSchema: { type: "object", properties: { name, newName: name }, required: ["name", "newName"] },
        _meta: admin,
      },
      {
        name: "closeSession",
        description: "セッションを閉じる（中のシェルは終わる）。消えたセッションなら控えから消す",
        inputSchema: { type: "object", properties: { name }, required: ["name"] },
        _meta: admin,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    try {
      // **人の操作だけ**。可視性で AI からは見えないが、呼び出しの刻印でも確かめる——人の画面からの呼び出しには、
      // host が `{admin: true}` を刻む
      const caller = callerOf(request.params._meta as Record<string, unknown> | undefined);
      if (!caller || !("admin" in caller)) throw new TerminalError(`${request.params.name} は人の画面からだけ呼べます`);
      switch (request.params.name) {
        case "listSessions":
          return text(await terminal.listSessions());
        case "createSession":
          return text(await terminal.createSession(args));
        case "renameSession":
          return text(await terminal.renameSession(args));
        case "closeSession":
          return text(await terminal.closeSession(args));
        default:
          throw new Error(`unknown tool: ${request.params.name}`);
      }
    } catch (err) {
      // 断り・tmux の失敗は理由ごと画面に返す（黙って空を返さない）
      if (err instanceof TerminalError) return { content: [{ type: "text", text: err.message }], isError: true };
      throw err;
    }
  });

  return server;
}

/**
 * **シェルの環境**：Module の環境から host が渡した `BANTO_*`（中継の合言葉を含みうる）を落とし、専用のホームと
 * XDG の置き場・locale を足す（Shell のコマンドと揃える——v4-security.md「Shell のコマンドには、専用のホームを渡す」）
 */
export function buildEnvironments(parent: NodeJS.ProcessEnv, home: string | undefined): {
  processEnv: NodeJS.ProcessEnv;
  sessionEnv: Record<string, string>;
} {
  const processEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) if (!k.startsWith("BANTO_") && k !== "TMUX" && k !== "TMUX_PANE") processEnv[k] = v;
  const sessionEnv: Record<string, string> = {};
  if (home) {
    Object.assign(sessionEnv, {
      HOME: home,
      XDG_CONFIG_HOME: `${home}/.config`,
      XDG_CACHE_HOME: `${home}/.cache`,
      XDG_DATA_HOME: `${home}/.local/share`,
      XDG_STATE_HOME: `${home}/.local/state`,
    });
  }
  // 日本語を打って読めるように（コンテナの既定は C のことがある）
  if (!processEnv.LANG) sessionEnv.LANG = "C.UTF-8";
  for (const n of INHERITED_ENV_NAMES) if (parent[n]) sessionEnv[n] = parent[n]!;
  Object.assign(processEnv, sessionEnv);
  return { processEnv, sessionEnv };
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  if (!projectRoot || !dataDir) {
    console.error("BANTO_PROJECT_ROOT, BANTO_MODULE_DATA_DIR が必要です");
    process.exit(1);
  }
  // 専用のホームは host が用意する（Shell と同じ形、`BANTO_SHELL_HOME`）。無ければ親の HOME のまま
  const home = process.env.BANTO_SHELL_HOME || undefined;
  const { processEnv, sessionEnv } = buildEnvironments(process.env, home);
  const tmux = new Tmux({ env: processEnv });
  const terminal = new Terminal({
    tmux,
    store: new SessionStore(dataDir),
    projectRoot,
    sessionEnv,
    prepare: async () => {
      if (home) await mkdir(home, { recursive: true });
    },
  });
  const { listenStreams } = await import("@banto/stream-server");
  await listenStreams({ terminal: terminalStreamHandler({ tmux }) }, { dataDir, onError: (err) => console.error("[terminal]", err.message) });
  await createTerminalServer(terminal).connect(new StdioServerTransport());
}
