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
  createEnvProxyExposer,
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
  /** タスクのワークツリーの置き場（段11c-2：立てる環境はここを映す） */
  worktreeBase: string;
  dirs: string[];
}

/**
 * Kobo と Environment Pool（独立サービス）を立てる。
 * @param envPoolUrl 到達先を差し替える（到達できない場合の検査に使う）
 */
async function harness(
  options: { profileBody?: string; envPoolUrl?: string; configBody?: string | null } = {}
): Promise<Harness> {
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
  // 段11c-1: `environment` を宣言していないタスクの落ち先（層B設定が名指しする環境）
  if (options.configBody !== null) {
    fs.writeFileSync(
      path.join(projectDir, "meta", "config.yaml"),
      options.configBody ?? "review:\n  env_profile: dev\n",
      "utf-8"
    );
  }

  const pool = new EnvironmentPool({
    dataDir: poolDir,
    driverTimeoutMs: 20_000,
    // 決定39: ポートを持つプロファイル（＝人が触れる面）は公開の口が要る。
    // 無いと `exposeProfilePort` の頼みが「公開の実装が設定されていない」で落ちる
    exposers: {
      proxy: createEnvProxyExposer({
        baseUrl: "/api/environment-pool",
        publicBaseUrl: "https://banto.example",
      }),
    },
  });
  const service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });

  const worktreeBase = path.join(dataDir, "worktrees");
  const daemon = Daemon.create({
    port: await freePort(),
    dataDir,
    tickIntervalMs: 200,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: worktreeBase,
    environmentPoolUrl: options.envPoolUrl ?? service.baseUrl,
  });
  await daemon.start();

  const projId = "kobo-env-proj";
  daemon.registerProject(projId, projectDir);

  return { daemon, pool, service, projId, worktreeBase, dirs: [dataDir, poolDir, projectDir] };
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
 *
 * 段11c-2: 環境が映すのは**タスクのワークツリー**なので、職人を起こさない検体でも
 * ワークツリーは在ることにする（無ければ Kobo は「main を映す環境」を立てずに断る）。
 */
