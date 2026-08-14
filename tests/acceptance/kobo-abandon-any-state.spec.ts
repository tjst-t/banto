/**
 * `kobo.abandon` は**どの状態のタスクでも畳める**（PO 裁定 2026-08-14）。
 *
 * **困っていたこと**：`kobo.abandon` は `failed` 専用だった（`Daemon.abandonTask` の
 * `if (task.status !== "failed")`）。ところが実運用で宙に浮くのは落ちたタスクではなく、
 * 依存で止まった `queued`・戻らない `paused`・放置された `review-ready` の方で、実機の
 * 工場には queued 10本・paused 3本・review-ready 1本が**畳む手段の無いまま**凍っていた。
 *
 * ここで固定するのは4つ:
 *
 *   1. **どの状態からでも closed へ**（queued / ready / planning / implementing /
 *      auditing / review-ready / in-review / approved / merging / paused / failed）
 *   2. **記録は消えない**——`state_transitioned.from` に畳む前の状態が載る
 *   3. **もう畳んであるもの（closed / superseded）は断る**。いまの状態を名指しで言う（I2）
 *   4. **稼働中の職人を置き去りにしない**。止まらなければ、どのセッションが残ったかを
 *      返り値と帳簿（`po_operation:task_abandoned`）に名指しで残す
 *
 * そして**畳んだものが機構に拾い直されないこと**（これが無いとこの改修は無意味になる）:
 *
 *   5a. マージキューが closed を掴まない（`deriveQueue`）
 *   5b. **関所を通している最中に畳んでもマージしない**（`processMergeQueue` の読み直し）
 *   5c. paused からの自動再開が closed を起こさない（`runConflictResolutionCheck`）
 *   5d. **タスク定義ファイルの watcher が queued へ戻さない**（md は畳んでも残る）
 *
 * story_type=api: 本物の Daemon・本物の git リポジトリ・本物の Worker Pool。
 * 差し替えるのは pi の代わりのランタイムと、検証環境の代わりの作業ディレクトリだけ（I1）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { Daemon, deriveQueue } from "@banto/daemon";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import type { GateVerifyRunner } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog } from "@banto/core";
import { hostVerifyRunner } from "./gate-verify-runner.js";
import { FakeRuntimeDriver, startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@banto-abandon.local"], dir);
  git(["config", "user.name", "banto-abandon-test"], dir);
  fs.writeFileSync(path.join(dir, "shared.ts"), "// shared.ts\nexport const VERSION = 0;\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial"], dir);
}

async function pollUntil<T>(
  fn: () => Promise<T> | T,
  pred: (v: T) => boolean,
  timeoutMs = 20000,
  intervalMs = 100
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

/** 道具は番頭が呼ぶのと同じ口を通す（`kobo.*` の execute）。 */
function toolCaller(daemon: Daemon) {
  const tools = createKoboTools(daemon);
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool: ${name}`);
    const r = await t.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as Record<string, unknown>;
  };
}

// ── 1. どの状態からでも畳める ─────────────────────────────────────────────────

describe("[abandon-any-state] どの状態のタスクでも畳める", () => {
  const PROJ = "abandon-states";
  let tmpDir: string;
  let daemon: Daemon;
  let call: ReturnType<typeof toolCaller>;

  /** そのタスクを目的の状態まで運ぶ（職人も監査もマージキューも動かさない足場）。 */
  function place(taskId: string, ...steps: string[]): void {
    daemon.createTask(PROJ, taskId, taskId, {
      kind: "feature",
      scope: { paths: [`src/${taskId}/**`] },
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    for (const to of steps) {
      const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
      assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
    }
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandon-states-"));
    const repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      // 動かしたいのは「畳めるか」だけ。機構が横から状態を動かすと何を見たのか分からなくなる
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);
    call = toolCaller(daemon);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 工程の**全部の段**を並べる。1つでも畳めない段が残ると、そこにタスクが凍る
   * ——「たいてい畳める」では、凍るのはいつも畳めない段である。
   */
  const STATES: Array<{ id: string; steps: string[]; from: string }> = [
    { id: "task-q", steps: ["queued"], from: "queued" },
    // 依存ゲートを通った段（`queued → ready` が「gating」に当たる）
    { id: "task-r", steps: ["queued", "ready"], from: "ready" },
    { id: "task-p", steps: ["queued", "ready", "planning"], from: "planning" },
    { id: "task-i", steps: ["queued", "ready", "planning", "implementing"], from: "implementing" },
    {
      id: "task-a",
      steps: ["queued", "ready", "planning", "implementing", "auditing"],
      from: "auditing",
    },
    {
      id: "task-rr",
      steps: ["queued", "ready", "planning", "implementing", "auditing", "review-ready"],
      from: "review-ready",
    },
    {
      id: "task-ir",
      steps: [
        "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review",
      ],
      from: "in-review",
    },
    {
      id: "task-ap",
      steps: [
        "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review",
        "approved",
      ],
      from: "approved",
    },
    {
      id: "task-m",
      steps: [
        "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review",
        "approved", "merging",
      ],
      from: "merging",
    },
    { id: "task-f", steps: ["queued", "ready", "failed"], from: "failed" },
  ];

  for (const { id, steps, from } of STATES) {
    it(`${from} から畳める（closed へ・経緯に ${from} が残る）`, async () => {
      place(id, ...steps);
      assert.equal(daemon.getTask(PROJ, id)?.status, from, "前提：その状態に置けている");

      const details = await call("kobo.abandon", {
        projectTag: PROJ,
        taskId: id,
        reason: `テスト: ${from} から畳む`,
      });

      assert.equal(daemon.getTask(PROJ, id)?.status, "closed", `${from} から closed へ行かない`);
      assert.equal(details["from"], from, "**どこから畳んだか**を返すこと");

      // 記録は消えない——畳む前の状態と理由が帳簿から読める
      const events = daemon.getTaskEvents(PROJ, id);
      assert.ok(
        events.some(
          (e) =>
            e.type === "state_transitioned" &&
            e.from === from &&
            e.to === "closed" &&
            (e.reason ?? "").includes(`テスト: ${from} から畳む`)
        ),
        `${from} → closed と理由が帳簿に残っていない`
      );
      assert.ok(
        events.some((e) => e.type === "po_operation" && e.operation === "task_abandoned"),
        "畳んだ操作そのものが帳簿に残っていない"
      );
    });
  }

  it("既に closed のものは畳まない（いまの状態を名指しで断る・I2）", async () => {
    // 上の表で畳んだ札をそのまま使う
    assert.equal(daemon.getTask(PROJ, "task-q")?.status, "closed", "前提：畳んである");
    await assert.rejects(
      () => call("kobo.abandon", { projectTag: PROJ, taskId: "task-q", reason: "二度目" }),
      /既に畳んであります（いまは closed）/
    );
    assert.equal(daemon.getTask(PROJ, "task-q")?.status, "closed", "断っても動かないこと");
  });

  it("既に superseded のものは畳まない（いまの状態を名指しで断る・I2）", async () => {
    place("task-sup", "queued", "ready");
    daemon.transition(PROJ, "task-sup", "superseded", "task-other");
    assert.equal(daemon.getTask(PROJ, "task-sup")?.status, "superseded", "前提：降ろしてある");

    await assert.rejects(
      () => call("kobo.abandon", { projectTag: PROJ, taskId: "task-sup", reason: "畳もうとする" }),
      /いまは superseded/
    );
    assert.equal(
      daemon.getTask(PROJ, "task-sup")?.status,
      "superseded",
      "断っても動かないこと"
    );
  });

  it("そもそも無いタスクは畳めない（黙って成功にしない）", async () => {
    await assert.rejects(
      () => call("kobo.abandon", { projectTag: PROJ, taskId: "task-nope", reason: "無い" }),
      /工場にありません/
    );
  });

  /**
   * **遷移表は緩めていない。** 畳むのは横断の遷移（`StateMachine.abandon`）にしたので、
   * `transition()` を素で呼ぶ道——HTTP の `/transition` も機構の tick も通る口——では
   * 今までどおり queued → closed は通らない。ここが緩むと、機構が通りがかりに
   * タスクを閉じられるようになる。
   */
  it("素の transition では今までどおり closed へ飛べない（畳むのは番頭の判断の口だけ）", () => {
    place("task-guard", "queued");
    const r = daemon.transition(PROJ, "task-guard", "closed", "テスト：素で閉じようとする");
    assert.equal(r.ok, false, "素の transition で閉じられてしまう");
    assert.equal(daemon.getTask(PROJ, "task-guard")?.status, "queued");
  });
});

