/**
 * 番頭ホストは工房（Worker Pool）と検証環境（Environment Pool）を**自分の中に作らない**
 * （task-0066・ADR-0013 決定61）。
 *
 * 作っていた頃に起きていたこと：
 *   - Kobo が職人を起こすのに番頭の稼働が要る（決定27b が避けた依存の逆転）
 *   - 番頭が立てた環境と Kobo が立てた環境で**台帳が2つに割れる**（inc-0027）
 *
 * ここで確かめるのは、**本物のサービスを立てて番頭ホストの載せ方で叩く**こと。
 * 偽の fetch で済ませない——過去に「偽物では全部通るのに本物で壊れていた」を繰り返している。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { WorkerPoolService } from "../../packages/banto-worker-pool/src/service.js";
import {
  createWorkerReportTools,
  createWorkerTools,
} from "../../packages/banto-worker-pool/src/worker-tools.js";
import { createWorkerPoolSettings } from "../../packages/banto-worker-pool/src/settings.js";
import { EnvironmentPool } from "../../packages/banto-environment-pool/src/pool.js";
import { EnvironmentPoolService } from "../../packages/banto-environment-pool/src/service.js";
import { createEnvTools } from "../../packages/banto-environment-pool/src/tools.js";
import { createEnvProxyExposer } from "../../packages/banto-environment-pool/src/proxy-exposer.js";
import { createSettingsTools, createFileSettingsSection } from "../../packages/banto-core/src/index.js";
import {
  createRemoteEnvironmentPoolModule,
  createRemoteWorkerPoolModule,
} from "../../packages/banto-host/src/remote-pools.js";
import { startWorkerNotices } from "../../packages/banto-host/src/worker-notice.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

const HOST_SOURCE = new URL("../../packages/banto-host/src/bin.ts", import.meta.url).pathname;

/** Tool を1本呼んで `details` を返す。 */
async function invoke(
  tools: NamespacedToolDefinition[],
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} が無い`);
  const result = await tool!.execute(args as never, { toolCallId: "test" });
  return (result.details ?? {}) as Record<string, unknown>;
}

describe("[task-0066] 番頭ホストは工房を自分の中に作らない", () => {
  it("bin.ts が WorkerPool / EnvironmentPool を new しない（a1）", () => {
    const source = fs.readFileSync(HOST_SOURCE, "utf-8");
    assert.doesNotMatch(
      source,
      /new WorkerPool\(/,
      "工房を中に作ると、Kobo が職人を起こすのに番頭の稼働が要る（決定27b の依存の逆転）"
    );
    assert.doesNotMatch(
      source,
      /new EnvironmentPool\(/,
      "検証環境を中に作ると、番頭の台帳と Kobo の台帳が割れる（inc-0027）"
    );
  });

  it("**畳めるのは自分の職人だけ**の砦が、別プロセスでも生きている（決定63）", () => {
    const source = fs.readFileSync(HOST_SOURCE, "utf-8");
    // 台帳を直に見られなくなったので、誰が起こしたかは Tool で引く。
    // 引き方ごと消えると、Kobo の職人を番頭が畳めてしまう
    assert.match(
      source,
      /worker\.close[\s\S]{0,400}guardWorkerOrigin\([\s\S]{0,200}lookupWorker\(modules\.tools\(\)/,
      "worker.close / worker.stop は起動元の一致で守ること（引き方は worker.list）"
    );
  });

  it("到達先は設定で差し替えられる（a1）", async () => {
    const { createRemoteWorkerPoolModule: make } = await import(
      "../../packages/banto-host/src/remote-pools.js"
    );
    const module = make("http://127.0.0.1:1/api/worker-pool");
    // UI から見える先は**相対パス**（ブラウザは 127.0.0.1 のサービスへ届かない）
    assert.equal(module.endpoint.baseUrl, "/api/worker-pool");
    // I2: 立っていない相手を「結果なし」にしない
    await assert.rejects(() => invoke(module.tools, "worker.list"), /.*/);
  });
});

describe("[task-0066] テストは実機のサービスを叩かない", () => {
  /**
   * **常駐している工房と検証環境が、テストの相手になってはいけない。**
   *
   * 実際に踏んだ（2026-08-07）：この task で :4300 / :4400 を常駐させた途端、
   * Kobo の受け入れテストが落ちた——テストが立てた Kobo が**実機の検証環境**へ
   * 問い合わせ、ゲートの tick が遅くなって状態遷移の前提が崩れていた。落ちたのは
   * まだ幸運で、悪くすれば**テストが実機に本物の環境を立てる**。
   *
   * 到達先は `npm test` が届かない先に固定する。自分のプールが要るテストは
   * ハーネスを立てて URL を明示的に渡す（このファイルの他の試験がそうしている）。
   */
  it("npm test が到達先を実機から外している", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url).pathname, "utf-8")
    ) as { scripts: Record<string, string> };
    // e2e も同じ（実機の職人と環境を巻き込む余地を残さない）
    for (const script of [pkg.scripts["test"] ?? "", pkg.scripts["test:e2e"] ?? ""]) {
      for (const name of ["BANTO_WORKER_POOL_URL", "BANTO_ENV_POOL_URL"]) {
        assert.match(
          script,
          new RegExp(`${name}=http://127\\.0\\.0\\.1:1/`),
          `${name} を届かない先に固定すること——実機のサービスがテストの相手になる`
        );
      }
    }
  });
});

