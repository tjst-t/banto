/**
 * task-0060: Kobo は職人を **Worker Pool へ頼む**（ADR-0013 決定60・63）。
 *
 * 旧 `spawn-pi` / `spawn-ledger` / `spawn-reconcile` / `tmux-attach` の置き換え。
 * 職人そのものの振る舞い（台帳・畳み・起こし直し・ライブアタッチ）は
 * `banto-worker-pool.spec.ts` が見る。**ここで見るのは「Kobo が worker.* を正しく使うか」**
 * ——統治の都合が5つある：
 *
 *   1. ready のタスクに職人を1人つけ、planning へ進める
 *   2. **台帳を持たない**（決定29c：職人の真実は Worker Pool に一箇所）。起こした職人は
 *      番頭の worker.list にも並び、起動元が kobo だと分かる（a2・a3）
 *   3. 自分の道具立て（banto-executor 拡張・指示・等級）が届く（a5・a8）
 *   4. 職人が黙って終わったら、統治として止まる（I2。旧・照合 tick の役目）
 *   5. 済んだ職人は Kobo が畳む（I3。番頭には畳めない・決定63）
 *
 * Worker Pool は**本物**を独立サービスとして立てる（偽物では決定27b の経路を検査できない）。
 * 差し替えるのは pi の代わりのランタイムだけで、最後の1本は**本物の pi** を起こす。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboSettings } from "../../packages/banto-daemon/src/kobo-settings.js";
import { PiRpcDriver } from "../../packages/banto-worker-pool/src/pi-rpc-driver.js";
import {
  FakeRuntimeDriver,
  startWorkerPool,
  type WorkerPoolHarness,
} from "./worker-pool-harness.js";

// ── git helpers ───────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

async function until(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  daemon: Daemon;
  workers: WorkerPoolHarness;
  driver: FakeRuntimeDriver;
  dataDir: string;
  repoDir: string;
  tmpDir: string;
  proj: string;
}

async function harness(options: { tickIntervalMs?: number } = {}): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-worker-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);
  const dataDir = path.join(tmpDir, "data");

  const driver = new FakeRuntimeDriver();
  const workers = await startWorkerPool(driver, {
    // 名指しの照合（`worker.models`）に要る。実物の登録は LLM Registry が持つ
    catalog: {
      models: () => [
        {
          providerId: "opencode-go",
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          tier: "standard",
          workerUsable: true,
        },
      ],
    },
  });

  const daemon = Daemon.create({
    port: 0,
    dataDir,
    watchIntervalMs: 99999,
    tickIntervalMs: options.tickIntervalMs ?? 99999,
    // 明示の置き場（テスト用リポジトリにはリモートが無く gwq が場所を決められない）
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();

  const proj = "kobo-worker-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, workers, driver, dataDir, repoDir, tmpDir, proj };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  await h.workers.close();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

/** ready まで進めたタスクを1つ用意する。 */
function readyTask(
  h: Harness,
  taskId: string,
  extra: Record<string, unknown> = {}
): void {
  h.daemon.createTask(h.proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
    ...extra,
  });
  h.daemon.transition(h.proj, taskId, "queued", "test");
  h.daemon.transition(h.proj, taskId, "ready", "test");
}

// ── a1 / a2 / a3: 職人は Worker Pool が持つ ──────────────────────────────────

