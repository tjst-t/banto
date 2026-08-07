/**
 * task-0071: 検証の**時間切れ**は「判断」ではなく「事故」（PO裁定 2026-08-07）。
 *
 * ## 何が起きていたか（実機・loamium/task-0002）
 *
 * ```
 * task_failed — merge_gate_failed: verify_failed:a3(exit=124)
 * ```
 *
 * `exit=124` は時間切れ。**`verifyTimeoutMs` は daemon から一度も渡されておらず、常に
 * 既定の 60 秒**だった——検証コマンドはテスト一式そのものなので、1分で足りるわけがない。
 *
 * **同じ問いは既に裁定済みだった。** 検証環境側は 2026-08-01 に「既定30秒では npm test が
 * 途中で切れていた」として既定10分・上限60分に直している（spec-environment §5.1）。
 * ゲート側だけ取り残されていた。
 *
 * ## ここで確かめること
 *
 * 1. 時間切れなら**上限まで倍にして1回やり直す**（監査人が落ちたときと同じ扱い）
 * 2. **テストが落ちた（exit≠124）ものはやり直さない**——それは検証が出した判定であって、
 *    二度走らせても同じことを二度言われるだけ
 * 3. 上限まで駄目なら、**何分待ったのか**まで理由に残す（番頭が読んで判断できるように）
 *
 * 本物の git リポジトリと本物の子プロセスで見る（偽物では時間切れが再現しない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import {
  DEFAULT_VERIFY_TIMEOUT_MINUTES,
  MAX_VERIFY_TIMEOUT_MINUTES,
  loadProjectConfig,
} from "../../packages/banto-daemon/src/review-policy.js";
import { EventLog } from "../../packages/banto-core/src/index.js";
import { hostVerifyRunner } from "./gate-verify-runner.js";

let repoDir: string;
let dataDir: string;
let base: string;
let branch: string;

function setupRepo(dir: string): { base: string; branch: string } {
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "main.ts"), "// initial\n");
  git("add", "-A");
  git("commit", "-m", "initial");
  git("checkout", "-b", "task-branch");
  fs.writeFileSync(path.join(dir, "src", "work.ts"), "// work\n");
  git("add", "-A");
  git("commit", "-m", "feat");
  return { base: "main", branch: "task-branch" };
}

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-timeout-repo-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-timeout-data-"));
  ({ base, branch } = setupRepo(repoDir));
  execFileSync("git", ["checkout", branch], { cwd: repoDir, stdio: "pipe" });
});

after(() => {
  for (const d of [repoDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
});

function taskWith(id: string, verify: string): Record<string, unknown> {
  return {
    id,
    projectTag: "proj-timeout",
    status: "merging",
    title: `検証 ${id}`,
    scope: { paths: ["src/**"] },
    acceptance: [{ id: "a1", text: "動くこと", verify }],
  };
}

describe("[task-0071] 時間切れは事故として扱う（やり直す）", () => {
  it("延ばせば通る検証は、延ばして通る", async () => {
    const log = EventLog.open(dataDir);
    // 1回目は 200ms で切られ、やり直しは**上限まで一気に**（倍ではない）。
    // 混んでいる機械でも通るよう、上限は余裕を持って取る
    const result = await runMergeGate(log, taskWith("task-stretch", "sleep 0.5") as never, {
      dataDir,
      repoPath: repoDir,
      base,
      branch,
      worktreePath: repoDir,

      verifyRunner: hostVerifyRunner(),

      repoPathForProfile: repoDir,
      verifyTimeoutMs: 200,
      maxVerifyTimeoutMs: 60_000,
    });

    assert.equal(
      result.passed,
      true,
      `延ばせば通るのに落ちている: ${JSON.stringify(result.reasons)}`
    );
  });

  it("上限まで延ばしても駄目なら落ちる。**何分待ったか**が理由に残る（I2）", async () => {
    const log = EventLog.open(dataDir);
    const result = await runMergeGate(log, taskWith("task-too-slow", "sleep 30") as never, {
      dataDir,
      repoPath: repoDir,
      base,
      branch,
      worktreePath: repoDir,

      verifyRunner: hostVerifyRunner(),

      repoPathForProfile: repoDir,
      verifyTimeoutMs: 300,
      maxVerifyTimeoutMs: 600,
    });

    assert.equal(result.passed, false);
    const reason = result.reasons.join(" ");
    assert.match(reason, /verify_timeout:a1/, "時間切れを他の失敗と混ぜない");
    assert.match(reason, /待っても終わらず/, "何が起きたかが日本語で読める");
    assert.match(reason, /延長済み/, "延ばしたうえで駄目だったことが残る");
    // exit=124 のままだと「テストが落ちた」と読める
    assert.doesNotMatch(reason, /verify_failed:a1/, "時間切れを verify_failed と書かない");
  });

  it("**テストが落ちたものはやり直さない**（判定を二度取りに行かない）", async () => {
    const log = EventLog.open(dataDir);
    const marker = path.join(dataDir, "runs.txt");
    fs.writeFileSync(marker, "");
    const result = await runMergeGate(
      log,
      taskWith("task-real-fail", `echo x >> ${marker}; exit 1`) as never,
      {
        dataDir,
        repoPath: repoDir,
        base,
        branch,
        worktreePath: repoDir,

        verifyRunner: hostVerifyRunner(),

        repoPathForProfile: repoDir,
        verifyTimeoutMs: 5000,
        maxVerifyTimeoutMs: 60_000,
      }
    );

    assert.equal(result.passed, false);
    assert.match(result.reasons.join(" "), /verify_failed:a1\(exit=1\)/);
    assert.equal(
      fs.readFileSync(marker, "utf-8").trim().split("\n").length,
      1,
      "落ちたテストを二度走らせている（判定は事故ではない）"
    );
  });

  it("既に上限のときは、延ばさずに落ちる（際限なく粘らない）", async () => {
    const log = EventLog.open(dataDir);
    const marker = path.join(dataDir, "runs2.txt");
    fs.writeFileSync(marker, "");
    const result = await runMergeGate(
      log,
      taskWith("task-at-max", `echo x >> ${marker}; sleep 30`) as never,
      {
        dataDir,
        repoPath: repoDir,
        base,
        branch,
        worktreePath: repoDir,

        verifyRunner: hostVerifyRunner(),

        repoPathForProfile: repoDir,
        verifyTimeoutMs: 300,
        maxVerifyTimeoutMs: 300,
      }
    );

    assert.equal(result.passed, false);
    assert.equal(
      fs.readFileSync(marker, "utf-8").trim().split("\n").length,
      1,
      "上限に達しているのに延ばして走らせている"
    );
  });
});

describe("[task-0071] 制限時間は層B設定（meta/config.yaml）", () => {
  it("既定は分の単位（検証環境側の裁定と同じ数字）", () => {
    // spec-environment §5.1 と揃える。同じ問いに2つの答えを作らない
    assert.equal(DEFAULT_VERIFY_TIMEOUT_MINUTES, 10);
    assert.equal(MAX_VERIFY_TIMEOUT_MINUTES, 60);
  });

  it("設定した値が読める", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-"));
    try {
      fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta", "config.yaml"),
        "limits:\n  verify_timeout_minutes: 25\n",
        "utf-8"
      );
      assert.equal(loadProjectConfig(dir).limits.verifyTimeoutMinutes, 25);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("上限を超える指定は黙って丸めず断る（I2）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-over-"));
    try {
      fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta", "config.yaml"),
        "limits:\n  verify_timeout_minutes: 120\n",
        "utf-8"
      );
      assert.throws(
        () => loadProjectConfig(dir),
        /上限は 60 分/,
        "丸めると「30分待つ設定にした」と思い込んだまま切られる"
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("数として読めないものは黙って無視しない（I2）", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-cfg-bad-"));
    try {
      fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta", "config.yaml"),
        "limits:\n  verify_timeout_minutes: たっぷり\n",
        "utf-8"
      );
      assert.throws(() => loadProjectConfig(dir), /正の数/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
