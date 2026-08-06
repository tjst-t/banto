/**
 * task-0059: Kobo は検証環境を **Environment Pool へ頼む**（ADR-0013 決定60）。
 *
 * 旧 `env-review-provision` / `env-teardown-on-task-end` / `env-quota` の置き換え。
 * 検証環境そのものの振る舞い（期限・上限・台帳）は `env-pool-lifecycle.spec.ts` が見る。
 * **ここで見るのは「Kobo が `env.*` を正しく呼ぶか」だけ**——統治の都合が3つある：
 *
 *   1. レビューに入ったら立てる（決定59：POが触れる状態で差し出す）
 *   2. タスクが終わったら畳む（I3：作った者が片付ける）
 *   3. 立てられないものを ready にしない（物理quota。職人を起こす前に止める）
 *
 * Environment Pool は**本物の独立サービス**として立てる（偽物では決定27b の経路を検査できない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "@banto/daemon";
import {
  EnvironmentPool,
  EnvironmentPoolService,
  createEnvTools,
} from "@banto/environment-pool";

// imp-0012: テスト用の一時 state に隔離
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-kobo-env.json"
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

/** 条件が満たされるまで待つ。 */
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
  projId: string;
  dirs: string[];
}

/**
 * Kobo と Environment Pool（独立サービス）を立てる。
 * @param envPoolUrl 到達先を差し替える（到達できない場合の検査に使う）
 */
async function harness(options: { profileBody?: string; envPoolUrl?: string } = {}): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-env-daemon-"));
  const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-env-pool-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-env-proj-"));

  fs.mkdirSync(path.join(projectDir, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, "meta", "environments.yaml"),
    options.profileBody ??
      "profiles:\n  dev:\n    driver: process\n    config:\n      cmd: sleep 120\n    ttl: 1h\n",
    "utf-8"
  );

  const pool = new EnvironmentPool({ dataDir: poolDir, driverTimeoutMs: 20_000 });
  const service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

  const daemon = Daemon.create({
    port: await freePort(),
    dataDir,
    watchIntervalMs: 200,
    tickIntervalMs: 200,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    environmentPoolUrl: options.envPoolUrl ?? service.baseUrl,
  });
  await daemon.start();

  const projId = "kobo-env-proj";
  daemon.registerProject(projId, projectDir);

  return { daemon, pool, service, projId, dirs: [dataDir, poolDir, projectDir] };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.daemon.stop();
  await h.service.close();
  h.pool.stopMaintenance();
  for (const d of h.dirs) fs.rmSync(d, { recursive: true, force: true });
}

/**
 * タスクを作り、`in-review` まで運ぶ。
 *
 * `queued → ready` は**ゲートが上げる**（手で動かすものではない）ので、そこだけは待つ。
 */
