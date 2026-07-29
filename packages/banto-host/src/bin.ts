#!/usr/bin/env node
/**
 * `banto` CLI（task-0009）。
 *
 *   banto serve            番頭ホストを常駐起動する（WS APIを開く）
 *   banto chat [--url ..]  起動中のホストへ接続し、端末から会話する
 *
 * CLI は WS APIの一クライアントに過ぎない——WebUI も同じAPIにぶら下がる
 * （Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * D5: 判断ロジックを持たない。組み立ては host-session.ts、配信は server.ts。
 * I2: 失敗は握りつぶさず、終了コードとメッセージで返す。
 */

import * as path from "node:path";
import * as readline from "node:readline";
import { getModel } from "@mariozechner/pi-ai";
import { JsonlMemoryStore } from "@banto/core";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { demoCanvasViews } from "./demo-views.js";
import { createBantoHostSession } from "./host-session.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createFileTools } from "./file-tools.js";
import { createGitTools } from "./git-tools.js";
import { createMemoryTools } from "./memory-tools.js";
import { workspaceRoot } from "./workspace.js";
import { createSkillTools } from "./skill-tools.js";
import { loadBantoSkills } from "./skills.js";

/** 記憶の既定の置き場所。BANTO_DATA_DIR で差し替えられる。 */
function memoryPath(): string {
  const dataDir = process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto");
  return path.join(dataDir, "memory.jsonl");
}

const SYSTEM_PROMPT = [
  "あなたは banto（番頭）です。POの代理として店を切り盛りします。",
  "細かい実装作業は自分でせず職人へ委譲し、自分の文脈は記憶と判断に使ってください（D10）。",
  "覚えておくべき好み・習慣が出てきたら memory.save で保存してください。",
  "POに何かを見せたいときは canvas.open でキャンバスに表示できます（何が開けるかは canvas.list_catalog）。",
  "file.* と git.* でワークスペースの中身と履歴を閲覧できます（いずれも読み取り専用）。",
].join("\n");

interface ServeOptions {
  port: number;
  /** provider/model を明示する。省略時は pi の既定解決（settings→最初に使えるもの）に任せる。 */
  provider?: string;
  model?: string;
}

async function serve(options: ServeOptions): Promise<void> {
  const memory = new JsonlMemoryStore(memoryPath());
  const skills = loadBantoSkills();
  // 当面のカタログはテスト用GUIのみ。基本GUIセット（決定18・24）とKobo由来のGUIは後続。
  const catalog = createCanvasCatalog(demoCanvasViews);
  const canvas = new Canvas(catalog);

  // I2: 指定されたモデルが見つからないなら黙って別のモデルに落とさず止める。
  //     既定解決に任せると、auth.json に別プロバイダの無効な鍵が残っている場合に
  //     そちらが選ばれて 401 になる（実際に踏んだ）。
  let model;
  if (options.provider && options.model) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getModel は既知providerの
    // リテラル型を要求するが、ここはCLI引数由来の文字列を通す (I4)
    model = getModel(options.provider as any, options.model as any);
    if (!model) throw new Error(`unknown model: ${options.provider}/${options.model}`);
  }

  const workspace = workspaceRoot();
  // 記憶・SKILLのToolは createBantoHostSession が内部で足すので、ここでは渡さない
  const ownTools = [
    ...createCanvasTools(canvas, catalog),
    ...createFileTools(workspace),
    ...createGitTools(workspace),
  ];
  const { session } = await createBantoHostSession({
    systemPrompt: SYSTEM_PROMPT,
    tools: ownTools,
    memory,
    ...(model ? { model } : {}),
  });

  // server はイベントの wire名→論理名 逆引きに、登録した論理名のToolを必要とする
  const tools = [...ownTools, ...createMemoryTools(memory), ...createSkillTools(skills)];
  const server = await BantoHostServer.start({
    session,
    tools,
    port: options.port,
    canvas,
    catalog,
    getLastError: () => session.agent.state.errorMessage,
    // 会話だけ捨てる。記憶はシステムプロンプト側にあるので残る（D11）
    clearHistory: () => {
      session.agent.state.messages = [];
    },
  });

  console.log(`[banto] listening on ws://localhost:${server.port}/ws`);
  console.log(
    `[banto] model: ${session.model ? `${session.model.provider}/${session.model.id}` : "(none)"}`
  );
  console.log(`[banto] memory: ${memoryPath()}`);
  console.log(`[banto] skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`[banto] canvas: ${catalog.list().map((c) => c.kind).join(", ") || "(none)"}`);
  console.log(`[banto] workspace: ${workspace}`);

  const shutdown = (): void => {
    void (async () => {
      await server.close();
      session.dispose();
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function chat(url: string): Promise<void> {
  let resolveTurn: (() => void) | undefined;

  const onEvent = (event: ServerEvent): void => {
    switch (event.type) {
      case "welcome":
        console.log(`[banto] connected (session ${event.sessionId})`);
        console.log(`[banto] tools: ${event.tools.join(", ") || "(none)"}\n`);
        break;
      case "text_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_start":
        console.log(`\n[tool] ${event.name} ...`);
        break;
      case "tool_end":
        console.log(`[tool] ${event.name} ${event.isError ? "failed" : "ok"}`);
        break;
      case "turn_end":
        if (event.errorMessage) console.error(`\n[banto] error: ${event.errorMessage}`);
        console.log("\n");
        resolveTurn?.();
        break;
      case "error":
        console.error(`[banto] ${event.message}`);
        resolveTurn?.();
        break;
    }
  };

  const client = await BantoHostClient.connect(url, onEvent);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("close", () => {
    client.close();
    process.exit(0);
  });

  const ask = (): void => {
    rl.question("> ", (line) => {
      const text = line.trim();
      if (text.length === 0) {
        ask();
        return;
      }
      const turn = new Promise<void>((resolve) => {
        resolveTurn = resolve;
      });
      client.send({ type: "prompt", text });
      void turn.then(ask);
    });
  };
  ask();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  switch (command) {
    case "serve": {
      const provider = flag("provider") ?? process.env["BANTO_PROVIDER"];
      const model = flag("model") ?? process.env["BANTO_MODEL"];
      await serve({
        port: Number(flag("port") ?? process.env["BANTO_PORT"] ?? BANTO_DEFAULT_PORT),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      });
      break;
    }
    case "chat":
      await chat(flag("url") ?? `ws://localhost:${BANTO_DEFAULT_PORT}`);
      break;
    default:
      console.error(
        "usage: banto <serve|chat> [--port N] [--provider P --model M] [--url ws://host:port]"
      );
      process.exit(2);
  }
}

// I2: 起動時の失敗は静かに終わらせず、原因を出して非ゼロ終了する
main().catch((err: unknown) => {
  console.error(`[banto] ${String(err)}`);
  process.exit(1);
});
