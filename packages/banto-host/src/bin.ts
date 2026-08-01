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

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { getModel, getModels } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { JsonlMemoryStore } from "@banto/core";

import {
  PiRpcDriver,
  WorkerPool,
  createWorkerPoolModule,
} from "@banto/worker-pool";
import {
  BANTO_ORIGIN,
  isBantoOrigin,
  renderWorkerNotice,
  threadIdOfOrigin,
  threadOrigin,
} from "./worker-notice.js";

import { Canvas, createCanvasCatalog } from "./canvas.js";
import { createCanvasTools } from "./canvas-tools.js";
import { demoCanvasViews } from "./demo-views.js";
import { createBantoHostSession } from "./host-session.js";
import { BantoHostClient } from "./client.js";
import { BANTO_DEFAULT_PORT, type ServerEvent } from "./protocol.js";
import { BantoHostServer } from "./server.js";
import { createMemoryTools } from "./memory-tools.js";
import { CORE_ORIGIN, createModuleRegistry, resolveSkills, type SkillEntry } from "./module.js";
import { createDemoModule } from "./modules/demo.js";
import { createStudioModule } from "./modules/studio.js";
import { createWorkspaceModule } from "./modules/workspace.js";
import { PlaceGrantStore } from "./place-grants.js";
import { ThreadStore } from "./thread-store.js";
import { createRepoManagerModule, createRepoManagerPlaceProvider } from "@banto/repo-manager";
import {
  EnvironmentPool,
  ENVIRONMENT_POOL_BASE_URL,
  createCaddyExposer,
  createEnvironmentPoolModule,
  createEnvProxyExposer,
} from "@banto/environment-pool";
import { workspaceRoot } from "./workspace.js";
import {
  PlaceRegistry,
  broadlyWritable,
  createStaticPlaceProvider,
  type StaticPlaceConfig,
} from "./places.js";
import { guardPathArg } from "./place-scoped.js";
import { createSkillTools } from "./skill-tools.js";
import { bindToolArgs, createThreadTools } from "./thread-tools.js";
import { ThreadRegistry, type ThreadFactory } from "./threads.js";
import { loadBantoSkills } from "./skills.js";

/**
 * 番頭が作業してよい場所の設定（決定36d・38b）。
 *
 * **番頭が書けない場所に置く**のが要点——リポジトリ内の設定に置くと、番頭がそれ自体を
 * 書き換えて自分の権限を広げられる（I1：ずるは不可能にする）。
 *
 * 形式：`BANTO_PLACES=<id>:<path>[:<書ける範囲をカンマ区切り>];...`
 * 例：`banto:/home/me/ghq/github.com/me/banto:docs/**,work/**`
 * 未設定なら、従来どおりワークスペース1つ（読み取り専用）。
 */