describe("[task-0066] 本物の工房サービスへ繋がる", () => {
  let pool: WorkerPool;
  let service: WorkerPoolService;
  let dataDir: string;
  let driver: FakeRuntimeDriver;
  let tools: NamespacedToolDefinition[];
  let settingsFile: string;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-uses-pool-"));
    settingsFile = path.join(dataDir, "settings.json");
    driver = new FakeRuntimeDriver();
    pool = new WorkerPool({
      driver,
      dataDir,
      defaultProjectTag: "banto",
      defaultOrigin: "banto",
      idleTimeoutMs: 0,
    });
    service = await WorkerPoolService.start({
      tools: [
        ...createWorkerTools(pool),
        ...createWorkerReportTools(pool),
        ...createSettingsTools(
          "worker",
          createWorkerPoolSettings(pool, createFileSettingsSection(settingsFile))
        ),
      ],
      port: 0,
    });
    tools = createRemoteWorkerPoolModule(service.baseUrl).tools;
  });

  after(async () => {
    for (const worker of pool.list({ includeClosed: false })) {
      await pool.close(worker.sessionId, "stopped").catch(() => undefined);
    }
    pool.dispose();
    await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("契約は持ち主のものがそのまま出る（2箇所に書かない）", () => {
    const local = createWorkerTools(pool);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      local.map((t) => t.name).sort()
    );
    for (const tool of tools) {
      const same = local.find((t) => t.name === tool.name)!;
      assert.equal(tool.description, same.description, `${tool.name}: 説明がずれている`);
    }
    // 職人が叩く口（決定29e）は番頭ホストに載せない——報告は工房へ直に返る
    assert.equal(
      tools.find((t) => t.name === "worker.report"),
      undefined
    );
  });

  it("委譲が HTTP 越しに通り、台帳は工房側の1つだけ（a2）", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "host-uses-pool-wt-"));
    const details = await invoke(tools, "worker.delegate", {
      taskId: "task-remote-1",
      instruction: "何かする",
      worktreePath: worktree,
      origin: "banto:thread-1",
    });
    const sessionId = String((details["sessionId"] as string) ?? "");
    assert.ok(sessionId.length > 0, "sessionId が返らない");
    // **工房の台帳に載っている**（番頭ホスト側に別の台帳が生まれていない）
    assert.equal(pool.get(sessionId)?.origin, "banto:thread-1");
    assert.equal(driver.sessions.length, 1);

    const listed = await invoke(tools, "worker.list", { query: sessionId });
    const workers = (listed["workers"] ?? []) as Array<{ sessionId: string }>;
    assert.ok(
      workers.some((w) => w.sessionId === sessionId),
      "sessionId で引けない（決定63 の砦がこの経路で職人を引く）"
    );
  });

  it("設定の読み書きが口を通って届く（決定41 は持ち場が変わっても効く）", async () => {
    const module = createRemoteWorkerPoolModule(service.baseUrl);
    const before = await module.settings!.read();
    assert.ok("idleTimeoutMinutes" in before);

    const result = await module.settings!.write({ idleTimeoutMinutes: 3 });
    assert.equal(result.applied, true);
    assert.equal(pool.currentIdleTimeoutMs(), 3 * 60_000, "工房に効いていない");
    // 次の起動でも効く（保存されている）
    assert.equal(
      (createFileSettingsSection(settingsFile).read() as { idleTimeoutMs?: number }).idleTimeoutMs,
      3 * 60_000
    );

    // I2: 受け付けられない値は黙って丸めず、画面へ理由が返る
    await assert.rejects(
      async () => module.settings!.write({ idleTimeoutMinutes: "たくさん" }),
      /0以上の数/
    );
  });

  it("職人の知らせが引きに行く形で会話へ返る（a4）", async () => {
    const seen: Array<{ message: string; threadId?: string }> = [];
    const stop = startWorkerNotices({
      tools,
      notify: async (message, target) => {
        seen.push({ message, ...(target.threadId ? { threadId: target.threadId } : {}) });
      },
      intervalMs: 50,
      log: () => undefined,
    });
    try {
      // 最初の tick が今の位置まで進むのを待つ（起動前の分を流さない）
      await new Promise((r) => setTimeout(r, 150));
      const before = seen.length;

      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "host-uses-pool-wt-"));
      const details = await invoke(tools, "worker.delegate", {
        taskId: "task-remote-2",
        instruction: "質問させる",
        worktreePath: worktree,
        origin: "banto:thread-7",
      });
      const sessionId = String(details["sessionId"]);
      // 職人が質問する（工房の口を直に叩く＝職人と同じ経路）
      const asked = await fetch(`${service.baseUrl}/tools/worker.ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          args: { projectTag: "banto", taskId: "task-remote-2", question: "どっちにしますか" },
        }),
      });
      assert.ok(asked.ok, `worker.ask が通らない: ${asked.status}`);

      const deadline = Date.now() + 5000;
      while (seen.length === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const notice = seen[seen.length - 1];
      assert.ok(notice, "職人の質問が会話へ返らない");
      assert.match(notice!.message, /どっちにしますか/);
      assert.equal(notice!.threadId, "thread-7", "起こしたスレッドへ返っていない（決定35a）");
      await pool.close(sessionId, "stopped").catch(() => undefined);
    } finally {
      stop();
    }
  });

  it("起動前に溜まっていた分は流さない", async () => {
    const seen: string[] = [];
    const stop = startWorkerNotices({
      tools,
      notify: async (message) => {
        seen.push(message);
      },
      intervalMs: 50,
      log: () => undefined,
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(seen, [], "落ちている間の古い報告を今さら会話へ流し込まない");
    } finally {
      stop();
    }
  });
});

describe("[task-0066] 検証環境は中継してブラウザへ出す（a3）", () => {
  let pool: EnvironmentPool;
  let service: EnvironmentPoolService;
  let target: http.Server;
  let dataDir: string;
  let relayed: ReturnType<typeof createRemoteEnvironmentPoolModule>;
  let hostServer: http.Server;
  let hostPort: number;

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-uses-env-"));
    // 「検証環境」の中身。中継が本当に届いているかを、返る本文で見る
    target = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("これは検証環境の中身です");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", () => resolve()));
    const targetPort = (target.address() as { port: number }).port;

    const proxy = createEnvProxyExposer({ baseUrl: "/api/environment-pool" });
    await proxy.expose({ envId: "env-1", port: targetPort });
    pool = new EnvironmentPool({ dataDir, exposers: { proxy } });
    service = await EnvironmentPoolService.start({
      tools: [...createEnvTools(pool), ...createSettingsTools("env", { title: "検証環境", fields: [], read: () => ({}), write: () => ({ applied: true }) })],
      port: 0,
      proxy,
    });

    // 番頭ホストの載せ方（相対パスの面＋中継）を、素の http サーバで再現する
    relayed = createRemoteEnvironmentPoolModule(service.baseUrl);
    hostServer = http.createServer((req, res) => {
      if (relayed.serve?.(req, res)) return;
      res.writeHead(404);
      res.end("not relayed");
    });
    // 番頭ホストの server.ts と同じ配り方（モジュールの到達先の下の upgrade を渡す）
    hostServer.on("upgrade", (req, socket, head) => {
      if (relayed.handleUpgrade?.(req, socket, head)) return;
      socket.destroy();
    });
    await new Promise<void>((resolve) => hostServer.listen(0, "127.0.0.1", () => resolve()));
    hostPort = (hostServer.address() as { port: number }).port;
  });

  after(async () => {
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    await service.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    pool.stopMaintenance();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("公開された環境へ、番頭ホストの面から届く", async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/api/environment-pool/env/env-1/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /検証環境の中身/);
  });

  it("Tool の口は中継しない（同じ結果に経路を2つ作らない）", async () => {
    const res = await fetch(`http://127.0.0.1:${hostPort}/api/environment-pool/tools/env.list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404, "Tool は写しの execute が呼ぶ（中継させない）");
  });

  it("WebSocket も中継する（検証環境の中で動く会話が成立する）", async () => {
    // 決定39b の利点（banto を守っている認証をそのまま継承する）は、**upgrade も
    // 通って初めて**成立する。生ソケットでヘッダを組み直す経路なので、実物で確かめる
    const { WebSocketServer, WebSocket } = await import("ws");
    const wss = new WebSocketServer({ server: target });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(`echo:${String(data)}`));
    });
    try {
      const client = new WebSocket(`ws://127.0.0.1:${hostPort}/api/environment-pool/env/env-1/ws`);
      const echoed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("中継された WebSocket が応えない")), 5000);
        client.on("open", () => client.send("こんにちは"));
        client.on("message", (data) => {
          clearTimeout(timer);
          resolve(String(data));
        });
        client.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      assert.equal(echoed, "echo:こんにちは");
      client.close();
    } finally {
      wss.close();
    }
  });

  it("Tool は写しから本物のサービスへ通る", async () => {
    const details = await invoke(relayed.tools, "env.list");
    assert.ok(Array.isArray(details["environments"]) || details["environments"] === undefined);
  });
});
