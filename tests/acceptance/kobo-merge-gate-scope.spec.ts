/**
 * マージ前ゲートの守りを狭める（task-0274 / PO裁定 2026-08-17）。
 *
 * ## 背景
 *
 * banto のフル npm test は5〜6分（2700超テスト）。マージキューは直列なので、タスクごとに
 * フル回帰を払うと累積で待ちが大きい。banto は main の .ts を直読みし、**再起動で
 * 反映**される——マージ ≠ 反映なので、フル回帰は起こし直し（デプロイ）の前に1回走らせれば
 * 足りる。
 *
 * だから2段構えにする:
 * 1. マージ前ゲート = 変更対象 spec + typecheck のみ（フル回帰は走らせない）
 * 2. デプロイゲート = 起こし直しの直前に main に対して npm test 一斉（`system.deploy`）
 *
 * この試験は段1の側——マージ前ゲートが**フルスイート相当（npm test / test:all 等）**を
 * verify に持つとき、**明示的な警告**を残すことを固定する（a1）。警告は通しを変えない
 * ——PO が「やはり回す」と承認できる情報として残す。フルを回さない限定（test:one /
 * typecheck）は警告の対象にならない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runMergeGate, isFullSuiteCommand } from "@banto/daemon";
import { EventLog } from "@banto/core";

function setupGitRepo(repoDir: string): { base: string; branch: string } {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");
  fs.mkdirSync(path.join(repoDir, "packages", "banto-daemon", "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "packages", "banto-daemon", "src", "a.ts"), "// initial\n");
  fs.writeFileSync(path.join(repoDir, "package.json"), '{ "name": "fixture" }\n');
  git("add", "-A");
  git("commit", "-m", "initial");
  git("checkout", "-b", "task-branch");
  fs.writeFileSync(path.join(repoDir, "packages", "banto-daemon", "src", "a.ts"), "// changed\n");
  git("add", "-A");
  git("commit", "-m", "task: change a.ts");
  return { base: "main", branch: "task-branch" };
}

type TaskRecord = {
  id: string;
  projectTag: string;
  status: string;
  title: string;
  scope: { paths: string[] };
  acceptance: Array<{ id: string; text: string; verify?: string }>;
};

/** フル回帰を**本当に回さない**検証ランナー。accepted のどれも pass にする。 */
function passingRunner() {
  let counter = 0;
  return {
    async provision() {
      counter += 1;
      return { envId: `fake-${counter}`, profileDigest: "digest-1" };
    },
    async run() {
      return { exit: 0, logTail: "ok" };
    },
    async teardown() {},
  };
}

describe("[task-0274] マージ前ゲートがフルスイートを持ち込んだとき、明示的な警告を残す（a1）", () => {
  let repoDir: string;
  let dataDir: string;
  let base: string;
  let branch: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-merge-scope-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-merge-scope-data-"));
    const refs = setupGitRepo(repoDir);
    base = refs.base;
    branch = refs.branch;
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function runTask(task: TaskRecord) {
    const log = EventLog.open(dataDir);
    log.append({
      type: "task_created",
      projectTag: task.projectTag,
      taskId: task.id,
      payload: { title: task.title, scope: task.scope, acceptance: task.acceptance },
    });
    log.append({
      type: "state_transitioned",
      projectTag: task.projectTag,
      taskId: task.id,
      from: "draft",
      to: "merging",
    });
    const gateResult = await runMergeGate(log, task, {
      dataDir,
      repoPath: repoDir,
      base,
      branch,
      worktreePath: repoDir,
      repoPathForProfile: repoDir,
      verifyRunner: passingRunner(),
    });
    const events = log.readAllEvents();
    const gateEvt = events.find(
      (e) => e.type === "merge_gate_evaluated"
    ) as Extract<(typeof events)[number], { type: "merge_gate_evaluated" }> | undefined;
    return { gateResult, gateEvt };
  }

  it("フルスイート（npm test）を含む verify に warning が立つ", async () => {
    const { gateResult, gateEvt } = await runTask({
      id: "task-full-1",
      projectTag: "proj",
      status: "merging",
      title: "full",
      scope: { paths: ["packages/banto-daemon/**"] },
      acceptance: [
        { id: "a1", text: "a1", verify: "npm test" },
        { id: "a2", text: "a2", verify: "npm run typecheck" },
      ],
    });
    assert.ok(
      gateResult.warnings.some((w) => w.includes("full_suite_verify:a1")),
      `a1（npm test）への警告がありません: ${JSON.stringify(gateResult.warnings)}`
    );
    assert.ok(
      !gateResult.warnings.some((w) => w.includes("full_suite_verify:a2")),
      `typecheck はフルスイートではないので警告が要りません: ${JSON.stringify(gateResult.warnings)}`
    );
    // 警告は event にも残る（遡れるように）
    assert.ok(
      gateEvt && gateEvt.warnings.some((w) => w.includes("full_suite_verify:a1")),
      "event にフルスイートの警告がありません"
    );
    // 警告が付いても通しは変えない（フル回帰を回しても害は無い）
    assert.equal(gateResult.passed, true, "警告はゲートの通しを変えてはいけない");
  });

  it("test:all もフルスイートの警告対象になる", async () => {
    const { gateResult } = await runTask({
      id: "task-full-2",
      projectTag: "proj",
      status: "merging",
      title: "full2",
      scope: { paths: ["packages/banto-daemon/**"] },
      acceptance: [{ id: "a1", text: "a1", verify: "npm run test:all" }],
    });
    assert.ok(
      gateResult.warnings.some((w) => w.includes("full_suite_verify:a1")),
      `test:all への警告がありません: ${JSON.stringify(gateResult.warnings)}`
    );
  });

  it("変更対象の限定（test:one / typecheck）は警告しない", async () => {
    const { gateResult } = await runTask({
      id: "task-scoped-1",
      projectTag: "proj",
      status: "merging",
      title: "scoped",
      scope: { paths: ["packages/banto-daemon/**"] },
      acceptance: [
        { id: "a1", text: "a1", verify: "npm run test:one tests/acceptance/x.spec.ts" },
        { id: "a2", text: "a2", verify: "npm run typecheck" },
      ],
    });
    assert.deepEqual(
      gateResult.warnings,
      [],
      `限定の verify に警告が付いてはいけません: ${JSON.stringify(gateResult.warnings)}`
    );
  });
});

describe("[task-0274] isFullSuiteCommand の判定（ユニット）", () => {
  it("npm test / npm run test / test:all / test:acceptance を拾う", () => {
    for (const cmd of ["npm test", "npm run test", "npm run test:all", "npm run test:acceptance"]) {
      assert.equal(isFullSuiteCommand(cmd), true, `${cmd} はフルスイートとして扱うべき`);
    }
  });

  it("test:one / typecheck / build は拾わない", () => {
    for (const cmd of [
      "npm run test:one tests/x.spec.ts",
      "npm run typecheck",
      "npm run build",
      "npm run typecheck:web",
    ]) {
      assert.equal(isFullSuiteCommand(cmd), false, `${cmd} はフルスイートではない`);
    }
  });
});
