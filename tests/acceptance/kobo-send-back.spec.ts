/**
 * 段2: レビューから**実装へ差し戻す**（`kobo.send_back`）。
 *
 * **困っていたこと**（報告 `2026-08-13-kobo-vs-po-intent.md` A 表 11b）：
 * 期待像「必要に応じて実装に差し戻す」に対して、レビュー待ちのタスクを実装へ戻す口が
 * 1つも無かった。`kobo.reopen` も `kobo.abandon` も `failed` 専用で、`review-ready` から
 * `implementing` へ通る唯一の道は**契約を書き換える** `kobo.amend` だけ。
 * レビュー面のボタンも「通す」しか無く、**判断の片側しか受け取れなかった**。
 *
 * 入れたもの: `kobo.send_back(projectTag, taskId, reason)`
 *   - `review-ready` / `in-review` → `implementing`。**契約は変えない**
 *   - 理由は帳簿に残り、**職人にそのまま渡る**（reopen と同じ扱い）
 *
 * 守ること（I2）: レビュー待ちでないものは差し戻せない。落ちたものは `kobo.reopen` の領分。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import { startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";
import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "../../packages/banto-core/src/index.js";

/** 起こされた職人の指示文をそのまま取っておくドライバ（`kobo-reopen-failed.spec.ts` と同じ形）。 */
class CaptureDriver implements RuntimeDriver {
  readonly spawned: SpawnOptions[] = [];
  readonly injected: string[] = [];
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
    const start: DriverEvent = {
      type: "process_started",
      pid,
      sessionId,
      sessionPath: opts.sessionPath,
    };
    for (const h of this.handlers) { try { h(start); } catch { /* ignore */ } }
    this.spawned.push(opts);
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

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

const PROJ = "sendbackproj";
let daemon: Daemon;
let tmpDir: string;
let driver: CaptureDriver;
let workers: WorkerPoolHarness;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** タスクを判断待ち（`review-ready`）まで運ぶ。 */
function driveToReviewReady(taskId: string, extra: Record<string, unknown> = {}): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
    ...extra,
  });
  for (const to of ["queued", "ready", "planning", "implementing", "auditing", "review-ready"]) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-send-back-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  // **本物の Worker Pool を立てる**（差し戻した理由が職人に届くところまで見る）
  driver = new CaptureDriver();
  workers = await startWorkerPool(driver);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    // 判断待ちに入ると環境を頼みに行く（段11c）。ここで見たいのは差し戻しだけなので、
    // **稼働中の Environment Pool に触らせない**（直に `node --test` で走らせたときの事故防止）
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);

  const tools = createKoboTools(daemon);
  call = async (name, args) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool: ${name}`);
    const r = await t.execute(args as never, { toolCallId: "t" });
    return (r.details ?? {}) as Record<string, unknown>;
  };
});

after(async () => {
  await daemon.stop();
  await workers.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[段2] レビューから実装へ差し戻せる", () => {
  it("review-ready → implementing。理由が帳簿に残り、**職人にそのまま渡る**", async () => {
    const id = "task-2001";
    driveToReviewReady(id);
    const before = driver.injected.length;

    const r = await call("kobo.send_back", {
      projectTag: PROJ,
      taskId: id,
      reason: "エラーを握り潰している（I2）。握らず failed にして止めること",
    });

    assert.equal(r["to"], "implementing");
    assert.equal(daemon.getTask(PROJ, id)?.status, "implementing");

    // 帳簿：**なぜ戻したか**が state_transitioned の理由に残る（reopen と同じ扱い）
    const transition = daemon
      .getTaskEvents(PROJ, id)
      .find(
        (e) => e.type === "state_transitioned" && e.from === "review-ready" && e.to === "implementing"
      ) as { reason?: string } | undefined;
    assert.ok(transition, "差し戻しの遷移が帳簿に無い");
    assert.match(transition.reason ?? "", /sent_back_by:banto/);
    assert.match(transition.reason ?? "", /握り潰している/, "理由が帳簿に残っていない");

    // 職人：**同じものが上がってこないように**、指摘がそのまま渡っていること
    assert.ok(driver.injected.length > before, "職人が起きていない");
    const instruction = driver.injected.slice(before).join("\n");
    assert.match(instruction, /レビューでの指摘/, "指摘の見出しが職人へ渡っていない");
    assert.match(instruction, /握らず failed にして止めること/, "指摘の中身が職人へ渡っていない");
  });

  it("in-review（番頭が開いた状態）からも戻せる", async () => {
    const id = "task-2002";
    driveToReviewReady(id);
    assert.equal(daemon.transition(PROJ, id, "in-review", "テスト：開く").ok, true);

    const r = await call("kobo.send_back", {
      projectTag: PROJ,
      taskId: id,
      reason: "受け入れ基準の a2 が満たせていない",
    });
    assert.equal(r["to"], "implementing");
    assert.equal(daemon.getTask(PROJ, id)?.status, "implementing");
  });

  /**
   * **契約を変えないことが段2 の要点。** 変えるなら `kobo.amend`（監査が無効になる）か
   * `kobo.supersede`（別のタスクに置き換える）で、そちらは意味も手続きも違う。
   * ここが契約に触れると「何に対して監査したのか」が答えられなくなる（決定64）。
   */
  it("**契約は変わらない**（改訂の記録も残らない・スコープも受け入れ基準もそのまま）", async () => {
    const id = "task-2003";
    driveToReviewReady(id);
    const contractBefore = JSON.stringify({
      scope: daemon.getTask(PROJ, id)?.["scope"],
      acceptance: daemon.getTask(PROJ, id)?.["acceptance"],
    });

    await call("kobo.send_back", { projectTag: PROJ, taskId: id, reason: "作りが違う" });

    const contractAfter = JSON.stringify({
      scope: daemon.getTask(PROJ, id)?.["scope"],
      acceptance: daemon.getTask(PROJ, id)?.["acceptance"],
    });
    assert.equal(contractAfter, contractBefore, "差し戻しで契約が動いている");
    assert.equal(
      daemon.getTaskEvents(PROJ, id).filter((e) => e.type === "task_contract_amended").length,
      0,
      "契約を触っていないのに改訂の記録が積まれている（帳簿が嘘になる）"
    );
  });

  it("宛先の無いタスクを戻すと、戻した会話が宛先になる（reopen と同じ・決定58）", async () => {
    const id = "task-2004";
    driveToReviewReady(id);
    assert.equal(daemon.originOfTask(PROJ, id), undefined, "前提：取り込んだタスクに宛先は無い");

    await call("kobo.send_back", {
      projectTag: PROJ,
      taskId: id,
      reason: "直して",
      origin: "banto:thread-77",
    });
    assert.equal(daemon.originOfTask(PROJ, id), "banto:thread-77");
  });

  it("レビュー待ちでないものは差し戻せない（落ちたものは kobo.reopen の領分・I2）", async () => {
    const id = "task-2005";
    daemon.createTask(PROJ, id, id);
    daemon.transition(PROJ, id, "queued", "テスト");

    await assert.rejects(
      () => call("kobo.send_back", { projectTag: PROJ, taskId: id, reason: "なんとなく" }),
      /レビュー待ちではありません/
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "queued", "断ったのに状態が動いている");
  });

  /**
   * 決定57 が番頭に禁じているのは**通す**ことだけ。差し戻しは厳しい方向へ倒す判断なので、
   * `po` 段でも番頭が押せる——ここを対称にすると、PO が見るまで直し始められない。
   */
  it("PO 判断のタスクでも、番頭は差し戻せる（通せないのは approve だけ）", async () => {
    const id = "task-2006";
    driveToReviewReady(id, { governance: true });
    assert.equal(
      daemon.approveTask(PROJ, id, { by: "banto" }).ok,
      false,
      "前提：番頭には通せないタスク"
    );

    const r = await call("kobo.send_back", {
      projectTag: PROJ,
      taskId: id,
      reason: "統治コードの変更としては説明が足りない",
    });
    assert.equal(r["to"], "implementing");
  });
});

describe("[段2] 道具が番頭の手に在る", () => {
  it("kobo.send_back が Kobo の在庫にある", () => {
    const names = createKoboTools(daemon).map((t) => t.name);
    assert.ok(names.includes("kobo.send_back"), "在庫に無い");
  });

  /**
   * **在庫にあっても提示していなければ「無い」のと同じ**（決定82・inc-0063 で踏んだ形）。
   * 通す口だけを見せると、番頭は駄目だと分かったものを通すか放置するしかなくなる。
   */
  it("番頭へ提示する道具の一覧にも載っている（決定82・83）", async () => {
    const { PRESENTED_TOOL_NAMES } = await import(
      "../../packages/banto-host/src/presented-tools.js"
    );
    assert.ok(
      (PRESENTED_TOOL_NAMES as readonly string[]).includes("kobo.send_back"),
      "提示していないと、番頭の手には無いのと同じ"
    );
  });
});
