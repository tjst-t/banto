/**
 * [task-0219] マージ前ゲートは、**同じ検証コマンドを1回だけ**走らせる。
 *
 * 何が起きていたか（実測）：ゲートは受け入れ条件の本数ぶん検証コマンドを走らせていた。
 * task-0165 は a1〜a12 の12本すべてが全量 `npm test`（1本 4.85〜6.04分）で、12本＝約64分。
 * 検証環境（test プロファイル）の寿命は 45分で進捗による延長は無いため、3周まわして
 * **一度も判定に到達しなかった**（`merge_gate_evaluated` が1件も無い）。
 *
 * 同じコミット・同じ環境で同じコマンドを12回回せば12回とも同じ答えが返る——費用だけ12倍で、
 * 得られる情報は1倍。だから**走らせる回数だけを畳む**。畳んでよいのは実行であって、
 * **記録ではない**：条件ごとの合否は全件そろって残らなければ、後から
 * 「何をもって通した（落とした）のか」を条件の単位で言えなくなる。
 *
 * ここが見るもの：
 *   1. 同じコマンドの条件が何本あっても、検証環境で走るのは1回だけ
 *   2. その1回の結果が全条件へ配られ、`verifyResults` には acId が全件並ぶ（ログも読める）
 *   3. コマンドが違う条件は、これまでどおり別々に走る
 *   4. 束ねた1回が落ちたら、そのコマンドを持つ全条件が不合格になり、ゲートは通らない
 *
 * 検証環境は `hostVerifyRunner`（試験専用の偽物）。ここで見たいのは**ゲートの筋道**
 * ——何回走らせたか——であって、検証環境の実体ではない。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { runMergeGate } from "@banto/daemon";
import { EventLog } from "@banto/core";
import type { MergeGateEvaluatedEvent } from "@banto/core";
import { hostVerifyRunner } from "./gate-verify-runner.js";

// ── Git fixture ───────────────────────────────────────────────────────────────

/** main の初期コミットと、scope 内に1ファイル足したタスクブランチを作る。 */
function setupSimpleRepo(repoDir: string, taskId: string): { base: string; branch: string } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");

  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "main.ts"), "// initial\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  const branchName = `${taskId}-branch`;
  git("checkout", "-b", branchName);
  fs.writeFileSync(path.join(repoDir, "src", `${taskId}.ts`), `// ${taskId}\n`);
  git("add", "-A");
  git("commit", "-m", `feat: ${taskId}`);
  git("checkout", branchName);

  return { base: "main", branch: branchName };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("[task-0219] マージ前ゲートは同じ検証コマンドを1回だけ走らせる", () => {
  const tempDirs: string[] = [];

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  // 各 it が自分の repo / dataDir を作る（互いの gate-logs を混ぜない）
  after(() => {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it("[a1] 同じ検証コマンドの受け入れ条件が3本あっても、検証環境で走るのは1回だけ", async () => {
    const taskId = "task-dedupe-same";
    const repo = makeTempDir("banto-dedupe-same-repo-");
    const dataDir = makeTempDir("banto-dedupe-same-data-");
    const { base, branch } = setupSimpleRepo(repo, taskId);
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();

    const command = 'sh -c "exit 0"';
    const task = {
      id: taskId,
      projectTag: "proj-dedupe",
      status: "merging",
      title: "同じコマンドが3本",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "1本目", verify: command },
        { id: "a2", text: "2本目", verify: command },
        { id: "a3", text: "3本目", verify: command },
      ],
    };

    const result = await runMergeGate(log, task, {
      dataDir,
      repoPath: repo,
      base,
      branch,
      worktreePath: repo,
      verifyRunner: runner,
      repoPathForProfile: repo,
    });

    assert.equal(result.passed, true, `ゲートは通ること: ${JSON.stringify(result.reasons)}`);
    assert.equal(
      runner.ran.length,
      1,
      `同じコマンドは1回だけ走ること。実際に走ったもの: ${JSON.stringify(runner.ran.map((r) => r.cmd))}`
    );
    assert.equal(runner.ran[0]!.cmd, command, "走ったのはその検証コマンドであること");
    // 環境を立てるのも1回（既存の性質。畳んだせいで壊していないことの確認）
    assert.equal(runner.provisioned.length, 1, "検証環境を立てるのは1回だけ");
    assert.equal(runner.tornDown.length, 1, "立てた環境は畳むこと（I3）");
  });

  it("[a2] 束ねた1回の結果が全条件へ配られ、証拠には条件が全件そろって残る", async () => {
    const taskId = "task-dedupe-evidence";
    const repo = makeTempDir("banto-dedupe-evi-repo-");
    const dataDir = makeTempDir("banto-dedupe-evi-data-");
    const { base, branch } = setupSimpleRepo(repo, taskId);
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();

    const command = 'sh -c "exit 0"';
    const acIds = ["a1", "a2", "a3", "a4"];
    const task = {
      id: taskId,
      projectTag: "proj-dedupe",
      status: "merging",
      title: "同じコマンドが4本",
      scope: { paths: ["src/**"] },
      acceptance: acIds.map((id) => ({ id, text: `${id} の中身`, verify: command })),
    };

    const result = await runMergeGate(log, task, {
      dataDir,
      repoPath: repo,
      base,
      branch,
      worktreePath: repo,
      verifyRunner: runner,
      repoPathForProfile: repo,
    });

    assert.equal(runner.ran.length, 1, "走ったのは1回だけ");

    // **畳んだせいで欠けない**：acId は全件そろっていること
    assert.deepEqual(
      result.verifyResults.map((r) => r.acId).sort(),
      [...acIds].sort(),
      `verifyResults には条件が全件並ぶこと: ${JSON.stringify(result.verifyResults)}`
    );

    for (const acId of acIds) {
      const vr = result.verifyResults.find((r) => r.acId === acId);
      assert.ok(vr, `${acId} の結果があること`);
      assert.equal(vr!.command, command, `${acId} には検証コマンドが残ること`);
      assert.equal(vr!.exitCode, 0, `${acId} へ束ねた1回の終了コードが配られること`);
      assert.ok(vr!.logDirPath !== undefined, `${acId} のログの在り処が付くこと`);
      // 「その条件の検証ログが読めない」状態を作らないこと
      assert.ok(
        fs.existsSync(path.join(vr!.logDirPath!, "stdout.txt")),
        `${acId} の検証ログ（stdout.txt）が読めること: ${vr!.logDirPath}`
      );
    }

    // 束ねた側の条件も、自分の名前の置き場から実行を辿れること
    const logBaseDir = path.join(dataDir, "gate-logs", taskId);
    for (const acId of acIds.slice(1)) {
      const pointer = path.join(logBaseDir, acId, "shared-run.txt");
      assert.ok(fs.existsSync(pointer), `${acId} から束ねた実行を辿れること: ${pointer}`);
      const body = fs.readFileSync(pointer, "utf-8");
      assert.ok(
        body.includes(result.verifyResults.find((r) => r.acId === acId)!.logDirPath!),
        `${acId} の目印はログの在り処を指すこと: ${body}`
      );
    }

    // merge_gate_evaluated が刻まれ、参照されたログが実在すること
    const gateEvents = log.readAllEvents().filter((e) => e.type === "merge_gate_evaluated");
    assert.equal(gateEvents.length, 1, "merge_gate_evaluated はちょうど1件");
    const gateEvt = gateEvents[0] as MergeGateEvaluatedEvent;
    assert.equal(gateEvt.passed, true, "ゲートは通ったと刻まれること");
    assert.ok(gateEvt.logPaths.length > 0, "ログの参照が刻まれること");
    for (const p of gateEvt.logPaths) {
      assert.ok(fs.existsSync(p), `刻まれたログの在り処は実在すること: ${p}`);
    }
  });

  it("[a3] 検証コマンドが違う受け入れ条件は、これまでどおり別々に走る", async () => {
    const taskId = "task-dedupe-distinct";
    const repo = makeTempDir("banto-dedupe-dist-repo-");
    const dataDir = makeTempDir("banto-dedupe-dist-data-");
    const { base, branch } = setupSimpleRepo(repo, taskId);
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();

    const shared = 'sh -c "exit 0"';
    const other = 'sh -c "echo other"';
    const task = {
      id: taskId,
      projectTag: "proj-dedupe",
      status: "merging",
      title: "同じのが2本と、違うのが1本",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "共有1", verify: shared },
        { id: "a2", text: "別のコマンド", verify: other },
        { id: "a3", text: "共有2", verify: shared },
        { id: "a4", text: "コマンド無し" },
      ],
    };

    const result = await runMergeGate(log, task, {
      dataDir,
      repoPath: repo,
      base,
      branch,
      worktreePath: repo,
      verifyRunner: runner,
      repoPathForProfile: repo,
    });

    assert.equal(result.passed, true, `ゲートは通ること: ${JSON.stringify(result.reasons)}`);
    // 違うコマンドは畳まない。走る順は最初に現れた条件の順（a1 の shared → a2 の other）
    assert.deepEqual(
      runner.ran.map((r) => r.cmd),
      [shared, other],
      "違うコマンドは別々に、最初に現れた順で走ること"
    );

    // コマンドを持たない条件も含めて、記録は全件
    assert.deepEqual(
      result.verifyResults.map((r) => r.acId).sort(),
      ["a1", "a2", "a3", "a4"],
      `verifyResults には条件が全件並ぶこと: ${JSON.stringify(result.verifyResults)}`
    );
    const a4 = result.verifyResults.find((r) => r.acId === "a4");
    assert.equal(a4!.exitCode, null, "検証コマンドを持たない条件は走らせるものが無いまま");

    // 束ねた a1/a3 は同じ実行を指し、a2 は自分の実行を持つ
    const a1 = result.verifyResults.find((r) => r.acId === "a1")!;
    const a2 = result.verifyResults.find((r) => r.acId === "a2")!;
    const a3 = result.verifyResults.find((r) => r.acId === "a3")!;
    assert.equal(a3.logDirPath, a1.logDirPath, "同じコマンドの条件は同じ実行を指すこと");
    assert.notEqual(a2.logDirPath, a1.logDirPath, "違うコマンドの条件は別の実行を指すこと");
  });

  it("[a4] 束ねた1回が落ちたら、そのコマンドを持つ全条件が不合格になりゲートは通らない", async () => {
    const taskId = "task-dedupe-fail";
    const repo = makeTempDir("banto-dedupe-fail-repo-");
    const dataDir = makeTempDir("banto-dedupe-fail-data-");
    const { base, branch } = setupSimpleRepo(repo, taskId);
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();

    const failing = 'sh -c "exit 3"';
    const passing = 'sh -c "exit 0"';
    const task = {
      id: taskId,
      projectTag: "proj-dedupe",
      status: "merging",
      title: "束ねた1回が落ちる",
      scope: { paths: ["src/**"] },
      acceptance: [
        { id: "a1", text: "落ちる1", verify: failing },
        { id: "a2", text: "落ちる2", verify: failing },
        { id: "a3", text: "落ちる3", verify: failing },
        { id: "a4", text: "通る", verify: passing },
      ],
    };

    // StateMachine.fail が辿れるように、タスクの来歴を積んでおく
    log.append({
      type: "task_created",
      projectTag: "proj-dedupe",
      taskId,
      payload: {
        title: "束ねた1回が落ちる",
        scope: { paths: ["src/**"] },
        acceptance: [{ id: "a1", text: "落ちる1" }],
      },
    });
    log.append({
      type: "state_transitioned",
      projectTag: "proj-dedupe",
      taskId,
      from: "draft",
      to: "merging",
    });

    const result = await runMergeGate(log, task, {
      dataDir,
      repoPath: repo,
      base,
      branch,
      worktreePath: repo,
      verifyRunner: runner,
      repoPathForProfile: repo,
    });

    assert.equal(runner.ran.length, 2, "落ちる方は1回、通る方は1回——計2回");
    assert.equal(result.passed, false, "ゲートは通らないこと");

    for (const acId of ["a1", "a2", "a3"]) {
      const vr = result.verifyResults.find((r) => r.acId === acId);
      assert.ok(vr, `${acId} の結果があること`);
      assert.equal(vr!.exitCode, 3, `${acId} にも落ちた終了コードが配られること`);
      assert.ok(
        result.reasons.some((r) => r.includes(`verify_failed:${acId}`)),
        `${acId} が不合格として理由に残ること: ${JSON.stringify(result.reasons)}`
      );
    }
    const a4 = result.verifyResults.find((r) => r.acId === "a4");
    assert.equal(a4!.exitCode, 0, "違うコマンドの条件は道連れにしないこと");
    assert.ok(
      !result.reasons.some((r) => r.includes("verify_failed:a4")),
      `a4 は不合格にしないこと: ${JSON.stringify(result.reasons)}`
    );

    // 証拠にも、落ちた条件が全件そろっていること
    const gateEvents = log.readAllEvents().filter((e) => e.type === "merge_gate_evaluated");
    assert.equal(gateEvents.length, 1, "merge_gate_evaluated はちょうど1件");
    const gateEvt = gateEvents[0] as MergeGateEvaluatedEvent;
    assert.equal(gateEvt.passed, false, "通らなかったと刻まれること");
    for (const acId of ["a1", "a2", "a3"]) {
      assert.ok(
        gateEvt.reasons.some((r) => r.includes(`verify_failed:${acId}`)),
        `証拠に ${acId} の不合格が残ること: ${JSON.stringify(gateEvt.reasons)}`
      );
    }
  });
});
