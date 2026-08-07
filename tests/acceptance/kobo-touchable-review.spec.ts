/**
 * Phase 3「触れる環境」（ADR-0013 決定59）。
 *
 * **PO の判断が要るものは、見るだけでなく触れる状態で差し出す。** `in-review` に入ったら
 * Kobo が Environment Pool に環境を立ててもらい、**公開URLを判断待ちの札に添える**。
 *
 * 要点3つ:
 *   1. **ポート番号は Kobo が知らない**（決定60a）。「人が触る」意図だけを渡し、
 *      どのポートかは Environment Pool がプロファイルから決める
 *   2. **URL は帳簿から導く**（D3）。畳んだ環境の URL を札に載せない
 *   3. **環境の寿命は判断に紐づく**（決定59）。判断が付いた瞬間に畳む
 *
 * Environment Pool も Kobo も**本物**を立てる（偽物では決定27b の経路を検査できない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import {
  EnvironmentPool,
  EnvironmentPoolService,
  createEnvTools,
  createEnvProxyExposer,
} from "@banto/environment-pool";

// imp-0012: テスト用の一時 state に隔離
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-touchable.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      s.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("待っていた状態にならなかった");
}

interface Harness {
  daemon: Daemon;
  pool: EnvironmentPool;
  service: EnvironmentPoolService;
  tools: ReturnType<typeof createKoboTools>;
  proj: string;
  dirs: string[];
}

/** `dev` プロファイル（ポートを持つ＝人が触れる面）。 */
const PROFILE_WITH_PORT = (port: number): string =>
  "profiles:\n" +
  "  dev:\n" +
  "    driver: process\n" +
  "    config:\n" +
  "      cmd: sleep 120\n" +
  `      port: ${port}\n` +
  "    ttl: 1h\n";

/** ポートを持たないプロファイル（監査用のテスト環境など、触る面が無いもの）。 */
const PROFILE_WITHOUT_PORT =
  "profiles:\n  audit:\n    driver: process\n    config:\n      cmd: sleep 120\n    ttl: 1h\n";

async function harness(profileBody: string): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "touchable-daemon-"));
  const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "touchable-pool-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "touchable-proj-"));
  fs.mkdirSync(path.join(projectDir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "meta", "environments.yaml"), profileBody, "utf-8");

  const pool = new EnvironmentPool({
    dataDir: poolDir,
    driverTimeoutMs: 20_000,
    // 決定39: 既定の公開方式は自分で中継する（banto を守っている前段を継承する形）
    // 決定39b: 中継の URL は banto の公開URLの下に生える（前段の認証をそのまま継承する）
    exposers: {
      proxy: createEnvProxyExposer({
        baseUrl: "/api/environment-pool",
        publicBaseUrl: "https://banto.example",
      }),
    },
  });
  const service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

  const daemon = Daemon.create({
    port: await freePort(),
    dataDir,
    watchIntervalMs: 99999,
    tickIntervalMs: 300,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    environmentPoolUrl: service.baseUrl,
  });
  await daemon.start();
  const proj = "touchable-proj";
  daemon.registerProject(proj, projectDir);

  return { daemon, pool, service, tools: createKoboTools(daemon), proj, dirs: [dataDir, poolDir, projectDir] };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  await h.service.close();
  h.pool.stopMaintenance();
  for (const d of h.dirs) fs.rmSync(d, { recursive: true, force: true });
}

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

/** タスクを `in-review` まで運ぶ。 */
async function driveToReview(h: Harness, taskId: string, environment: string): Promise<void> {
  h.daemon.createTask(h.proj, taskId, `レビュー用 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
    environment,
  });
  h.daemon.transition(h.proj, taskId, "queued", "test");
  await until(() => h.daemon.getTask(h.proj, taskId)?.status === "ready");
  for (const to of ["planning", "implementing", "auditing", "review-ready", "in-review"]) {
    const result = h.daemon.transition(h.proj, taskId, to, "test");
    assert.equal(result.ok, true, `${taskId} を ${to} へ動かせない`);
  }
}

const call = async (
  h: Harness,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const tool = h.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool: ${name}`);
  const result = await tool.execute(args as never, { toolCallId: "t" });
  return (result.details ?? {}) as Record<string, unknown>;
};