function readPlaceConfig(fallbackRoot: string): StaticPlaceConfig[] {
  const raw = process.env["BANTO_PLACES"];
  if (!raw || raw.trim().length === 0) {
    return [{ id: "workspace", label: "ワークスペース", path: fallbackRoot }];
  }
  const places: StaticPlaceConfig[] = [];
  for (const entry of raw.split(";").map((e) => e.trim()).filter((e) => e.length > 0)) {
    const [id, place, writable] = entry.split(":");
    // I2: 壊れた設定を黙って飛ばさない。場所を1つ失うと番頭が黙って別の場所を触りうる
    if (!id || !place) throw new Error(`BANTO_PLACES の項目が不正です: "${entry}"`);
    places.push({
      id,
      label: id,
      path: place,
      ...(writable ? { writable: writable.split(",").map((w) => w.trim()).filter(Boolean) } : {}),
    });
  }
  return places;
}

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
  "作業できる場所（リポジトリ・ワークツリー・作業領域）は place.list で分かります。file.* と git.* でその中身と履歴を閲覧でき、どの場所かは place で選びます。",
  "file.write で自分の成果物（決定の記録・起票・メモ）を書けますが、**POが場所ごとに許した範囲だけ**で、既定はどの場所も読み取り専用です。断られたら place.request_write で範囲を頼み、canvas.open で place.permissions を開けばPOがその場で許可できます。頼んだだけでは書けません。コードを変える仕事は自分で書かず職人へ委譲します（D10）。",
  "gitの変更操作（commit・push・branch）は持っていません。頼まれたら職人へ委譲してください——書いたものは未コミットで残り、POのレビューを通ります。",
  "調査・実装など手を動かす仕事は worker.delegate で職人へ委譲してください（D10）。手順は skill.read で worker-delegation を確認できます。",
  "検証環境を外から見せたいときは env.provision の expose にポートを渡すと url が返ります。POが自分の目で確かめたいときに使ってください（機械が確かめるだけなら要りません）。",
  "検証は env.verify で回せます。環境を立ててコマンドを走らせて必ず畳むところまで機構がやるので、結果は職人の主張ではなく確かめた事実として扱えます。レビュー用に環境を残したいときだけ env.provision を使い、使い終わったら env.teardown で畳んでください。",
  "職人からの報告・質問は自動で届きます。報告は主張であって完了の証明ではないので、必要なら成果を自分で確かめてください。質問には worker.steer で答えられます。",
  "確かめて良いと判断したら worker.close で職人を畳んでください。待機中の職人はプロセスとして残り続けます。畳んでも記録は残り、続きを頼みたくなったら worker.wake で元の会話ごと起こし直せます。",
].join("\n");

/**
 * provider/model を pi のモデルに解決する。
 *
 * **台帳に無いモデルも通す。** プロバイダは台帳より速く増減する——実際に
 * `deepseek-v4-flash-free` は pi の台帳に無いが opencode では動く。pi の CLI も
 * 同じ扱いで、同プロバイダの既知モデルを土台に id だけ差し替えている
 * （`model-resolver.js` の `buildFallbackModel`）。ホストだけ厳しくすると、
 * CLI では使えるモデルがホストでは使えないという食い違いになる。
 *
 * I2: **プロバイダが台帳に無いときは止まる**。ここまで緩めると、綴り間違いが
 *     黙って通って別のプロバイダの鍵で 401 になる（既定解決で実際に踏んだ）。
 */
