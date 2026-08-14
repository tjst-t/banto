/**
 * 落ちたタスクを**切り直さずに**最後まで通す（task-0081・PO 要望 2026-08-08）。
 *
 * **困っていたこと**：落ちるたびに新しいタスクを立てる運用になっていた。実機の loamium は
 * task-0004 がマージ前ゲートで落ち → **task-0005 を切り直し** → それも落ちた。
 * 同じ依頼が別 id に分かれ、**何度目の挑戦なのかが帳簿から読めない**。
 *
 * 入れたもの:
 *   1. **なぜ落ちたかが読める**（`kobo.task`）。「verify_failed:a4(exit=1)」だけでは
 *      直しようがない——番号から先は検証のログにしか無い
 *   2. **同じタスクのまま戻せる**（`kobo.reopen`）。中身なら rework、検証環境なら reverify
 *   3. **どうしようもなければ畳める**（`kobo.abandon`）。closed へ
 *      ——**どの状態からでも**（PO 裁定 2026-08-14。当初は failed 専用だった）
 *
 * 守ること（I2）:
 *   - `reverify` は**承認まで行った実績があるときだけ**。監査を飛ばさせない
 *   - 落ちていないタスクは戻せない（`reopen` は failed 専用のまま）
 *   - **もう畳んであるもの（closed / superseded）は畳み直さない**。いまの状態を名指しで断る
 *
 * 直しを戻すと落ちることを確認済み。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog } from "../../packages/banto-core/src/index.js";
import { hostVerifyRunner } from "./gate-verify-runner.js";
import { startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";
import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "../../packages/banto-core/src/index.js";

/**
 * 起こされた職人の**指示文をそのまま取っておく**ドライバ。
 * 「落ちた理由が職人に届いているか」は、これでしか確かめられない。
 */
class CaptureDriver implements RuntimeDriver {
  readonly spawned: SpawnOptions[] = [];
  private readonly handlers = new Set<DriverEventHandler>();
  private readonly procs = new Map<string, childProcess.ChildProcess>();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("CaptureDriver: pid が取れない");
    const sessionId = `capture-${opts.taskId}-${Date.now()}-${pid}`;
    this.procs.set(sessionId, proc);
    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) { try { h(ev); } catch { /* ignore */ } }
      this.procs.delete(sessionId);
    });
    const start: DriverEvent = { type: "process_started", pid, sessionId, sessionPath: opts.sessionPath };
    for (const h of this.handlers) { try { h(start); } catch { /* ignore */ } }
    this.spawned.push(opts);
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  /** 指示文はここで届く（起こしたあとに流し込む形）。 */
  readonly injected: string[] = [];
  async inject(_sessionId: string, message: string): Promise<void> {
    this.injected.push(message);
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async kill(sessionId: string): Promise<void> {
    const proc = this.procs.get(sessionId);
    if (proc?.pid) { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ } }
    this.procs.delete(sessionId);
  }
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "reopenproj";
let daemon: Daemon;
let tmpDir: string;
let dataDir: string;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
let driver: CaptureDriver;
let workers: WorkerPoolHarness;