describe("[task-0060/a1,a2,a3] Kobo は職人を Worker Pool へ頼み、自分の台帳を持たない", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("ready のタスクに職人が1人つき、planning へ進む", async () => {
    readyTask(h, "task-0001");
    const session = await h.daemon.spawnTask(h.proj, "task-0001");

    assert.ok(session.sessionId.length > 0, "職人のセッションが返る");
    assert.equal(h.daemon.getTask(h.proj, "task-0001")?.status, "planning");

    const spawned = h.daemon
      .getTaskEvents(h.proj, "task-0001")
      .find((e) => e.type === "agent_spawned");
    assert.ok(spawned, "帳簿に agent_spawned が残る");
    assert.equal(
      (spawned as { sessionId?: string }).sessionId,
      session.sessionId,
      "どの職人を起こしたかが残り、職人ビューアへ辿れる（決定18）"
    );
    assert.ok(
      fs.existsSync(session.worktreePath),
      `ワークツリーが用意される: ${session.worktreePath}`
    );
  });

  it("[a2] Kobo は spawn 台帳を開かない（台帳は Worker Pool に一箇所）", () => {
    assert.equal(
      fs.existsSync(path.join(h.dataDir, "spawn-ledger.json")),
      false,
      "Kobo のデータ置き場に職人の台帳ができないこと（D3：真実が割れない）"
    );
    const poolWorkers = h.workers.pool.list({ includeClosed: false });
    assert.equal(poolWorkers.length, 1, "Worker Pool の台帳に1人だけ居る");
    assert.equal(poolWorkers[0]!.taskId, "task-0001");
  });

  it("[a3] 番頭の worker.list に並び、起動元で Kobo 由来と分かる", async () => {
    // 番頭が見るのと同じ口（決定27b の `{baseUrl}/tools/{名前}`）を通す
    const res = await fetch(`${h.workers.url}/tools/worker.list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { includeClosed: false } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      details: { workers: Array<{ taskId: string; origin: string; worktree: string }> };
    };
    const found = body.details.workers.find((w) => w.taskId === "task-0001");
    assert.ok(found, "Kobo が起こした職人が番頭の一覧にも出る");
    assert.equal(found.origin, "kobo", "起動元で Kobo 由来と分かる（決定63 の判定材料）");
  });

  it("[a5] Kobo の道具立て（executor 拡張・到達先）が職人へ届く", () => {
    const session = h.driver.byTaskId("task-0001");
    assert.ok(session, "偽ランタイムに起動が届いている");
    const extensions = session.driverOptions["extensionPaths"] as string[] | undefined;
    assert.ok(
      extensions?.some((p) => p.endsWith("banto-executor.ts")),
      `banto-executor 拡張が載ること。載ったのは: ${JSON.stringify(extensions)}`
    );
    assert.match(
      String(session.driverOptions["daemonUrl"] ?? ""),
      /^http:\/\/localhost:\d+$/,
      "職人が Kobo へ報告するための到達先が渡る"
    );
    assert.equal(session.driverOptions["projectTag"], h.proj);
  });

  it("[a5] 指示にタスクの契約が書き切ってある（職人は記憶を持たない・D11）", () => {
    const session = h.driver.byTaskId("task-0001");
    const instruction = session!.injected[0] ?? "";
    assert.match(instruction, /task-0001/);
    assert.match(instruction, /src\/task-0001\/\*\*/, "スコープが渡る");
    assert.match(instruction, /動くこと/, "受け入れ基準が渡る");
    assert.match(instruction, /npm test/, "検証コマンドが渡る");
    assert.match(instruction, /task\/task-0001/, "コミット先のブランチが渡る");
    assert.match(instruction, /report_done/, "完了の合図の呼び方が渡る");
  });

  it("[a8] 渡すのは tier だけ。モデル名も provider も渡らない（決定60a）", () => {
    const session = h.driver.byTaskId("task-0001");
    assert.equal(session!.modelTier, "standard", "既定の等級");
    assert.equal(session!.driverOptions["model"], undefined, "モデル名を渡さない");
    assert.equal(session!.driverOptions["provider"], undefined, "provider を渡さない");
    const serialized = JSON.stringify(session!.driverOptions);
    assert.ok(
      !serialized.includes("deepseek") && !serialized.includes("opencode"),
      `具体のモデルが混ざらないこと: ${serialized}`
    );
  });

  it("[a8] タスクの model_tier がそのまま渡る", async () => {
    readyTask(h, "task-0002", { model_tier: "reasoning" });
    await h.daemon.spawnTask(h.proj, "task-0002");
    assert.equal(h.driver.byTaskId("task-0002")!.modelTier, "reasoning");
  });

  it("ready でないタスク・居ないタスクには職人をつけない", async () => {
    await assert.rejects(() => h.daemon.spawnTask(h.proj, "task-nonexistent"), /not found/i);
    await assert.rejects(() => h.daemon.spawnTask(h.proj, "task-0001"), /ready/i);
  });
});

// ── 職人が黙って終わったら統治として止まる（旧・照合 tick）────────────────────

describe("[task-0060/a1] 職人が報告せずに終わったら、Kobo が止まる（I2）", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ tickIntervalMs: 200 });
  });
  after(async () => {
    await teardown(h);
  });

  it("職人が落ちると agent_exited が残り、タスクは failed になる", async () => {
    readyTask(h, "task-0010");
    const session = await h.daemon.spawnTask(h.proj, "task-0010");
    assert.equal(h.daemon.getTask(h.proj, "task-0010")?.status, "planning");

    // 生きている職人を、tick が何回か回っても落とさない（旧・照合 tick の裏返し）
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0010")?.status,
      "planning",
      "動いている職人のタスクを勝手に failed にしない"
    );

    // 職人のプロセスが落ちる（外から SIGKILL された等）
    h.driver.exit(session.sessionId, null, "SIGKILL");

    // Kobo は職人のイベントを tick で引き取る（決定29c）
    await until(() =>
      h.daemon.getTaskEvents(h.proj, "task-0010").some((e) => e.type === "agent_exited")
    );
    await until(() => h.daemon.getTask(h.proj, "task-0010")?.status === "failed");

    const failed = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .find((e) => e.type === "task_failed") as { reason?: string } | undefined;
    assert.match(
      failed?.reason ?? "",
      /agent_exited_without_report/,
      "止まった理由が残る（黙って planning のまま残さない）"
    );
  });

  it("同じ出来事を二度書かない（起動時に読み直しても増えない）", async () => {
    const before = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .filter((e) => e.type === "agent_exited").length;
    await new Promise((r) => setTimeout(r, 600));
    const after = h.daemon
      .getTaskEvents(h.proj, "task-0010")
      .filter((e) => e.type === "agent_exited").length;
    assert.equal(after, before, "agent_exited は1回だけ（帳簿から重複を弾く）");
  });
});

/**
 * **「終わった」を工房の経路からも受ける**（PO報告 2026-08-11）。
 *
 * Kobo は `report_done`（pi 拡張が載せる口）でしか完了を知らなかった。Claude Code の
 * 職人にはその口が無く、汎用の `worker.report` で工房へ報告する——**その出来事を Kobo が
 * 読んでいなかったので、実装を終えてコミットまでしているのにタスクは implementing のまま**
 * 止まり、やがて `agent_exited_without_report` で failed になった（hiragana/task-0001・0002）。
 */
describe("[PO報告 2026-08-11] 職人が終わったと言えば、口が違っても監査へ回る", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ tickIntervalMs: 200 });
  });
  after(async () => {
    await teardown(h);
  });

  it("done の報告で implementing → auditing へ進む", async () => {
    readyTask(h, "task-0030");
    const session = await h.daemon.spawnTask(h.proj, "task-0030");
    assert.equal(h.daemon.getTask(h.proj, "task-0030")?.status, "planning");

    // 途中経過では動かさない（書きかけを検証させない）
    h.workers.pool.report(session.sessionId, "着手しました", { done: false });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0030")?.status,
      "planning",
      "途中経過の報告で監査へ回してはいけない"
    );

    h.workers.pool.report(session.sessionId, "task-0030 完了。abc1234 でコミット済み", {
      done: true,
    });
    await until(() => h.daemon.getTask(h.proj, "task-0030")?.status === "auditing");
    const moved = h.daemon
      .getTaskEvents(h.proj, "task-0030")
      .findLast((e) => e.type === "state_transitioned" && e.to === "auditing") as
      | { reason?: string }
      | undefined;
    assert.match(moved?.reason ?? "", /abc1234 でコミット済み/u, "何を報告したかが残ること");
  });

  it("同じ報告が二度読まれても、先へ進んだ状態は動かさない（冪等）", async () => {
    const sessions = h.workers.pool.list().filter((w) => w.taskId === "task-0030");
    const sessionId = sessions[0]!.sessionId;
    h.workers.pool.report(sessionId, "もう一度", { done: true });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0030")?.status,
      "auditing",
      "auditing から動かしてはいけない（report_done を通った職人と二重にならない）"
    );
  });

  /**
   * **古い報告が、いまの試行に当たらない**（実測 2026-08-11）。
   *
   * 工房の帳簿はどこまで読んだかを持たない（D3：起動時は 0 から読み直す）ので、
   * 再起動すると過去の報告がもう一度流れてくる。それがいまの試行に当たると、
   * **前の職人の言い分で今の状態が動く**——実際、前の監査人の「判定の口が無い」報告が、
   * 口を載せ直したあとの試行を落とした。
   */
  it("[実測 2026-08-11] 前の職人の報告は読み捨てる（起動時の読み直しで巻き戻さない）", async () => {
    readyTask(h, "task-0032");
    const executor = await h.daemon.spawnTask(h.proj, "task-0032");
    h.workers.pool.report(executor.sessionId, "実装しました", { done: true });
    await until(() => h.daemon.getTask(h.proj, "task-0032")?.status === "auditing");
    // 監査人が起きた＝いま働いているのはそちら
    await until(() => h.workers.pool.list().some((w) => w.taskId === "task-0032:audit"));

    // **実装役がもう一度報告してくる**（＝読み直しで流れてきた古い出来事）
    h.workers.pool.report(executor.sessionId, "実装しました", { done: true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0032")?.status,
      "auditing",
      "前の職人の報告で、いまの状態を動かしてはいけない"
    );
  });

  it("監査人が判定を出さずに報告したら、黙って待たずに止める（I2）", async () => {
    readyTask(h, "task-0031");
    const executor = await h.daemon.spawnTask(h.proj, "task-0031");
    h.workers.pool.report(executor.sessionId, "実装しました", { done: true });
    await until(() => h.daemon.getTask(h.proj, "task-0031")?.status === "auditing");

    // 監査人は Kobo が起こす（auditing に入った tick で）。起きるまで待つ
    await until(() => h.workers.pool.list().some((w) => w.taskId === "task-0031:audit"));
    const audit = h.workers.pool.list().find((w) => w.taskId === "task-0031:audit")!;
    h.workers.pool.report(audit.sessionId, "見ました。良さそうです", { done: true });

    await until(() => h.daemon.getTask(h.proj, "task-0031")?.status === "failed");
    const failed = h.daemon
      .getTaskEvents(h.proj, "task-0031")
      .findLast((e) => e.type === "task_failed") as { reason?: string } | undefined;
    assert.match(
      failed?.reason ?? "",
      /audit_reported_without_verdict/u,
      "自由文から通す／通さないを決めてはいけない（決定57）"
    );
  });
});

/**
 * **喋り終わった時点で先へ進む**（PO要望 2026-08-11）。
 *
 * これまで起動元が「終わった」を知る道は2つしか無かった：職人が明示的に報告するか、
 * 手が止まったまま**安全弁の時間切れ**（既定15分）を待つか。だが出力が終われば終わった
 * ことはその場で分かる——ランタイムがターンの終わりを積み、Kobo がそれを読む。
 */
describe("[PO要望 2026-08-11] 職人が喋り終わったら、報告を待たずに先へ進む", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ tickIntervalMs: 200 });
  });
  after(async () => {
    await teardown(h);
  });

  it("報告が無くてもターンの終わりで監査へ回る（時間切れを待たない）", async () => {
    readyTask(h, "task-0040");
    const session = await h.daemon.spawnTask(h.proj, "task-0040");
    assert.equal(h.daemon.getTask(h.proj, "task-0040")?.status, "planning");

    // 職人は報告しないまま喋り終わった。ランタイムが事実だけを積む
    h.workers.pool.turnEnded(session.sessionId, {
      text: "src/ を直して build を通しました",
      reported: false,
    });

    await until(() => h.daemon.getTask(h.proj, "task-0040")?.status === "auditing");
    const moved = h.daemon
      .getTaskEvents(h.proj, "task-0040")
      .findLast((e) => e.type === "state_transitioned" && e.to === "auditing") as
      | { reason?: string }
      | undefined;
    assert.match(moved?.reason ?? "", /build を通しました/u, "最後の発話が手がかりとして残る");
  });

  it("答え待ちで止まっているのは「終わった」ではない", async () => {
    readyTask(h, "task-0041");
    const session = await h.daemon.spawnTask(h.proj, "task-0041");
    h.workers.pool.ask(session.sessionId, "スコープ外も直してよいですか");
    await until(() => h.daemon.getTask(h.proj, "task-0041")?.status === "paused");

    // 質問したあとターンが終わる（＝答え待ちで止まる）。**監査へ回してはいけない**
    h.workers.pool.turnEnded(session.sessionId, { text: "質問して待っています", reported: true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      h.daemon.getTask(h.proj, "task-0041")?.status,
      "paused",
      "答え待ちの職人を「終わった」として先へ進めてはいけない"
    );
  });

  /**
   * **既に伝わっているかを工房が判定する**（PO指摘 2026-08-11）。
   *
   * 「ターンの終わりに番頭の判断が要る」は正しい。ただし**そのターンで既に何かが届いて
   * いるなら二重**なので、届いていないときだけ知らせる——その判定は台帳を持つ工房が持つ
   * （職人やランタイムの自己申告より確か・D3）。
   */
  it("完了を報告して終えたターンは settled（改めて知らせない）", async () => {
    readyTask(h, "task-0043");
    const session = await h.daemon.spawnTask(h.proj, "task-0043");
    h.workers.pool.report(session.sessionId, "終わりました", { done: true });
    const ended = h.workers.pool.turnEnded(session.sessionId, { reported: true });
    assert.equal(ended.data["settled"], true, "完了の報告が既に届いている");
  });

  it("進捗だけ報告して終えたターンは settled ではない（番頭は動いていると思っている）", async () => {
    readyTask(h, "task-0044");
    const session = await h.daemon.spawnTask(h.proj, "task-0044");
    h.workers.pool.report(session.sessionId, "着手しました", { done: false });
    const ended = h.workers.pool.turnEnded(session.sessionId, { reported: true });
    assert.equal(ended.data["settled"], false, "「着手しました」だけでは手が止まったと分からない");
  });

  it("前のターンの完了報告は、次のターンには効かない", async () => {
    readyTask(h, "task-0045");
    const session = await h.daemon.spawnTask(h.proj, "task-0045");
    h.workers.pool.report(session.sessionId, "終わりました", { done: true });
    h.workers.pool.turnEnded(session.sessionId, { reported: true });

    // 続きを渡した → 2ターン目。今度は何も報告せずに終える
    await h.workers.pool.steer(session.sessionId, "続けてください");
    const second = h.workers.pool.turnEnded(session.sessionId, { reported: false });
    assert.equal(second.data["settled"], false, "前のターンの完了で今のターンを黙らせない");
  });

  it("手が空いていることが一覧から分かる（見れば分かる）", async () => {
    readyTask(h, "task-0042");
    const session = await h.daemon.spawnTask(h.proj, "task-0042");
    assert.equal(
      h.workers.pool.get(session.sessionId)?.state,
      "running",
      "起こした直後は動いている"
    );

    h.workers.pool.turnEnded(session.sessionId, { text: "終わりました", reported: false });
    assert.equal(h.workers.pool.get(session.sessionId)?.state, "idle", "喋り終わったら idle");

    // 次の指示を渡せば、また動いている
    await h.workers.pool.steer(session.sessionId, "続けてください");
    assert.equal(h.workers.pool.get(session.sessionId)?.state, "running");
  });
});

/**
 * **職人の質問を宙に消さない**（PO報告 2026-08-11）。
 *
 * `worker_asked` を誰も読んでいなかった：番頭ホスト側の知らせは「番頭が起こした職人の分
 * だけ」で弾かれ（決定29）、Kobo は exited / closed しか見ていなかった。**Kobo が起こした
 * 職人の質問は、どこにも出ないまま消えていた**——職人は答えを待って止まり、やがて
 * `agent_exited_without_report` として failed になる。banto/task-0091 のセッションログに
 * その形がそのまま残っている（「質問を投げて待っています」で止まり、33分後に failed）。
 */
describe("[PO報告 2026-08-11] 職人が聞いてきたら、タスクは止まって待つ", () => {
  let h: Harness;
  before(async () => {
    h = await harness({ tickIntervalMs: 200 });
  });
  after(async () => {
    await teardown(h);
  });

  it("質問が届くと paused になり、理由に質問文が残る", async () => {
    readyTask(h, "task-0020");
    const session = await h.daemon.spawnTask(h.proj, "task-0020");
    assert.equal(h.daemon.getTask(h.proj, "task-0020")?.status, "planning");

    h.workers.pool.ask(session.sessionId, "tests/ 配下も直してよいですか（スコープ外）");

    await until(() => h.daemon.getTask(h.proj, "task-0020")?.status === "paused");
    const paused = h.daemon
      .getTaskEvents(h.proj, "task-0020")
      .findLast((e) => e.type === "state_transitioned" && e.to === "paused") as
      | { reason?: string }
      | undefined;
    assert.match(
      paused?.reason ?? "",
      /tests\/ 配下も直してよいですか/u,
      "何を聞かれたのかが残らないと、番頭は答えようがない"
    );
    assert.match(paused?.reason ?? "", /worker\.steer/u, "どう答えるかも書く（D8）");
    // 戻り先が帳簿に残る（推測しないため）
    const meta = h.daemon
      .getTaskEvents(h.proj, "task-0020")
      .findLast((e) => e.type === "task_paused") as { suspended_from?: string } | undefined;
    assert.equal(meta?.suspended_from, "planning");
  });

  it("答えると元の状態へ戻る（止まりっぱなしにしない）", async () => {
    const sessions = h.workers.pool.list().filter((w) => w.taskId === "task-0020");
    const sessionId = sessions[0]!.sessionId;

    await h.workers.pool.steer(sessionId, "いいえ、src/** の中で直してください");

    await until(() => h.daemon.getTask(h.proj, "task-0020")?.status === "planning");
    const resumed = h.daemon
      .getTaskEvents(h.proj, "task-0020")
      .findLast((e) => e.type === "task_resumed") as { restored_to?: string } | undefined;
    assert.equal(resumed?.restored_to, "planning", "止まる前の状態へ戻すこと");
  });
});

// ── Kobo が落ちている間の出来事を取りこぼさない（旧・孤児回収）──────────────

describe("[task-0060/a1] Kobo の再起動：職人は畳まず、落ちている間の出来事に追いつく", () => {
  let h: Harness;
  after(async () => {
    await teardown(h);
  });

  it("止まっている間に終わった職人を、起動後の tick が拾う", async () => {
    h = await harness({ tickIntervalMs: 200 });
    readyTask(h, "task-0040");
    const session = await h.daemon.spawnTask(h.proj, "task-0040");

    // Kobo だけを止める。**職人は畳まない**（決定63：面倒を見るのは Worker Pool）
    await h.daemon.stop();
    assert.equal(
      h.workers.pool.get(session.sessionId)?.alive,
      true,
      "Kobo を止めても職人は生きている（以前は再起動時に SIGTERM で畳んでいた）"
    );

    // 止まっている間に職人が落ちる
    h.driver.exit(session.sessionId, null, "SIGKILL");

    // 同じデータ置き場で起動し直す
    const restarted = Daemon.create({
      port: 0,
      dataDir: h.dataDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 200,
      worktreeBaseDir: path.join(h.tmpDir, "worktrees"),
      workerPoolUrl: h.workers.url,
      disableAutoSpawn: true,
    });
    await restarted.start();
    h.daemon = restarted;

    await until(() =>
      restarted.getTaskEvents(h.proj, "task-0040").some((e) => e.type === "agent_exited")
    );
    await until(() => restarted.getTask(h.proj, "task-0040")?.status === "failed");
  });
});

// ── 済んだ職人は Kobo が畳む（I3・決定63）────────────────────────────────────

describe("[task-0060/a1] 役目を終えた職人は Kobo が畳む（番頭には畳めない）", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("監査に入ると実装の職人は畳まれ、監査人が起こされる", async () => {
    readyTask(h, "task-0020");
    const executor = await h.daemon.spawnTask(h.proj, "task-0020");
    h.daemon.transition(h.proj, "task-0020", "implementing", "test");
    h.daemon.transition(h.proj, "task-0020", "auditing", "test");

    await until(() => h.driver.byTaskId("task-0020:audit") !== undefined);

    const executorWorker = h.workers.pool.get(executor.sessionId);
    assert.equal(
      executorWorker?.state,
      "closed",
      "実装の職人は畳まれる（放っておくと安全弁の時間までプロセスが残る）"
    );

    const audit = h.driver.byTaskId("task-0020:audit")!;
    assert.equal(audit.modelTier, "reasoning", "監査は一段上の等級（spec §3.5）");
    const extensions = audit.driverOptions["extensionPaths"] as string[] | undefined;
    assert.ok(
      extensions?.some((p) => p.endsWith("banto-auditor.ts")),
      "監査人には banto-auditor 拡張が載る"
    );
    assert.equal(
      audit.worktreePath,
      executor.worktreePath,
      "監査は実装者と同じワークツリーを見る（作り直すと見るものが無い）"
    );
  });

  it("[a9] 監査に落ちると、rework は一段上の等級で起こされる（失敗駆動の昇格）", async () => {
    h.daemon.handleAuditVerdict(h.proj, "task-0020", "fail", ["a1 が検証されていない"]);
    await until(() => h.driver.byTaskId("task-0020:rework") !== undefined);

    const rework = h.driver.byTaskId("task-0020:rework")!;
    assert.equal(
      rework.modelTier,
      "reasoning",
      "既定 standard の1段上。Kobo が変えるのは tier の文字列だけ（決定60a）"
    );
    assert.match(
      rework.injected[0] ?? "",
      /a1 が検証されていない/,
      "監査の指摘が指示に書き切ってある（職人は記憶を持たない）"
    );

    const auditWorker = h.workers.pool
      .list()
      .find((w) => w.taskId === "task-0020:audit");
    assert.equal(auditWorker?.state, "closed", "監査人は役目を終えたので畳まれる");
  });
});

// ── 本物の pi で1本通す（偽ドライバだけで済ませない）─────────────────────────

describe("[task-0060/a1] 本物の pi を Worker Pool 越しに起こす", () => {
  let h: Omit<Harness, "driver"> & { driver: PiRpcDriver };

  before(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-worker-real-"));
    const repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    const dataDir = path.join(tmpDir, "data");
    // 本物の pi を RPC モードで起こす（LLM は呼ばない——起動と受け渡しだけを見る）
    const driver = new PiRpcDriver({ sessionBaseDir: path.join(tmpDir, "sessions") });
    const workers = await startWorkerPool(driver);
    const daemon = Daemon.create({
      port: 0,
      dataDir,
      watchIntervalMs: 99999,
      tickIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
      disableAutoSpawn: true,
    });
    await daemon.start();
    const proj = "kobo-worker-real";
    daemon.registerProject(proj, repoDir);
    h = { daemon, workers, driver, dataDir, repoDir, tmpDir, proj };
  });

  after(async () => {
    await h.daemon.stop();
    await h.workers.close();
    fs.rmSync(h.tmpDir, { recursive: true, force: true });
  });

  it("実プロセスの職人が Worker Pool の台帳に載り、Kobo の帳簿と一致する", async () => {
    readyTask(h as unknown as Harness, "task-0030");

    let session: { sessionId: string; pid: number } | undefined;
    try {
      session = await h.daemon.spawnTask(h.proj, "task-0030");
    } catch (err) {
      // I2: 起こせなかったなら、そのことが帳簿に残っていること（黙って planning に残さない）
      const failed = h.daemon
        .getTaskEvents(h.proj, "task-0030")
        .find((e) => e.type === "task_failed");
      assert.ok(failed, `pi を起こせなかったが task_failed も無い: ${String(err)}`);
      return;
    }

    assert.ok(session.pid > 0, "実プロセスの pid が返る");
    const worker = h.workers.pool.get(session.sessionId);
    assert.ok(worker, "Worker Pool の台帳に載る");
    assert.equal(worker.origin, "kobo");
    assert.equal(worker.pid, session.pid, "Kobo が帳簿に残した pid と台帳が一致する");

    // 起こした者が片付ける（I3）
    await h.workers.pool.close(session.sessionId, "done");
  });
});

// ── 役割ごとの職人の当て方（設定画面。PO裁定 2026-08-10） ─────────────────────

describe("[kobo-roles] 実装・レビューを、どの等級／どのモデルの職人にやらせるか", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("[kobo-roles] 何も決めていなければ、これまでどおり（タスクの等級で回る）", async () => {
    readyTask(h, "task-0301", { model_tier: "fast" });
    await h.daemon.spawnTask(h.proj, "task-0301");
    const spawned = h.driver.byTaskId("task-0301")!;
    assert.equal(spawned.modelTier, "fast");
    assert.equal(spawned.driverOptions["model"], undefined);
  });

  it("[kobo-roles] 役割に等級を当てると、タスクの指定より優先される", async () => {
    h.daemon.setRoleAssignments({ executor: { tier: "reasoning" } });
    readyTask(h, "task-0302", { model_tier: "fast" });
    await h.daemon.spawnTask(h.proj, "task-0302");
    assert.equal(h.driver.byTaskId("task-0302")?.modelTier, "reasoning");
  });

  it("[kobo-roles] モデルを名指しすると、その名前が Worker Pool まで届く", async () => {
    // 決定60a の改訂（PO裁定 2026-08-10）。Kobo は名前を渡すだけで、
    // provider も鍵も知らない——解決は Worker Pool のまま
    h.daemon.setRoleAssignments({
      executor: { model: "opencode-go/deepseek-v4-flash" },
    });
    readyTask(h, "task-0303");
    await h.daemon.spawnTask(h.proj, "task-0303");
    const spawned = h.driver.byTaskId("task-0303")!;
    assert.equal(spawned.driverOptions["provider"], "opencode-go");
    assert.equal(spawned.driverOptions["model"], "deepseek-v4-flash");
  });

  it("[kobo-roles] 設定は読み書きでき、知らない名前は保存の時点で断る（I2）", async () => {
    const settings = createKoboSettings({
      roleAssignments: () => h.daemon.roleAssignments(),
      setRoleAssignments: (next) => h.daemon.setRoleAssignments(next),
      selectableModelNames: () => h.daemon.selectableModelNames(),
    });

    await settings.write({ auditModel: "opencode-go/deepseek-v4-flash", auditTier: "reasoning" });
    const values = (await settings.read()) as Record<string, unknown>;
    assert.equal(values["auditModel"], "opencode-go/deepseek-v4-flash");
    assert.equal(values["auditTier"], "reasoning");

    // 打ち間違いが「実際に職人を起こす夜」まで出ないのでは遅い
    await assert.rejects(
      () => Promise.resolve(settings.write({ auditModel: "オパス" })),
      /知らないモデルです/
    );
    // 断ったなら、残っているのは前の値のまま
    assert.equal(
      ((await settings.read()) as Record<string, unknown>)["auditModel"],
      "opencode-go/deepseek-v4-flash"
    );
  });
});