function resolveModel(provider: string, modelId: string): ReturnType<typeof getModel> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- getModel/getModels は既知
  // provider のリテラル型を要求するが、ここは CLI 引数由来の文字列を通す (I4)
  const known = getModel(provider as any, modelId as any);
  if (known) return known;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上 (I4)
  const siblings = getModels(provider as any);
  if (!siblings || siblings.length === 0) {
    throw new Error(`unknown provider: ${provider}`);
  }
  console.warn(
    `[banto] モデル "${modelId}" は pi の台帳にありません。${provider} の設定を土台に、` +
      "id をそのまま使います（pi CLI と同じ扱い）"
  );
  return { ...siblings[0]!, id: modelId, name: modelId };
}

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

  // 決定36：番頭が作業してよい場所。既定は BANTO_WORKSPACE（従来どおり1つ）。
  // BANTO_PLACES で複数を与えられる（決定36d：静的な場所はホスト設定。モジュールにしない）。
  //
  // **設定を先に登録する。** 同じ場所が両方から出たとき先勝ちなので、書き込みを許した
  // 設定側が、repo-manager が返す読み取り専用の同じリポジトリに負けないようにする（決定38a）。
  // 決定38c: POが後から許した範囲。保存先はホストのデータ置き場——リポジトリの中に置くと
  // 番頭が宣言を書き換えて自分の権限を広げられる（決定38b。file.write の砦がここを守っている）
  const grants = new PlaceGrantStore(path.join(dataDir(), "place-grants.json"));
  const places = new PlaceRegistry(
    [createStaticPlaceProvider(readPlaceConfig(workspace)), createRepoManagerPlaceProvider()],
    grants
  );
  for (const place of broadlyWritable(await places.list())) {
    // 決定38e：広く許したことを黙って通さない
    console.warn(
      `[banto] 場所 "${place.id}" は広い書き込み範囲（${(place.writable ?? []).join(", ")}）を許しています`
    );
  }

  // 決定25・27: モジュールを1箇所で登録する。Tool・GUI・SKILL はここから束ねて配る。
  // Kobo は接続後に、同じ口から登録される。
  //
  // Worker Pool は**必須の組み込みモジュール**（決定27c）。無いと番頭は職人へ委譲できず
  // D10 が構造的に満たせない。Banto に同居させる形で立て、到達先は相対パスにする
  // （独立サービスとして別に立てる場合は BANTO_WORKER_POOL_URL で絶対URLを指す）。
  //
  // 決定29: 職人が報告・質問を返す先。職人は別プロセスなので絶対URLが要る
  // （UI 向けの相対パスとは別物——UI は自分のオリジンに解決できるが、子プロセスはできない）。
  // 決定39: 検証環境を外から見えるようにする口。既定は番頭ホスト自身が中継する
  // ——どこでも動き、banto を守っている認証をそのまま継承する。Caddy を持つ配置では
  // BANTO_CADDY_ADMIN + BANTO_ENV_DOMAIN でサブドメイン公開へ差し替える
  const caddyAdmin = process.env["BANTO_CADDY_ADMIN"];
  const envDomain = process.env["BANTO_ENV_DOMAIN"];
  const envProxy = createEnvProxyExposer({
    baseUrl: ENVIRONMENT_POOL_BASE_URL,
    ...(process.env["BANTO_PUBLIC_URL"] ? { publicBaseUrl: process.env["BANTO_PUBLIC_URL"] } : {}),
  });
  const exposer =
    caddyAdmin && envDomain
      ? createCaddyExposer({ adminUrl: caddyAdmin, baseDomain: envDomain })
      : envProxy;
  if (caddyAdmin && !envDomain) {
    // I2: 半端な設定を黙って既定へ落とさない（Caddy のつもりで中継されると気づけない）
    throw new Error("BANTO_CADDY_ADMIN を設定するなら BANTO_ENV_DOMAIN も要ります。");
  }
  const environmentPool = new EnvironmentPool({
    dataDir: path.join(dataDir(), "environment-pool"),
    exposer,
    // 決定32d: 復号鍵は Environment Pool が持つ。sops の標準の環境変数から取る
    // ——これを渡さないと credentials 付きのプロファイルが使えない
    ...(process.env["SOPS_AGE_KEY_FILE"]
      ? { sopsAgeKeyFile: process.env["SOPS_AGE_KEY_FILE"] }
      : {}),
    // spec §5: 畳み損ね・孤児はPOへ知らせる。Kobo のケイデンスはまだ配線されていないので
    // 番頭の会話へ流す——ログと画面だけでは、開くまで気づけない（I3）
    onAttention: (message) => {
      void server?.notify(`【検証環境】${message}`, { source: "system" }).catch((err: unknown) => {
        console.error(`[env] 知らせを届けられませんでした: ${String(err)}`);
      });
    },
  });
  // spec-environment §5: 執行は Environment Pool の台帳が行う。**ここで回さないと
  // 番頭が立てた環境を誰も片付けない**——Kobo 側の tick は台帳が別で対象外（I3）
  environmentPool.startMaintenance();

  const workerPoolUrl = process.env["BANTO_WORKER_POOL_URL"] ?? "/api/worker-pool";
  const reportUrl = workerPoolUrl.startsWith("/")
    ? `http://localhost:${options.port}${workerPoolUrl}`
    : workerPoolUrl;

  const workerPool = new WorkerPool({
    driver: new PiRpcDriver({ sessionBaseDir: path.join(dataDir(), "worker-sessions") }),
    dataDir: path.join(dataDir(), "worker-pool"),
    defaultProjectTag: "banto",
    defaultOrigin: BANTO_ORIGIN,
    reportUrl,
  });
  const workerPoolModule = createWorkerPoolModule(workerPool, workerPoolUrl);

  // 決定26 の層を解いた SKILL（番頭核＋モジュール）。studio はこれをそのまま見せる
  const coreSkills: SkillEntry[] = skills.map((skill) => ({ skill, origin: CORE_ORIGIN }));

  const modules = createModuleRegistry([
    // 決定38b: ホスト自身のデータ置き場は、設定で ** を許しても書かせない（自己昇格を塞ぐ）
    createWorkspaceModule(places, { protectedPaths: [dataDir()] }, grants),
    workerPoolModule,
    createRepoManagerModule(),
    // 決定32c・34: 番頭は Kobo 無しでも検証を回せる。「テストが通った」を職人の主張ではなく
    // 機構の返す事実として受け取るための実行能力（決定29a）
    // 中継はこのモジュールが自分の到達先の下で捌く（決定27・39）
    createEnvironmentPoolModule(environmentPool, ENVIRONMENT_POOL_BASE_URL, envProxy),
    createDemoModule(),
  ]);

  // studio は他モジュールの SKILL も見せるので、レジストリが揃ってから登録する
  modules.register(
    createStudioModule({
      memory,
      skills: resolveSkills([coreSkills, modules.skills()]),
    })
  );

  const catalog = createCanvasCatalog(modules.views());

  // I2: 指定されたモデルが見つからないなら黙って別のモデルに落とさず止める。
  //     既定解決に任せると、auth.json に別プロバイダの無効な鍵が残っている場合に
  //     そちらが選ばれて 401 になる（実際に踏んだ）。
  const model = options.provider && options.model
    ? resolveModel(options.provider, options.model)
    : undefined;

  // スレッド1本分の器を作る（決定2・task-0035）。**キャンバスはスレッドごと**——
  // ここを共有すると、ある会話で GUI を開いたときに別の会話の表示まで変わる。
  //
  // 記憶は全スレッドで共有する（D11：番頭は記憶を持つ。分裂させない）。
  let threads: ThreadRegistry;
  let server: BantoHostServer;
  const threadFactory: ThreadFactory = async (threadId, resumeFrom) => {
    const canvas = new Canvas(catalog);
    // 記憶・SKILLのToolは createBantoHostSession が内部で足すので、ここでは渡さない。
    // canvas.* / thread.* は Banto 中核自身のドメイン（決定27a）でモジュールではない。
    const ownTools = [
      ...createCanvasTools(canvas, catalog),
      ...createThreadTools({
        threads,
        // 出所は「別の会話」。職人の報告と同じ札で出さない（PO報告 2026-07-31）
        seed: (threadId, message) => server.notify(message, { threadId, source: "thread" }),
      }),
      // 決定35a: 職人の報告は**起こしたスレッド**へ返る。番頭に自分の threadId を
      // 書かせず、ここで固定して渡す（番頭は自分がどのスレッドかを知らない）
      ...modules.tools().map((tool) => {
        if (tool.name !== "worker.delegate") return tool;
        const bound = bindToolArgs(tool, { origin: threadOrigin(threadId) });
        // 決定36g：職人の作業場所を砦に通す。いままで無検査で、番頭が任意の
        // ディレクトリを職人に書き換えさせられた
        return guardPathArg(bound, places, "worktreePath");
      }),
    ];
    // task-0036: 番頭の文脈をディスクへ書く。**ここが inMemory だと再起動で全部消える**
    // ——画面の記録（ThreadStore）を戻しても、番頭は何も覚えていない状態になる。
    // 復元のときは元のファイルを開き直し、続きから話せるようにする
    const sessionDir = path.join(dataDir(), "threads", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionManager =
      resumeFrom && fs.existsSync(resumeFrom)
        ? SessionManager.open(resumeFrom, sessionDir, process.cwd())
        : SessionManager.create(process.cwd(), sessionDir);

    const { session } = await createBantoHostSession({
      systemPrompt: SYSTEM_PROMPT,
      tools: ownTools,
      memory,
      moduleSkills: modules.skills(),
      sessionManager,
      ...(model ? { model } : {}),
    });
    // server はイベントの wire名→論理名 逆引きに、登録した論理名のToolを必要とする
      const tools = [...ownTools, ...createMemoryTools(memory), ...createSkillTools(skills)];
    return {
      session,
      canvas,
      tools,
      getLastError: () => session.agent.state.errorMessage,
      ...(sessionManager.getSessionFile() ? { sessionFile: sessionManager.getSessionFile()! } : {}),
      dispose: () => session.dispose(),
    };
  };

  // task-0036: 会話はホストの再起動を越えて残る
  const threadStore = new ThreadStore(path.join(dataDir(), "threads"));
  threads = new ThreadRegistry(threadFactory, threadStore);
  await threads.restore();
  // 残っていた会話が1本も無ければ新しく開く。宛先が無いと threadId 省略のメッセージを捌けない
  const restored = threads.list({ state: "open" });
  const defaultThread = restored[0] ?? (await threads.open());
  if (restored.length > 0) {
    console.log(`[banto] 会話を ${threads.list().length} 本読み戻しました`);
  }

  server = await BantoHostServer.start({
    threads,
    port: options.port,
    catalog,
    modules,
  });

  // 決定29: 番頭が起こした職人のイベントだけを受ける。他の起動元（Kobo 等）の分は届かない。
  // lastEventId から始めるので、起動前に溜まっていた古い報告を今さら会話へ流し込まない。
  //
  // 決定35a: 宛先は**起こしたスレッド**。origin を見て振り分ける（Worker Pool 側の
  // 絞り込みは1つの origin しか取れないため、ここで前置きの一致を見る）。
  const unsubscribeWorkers = workerPool.subscribe(
    (event) => {
      if (!isBantoOrigin(event.origin)) return;
      const notice = renderWorkerNotice(event);
      if (!notice) return;
      const threadId = threadIdOfOrigin(event.origin);
      void server.notify(notice, { ...(threadId ? { threadId } : {}), source: "worker" }).catch((err: unknown) => {
        // 決定35b: 宛先スレッドが畳まれていたら起こし直して届ける——のが本筋だが、
        // 起こし直せるのは会話が残っている場合（task-0036 の永続化）。いまは既定スレッドへ
        // 逃がし、消えたことにしない（I2：答え手のいない質問を黙って捨てない）
        console.error(`[banto] 知らせの宛先 ${String(threadId)} が見つかりません: ${String(err)}`);
        void server.notify(notice, { source: "worker" });
      });
    },
    { afterEventId: workerPool.lastEventId }
  );

  console.log(`[banto] listening on ws://localhost:${server.port}/ws`);
  console.log(
    `[banto] model: ${model ? `${model.provider}/${model.id}` : "(pi の既定解決)"}`
  );
  console.log(`[banto] memory: ${memoryPath()}`);
  console.log(`[banto] skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`);
  console.log(`[banto] canvas: ${catalog.list().map((c) => c.kind).join(", ") || "(none)"}`);
  console.log(`[banto] workspace: ${workspace}`);
  console.log(`[banto] worker report url: ${reportUrl}`);
  console.log(`[banto] default thread: ${defaultThread.title} (${defaultThread.id})`);
  console.log(
    `[banto] modules: ${modules.list().map((m) => `${m.name}(${m.endpoint.baseUrl})`).join(", ") || "(none)"}`
  );

  const shutdown = (): void => {
    void (async () => {
      unsubscribeWorkers();
      workerPool.dispose();
      // server.close() が全スレッドの後始末（購読解除＋対話ループの dispose）まで行う
      await server.close();
      threads.dispose();
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
