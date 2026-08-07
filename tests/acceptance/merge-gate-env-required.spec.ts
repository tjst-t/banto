/**
 * task-0075: **Kobo は検証環境を必須にする**（PO裁定 2026-08-07）。
 *
 * ## なぜ
 *
 * ホストで検証を走らせると、**ホストの状態が検証結果に混ざる**。実際に混ざった（inc-0032）：
 *
 * - banto の Kobo が 127.0.0.1:3000 に居座っていたせいで、loamium のテストが1件、
 *   **永久に落ちていた**（「3000番に何も居ないこと」を確かめる検査）
 * - 機械に `make` が入っていなかったせいで3件落ちていた
 *
 * どちらも loamium のコード欠陥ではないのに、`verify_failed` として返る——
 * **「loamium のテストが壊れている」と読める形で失敗する**のが一番たちが悪い。
 *
 * ## ここで見る不変条件
 *
 * **検証環境へ届かないなら、ゲートは通さない。** ホストへ落とす道を残すと、
 * いちばん静かに壊れる形（「たまたま通った」）に戻る。確かめていないものを
 * 「確かめた」にしない（I1・I2）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import { EventLog } from "../../packages/banto-core/src/index.js";
import { hostVerifyRunner } from "./gate-verify-runner.js";

let repoDir: string;
let dataDir: string;

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-env-req-repo-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-env-req-data-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "main.ts"), "// initial\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  git("checkout", "-b", "task-branch");
  fs.writeFileSync(path.join(repoDir, "src", "work.ts"), "// work\n");
  git("add", "-A");
  git("commit", "-m", "feat");
  git("checkout", "task-branch");
});

after(() => {
  for (const d of [repoDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

function task(id: string, verify?: string): Record<string, unknown> {
  return {
    id,
    projectTag: "proj-env-req",
    status: "merging",
    title: `検証 ${id}`,
    scope: { paths: ["src/**"] },
    acceptance: [{ id: "a1", text: "動くこと", ...(verify ? { verify } : {}) }],
  };
}

const gateOpts = {
  dataDir: "",
  repoPath: "",
  base: "main",
  branch: "task-branch",
  worktreePath: "",
};

describe("[task-0075] 検証環境が無ければゲートは通らない", () => {
  it("**検証を回す場所が無いと通らない**（ホストへ落とさない）", async () => {
    const log = EventLog.open(dataDir);
    // verifyRunner を渡さない＝Kobo に検証環境が配線されていない状態
    const result = await runMergeGate(log, task("task-no-runner", "true") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
    });

    assert.equal(result.passed, false, "検証環境が無いのに通っている（ホストへ落ちている）");
    assert.match(result.reasons.join(" "), /verify_runner_missing/);
  });

  it("環境が立たないときは「確かめていない」と言う（テストが落ちたことにしない）", async () => {
    const log = EventLog.open(dataDir);
    const result = await runMergeGate(log, task("task-no-env", "true") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: hostVerifyRunner({ failProvision: "プロファイル test がありません" }),
      verifyProfile: "test",
    });

    assert.equal(result.passed, false);
    const reason = result.reasons.join(" ");
    assert.match(reason, /verify_env_unavailable:test/, "どのプロファイルが無いのかが出る");
    assert.match(reason, /プロファイル test がありません/, "理由が残る（I2）");
    // **「テストが落ちた」と読める形にしない**
    assert.doesNotMatch(reason, /verify_failed/);
  });

  it("検証コマンドが1本も無ければ、環境は立てない（要らないものを立てない）", async () => {
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();
    const result = await runMergeGate(log, task("task-no-verify") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: runner,
    });

    assert.equal(result.passed, true, `落ちている: ${JSON.stringify(result.reasons)}`);
    assert.deepEqual(runner.provisioned, [], "走らせるものが無いのに環境を立てている");
  });

  it("立てた環境は必ず畳む。**複数の検証でも立てるのは1回**（I3）", async () => {
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();
    const many = {
      ...task("task-many"),
      acceptance: [
        { id: "a1", text: "1", verify: "true" },
        { id: "a2", text: "2", verify: "true" },
        { id: "a3", text: "3", verify: "true" },
      ],
    };
    const result = await runMergeGate(log, many as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: runner,
    });

    assert.equal(result.passed, true, `落ちている: ${JSON.stringify(result.reasons)}`);
    assert.equal(runner.provisioned.length, 1, "受け入れ条件ごとに環境を立て直している");
    assert.deepEqual(runner.tornDown, runner.provisioned, "立てた環境を畳んでいない（I3）");
    assert.equal(runner.ran.length, 3, "3本とも走らせていない");
  });

  it("検証が落ちても環境は畳む（途中で抜けても漏らさない・I3）", async () => {
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();
    const result = await runMergeGate(log, task("task-fail-teardown", "exit 1") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: runner,
    });

    assert.equal(result.passed, false);
    assert.deepEqual(runner.tornDown, runner.provisioned, "落ちたときに環境が残っている（I3）");
  });

  it("検証は**worktree の中**で回る（ホストのどこかではない）", async () => {
    const log = EventLog.open(dataDir);
    const runner = hostVerifyRunner();
    // worktree にしか無いファイルを見に行く検証
    await runMergeGate(log, task("task-cwd", "test -f src/work.ts") as never, {
      ...gateOpts,
      dataDir,
      repoPath: repoDir,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: runner,
    });
    assert.equal(runner.ran.length, 1);
    assert.equal(runner.ran[0]!.cmd, "test -f src/work.ts");
  });
});