describe("[Phase 3/決定59] レビューには触れる環境を添える", () => {
  let h: Harness;
  before(async () => {
    h = await harness(PROFILE_WITH_PORT(5173));
  });
  after(async () => {
    await teardown(h);
  });

  it("in-review に入ると環境が立ち、**公開URLが帳簿に残る**", async () => {
    await driveToReview(h, "task-0001", "dev");
    await until(() =>
      h.daemon.getTaskEvents(h.proj, "task-0001").some((e) => e.type === "env_provisioned")
    );

    const provisioned = h.daemon
      .getTaskEvents(h.proj, "task-0001")
      .find((e) => e.type === "env_provisioned") as { url?: string; envId: string };
    assert.ok(provisioned.url, "触れる URL が帳簿に残ること（決定59）");
    assert.match(provisioned.url!, /\/env\//, "中継の URL であること");

    const live = h.pool.list({ taskId: "task-0001" });
    assert.equal(live.length, 1);
    assert.equal(live[0]!.url, provisioned.url, "Environment Pool の台帳と一致する");
  });

  it("**ポート番号は Kobo が知らない**（決定60a）。渡すのは「人が触る」意図だけ", () => {
    // Kobo のコードに公開ポートの数値が現れないこと——プロファイルの内部（config.port）を
    // Kobo が読み始めると、その口の変更が黙って Kobo を壊す
    const source = fs.readFileSync(
      path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "..",
        "packages",
        "banto-daemon",
        "src",
        "daemon.ts"
      ),
      "utf-8"
    );
    assert.match(source, /exposeProfilePort: true/, "意図だけを渡していること");
    assert.doesNotMatch(
      source,
      /expose:\s*\d/,
      "公開ポートの数値を Kobo が渡していないこと（番号は Environment Pool が決める）"
    );
    assert.doesNotMatch(
      source,
      /environments\.yaml/,
      "プロファイルの定義ファイルを Kobo が読んでいないこと（決定60a）"
    );
  });

  it("判断待ちの札に触れる場所が載る（kobo.task から取れる）", async () => {
    const details = await call(h, "kobo.task", { projectTag: h.proj, taskId: "task-0001" });
    assert.ok(details["envUrl"], "kobo.task が触れる場所を返すこと");
    const text = String(details["envUrl"]);
    assert.match(text, /^http/);
  });

  it("[決定59] 判断が付いた瞬間に畳む（approved で環境が消える）", async () => {
    const before = h.pool.list({ taskId: "task-0001" });
    assert.equal(before.length, 1, "判断の前は生きている");

    const approved = h.daemon.approveTask(h.proj, "task-0001", { by: "banto", note: "触って確かめた" });
    assert.equal(approved.ok, true);

    await until(() => h.pool.list({ taskId: "task-0001" }).length === 0);
    assert.ok(
      h.daemon.getTaskEvents(h.proj, "task-0001").some((e) => e.type === "env_torn_down"),
      "畳んだ記録が残る"
    );
  });

  it("畳んだあとは札に触れる場所を載せない（開いて初めて壊れていると分かる、を避ける）", async () => {
    const details = await call(h, "kobo.task", { projectTag: h.proj, taskId: "task-0001" });
    assert.equal(details["envUrl"], undefined, "畳んだ環境の URL は出さない（D3：帳簿から導く）");
  });
});

describe("[Phase 3/決定59] 触る面が無いプロファイルでも環境は立つ", () => {
  it("ポートを持たないプロファイルは、公開せずに立てる（環境ごと失敗にしない）", async () => {
    const h = await harness(PROFILE_WITHOUT_PORT);
    try {
      await driveToReview(h, "task-0002", "audit");
      await until(() =>
        h.daemon.getTaskEvents(h.proj, "task-0002").some((e) => e.type === "env_provisioned")
      );
      const provisioned = h.daemon
        .getTaskEvents(h.proj, "task-0002")
        .find((e) => e.type === "env_provisioned") as { url?: string };
      assert.equal(provisioned.url, undefined, "触れる URL は無い");
      assert.equal(h.pool.list({ taskId: "task-0002" }).length, 1, "環境そのものは立っている");

      const details = await call(h, "kobo.task", { projectTag: h.proj, taskId: "task-0002" });
      assert.equal(details["envUrl"], undefined);
    } finally {
      await teardown(h);
    }
  });
});
