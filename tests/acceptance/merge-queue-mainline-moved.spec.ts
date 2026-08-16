/**
 * [task-0197] **関所を通しているあいだに main が進んでも着地する。**
 *
 * マージキューは 1) rebase → 2) 関所（検証環境を立てて受け入れ条件を回す）→
 * 3) `git merge --ff-only` の順に進む。2 は全量 `npm test` を含むと6〜8分かかるので、
 * **1 と 3 のあいだが6〜8分空く**。その間に main が1コミットでも進めば枝はもう main の
 * 子孫ではなく、ff は必ず失敗する。
 *
 * 実データ（task-0159, 2026-08-16）:
 *
 *     06:45:58 merge_gate_evaluated — 通過［base 881371a8］
 *     06:45:58 task_failed — fast_forward_merge_failed: fatal: Not possible to fast-forward, aborting.
 *     07:00:38 merge_gate_evaluated — 通過［base 00031cf0］
 *     07:00:38 task_failed — fast_forward_merge_failed:（同上）
 *
 * **2回ともゲートは通過している。**中身も契約も無罪で、負けたのは時間。
 * `merge-queue.ts` には「rebase とゲートが通ったあとの ff 失敗は想定外」と書いてあったが、
 * その前提が誤り——rebase とゲートの成功は *その時点の main に対する主張* でしかない。
 *
 * ここで押さえるのは3つ:
 *   a1 関所の最中に main が進んでも着地し、main には**枝の変更と割り込んだコミットの両方**が載る
 *   a2 再試行は同じ tick の中で**1回だけ**（回数を固定する）
 *   a3 本物の衝突は従来どおり失敗にし、**衝突したファイル名を含む理由**を残す（I2）
 *
 * story_type=api: 本物の git リポジトリと本物のマージキューを回す。git は偽らない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { Daemon, processMergeQueue } from "@banto/daemon";
import type { GateVerifyRunner } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog, StateMachine, type OrchestrationEvent, type TaskRecord } from "@banto/core";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@banto-mainline-moved.local"], dir);
  git(["config", "user.name", "banto-mainline-moved-test"], dir);
  fs.writeFileSync(path.join(dir, "shared.ts"), "export const VERSION = 0;\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial"], dir);
}

/** 職人の代わりに、タスクのブランチとワークツリーを手で用意する。 */
function setupTaskBranch(opts: {
  repoDir: string;
  worktreeBaseDir: string;
  proj: string;
  taskId: string;
  /** 枝が触るファイルと中身。 */
  files: Record<string, string>;
  subject: string;
}): string {
  const { repoDir, worktreeBaseDir, proj, taskId, files, subject } = opts;
  const worktreePath = path.join(worktreeBaseDir, proj, taskId);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(["worktree", "add", "--detach", worktreePath], repoDir);
  git(["checkout", "-b", `task/${taskId}`], worktreePath);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(worktreePath, name), content);
  }
  git(["add", "-A"], worktreePath);
  git(["commit", "-m", subject], worktreePath);
  return worktreePath;
}

/** main に1コミット積む（＝「割り込み」）。 */
function commitOnMain(repoDir: string, files: Record<string, string>, subject: string): void {
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(repoDir, name), content);
  }
  git(["add", "-A"], repoDir);
  git(["commit", "-m", subject], repoDir);
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

/** 関所の中で止まる検証ランナー。止めているあいだに main を進める。 */
function pausingVerifyRunner(): {
  runner: GateVerifyRunner;
  entered: Promise<void>;
  release: () => void;
} {
  const inner = hostVerifyRunner();
  let signalEntered!: () => void;
  const entered = new Promise<void>((r) => {
    signalEntered = r;
  });
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const runner: GateVerifyRunner = {
    provision: (o) => inner.provision(o),
    teardown: (envId) => inner.teardown(envId),
    async run(o) {
      signalEntered();
      await gate;
      return inner.run(o);
    },
  };
  return { runner, entered, release: open };
}

const LIFECYCLE = [
  "queued",
  "ready",
  "planning",
  "implementing",
  "auditing",
  "review-ready",
  "in-review",
  "approved",
] as const;

// ── a1. 関所の最中に main が進んでも着地する ─────────────────────────────────