/** そのタスクをゲートで落ちた形にする（承認まで行かせるかを選べる）。 */
function driveToFailed(taskId: string, opts: { viaApproved: boolean; origin?: string }): void {
  // origin を渡すと「番頭が会話から積んだ」形、渡さないと「ファイルから取り込んだ」形
  daemon.createTask(PROJ, taskId, taskId, opts.origin ? { origin: opts.origin } : {});
  const steps = opts.viaApproved
    ? ["queued", "ready", "planning", "implementing", "auditing", "review-ready", "in-review", "approved", "merging"]
    : ["queued", "ready", "planning", "implementing"];
  for (const to of steps) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
  const f = daemon.transition(PROJ, taskId, "failed", "テスト：落とす");
  assert.equal(f.ok, true, `${taskId} → failed: ${JSON.stringify(f)}`);
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-reopen-"));
  dataDir = path.join(tmpDir, "data");
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  // **本物の Worker Pool を立てる。** 職人が実際に起きて、落ちた理由を受け取ることまで見る
  driver = new CaptureDriver();
  workers = await startWorkerPool(driver);

  daemon = Daemon.create({
    port: 0,
    dataDir,
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  rebindTools();
});

/** 道具は daemon に紐づくので、帳簿を読み直したら束ね直す。 */
function rebindTools(): void {
  const tools = createKoboTools(daemon);
  call = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool: ${name}`);
    const r = await t.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as Record<string, unknown>;
  };
}

after(async () => {
  await daemon.stop();
  await workers.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[task-0081] 落ちた理由が読める", () => {
  it("kobo.task が「なぜ落ちたか」を**本物の検証ログの末尾つき**で返す", async () => {
    // **本物のゲートを落とす。** 偽の記録を置くと、ゲートが実際に何を残すか
    // （ログの置き場所・ファイル名）とずれても検体が通ってしまう
    const id = "task-1001";
    driveToFailed(id, { viaApproved: true });
    await daemon.stop();

    const gateRepo = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-reopen-gate-"));
    const g = (...a: string[]): void => { childProcess.execFileSync("git", a, { cwd: gateRepo, stdio: "pipe" }); };
    g("init", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    fs.mkdirSync(path.join(gateRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(gateRepo, "src", "a.ts"), "// x\n");
    g("add", "-A"); g("commit", "-m", "init");
    g("checkout", "-b", "task-branch");
    fs.writeFileSync(path.join(gateRepo, "src", "b.ts"), "// y\n");
    g("add", "-A"); g("commit", "-m", "work");

    // 同じ帳簿に、本物のゲートの不通過を積む
    const log = EventLog.open(dataDir);
    const gateResult = await runMergeGate(
      log,
      {
        id,
        projectTag: PROJ,
        status: "merging",
        title: id,
        scope: { paths: ["src/**"] },
        // **本当に落ちる検証**。中身が読めることを見たいので、目印を出して落とす
        acceptance: [{ id: "a4", text: "テストが通る", verify: "echo '期待した値と違います'; exit 1" }],
      } as never,
      {
        dataDir,
        repoPath: gateRepo,
        base: "main",
        branch: "task-branch",
        worktreePath: gateRepo,
        repoPathForProfile: gateRepo,
        verifyRunner: hostVerifyRunner(),
      }
    );
    assert.equal(gateResult.passed, false, "ゲートが落ちていない（前提が崩れている）");

    // 帳簿を読み直す（再起動と同じ道）。番頭が見るのは常にこの読み直したもの
    daemon = Daemon.create({
      port: 0, dataDir, tickIntervalMs: 99999,
      disableAutoSpawn: true, disableAuditSpawn: true,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
    });
    await daemon.start();
    rebindTools();

    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    const failure = d["failure"] as {
      gateReasons: string[];
      logs: Array<{ acId: string; tail: string }>;
      reopenCount: number;
    };
    assert.ok(failure, "落ちているのに failure が返っていない（番号すら読めない状態）");
    assert.match(failure.gateReasons.join(" "), /verify_failed:a4/);
    // **ここが要点**：番号だけでなく、実際に何が起きたかが読めること
    assert.match(
      failure.logs.find((l) => l.acId === "a4")?.tail ?? "",
      /期待した値と違います/,
      "検証ログの中身が返っていない——番号だけでは直しようがない"
    );
    assert.equal(failure.reopenCount, 0);
    fs.rmSync(gateRepo, { recursive: true, force: true });
  });

  it("落ちていないタスクには failure を付けない（余計なものを出さない）", async () => {
    const id = "task-1002";
    daemon.createTask(PROJ, id, id);
    daemon.transition(PROJ, id, "queued", "テスト");
    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    assert.equal(d["failure"], undefined);
  });
});

describe("[task-0081] 同じタスクのまま戻せる（切り直さない）", () => {
  it("rework: 中身から直す（implementing へ戻る）", async () => {
    const id = "task-1003";
    driveToFailed(id, { viaApproved: true });

    const r = await call("kobo.reopen", {
      projectTag: PROJ,
      taskId: id,
      mode: "rework",
      reason: "スコープに package-lock.json を足して直す",
    });
    assert.equal(r["to"], "implementing");
    assert.equal(daemon.getTask(PROJ, id)?.status, "implementing");

    // **同じ id のまま**であること（切り直していない）
    const all = daemon.getTasksByProject(PROJ).filter((t) => t.id.startsWith("task-1003"));
    assert.equal(all.length, 1, "タスクが増えている＝切り直している");

    // **落ちた理由と番頭の指示が職人に届いていること**——これが届かないと同じ失敗を繰り返す
    assert.ok(driver.spawned.length > 0, "職人が起きていない");
    const instruction = driver.injected.join("\n");
    assert.match(instruction, /前回どこで落ちたか/, "落ちた理由の見出しが職人へ渡っていない");
    assert.match(instruction, /package-lock\.json/, "番頭の指示が職人へ渡っていない");
  });

  /**
   * **戻せと言った会話が、以後の宛先になる**（PO報告 2026-08-10）。
   *
   * 宛先はこれまで「積んだとき」にしか付かなかった。`work/tasks/*.md` から取り込まれた
   * タスク（`watcher-ingest`）には宛先が無く、番頭が会話から戻しても付かないままだったので、
   * 知らせが**帳場へ流れ込んでいた**——task-0089 が3回ともそうなった。
   */
  it("宛先の無いタスクを戻すと、戻した会話が宛先になる", async () => {
    const id = "task-1020";
    driveToFailed(id, { viaApproved: true });
    assert.equal(daemon.originOfTask(PROJ, id), undefined, "前提：取り込んだタスクに宛先は無い");

    await call("kobo.reopen", {
      projectTag: PROJ,
      taskId: id,
      mode: "rework",
      reason: "直して",
      origin: "banto:thread-61",
    });

    assert.equal(
      daemon.originOfTask(PROJ, id),
      "banto:thread-61",
      "戻した会話が宛先になっていない（知らせが既定＝帳場へ流れる）"
    );
  });

  it("既に宛先があるタスクは、戻しても宛先を奪わない", async () => {
    const id = "task-1021";
    driveToFailed(id, { viaApproved: true, origin: "banto:thread-50" });
    assert.equal(daemon.originOfTask(PROJ, id), "banto:thread-50", "前提：積んだ会話の宛先がある");

    await call("kobo.reopen", {
      projectTag: PROJ,
      taskId: id,
      mode: "rework",
      reason: "直して",
      origin: "banto:thread-61",
    });

    assert.equal(
      daemon.originOfTask(PROJ, id),
      "banto:thread-50",
      "最初に積んだ会話から宛先を奪ってはいけない"
    );
  });

  it("reverify: 中身は触らずゲートを回し直す（approved へ戻る）", async () => {
    const id = "task-1004";
    driveToFailed(id, { viaApproved: true });

    const r = await call("kobo.reopen", {
      projectTag: PROJ,
      taskId: id,
      mode: "reverify",
      reason: "検証環境が立たなかっただけ。中身は変わっていない",
    });
    assert.equal(r["to"], "approved");
    assert.equal(daemon.getTask(PROJ, id)?.status, "approved");
  });

  it("**承認まで行っていないタスクは reverify できない**（監査を飛ばさせない・I2）", async () => {
    const id = "task-1005";
    driveToFailed(id, { viaApproved: false });

    await assert.rejects(
      () =>
        call("kobo.reopen", {
          projectTag: PROJ,
          taskId: id,
          mode: "reverify",
          reason: "環境のせいだと思う",
        }),
      /承認まで行っていない|監査を飛ばして/,
      "未監査のタスクをマージ待ちに置けてしまうと、番頭の取り違えでそのままマージされる"
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "failed", "拒否したのに状態が動いている");
  });

  it("落ちていないタスクは戻せない（I2）", async () => {
    const id = "task-1006";
    daemon.createTask(PROJ, id, id);
    daemon.transition(PROJ, id, "queued", "テスト");
    await assert.rejects(
      () => call("kobo.reopen", { projectTag: PROJ, taskId: id, mode: "rework", reason: "なんとなく" }),
      /failed ではありません/
    );
  });

  it("戻した回数が数えられる（P6：同じところを何度も叩いていないか）", async () => {
    const id = "task-1007";
    driveToFailed(id, { viaApproved: true });

    await call("kobo.reopen", { projectTag: PROJ, taskId: id, mode: "rework", reason: "1回目" });
    daemon.transition(PROJ, id, "failed", "テスト：また落ちる");
    await call("kobo.reopen", { projectTag: PROJ, taskId: id, mode: "rework", reason: "2回目" });
    daemon.transition(PROJ, id, "failed", "テスト：また落ちる");

    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    const failure = d["failure"] as { reopenCount: number };
    // inc-0031 の残りの問い（reopen 計数が無いので P6 が機械で発火しない）がここで埋まる
    assert.equal(failure.reopenCount, 2, "戻した回数が数えられていない");
  });
});

