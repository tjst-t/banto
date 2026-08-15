/**
 * **どの環境で検査したか**を、ゲートの記録から一意に辿れるようにする（inc: dentaku
 * task-0020・2026-08-15）。
 *
 * **起きた事故**：`merge_gate_evaluated` の経緯表示に出る `［env <digest>］` の中身は
 * `environmentDigest`（検証環境プロファイルの指紋＝どういう作りの環境か）で、実際に
 * 検証を走らせた環境の実体（envId）ではなかった。同じプロファイルなら別回の検証でも
 * 指紋は同じ値になる——4分後に別環境（`env-ca8fdde874`）で回し直した記録が、
 * 1回目（`env-03a6b9ce17`）とまったく同じ `［env 04b7a6595c58］` を刷ったため、
 * 「同じ環境で2回走った」と誤読させ、調査を1日ぶん誤った方向へ送った。
 *
 * ここで見る不変条件:
 *   - `verifyRunner.provision()` が返した envId（立てた環境の実体）が
 *     `merge_gate_evaluated.environmentId` としてイベントに残ること
 *   - 検証コマンドを1本も持たず環境を立てなかった回は、何も詰めないこと（I2）
 *   - `kobo.task` の経緯表示は envId と指紋を取り違えない形で出すこと
 *     （envId が無い古い帳簿では指紋だけを「指紋」と明示して出す）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog, type TaskRecord } from "../../packages/banto-core/src/index.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "gateenvproj";

describe("[段1続き] merge_gate_evaluated に立てた環境の実体（envId）が残る", () => {
  let tmpDir: string;
  let gateRepo: string;
  const branch = "task/gate-env-6001";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-env-evidence-"));
    gateRepo = path.join(tmpDir, "gaterepo");
    fs.mkdirSync(path.join(gateRepo, "src"), { recursive: true });
    git(["init", "-b", "main"], gateRepo);
    git(["config", "user.email", "t@example.com"], gateRepo);
    git(["config", "user.name", "t"], gateRepo);
    fs.writeFileSync(path.join(gateRepo, "README.md"), "x\n");
    git(["add", "."], gateRepo);
    git(["commit", "-m", "init"], gateRepo);
    git(["checkout", "-b", branch], gateRepo);
    fs.writeFileSync(path.join(gateRepo, "src", "a.ts"), "export const a = 1;\n");
    git(["add", "."], gateRepo);
    git(["commit", "-m", "work"], gateRepo);
    git(["checkout", "main"], gateRepo);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("provision が返した envId が environmentId としてイベントに残る（指紋とは別物）", async () => {
    const logDir = path.join(tmpDir, "gatelog");
    const log = EventLog.open(logDir);
    try {
      const task: TaskRecord = {
        id: "task-6001",
        status: "merging",
        projectTag: PROJ,
        title: "t",
        scope: { paths: ["src/**"] },
        acceptance: [{ id: "a1", text: "動く", verify: "true" }],
      };

      const result = await runMergeGate(log, task, {
        dataDir: path.join(tmpDir, "gatedata"),
        repoPath: gateRepo,
        base: "main",
        branch,
        worktreePath: gateRepo,
        repoPathForProfile: gateRepo,
        verifyProfile: "test",
        // 偽の runner。**指紋は同じでも、立てた実体（envId）は毎回違いうる**
        verifyRunner: {
          async provision() {
            return { envId: "env-03a6b9ce17", profileDigest: "04b7a6595c58" };
          },
          async run() {
            return { exit: 0 };
          },
          async teardown() {
            /* 何もしない */
          },
        },
      });

      assert.equal(result.passed, true, `ゲートが通っていない: ${result.reasons.join(", ")}`);
      assert.equal(result.environmentId, "env-03a6b9ce17", "MergeGateResult に envId が返っていない");
      assert.equal(result.environmentDigest, "04b7a6595c58", "MergeGateResult に指紋が返っていない");

      const gate = log
        .readAllEvents()
        .find((e) => e.type === "merge_gate_evaluated") as unknown as Record<string, unknown>;
      assert.ok(gate, "merge_gate_evaluated が積まれていない");
      assert.equal(gate["environmentId"], "env-03a6b9ce17", "立てた環境の実体（envId）が刻まれていない");
      assert.equal(gate["environmentDigest"], "04b7a6595c58", "環境の指紋が刻まれていない");
      assert.notEqual(
        gate["environmentId"],
        gate["environmentDigest"],
        "envId と指紋が同じ値では、取り違えを再現しているだけで直っていない"
      );
    } finally {
      log.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("検証コマンドが1本も無く環境を立てなかった回は、environmentId を付けない（I2）", async () => {
    const logDir = path.join(tmpDir, "gatelog2");
    const log = EventLog.open(logDir);
    try {
      const task: TaskRecord = {
        id: "task-6002",
        status: "merging",
        projectTag: PROJ,
        title: "t",
        scope: { paths: ["src/**"] },
        acceptance: [{ id: "a1", text: "目で見る" }],
      };
      await runMergeGate(log, task, {
        dataDir: path.join(tmpDir, "gatedata2"),
        repoPath: gateRepo,
        base: "main",
        branch,
        worktreePath: gateRepo,
        repoPathForProfile: gateRepo,
      });
      const gate = log
        .readAllEvents()
        .find((e) => e.type === "merge_gate_evaluated") as unknown as Record<string, unknown>;
      assert.equal(
        gate["environmentId"],
        undefined,
        "**立てていない環境の envId を埋めている**（分からないものを埋めると証拠が嘘になる）"
      );
      assert.equal(gate["environmentDigest"], undefined);
    } finally {
      log.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("[表示] kobo.task が envId と指紋を取り違えない形で出す", () => {
  let tmpDir: string;
  let repoDir: string;
  let dataDir: string;
  let daemon: Daemon;
  let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

  function rebindTools(): void {
    const tools = createKoboTools(daemon);
    call = async (name, args) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`no tool: ${name}`);
      const r = await t.execute(args as never, { toolCallId: "t" });
      return (r.details ?? {}) as Record<string, unknown>;
    };
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-env-display-"));
    repoDir = path.join(tmpDir, "repo");
    dataDir = path.join(tmpDir, "data");
    fs.mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "t@example.com"], repoDir);
    git(["config", "user.name", "t"], repoDir);
    fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
    git(["add", "."], repoDir);
    git(["commit", "-m", "init"], repoDir);

    daemon = Daemon.create({
      port: 0,
      dataDir,
      tickIntervalMs: 99999,
      disableAutoSpawn: true,
      disableAuditSpawn: true,
      disableMergeQueue: true,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    });
    await daemon.start();
    daemon.registerProject(PROJ, repoDir);
    rebindTools();
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("envId が付いた新しい記録は「env <envId>／指紋 <digest>」と、取り違えない形で出す", async () => {
    const id = "task-6010";
    daemon.createTask(PROJ, id, id, {
      kind: "fix",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動く" }],
    });

    // 帳簿へ直に書くので、まず daemon を止める（二重の書き手にしない）
    await daemon.stop();

    // 帳簿へ直に、本物のゲートが刻む形の merge_gate_evaluated を積む
    const log = EventLog.open(dataDir);
    log.append({
      type: "merge_gate_evaluated",
      projectTag: PROJ,
      taskId: id,
      passed: true,
      reasons: [],
      logPaths: [],
      environmentId: "env-03a6b9ce17",
      environmentDigest: "04b7a6595c58",
    });
    log.close();

    // 帳簿を読み直す（再起動と同じ道）
    daemon = Daemon.create({
      port: 0, dataDir, tickIntervalMs: 99999,
      disableAutoSpawn: true, disableAuditSpawn: true, disableMergeQueue: true,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    });
    await daemon.start();
    rebindTools();

    daemon.transition(PROJ, id, "queued", "テスト：進める");

    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    const history = d["history"] as Array<{ type: string; detail?: string }>;
    const gateLine = history.find((h) => h.type === "merge_gate_evaluated");
    assert.ok(gateLine, "merge_gate_evaluated が経緯に出ていない");

    assert.match(gateLine!.detail ?? "", /env env-03a6b9ce17/, "envId が読める形で出ていない");
    assert.match(gateLine!.detail ?? "", /指紋 04b7a6595c58/, "指紋が読める形で出ていない");

    // **要点**：事故の再現条件——別々の envId でも指紋が同じなら、旧表示は同じ文字列
    // だった（［env 04b7a6595c58］）。新しい表示はこの文字列そのものを出さないこと
    assert.doesNotMatch(
      gateLine!.detail ?? "",
      /［env 04b7a6595c58］/,
      "envId と指紋が取り違えられる旧表示のまま——「env」が指紋に掛かって見える"
    );
  });

  it("envId が無い古い記録は、指紋だけを「指紋」と明示して出す（envId に掛けない）", async () => {
    const id = "task-6011";
    daemon.createTask(PROJ, id, id, {
      kind: "fix",
      scope: { paths: ["src/**"] },
      acceptance: [{ id: "a1", text: "動く" }],
    });

    // 帳簿へ直に書くので、まず daemon を止める（二重の書き手にしない）
    await daemon.stop();

    const log = EventLog.open(dataDir);
    // realign 第2便当時の帳簿の形（environmentId を持たない）をそのまま再現する
    log.append({
      type: "merge_gate_evaluated",
      projectTag: PROJ,
      taskId: id,
      passed: false,
      reasons: ["verify_failed:a1(exit=127)"],
      logPaths: [],
      environmentDigest: "04b7a6595c58",
    });
    log.close();

    daemon = Daemon.create({
      port: 0, dataDir, tickIntervalMs: 99999,
      disableAutoSpawn: true, disableAuditSpawn: true, disableMergeQueue: true,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
    });
    await daemon.start();
    rebindTools();

    daemon.transition(PROJ, id, "queued", "テスト：進める");

    const d = await call("kobo.task", { projectTag: PROJ, taskId: id });
    const history = d["history"] as Array<{ type: string; detail?: string }>;
    const gateLine = history.find((h) => h.type === "merge_gate_evaluated");
    assert.ok(gateLine, "merge_gate_evaluated が経緯に出ていない");

    assert.match(gateLine!.detail ?? "", /指紋 04b7a6595c58/, "指紋が読める形で出ていない");
    assert.doesNotMatch(
      gateLine!.detail ?? "",
      /env 04b7a6595c58/,
      "「env」という語が指紋に掛かって見えている——envId と取り違えられる"
    );
  });
});