describe("[mainline-moved] a1 関所の最中に main が進んでも着地し、両方の変更が main に載る", () => {
  const PROJ = "mainline-moved";
  const TASK = "task-mm1";
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let gate: ReturnType<typeof pausingVerifyRunner>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mainline-moved-"));
    repoDir = path.join(tmpDir, "repo");
    const worktreeBaseDir = path.join(tmpDir, "worktrees");
    initRepo(repoDir);

    gate = pausingVerifyRunner();
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir,
      verifyRunner: gate.runner,
      tickIntervalMs: 100,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);

    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: TASK,
      files: { "mm1.ts": "// task-mm1 の変更\n" },
      subject: "feat: task-mm1 の変更",
    });
  });

  after(async () => {
    gate.release();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("task_merged が出て、main に枝の変更と割り込んだコミットの両方が入る", async () => {
    daemon.createTask(PROJ, TASK, TASK, {
      kind: "feature",
      scope: { paths: ["mm1.ts"] },
      acceptance: [{ id: "a1", text: "ファイルがある", verify: "test -f mm1.ts" }],
    });
    for (const to of LIFECYCLE) daemon.transition(PROJ, TASK, to, "テスト");

    // 関所に入るまで待つ（rebase は済んでいて、ff はまだ）
    await gate.entered;
    assert.equal(daemon.getTask(PROJ, TASK)?.status, "merging", "前提：関所の中に居る");

    // **ここが本題**：検証を走らせているあいだに main へ別のコミットが1本入る
    commitOnMain(repoDir, { "intruder.ts": "// 割り込んだコミット\n" }, "chore: 割り込み");
    const intruderSha = git(["rev-parse", "main"], repoDir).trim();

    gate.release();

    const status = await pollUntil(
      () => daemon.getTask(PROJ, TASK)?.status ?? "",
      (s) => s === "merged" || s === "closed" || s === "failed",
      20000
    );

    const events = daemon.getAllEvents();
    const failed = events.filter(
      (e) => e.type === "task_failed" && (e as { taskId?: string }).taskId === TASK
    );
    assert.deepEqual(
      failed.map((e) => JSON.stringify(e)),
      [],
      "task_failed が出ている（着地の賭けに負けたまま）"
    );
    assert.equal(
      events.some(
        (e) => e.type === "task_merged" && (e as { taskId?: string }).taskId === TASK
      ),
      true,
      "task_merged が出ていない"
    );
    assert.ok(status === "merged" || status === "closed", `状態が ${status}`);

    // main の HEAD に**両方**入っていること。片方だけなら取りこぼし
    const tree = git(["ls-tree", "-r", "--name-only", "main"], repoDir).split("\n");
    assert.ok(tree.includes("mm1.ts"), `枝の変更が main に無い: ${tree.join(",")}`);
    assert.ok(tree.includes("intruder.ts"), `割り込んだコミットが消えている: ${tree.join(",")}`);

    // 割り込んだコミットが main の履歴に残っている＝上書きしていない
    const history = git(["rev-list", "main"], repoDir).trim().split("\n");
    assert.ok(history.includes(intruderSha), "割り込んだコミットが履歴から消えている");

    // 履歴は一直線のまま（ff を捨ててマージコミットを作っていない）
    const merges = git(["rev-list", "--merges", "main"], repoDir).trim();
    assert.equal(merges, "", `マージコミットができている: ${merges}`);
  });
});

// ── a3. 本物の衝突は従来どおり失敗にする ─────────────────────────────────────

describe("[mainline-moved] a3 乗せ直しても解けない衝突は、ファイル名を残して落ちる", () => {
  const PROJ = "mainline-conflict";
  const TASK = "task-mm3";
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let gate: ReturnType<typeof pausingVerifyRunner>;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mainline-conflict-"));
    repoDir = path.join(tmpDir, "repo");
    const worktreeBaseDir = path.join(tmpDir, "worktrees");
    initRepo(repoDir);

    gate = pausingVerifyRunner();
    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      worktreeBaseDir,
      verifyRunner: gate.runner,
      tickIntervalMs: 100,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);

    // 枝は shared.ts の同じ行を直す
    setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: TASK,
      files: { "shared.ts": "export const VERSION = 1;\n" },
      subject: "feat: task-mm3 が VERSION を 1 にする",
    });
  });

  after(async () => {
    gate.release();
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("failed になり、理由に衝突したファイル名が入る（握り潰さない）", async () => {
    daemon.createTask(PROJ, TASK, TASK, {
      kind: "feature",
      scope: { paths: ["shared.ts"] },
      acceptance: [{ id: "a1", text: "VERSION が 1", verify: "grep -q 'VERSION = 1' shared.ts" }],
    });
    for (const to of LIFECYCLE) daemon.transition(PROJ, TASK, to, "テスト");

    await gate.entered;
    assert.equal(daemon.getTask(PROJ, TASK)?.status, "merging", "前提：関所の中に居る");

    // 関所の最中に main が**同じ行**を直す。乗せ直しても解けない
    commitOnMain(repoDir, { "shared.ts": "export const VERSION = 2;\n" }, "chore: 割り込み(衝突)");

    gate.release();

    const status = await pollUntil(
      () => daemon.getTask(PROJ, TASK)?.status ?? "",
      (s) => s === "failed" || s === "merged" || s === "closed",
      20000
    );
    assert.equal(status, "failed", "本物の衝突なのに失敗になっていない");

    const events = daemon.getAllEvents();
    const failure = events.find(
      (e) => e.type === "task_failed" && (e as { taskId?: string }).taskId === TASK
    ) as ({ reason?: string } & OrchestrationEvent) | undefined;
    assert.ok(failure, "task_failed が出ていない");
    const reason = String(failure?.reason ?? "");
    assert.ok(
      reason.includes("shared.ts"),
      `理由に衝突したファイル名が入っていない: ${reason}`
    );

    // main は割り込んだ側のまま。枝の変更は載せていない
    assert.equal(
      git(["show", "main:shared.ts"], repoDir).trim(),
      "export const VERSION = 2;",
      "衝突したのに main が動いている"
    );
  });
});