describe("[task-0081] どうしようもないものは畳める（PO 裁定 2026-08-14: どの状態からでも）", () => {
  it("abandon: failed → closed。記録は消えない", async () => {
    const id = "task-1008";
    driveToFailed(id, { viaApproved: false });

    await call("kobo.abandon", {
      projectTag: PROJ,
      taskId: id,
      reason: "上流の依存が壊れていて、こちらでは直せない",
    });
    assert.equal(daemon.getTask(PROJ, id)?.status, "closed");

    // **経緯は残る**——落ちたことも、畳んだ理由も
    const events = daemon.getTaskEvents(PROJ, id);
    assert.ok(
      events.some((e) => e.type === "task_failed"),
      "落ちた記録が消えている"
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "state_transitioned" &&
          e.from === "failed" &&
          e.to === "closed" &&
          (e.reason ?? "").includes("上流の依存")
      ),
      "畳んだ理由が帳簿に残っていない"
    );
  });

  /**
   * **2026-08-14 の PO 裁定で意図が変わった。** 以前ここは
   * 「落ちていないタスクは畳めない（I2）」を固定していたが、実運用で宙に浮くのは
   * failed ではなく queued / paused / review-ready の方だった。いまは畳めるのが正しい。
   *
   * 残っている I2 は「**もう畳んであるものを黙って畳み直さない**」で、次の1件が見る。
   */
  it("落ちていないタスク（queued）も畳める", async () => {
    const id = "task-1009";
    daemon.createTask(PROJ, id, id);
    daemon.transition(PROJ, id, "queued", "テスト");
    await call("kobo.abandon", { projectTag: PROJ, taskId: id, reason: "やめる" });
    assert.equal(daemon.getTask(PROJ, id)?.status, "closed");

    // 経緯から**畳む前の状態**が読めること（記録は消えない）
    const events = daemon.getTaskEvents(PROJ, id);
    assert.ok(
      events.some(
        (e) => e.type === "state_transitioned" && e.from === "queued" && e.to === "closed"
      ),
      "queued から畳んだことが帳簿に残っていない"
    );
  });

  it("既に畳んだものは畳み直せない（いまの状態を名指しで断る・I2）", async () => {
    const id = "task-1009";
    assert.equal(daemon.getTask(PROJ, id)?.status, "closed", "前提：既に畳んである");
    await assert.rejects(
      () => call("kobo.abandon", { projectTag: PROJ, taskId: id, reason: "二度目" }),
      /いまは closed/
    );
  });

  it("畳んだタスクは既定の一覧から外れる（「まだ見る必要がある」ふりをしない）", async () => {
    const id = "task-1010";
    driveToFailed(id, { viaApproved: false });
    const before = (await call("kobo.list", { projectTag: PROJ })) as {
      tasks: Array<{ taskId: string }>;
    };
    assert.ok(before.tasks.some((t) => t.taskId === id), "落ちている間は既定に出るはず");

    await call("kobo.abandon", { projectTag: PROJ, taskId: id, reason: "諦める" });
    const after = (await call("kobo.list", { projectTag: PROJ })) as {
      tasks: Array<{ taskId: string }>;
    };
    assert.equal(after.tasks.some((t) => t.taskId === id), false);
  });
});