async function driveToReview(
  daemon: Daemon,
  projId: string,
  taskId: string,
  environment?: string
): Promise<void> {
  daemon.createTask(projId, taskId, `レビュー用 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
    ...(environment ? { environment } : {}),
  });
  assert.equal(daemon.transition(projId, taskId, "queued", "test").ok, true);
  await until(() => daemon.getTask(projId, taskId)?.status === "ready");

  for (const to of ["planning", "implementing", "auditing", "review-ready", "in-review"]) {
    const result = daemon.transition(projId, taskId, to, "test");
    assert.equal(result.ok, true, `${taskId} を ${to} へ動かせない: ${JSON.stringify(result)}`);
  }
}

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

describe("[task-0059/a1] レビューに入ったら Environment Pool に立ててもらう（決定59）", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardownHarness(h);
  });

  it("environment を持つタスクが in-review に入ると、環境が立ち env_provisioned が出る", async () => {
    await driveToReview(h.daemon, h.projId, "task-0001", "dev");

    // 立てるのは fire-and-forget（遷移をブロックしない）ので、記録が出るまで待つ。
    // **台帳に載るのが先、Kobo の記録は後**なので、台帳で待つと記録の手前で見に行ってしまう
    await until(() =>
      h.daemon.getTaskEvents(h.projId, "task-0001").some((e) => e.type === "env_provisioned")
    );

    const live = h.pool.list({ taskId: "task-0001" });
    assert.equal(live.length, 1, "Environment Pool の台帳に載る（真実は1つ）");
    assert.equal(live[0]!.projectTag, h.projId, "どの統治単位の環境かが残る");

    const events = h.daemon.getTaskEvents(h.projId, "task-0001");
    const provisioned = events.find((e) => e.type === "env_provisioned");
    assert.ok(provisioned, "Kobo 側にも「頼んだ」記録が残る");
    assert.equal((provisioned as { envId: string }).envId, live[0]!.envId);
  });

  it("environment を持たないタスクでは立てない（頼まれてもいないものを立てない）", async () => {
    await driveToReview(h.daemon, h.projId, "task-0002");
    await new Promise((r) => setTimeout(r, 800));

    assert.equal(h.pool.list({ taskId: "task-0002" }).length, 0);
    const events = h.daemon.getTaskEvents(h.projId, "task-0002");
    assert.equal(events.filter((e) => e.type === "env_provisioned").length, 0);
    assert.equal(events.filter((e) => e.type === "env_provision_failed").length, 0);
  });

  it("既にそのタスクの環境が生きていれば、二重に立てない", async () => {
    // 先に手で1つ立てておく（再度 in-review に入った状況と同じ）。
    // 守りが無いと、プロファイルに quota が無い場合に入るたび1つずつ漏れる
    await h.pool.provision({
      repoPath: h.dirs[2]!,
      profile: "dev",
      taskId: "task-0006",
      projectTag: h.projId,
    });

    await driveToReview(h.daemon, h.projId, "task-0006", "dev");
    await new Promise((r) => setTimeout(r, 1000));

    assert.equal(h.pool.list({ taskId: "task-0006" }).length, 1, "1つのまま（漏れない）");
    assert.equal(
      h.daemon.getTaskEvents(h.projId, "task-0006").filter((e) => e.type === "env_provisioned").length,
      0,
      "頼んでいないので記録も増えない"
    );
  });});

describe("[task-0059/a6] 到達できないことを成功に見せない（I2）", () => {
  it("Environment Pool へ届かないとき env_provision_failed に理由が残り、遷移は巻き戻らない", async () => {
    // 誰も待ち受けていない到達先を渡す
    const dead = `http://127.0.0.1:${await freePort()}/api/environment-pool`;
    const h = await harness({ envPoolUrl: dead });
    try {
      await driveToReview(h.daemon, h.projId, "task-0003", "dev");
      await until(() =>
        h.daemon
          .getTaskEvents(h.projId, "task-0003")
          .some((e) => e.type === "env_provision_failed")
      );

      const failed = h.daemon
        .getTaskEvents(h.projId, "task-0003")
        .find((e) => e.type === "env_provision_failed") as { reason: string };
      assert.match(failed.reason, /Failed to reach module|environment-pool/, "理由が残る");

      const task = h.daemon.getTask(h.projId, "task-0003");
      assert.equal(task?.status, "in-review", "provision の失敗で遷移は巻き戻らない");
    } finally {
      await teardownHarness(h);
    }
  });
});

describe("[task-0059/a1] タスクが終わったら畳む（I3：作った者が片付ける）", () => {
  it("failed に落ちたタスクの環境は畳まれ、env_torn_down が出る", async () => {
    const h = await harness();
    try {
      await driveToReview(h.daemon, h.projId, "task-0004", "dev");
      await until(() => h.pool.list({ taskId: "task-0004" }).length === 1);

      h.daemon.transition(h.projId, "task-0004", "failed", "テスト");
      await until(() => h.pool.list({ taskId: "task-0004" }).length === 0);

      const history = h.pool.list({ taskId: "task-0004", includeTornDown: true });
      assert.equal(history.length, 1, "履歴には残る");
      assert.equal(history[0]!.state, "torn-down");

      const events = h.daemon.getTaskEvents(h.projId, "task-0004");
      assert.ok(
        events.some((e) => e.type === "env_torn_down"),
        "Kobo 側にも畳んだ記録が残る"
      );
    } finally {
      await teardownHarness(h);
    }
  });
});

describe("[task-0059/a1] 立てられないものを ready にしない（物理quota）", () => {
  it("上限が埋まっている間は ready に上がらず、空くと上がる", async () => {
    const h = await harness({
      profileBody:
        "profiles:\n  capped:\n    driver: process\n    config:\n      cmd: sleep 120\n    ttl: 1h\n    quota:\n      max_instances: 1\n",
    });
    try {
      // 1つ埋める（番頭が直に立てた環境でも同じ台帳に載る＝Kobo からも見える）
      const taken = await h.pool.provision({
        repoPath: h.dirs[2]!,
        profile: "capped",
        taskId: "手で立てた",
        projectTag: h.projId,
      });

      h.daemon.createTask(h.projId, "task-0005", "上限待ち", {
        kind: "feature",
        scope: { paths: ["src/capped/**"] },
        acceptance: [{ id: "a1", text: "動く" }],
        environment: "capped",
      });
      h.daemon.transition(h.projId, "task-0005", "queued", "test");

      // ゲートの tick が写しを取り直して判定する
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(
        h.daemon.getTask(h.projId, "task-0005")?.status,
        "queued",
        "上限が埋まっている間は ready に上がらない"
      );

      await h.pool.teardown(taken.envId);
      await until(() => h.daemon.getTask(h.projId, "task-0005")?.status === "ready");
    } finally {
      await teardownHarness(h);
    }
  });
});