// ── a2. 再試行は同じ tick の中で1回だけ ──────────────────────────────────────

/**
 * **ff の直前に main が動く**状況は本番では偶然にしか起きないので、`onFastForwardAttempt`
 * （merge-queue.ts の継ぎ目）から毎回 main を進めて、必ず ff が失敗し続ける形を作る。
 *
 * これで「上限が無ければ回り続ける」入力になる。**回数が2で止まること**が a2 の中身。
 * ここは Daemon を通さず `processMergeQueue` を直接呼ぶ——tick の1回の中で何が起きたかを
 * 数えるのが目的なので、tick を回す側は要らない。
 */
describe("[mainline-moved] a2 ff が失敗し続けても、同じ tick の中では1回しか再試行しない", () => {
  const PROJ = "mainline-retry";
  const TASK = "task-mm2";
  let tmpDir: string;
  let repoDir: string;
  let worktreePath: string;
  let log: EventLog;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mainline-retry-"));
    repoDir = path.join(tmpDir, "repo");
    const worktreeBaseDir = path.join(tmpDir, "worktrees");
    initRepo(repoDir);
    worktreePath = setupTaskBranch({
      repoDir,
      worktreeBaseDir,
      proj: PROJ,
      taskId: TASK,
      files: { "mm2.ts": "// task-mm2 の変更\n" },
      subject: "feat: task-mm2 の変更",
    });

    log = EventLog.open(path.join(tmpDir, "data"));
    // 待ち行列は `state_transitioned` だけから導かれる（D3）。approved まで進めておく
    StateMachine.transition(log, TASK, "in-review", "approved", PROJ, "テスト");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ff の試行は2回（初回＋再試行1回）で止まり、failed になる", async () => {
    const taskBase: TaskRecord = {
      id: TASK,
      projectTag: PROJ,
      title: TASK,
      status: "approved",
      kind: "feature",
      scope: { paths: ["mm2.ts"] },
      acceptance: [{ id: "a1", text: "ファイルがある", verify: "test -f mm2.ts" }],
    };
    /** 状態の真実は帳簿（D3）。処理の途中で書かれた遷移をそのまま反映する */
    const getAllTasks = (): TaskRecord[] => {
      let status = "approved";
      for (const e of log.readAllEvents()) {
        const st = e as { type: string; taskId?: string; projectTag?: string; to?: string };
        if (st.type === "state_transitioned" && st.taskId === TASK && st.projectTag === PROJ) {
          status = st.to ?? status;
        }
      }
      return [{ ...taskBase, status }];
    };

    const attempts: number[] = [];
    const processed = await processMergeQueue(log, {
      dataDir: path.join(tmpDir, "data"),
      mainline: "main",
      getWorktreePath: () => worktreePath,
      getProjectRepoPath: () => repoDir,
      getAllTasks,
      verifyRunner: hostVerifyRunner(),
      // ff を試みるたびに main を1歩進める＝ff は必ず失敗する
      onFastForwardAttempt: (attempt) => {
        attempts.push(attempt);
        commitOnMain(
          repoDir,
          { [`moved-${attempt}.ts`]: `// ${attempt} 回目の割り込み\n` },
          `chore: ff の直前に main が進む (${attempt})`
        );
      },
    });

    assert.equal(processed, true, "先頭のタスクを処理していない");
    assert.deepEqual(attempts, [1, 2], "ff の試行回数が違う（1回だけ再試行するはず）");

    const status = getAllTasks()[0]?.status;
    assert.equal(status, "failed", "上限に当たったのに failed になっていない");

    const events = log.readAllEvents();
    const failure = events.find(
      (e) => e.type === "task_failed" && (e as { taskId?: string }).taskId === TASK
    ) as ({ reason?: string } & OrchestrationEvent) | undefined;
    assert.ok(failure, "task_failed が出ていない");
    assert.ok(
      String(failure?.reason ?? "").startsWith("fast_forward_merge_failed:"),
      `理由が変わっている: ${failure?.reason}`
    );

    // main には枝の変更が載っていない（握り潰して成功にしていない）
    const tree = git(["ls-tree", "-r", "--name-only", "main"], repoDir).split("\n");
    assert.equal(tree.includes("mm2.ts"), false, "落ちたのに main に載っている");
    assert.equal(
      events.some((e) => e.type === "task_merged" && (e as { taskId?: string }).taskId === TASK),
      false,
      "落ちたのに task_merged が出ている"
    );
  });
});
