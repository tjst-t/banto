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

import {
  PiRpcDriver,
  WorkerPool,
  createWorkerPoolModule,
} from "@banto/worker-pool";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { demoCanvasViews } from "./demo-views.js";
import { createBantoHostSession } from "./host-session.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createMemoryTools } from "./memory-tools.js";
import { createModuleRegistry } from "./module.js";
import { createDemoModule } from "./modules/demo.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { workspaceRoot } from "./workspace.js";
import { createSkillTools } from "./skill-tools.js";
import { loadBantoSkills } from "./skills.js";

/** データの置き場所。BANTO_DATA_DIR で差し替えられる。 */
function dataDir(): string {
  return process.env["BANTO_DATA_DIR"] ?? path.join(process.cwd(), ".banto");
}

/** 記憶の既定の置き場所。 */
function memoryPath(): string {
  return path.join(dataDir(), "memory.jsonl");
}

const SYSTEM_PROMPT = [
  "あなたは banto（番頭）です。POの代理として店を切り盛りします。",
  "細かい実装作業は自分でせず職人へ委譲し、自分の文脈は記憶と判断に使ってください（D10）。",
  "覚えておくべき好み・習慣が出てきたら memory.save で保存してください。",
  "POに何かを見せたいときは canvas.open でキャンバスに表示できます（何が開けるかは canvas.list_catalog）。",
  "file.* と git.* でワークスペースの中身と履歴を閲覧できます（いずれも読み取り専用）。",
  "調査・実装など手を動かす仕事は worker.delegate で職人へ委譲してください（D10）。手順は skill.read で worker-delegation を確認できます。",
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
  const workspace = workspaceRoot();

  // 決定25・27: モジュールを1箇所で登録する。Tool・GUI・SKILL はここから束ねて配る。
  // Kobo は接続後に、同じ口から登録される。
  //
  // Worker Pool は**必須の組み込みモジュール**（決定27c）。無いと番頭は職人へ委譲できず
  // D10 が構造的に満たせない。Banto に同居させる形で立て、到達先は相対パスにする
  // （独立サービスとして別に立てる場合は BANTO_WORKER_POOL_URL で絶対URLを指す）。
  const workerPool = new WorkerPool({
    driver: new PiRpcDriver({ sessionBaseDir: path.join(dataDir(), "worker-sessions") }),
    dataDir: path.join(dataDir(), "worker-pool"),
    defaultProjectTag: "banto",
  });
  const workerPoolModule = createWorkerPoolModule(
    workerPool,
    process.env["BANTO_WORKER_POOL_URL"] ?? "/api/worker-pool"
  );

  const modules = createModuleRegistry([
    createWorkspaceModule(workspace),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Worker Pool は banto-host に
    // 依存しないため BantoModule 型を参照できず、構造的に一致する形を返している（module.ts 参照）
    workerPoolModule as any,
    createDemoModule(),
  ]);

  const catalog = createCanvasCatalog(modules.views());
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

  // 記憶・SKILLのToolは createBantoHostSession が内部で足すので、ここでは渡さない。
  // canvas.* は Banto 中核自身のドメイン（決定27a）でモジュールではない。
  const ownTools = [...createCanvasTools(canvas, catalog), ...modules.tools()];
  const { session } = await createBantoHostSession({
    systemPrompt: SYSTEM_PROMPT,
    tools: ownTools,
    memory,
    moduleSkills: modules.skills(),
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
    modules,
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
  console.log(
    `[banto] modules: ${modules.list().map((m) => `${m.name}(${m.endpoint.baseUrl})`).join(", ") || "(none)"}`
  );

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