// ── 2. 稼働中の職人を置き去りにしない ────────────────────────────────────────

describe("[abandon-any-state] 畳むときに職人を止める", () => {
  const PROJ = "abandon-workers";
  let tmpDir: string;
  let daemon: Daemon;
  let workers: WorkerPoolHarness;
  let call: ReturnType<typeof toolCaller>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandon-workers-"));
    const repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    // **本物の Worker Pool を立てる。** 偽物だと「止めたつもり」を検査できない
    workers = await startWorkerPool(new FakeRuntimeDriver());
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
      workerPoolUrl: workers.url,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);
    call = toolCaller(daemon);
  });

  after(async () => {
    await daemon.stop();
    // 2本目のテストで工房の口を閉じてあることがある（二度閉じは黙って通す）
    await workers.close().catch(() => undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** ready まで進めて職人を1人つける（implementing まで運ぶ）。 */
  async function withWorker(taskId: string): Promise<string> {
    daemon.createTask(PROJ, taskId, taskId, {
      kind: "feature",
      scope: { paths: [`src/${taskId}/**`] },
      acceptance: [{ id: "a1", text: "動くこと" }],
    });
    daemon.transition(PROJ, taskId, "queued", "テスト");
    daemon.transition(PROJ, taskId, "ready", "テスト");
    const session = await daemon.spawnTask(PROJ, taskId);
    daemon.transition(PROJ, taskId, "implementing", "テスト");
    return session.sessionId;
  }

  it("implementing のタスクを畳むと、ぶら下がっていた職人が止まる", async () => {
    const sessionId = await withWorker("task-w1");
    assert.ok(
      workers.pool.list({ includeClosed: false }).some((w) => w.sessionId === sessionId),
      "前提：工房の台帳に職人が居る"
    );

    const details = await call("kobo.abandon", {
      projectTag: PROJ,
      taskId: "task-w1",
      reason: "テスト: 職人つきで畳む",
    });

    assert.equal(daemon.getTask(PROJ, "task-w1")?.status, "closed");
    assert.deepEqual(details["stoppedSessions"], [sessionId], "止めた職人を名指しで返すこと");
    assert.deepEqual(details["unstoppedSessions"], [], "止め残しは無いはず");
    assert.equal(
      workers.pool.list({ includeClosed: false }).some((w) => w.sessionId === sessionId),
      false,
      "**職人が置き去りになっている**（工房の台帳にまだ居る）"
    );
  });

  /**
   * **止められなかったことを握り潰さない**（I2）。工房へ届かないときに
   * 「畳みました」だけ返すと、番頭からは走り続けている職人が見えなくなる。
   */
  it("止められなかったら、どのセッションが残ったかを返り値と帳簿に名指しで残す", async () => {
    const sessionId = await withWorker("task-w2");
    // 工房の口だけ閉じる（台帳の職人は生きたまま＝止めに行っても届かない形）
    await workers.service.close();

    const details = await call("kobo.abandon", {
      projectTag: PROJ,
      taskId: "task-w2",
      reason: "テスト: 工房へ届かない",
    });

    // 畳むこと自体は成立する（止められないからといってタスクを凍らせない）
    assert.equal(daemon.getTask(PROJ, "task-w2")?.status, "closed");

    const unstopped = details["unstoppedSessions"] as Array<{ sessionId: string }>;
    assert.equal(unstopped.length, 1, "止め残しを黙って落としている");
    assert.equal(unstopped[0]!.sessionId, sessionId, "**どの職人が残ったか**を名指しすること");

    // 帳簿にも同じことが残る（返り値はその場限り。あとから追えるのは帳簿だけ）
    const abandoned = daemon
      .getTaskEvents(PROJ, "task-w2")
      .find((e) => e.type === "po_operation" && e.operation === "task_abandoned");
    assert.ok(abandoned, "畳んだ操作が帳簿に無い");
    const payload = (abandoned as { payload?: Record<string, unknown> }).payload ?? {};
    assert.deepEqual(
      (payload["unstoppedSessions"] as Array<{ sessionId: string }>).map((w) => w.sessionId),
      [sessionId],
      "止まらなかった職人が帳簿から読めない"
    );
    assert.equal(payload["from"], "implementing", "畳む前の状態が帳簿から読めない");
  });
});

// ── 3. 畳んだタスクが機構に拾い直されない ────────────────────────────────────

describe("[abandon-any-state] 畳んだタスクは待ち行列に戻らない", () => {
  const PROJ = "abandon-queue";
  let tmpDir: string;
  let dataDir: string;
  let daemon: Daemon;
  let call: ReturnType<typeof toolCaller>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandon-queue-"));
    dataDir = path.join(tmpDir, "data");
    const repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    daemon = Daemon.create({
      port: 0,
      dataDir,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);
    call = toolCaller(daemon);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * [5a] 待ち行列は帳簿から導かれる（D3）。`deriveQueue` は最後の `state_transitioned` で
   * いまの状態を決めるので、closed になった時点で行列から外れる。
   */
  it("merging のまま畳んだタスクは、マージ待ち行列から消える", async () => {
    for (const id of ["task-mq1", "task-mq2"]) {
      daemon.createTask(PROJ, id, id, {
        kind: "feature",
        scope: { paths: [`src/${id}/**`] },
        acceptance: [{ id: "a1", text: "動くこと" }],
      });
      for (const to of [
        "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review",
        "approved",
      ]) {
        daemon.transition(PROJ, id, to, "テスト");
      }
    }
    daemon.transition(PROJ, "task-mq1", "merging", "テスト");

    const before = deriveQueue(EventLog.open(dataDir).readAllEvents()).map((e) => e.taskId);
    assert.deepEqual(before, ["task-mq1", "task-mq2"], "前提：2本とも行列に居る");

    await call("kobo.abandon", { projectTag: PROJ, taskId: "task-mq1", reason: "テスト: 畳む" });

    const after = deriveQueue(EventLog.open(dataDir).readAllEvents()).map((e) => e.taskId);
    assert.deepEqual(after, ["task-mq2"], "畳んだタスクが行列に残っている");
  });
});

// ── 3b. 関所を通している最中に畳んでもマージしない ────────────────────────────

/**
 * **これが塞がっていないと、畳んだタスクが merged へ蘇る。**
 *
 * `processMergeQueue` は rebase → 関所（検証環境を立てて検証コマンドを回す）→
 * fast-forward merge → `merging → merged` の順に進む。関所は数十秒から数分かかるので、
 * その最中に番頭が畳むことが起きる。最後の遷移は `from: "merging"` 決め打ちなので、
 * 読み直さないと closed のタスクが merged になり、しかも mainline にコミットが載る。
 */
describe("[abandon-any-state] 関所を通している最中に畳んだらマージしない", () => {
  const PROJ = "abandon-inflight";
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let call: ReturnType<typeof toolCaller>;
  let releaseGate: () => void;
  let gateEntered: Promise<void>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandon-inflight-"));
    repoDir = path.join(tmpDir, "repo");
    const worktreeBaseDir = path.join(tmpDir, "worktrees");
    initRepo(repoDir);

    // 関所の中で**止まる**検証ランナー。ここで止めている間に畳む
    const inner = hostVerifyRunner();
    let signalEntered!: () => void;
    gateEntered = new Promise<void>((r) => { signalEntered = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    releaseGate = open;
    const pausing: GateVerifyRunner = {
      provision: (opts) => inner.provision(opts),
      teardown: (envId) => inner.teardown(envId),
      async run(opts) {
        signalEntered();
        await gate;
        return inner.run(opts);
      },
    };

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir,
      verifyRunner: pausing,
      tickIntervalMs: 100,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);
    call = toolCaller(daemon);

    // 職人の代わりに、タスクのブランチを手で用意する
    const worktreePath = path.join(worktreeBaseDir, PROJ, "task-if1");
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(["worktree", "add", "--detach", worktreePath], repoDir);
    git(["checkout", "-b", "task/task-if1"], worktreePath);
    fs.writeFileSync(path.join(worktreePath, "inflight.ts"), "// task-if1\n");
    git(["add", "-A"], worktreePath);
    git(["commit", "-m", "feat: task-if1"], worktreePath);
  });

  after(async () => {
    releaseGate();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("関所の最中に畳むと、closed のまま——merged へ蘇らず mainline にも載らない", async () => {
    daemon.createTask(PROJ, "task-if1", "task-if1", {
      kind: "feature",
      scope: { paths: ["inflight.ts"] },
      acceptance: [{ id: "a1", text: "ファイルがある", verify: "test -f inflight.ts" }],
    });
    for (const to of [
      "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review",
      "approved",
    ]) {
      daemon.transition(PROJ, "task-if1", to, "テスト");
    }

    // マージキューが拾って関所に入るまで待つ（tick 駆動）
    await gateEntered;
    assert.equal(daemon.getTask(PROJ, "task-if1")?.status, "merging", "前提：関所の中に居る");

    await call("kobo.abandon", { projectTag: PROJ, taskId: "task-if1", reason: "テスト: 関所の最中に畳む" });
    assert.equal(daemon.getTask(PROJ, "task-if1")?.status, "closed");

    // 関所を通す。ここから先が「畳んだのにマージが進む」道
    releaseGate();

    const status = await pollUntil(
      () => daemon.getTask(PROJ, "task-if1")?.status ?? "",
      (s) => s !== "closed",
      3000
    );
    assert.equal(status, "closed", "畳んだタスクが動いている（merged へ蘇った）");

    const log = execFileSync("git", ["log", "main", "--oneline"], {
      cwd: repoDir,
      encoding: "utf-8",
    });
    assert.equal(
      log.includes("task-if1"),
      false,
      "畳んだタスクのコミットが mainline に載っている"
    );
  });
});

// ── 3c/3d. paused からの自動再開・定義ファイルの watcher ──────────────────────

/**
 * コンフリクトで `paused` に落ちた origin を畳んだあと、**解消タスクが片付いても
 * 起き上がらない**こと（`runConflictResolutionCheck`）。
 *
 * 併せて、`work/tasks/*.md` は畳んでも残るので、**watcher が読み直して queued に
 * 戻さない**ことも見る——ここが塞がっていないと、この改修そのものが無意味になる。
 */
describe("[abandon-any-state] 畳んだタスクは機構に起こされない", () => {
  const PROJ = "abandon-revive";
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let call: ReturnType<typeof toolCaller>;

  function setupTaskBranch(taskId: string, fileName: string, content: string): void {
    const worktreePath = path.join(tmpDir, "worktrees", PROJ, taskId);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(["worktree", "add", "--detach", worktreePath], repoDir);
    git(["checkout", "-b", `task/${taskId}`], worktreePath);
    fs.writeFileSync(path.join(worktreePath, fileName), content);
    git(["add", "-A"], worktreePath);
    git(["commit", "-m", `feat: ${taskId}`], worktreePath);
  }

  async function statusOf(taskId: string): Promise<string> {
    return daemon.getTask(PROJ, taskId)?.status ?? "";
  }

  async function advance(taskId: string, ...steps: string[]): Promise<void> {
    for (const to of steps) {
      if ((await statusOf(taskId)) === to) continue;
      const r = await fetch(`${base}/api/v1/projects/${PROJ}/tasks/${taskId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, reason: "テスト" }),
      });
      if (r.status !== 200 && (await statusOf(taskId)) !== to) {
        throw new Error(`${taskId} → ${to}: ${await r.text()}`);
      }
    }
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abandon-revive-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      // watcher とマージキューは**本物を回す**——拾い直さないことを見るのが本題
      tickIntervalMs: 100,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    daemon.registerProject(PROJ, repoDir);
    call = toolCaller(daemon);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("paused（コンフリクト待ち）で畳んだら、解消タスクが片付いても起き上がらない", async () => {
    // task-X と task-Y が同じ行を書き換える＝ task-Y は rebase で必ず衝突する
    setupTaskBranch("task-X", "shared.ts", "// shared.ts\nexport const VERSION = 1; // X\n");
    setupTaskBranch("task-Y", "shared.ts", "// shared.ts\nexport const VERSION = 2; // Y\n");

    for (const id of ["task-X", "task-Y"]) {
      daemon.createTask(PROJ, id, id, {
        kind: "feature",
        scope: { paths: ["shared.ts"] },
        acceptance: [{ id: "a1", text: "ファイルがある" }],
      });
      await advance(
        id, "queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review"
      );
    }
    await advance("task-X", "approved");
    await advance("task-Y", "approved");

    const paused = await pollUntil(() => statusOf("task-Y"), (s) => s === "paused" || s === "failed");
    assert.equal(paused, "paused", "前提：task-Y がコンフリクトで止まっている");

    // paused のまま畳む（元は畳めなかった状態）
    const details = await call("kobo.abandon", {
      projectTag: PROJ,
      taskId: "task-Y",
      reason: "テスト: 解消する気が無いので畳む",
    });
    assert.equal(details["from"], "paused");
    assert.equal(await statusOf("task-Y"), "closed");

    // 起票された解消タスクを片付ける。`runConflictResolutionCheck` は解消タスクが
    // merged / closed になったとき origin を merging へ戻す——**そこが起き上がる道**
    const resolution = await pollUntil(
      () =>
        daemon
          .getTasksByProject(PROJ)
          .find((t) => t["kind"] === "conflict" && t.status !== "closed"),
      (t) => t !== undefined
    );
    assert.ok(resolution, "前提：解消タスクが起票されている");
    await call("kobo.abandon", {
      projectTag: PROJ,
      taskId: resolution.id,
      reason: "テスト: 解消タスクも畳む",
    });

    // tick を何周か回す。起き上がるならここで merging に戻る
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(
      await statusOf("task-Y"),
      "closed",
      "畳んだタスクが自動再開で起き上がっている"
    );
  });

  it("定義ファイルが残っていても、watcher は畳んだタスクを queued に戻さない", async () => {
    const taskFile = path.join(repoDir, "work", "tasks", "task-9001.md");
    fs.mkdirSync(path.dirname(taskFile), { recursive: true });
    fs.writeFileSync(
      taskFile,
      `---
id: task-9001
type: task
kind: feature
title: 畳んだあとも残る定義ファイル
status: queued
scope:
  paths: [zzz/**]
acceptance:
  - { id: a1, text: 動作確認 }
---

## 背景

畳んだあとに読み直されないことを見る。
`,
      "utf-8"
    );

    const ingested = await pollUntil(() => statusOf("task-9001"), (s) => s === "queued" || s === "ready");
    assert.ok(["queued", "ready"].includes(ingested), "前提：ファイルから取り込まれている");

    await call("kobo.abandon", { projectTag: PROJ, taskId: "task-9001", reason: "テスト: 畳む" });
    assert.equal(await statusOf("task-9001"), "closed");

    // **ファイルは残る**（畳んでも消さない）。ここで queued に戻ると改修が無意味になる
    assert.equal(fs.existsSync(taskFile), true, "前提：定義ファイルは畳んでも残る");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await statusOf("task-9001"), "closed", "watcher が畳んだタスクを起こし直している");

    // PO がその md を触った場合（mtime が動く）も、黙って queued に戻らないこと
    fs.utimesSync(taskFile, new Date(), new Date(Date.now() + 2000));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      await statusOf("task-9001"),
      "closed",
      "**ファイルを触ったら queued に戻った**（この改修が無意味になる道）"
    );
  });
});