async function driveToReview(
  h: Harness,
  taskId: string,
  environment?: string,
  options: { withoutWorktree?: boolean } = {}
): Promise<void> {
  const { daemon, projId } = h;
  daemon.createTask(projId, taskId, `レビュー用 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
    ...(environment ? { environment } : {}),
  });
  if (!options.withoutWorktree) {
    fs.mkdirSync(path.join(h.worktreeBase, projId, taskId), { recursive: true });
  }
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

  it("environment を持つタスクが判断待ちに入ると、環境が立ち env_provisioned が出る", async () => {
    await driveToReview(h, "task-0001", "dev");

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

  /**
   * 段11c-1（報告 A-6 (1)）。**宣言が無いことを「要らない」と読まない。**
   *
   * 以前はここで黙って return していた。実測で `environment` を宣言したタスクは
   * 70 本中 0 本——つまりこの経路は6日間・1,952 イベントを通して一度も先へ進んでおらず、
   * 「PO が触れる環境」は Kobo の外（番頭の手）でしか立っていなかった。
   */
  it("environment を宣言していなくても、層B設定が名指しした環境で立つ", async () => {
    await driveToReview(h, "task-0002");
    await until(() =>
      h.daemon.getTaskEvents(h.projId, "task-0002").some((e) => e.type === "env_provisioned")
    );

    const live = h.pool.list({ taskId: "task-0002" });
    assert.equal(live.length, 1, "宣言が無いタスクにも触れる場所が出る");
    assert.equal(live[0]!.profile, "dev", "層B設定の review.env_profile が既定として使われる");
  });

  /**
   * 段11c-2 の fail-closed（報告 A-6 (3)）。**中身が違う環境を差し出さない。**
   *
   * ワークツリーが引けないときに `workdir` 無しで頼むと、ドライバの `workdir ?? repoPath`
   * で main のチェックアウトが立つ。「環境が無い」は開けば気づけるが、
   * 「中身が main の環境が在る」は開いても気づけない——だから立てずに理由を残す。
   */
  it("ワークツリーが無いときは立てず、理由を残す（main を映す環境を差し出さない）", async () => {
    await driveToReview(h, "task-0007", "dev", { withoutWorktree: true });
    await until(() =>
      h.daemon.getTaskEvents(h.projId, "task-0007").some((e) => e.type === "env_provision_failed")
    );

    assert.equal(h.pool.list({ taskId: "task-0007" }).length, 0, "立ててはいけない");
    const failed = h.daemon
      .getTaskEvents(h.projId, "task-0007")
      .find((e) => e.type === "env_provision_failed") as { reason: string };
    assert.match(failed.reason, /ワークツリーが見つかりません/);
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

    await driveToReview(h, "task-0006", "dev");
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
      await driveToReview(h, "task-0003", "dev");
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
      await driveToReview(h, "task-0004", "dev");
      await until(() => h.pool.list({ taskId: "task-0004" }).length === 1);

      h.daemon.transition(h.projId, "task-0004", "failed", "テスト");
      await until(() => h.pool.list({ taskId: "task-0004" }).length === 0);

      const history = h.pool.list({ taskId: "task-0004", includeTornDown: true });
      assert.equal(history.length, 1, "履歴には残る");
      assert.equal(history[0]!.state, "torn-down");

      // task-0092: プールの帳簿が空になるのと、Kobo が記録を積むのは別の手。混んでいると
      // 帳簿の方が先に空になるので、**読む側の記録そのもの**を待ってから確かめる
      await until(() =>
        h.daemon.getTaskEvents(h.projId, "task-0004").some((e) => e.type === "env_torn_down")
      );
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

/**
 * 段B（番頭判断 2026-08-13）: **触れない環境を立てて「触れる」ふりをしない。**
 *
 * 第1便では `environment` の宣言が無いとき `verify.profile` へ落としたが、
 * banto のそれは `test`（docker・`setup: npm ci`・**ポート無し**）で、
 * 「毎回 docker が立つのに PO は触れない」——費用だけ掛かって決定59 の目的を果たさない。
 *
 * 落ち先は3分岐になる。**どれに落ちたかを番頭が読める**ことが条件（I2）。
 */
describe("[段B] 判断待ちに立てる環境の決め方（3分岐）", () => {
  /** ポートを持つ（人が触れる）／持たない（検証専用）の2つを定義する。 */
  const PROFILES =
    "profiles:\n" +
    "  touchable:\n" +
    "    driver: process\n" +
    "    config:\n" +
    "      cmd: sleep 120\n" +
    "      port: 5199\n" +
    "    ttl: 1h\n" +
    "  verify-only:\n" +
    "    driver: process\n" +
    "    config:\n" +
    "      cmd: sleep 120\n" +
    "    ttl: 1h\n";

  it("① `review.env_profile` を名指ししていれば、それで立つ", async () => {
    const h = await harness({
      profileBody: PROFILES,
      configBody: "verify:\n  profile: verify-only\nreview:\n  env_profile: touchable\n",
    });
    try {
      await driveToReview(h, "task-0010");
      await until(() =>
        h.daemon.getTaskEvents(h.projId, "task-0010").some((e) => e.type === "env_provisioned")
      );
      const live = h.pool.list({ taskId: "task-0010" });
      assert.equal(live.length, 1);
      assert.equal(live[0]!.profile, "touchable", "名指しより verify.profile が勝ってはいけない");
      assert.ok(live[0]!.url, "人が触れる URL が出る（決定59）");
    } finally {
      await teardownHarness(h);
    }
  });

  it("② 名指しが無くても、`verify.profile` が触れる面を持つならそれで立つ", async () => {
    const h = await harness({
      profileBody: PROFILES,
      configBody: "verify:\n  profile: touchable\n",
    });
    try {
      await driveToReview(h, "task-0011");
      await until(() =>
        h.daemon.getTaskEvents(h.projId, "task-0011").some((e) => e.type === "env_provisioned")
      );
      assert.equal(h.pool.list({ taskId: "task-0011" })[0]!.profile, "touchable");
    } finally {
      await teardownHarness(h);
    }
  });

  it("③ どちらも無いときは**立てず**、理由を帳簿に残す（費用だけの環境を作らない）", async () => {
    const h = await harness({
      profileBody: PROFILES,
      configBody: "verify:\n  profile: verify-only\n",
    });
    try {
      await driveToReview(h, "task-0012");
      await until(() =>
        h.daemon.getTaskEvents(h.projId, "task-0012").some((e) => e.type === "env_provision_failed")
      );

      assert.equal(h.pool.list({ taskId: "task-0012" }).length, 0, "立ててはいけない");
      const event = h.daemon
        .getTaskEvents(h.projId, "task-0012")
        .find((e) => e.type === "env_provision_failed") as { reason: string; profileName: string };
      // **番頭が読んで直せること**が条件。どのプロファイルが・なぜ・どうすればよいか
      assert.match(event.reason, /^立てていません:/);
      assert.match(event.reason, /config\.port/, "触れない理由が書いてある");
      assert.match(event.reason, /review\.env_profile/, "どう直すかが書いてある");
      assert.equal(event.profileName, "verify-only", "どのプロファイルの話かが分かる");
    } finally {
      await teardownHarness(h);
    }
  });

  it("タスクが `environment` を宣言していれば、層B設定より優先される（一番具体的なものが勝つ）", async () => {
    const h = await harness({
      profileBody: PROFILES,
      configBody: "review:\n  env_profile: touchable\n",
    });
    try {
      await driveToReview(h, "task-0013", "verify-only");
      await until(() =>
        h.daemon.getTaskEvents(h.projId, "task-0013").some((e) => e.type === "env_provisioned")
      );
      assert.equal(
        h.pool.list({ taskId: "task-0013" })[0]!.profile,
        "verify-only",
        "タスクが名指ししたものを勝手に取り替えない"
      );
    } finally {
      await teardownHarness(h);
    }
  });
});
