/**
 * task-0287・ADR-0027: 監査を合否の門から「補助の目」へ。
 *
 * PO の言葉のまま：「監査はプラスアルファの層にする。監査のせいで工程が止まる方が、
 * いまは問題である。取りこぼしが出たら、そのとき別途直せばよい。」
 *
 * 3つの柱（①だけ入れて②を落とすと悪化するので、3つまとめて縛る）：
 *   ① 監査から全体走査・テスト実行を剥がし、diff を渡す（診断は「まず diff、
 *      足りなければ遡る」の順）——buildAuditInstruction（a5・a6・a10）
 *   ② 判定の口 audit_report を claude-agent 経路・pi 経路の両方で確実に載せる（a7）
 *   ③ 判定は「明示の fail だけがブロック」＝フェイルオープン（a1〜a4）
 *
 * 契約改訂 a11（PO裁定 2026-08-20）: 監査人が diff の外を読んだら理由を audit_verdict に
 * 残す（自己申告・I1：pass/fail の判断材料ではない）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import {
  Daemon,
  buildAuditInstruction,
  AUDIT_DIFF_MAX_LINES,
} from "../../packages/banto-daemon/src/daemon.js";
import { createAuditTools, DaemonClient } from "../../packages/banto-core/src/index.js";
import { CLAUDE_KOBO_TOOL_NAMES } from "../../packages/banto-worker-pool/src/claude-agent/naming.js";
import { createKoboChannel } from "../../packages/banto-worker-pool/src/claude-agent/kobo.js";
import type { TaskRecord } from "../../packages/banto-core/src/index.js";
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

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("待っていた状態にならなかった");
}

// ── ①・a5・a6・a10: buildAuditInstruction ────────────────────────────────────

const baseTask: TaskRecord = {
  id: "task-diff-1",
  status: "auditing",
  projectTag: "diffproj",
  title: "diff を渡す",
  kind: "feature",
  scope: { paths: ["src/**"] },
  acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
};

describe("[a5] buildAuditInstruction にそのタスクの diff が載る", () => {
  it("実際の変更が diff として本文に載る", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diff-small-"));
    try {
      initRepo(tmp);
      git(["checkout", "-b", "task/task-diff-1"], tmp);
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src", "marker.ts"), "export const MARKER_9F3A = 1;\n");
      git(["add", "."], tmp);
      git(["commit", "-m", "add marker"], tmp);

      const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
      assert.match(instruction, /## 差分（diff）/);
      assert.ok(instruction.includes("MARKER_9F3A"), "実際の変更内容が diff に載っていない");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("diff が上限を超えたら打ち切り、その旨とファイル名だけを載せる", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diff-big-"));
    try {
      initRepo(tmp);
      git(["checkout", "-b", "task/task-diff-1"], tmp);
      const bigContent = Array.from({ length: AUDIT_DIFF_MAX_LINES + 500 }, (_, i) => `line ${i}`).join(
        "\n"
      );
      fs.writeFileSync(path.join(tmp, "big.txt"), bigContent + "\n");
      git(["add", "."], tmp);
      git(["commit", "-m", "add big file"], tmp);

      const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
      assert.match(instruction, /打ち切りました/, "打ち切ったことが書かれていない");
      assert.ok(instruction.includes(`${AUDIT_DIFF_MAX_LINES}`), "上限値が書かれていない");
      assert.ok(instruction.includes("big.txt"), "残りの変更ファイル名が載っていない");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("diff が取れなかったときは、取れなかったと書かれる（黙って空を渡さない・I2）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diff-none-"));
    try {
      // git リポジトリではないディレクトリ（ワークツリーがまだ無い状態を模す）
      fs.mkdirSync(tmp, { recursive: true });
      const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
      assert.match(instruction, /diff を取得できませんでした/);
      // I2: 黙って空にせず、従来どおりワークツリーを見てよいと案内する
      assert.ok(instruction.includes(tmp), "代わりの確かめ方（ワークツリーパス）が案内されていない");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("[a6] テストを回すのは監査人の仕事ではなく、全体走査を既定にしない", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diff-a6-"));
  before(() => {
    initRepo(tmp);
    git(["checkout", "-b", "task/task-diff-1"], tmp);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("「テストを回すのはあなたの仕事ではない」旨が書かれている", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    assert.match(instruction, /テストを回すのはあなたの仕事ではありません/);
  });

  it("「ワークツリーへ移動して実装内容を確認せよ」に相当する全体走査の指示が無い", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    assert.ok(
      !instruction.includes("に移動して実装内容を確認してください"),
      "全体走査の指示がまだ残っている"
    );
    assert.ok(
      !instruction.includes("scope.paths に指定されたファイルが存在し、acceptance criteria を満たしているか検証してください"),
      "全体走査相当の指示がまだ残っている"
    );
  });
});

describe("[a10] 監査手順が「まず diff→足りなければ遡る」の順で読める", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-diff-a10-"));
  before(() => {
    initRepo(tmp);
    git(["checkout", "-b", "task/task-diff-1"], tmp);
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("3段がこの順で読める：まず diff→diff だけで判断できるなら判定→判断できないときだけ遡る", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    const step1 = instruction.indexOf("まず diff を読んでください");
    const step2 = instruction.indexOf("diff だけで受け入れ基準を満たすか判断できるなら");
    const step3 = instruction.indexOf("判断できないときだけ");
    assert.ok(step1 >= 0 && step2 >= 0 && step3 >= 0, "3段のどれかが見つからない");
    assert.ok(step1 < step2 && step2 < step3, "3段の順序が逆転している");
  });

  it("ファイルを読むことを禁じていない", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    assert.match(
      instruction,
      /ファイルを読むこと自体は禁じません/,
      "ファイルを読むこと自体を禁じてしまっている（diff だけでは判断できない変更で嘘をつく）"
    );
  });

  it("リポジトリを読み直すことを既定にしていない（最初の一手が diff）", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    const step1Text = instruction.slice(
      instruction.indexOf("## 監査手順"),
      instruction.indexOf("## 監査チェックリスト")
    );
    assert.match(step1Text.split("\n").find((l) => l.startsWith("1.")) ?? "", /diff/);
  });

  it("diff の外を読んだら consultedBeyondDiff に理由を書くよう明記されている（a11）", () => {
    const instruction = buildAuditInstruction(baseTask, "diffproj", "task-diff-1", tmp);
    assert.match(instruction, /consultedBeyondDiff/);
  });
});

// ── ②・a7: 判定の口 audit_report が両経路に確実に載る ────────────────────────

describe("[a7] 判定の口 audit_report が claude-agent 経路・pi 経路の両方に確実に載る", () => {
  it("pi 経路: createAuditTools は常に audit_report を返す（role による分岐が無い）", () => {
    const client = new DaemonClient("http://127.0.0.1:1");
    const toolNames = createAuditTools(client).map((t) => t.name);
    assert.ok(toolNames.includes("audit_report"), "pi 経路に audit_report が無い");
  });

  it("pi 経路: banto-auditor 拡張は常に audit_report を registerTool する", async () => {
    const savedProject = process.env["BANTO_PROJECT"];
    const savedTask = process.env["BANTO_TASK_ID"];
    process.env["BANTO_PROJECT"] = "proj-a7";
    process.env["BANTO_TASK_ID"] = "task-a7:audit";
    try {
      const { default: auditorExtension } = await import(
        "../../packages/banto-daemon/src/pi-extension/banto-auditor.js"
      );
      const registered: Array<{ name: string }> = [];
      auditorExtension({
        registerTool(tool: { name: string }) {
          registered.push(tool);
        },
        on() {
          /* no-op */
        },
      });
      assert.ok(
        registered.some((t) => t.name === "audit_report"),
        `audit_report が登録されていない: ${JSON.stringify(registered.map((t) => t.name))}`
      );
    } finally {
      if (savedProject === undefined) delete process.env["BANTO_PROJECT"];
      else process.env["BANTO_PROJECT"] = savedProject;
      if (savedTask === undefined) delete process.env["BANTO_TASK_ID"];
      else process.env["BANTO_TASK_ID"] = savedTask;
    }
  });

  it("claude-agent 経路: naming.ts の口の名前一覧に audit_report が含まれ、絞り込みで消えない対象になっている", () => {
    assert.ok(
      CLAUDE_KOBO_TOOL_NAMES.includes("mcp__banto__audit_report"),
      "CLAUDE_KOBO_TOOL_NAMES に audit_report が無い——絞り込みで消える経路ができる"
    );
  });

  it("claude-agent 経路: createKoboChannel は役目（executor/audit）に関わらず口を作る", () => {
    // 役目の接尾辞は Kobo 側で外すだけで、口の有無そのものは役目を見ない
    // （host.ts の `kobo ? [report_phase, report_done, audit_report] : []` も role 分岐が無い）
    const auditEnv = {
      BANTO_DAEMON_URL: "http://127.0.0.1:1",
      BANTO_PROJECT: "proj-a7",
      BANTO_TASK_ID: "task-a7:audit",
    };
    const executorEnv = {
      BANTO_DAEMON_URL: "http://127.0.0.1:1",
      BANTO_PROJECT: "proj-a7",
      BANTO_TASK_ID: "task-a7",
    };
    const auditChannel = createKoboChannel(auditEnv);
    const executorChannel = createKoboChannel(executorEnv);
    assert.ok(auditChannel, "監査役に工場の口が作られない");
    assert.ok(executorChannel, "実装役に工場の口が作られない");
    assert.equal(typeof auditChannel!.auditReport, "function");
  });

  it("claude-agent 経路: host.ts のソースで、audit_report が report_phase/report_done と同じ kobo ゲートの中にあり、role で別扱いされていない", () => {
    const hostPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "packages",
      "banto-worker-pool",
      "src",
      "claude-agent",
      "host.ts"
    );
    const src = fs.readFileSync(hostPath, "utf-8");
    const koboBlockStart = src.indexOf("...(kobo");
    assert.ok(koboBlockStart >= 0, "kobo ゲートのブロックが見つからない");
    // report_phase/report_done/audit_report の3つは同じ `...(kobo ? [...] : [])` の中にある
    // （実測で ~2000 文字以内）。厳密な閉じ括弧探索より、広めの窓で「同じブロックの中に
    // 3つとも収まっているか」を見る方が、整形の揺れに強い
    const block = src.slice(koboBlockStart, koboBlockStart + 4000);
    assert.ok(block.includes("report_phase"));
    assert.ok(block.includes("report_done"));
    assert.ok(block.includes("audit_report"), "audit_report が kobo ゲートの外にある");
    // role による分岐（audit_report だけを別条件にする）が無いこと
    assert.ok(
      !/role\s*===\s*["']audit["']/.test(block),
      "audit_report が role === 'audit' で別扱いされている（監査役以外に載らない経路がある）"
    );
  });
});

// ── ③・a1〜a4: フェイルオープン ───────────────────────────────────────────────

interface Harness {
  daemon: Daemon;
  workers: WorkerPoolHarness;
  driver: FakeRuntimeDriver;
  tmpDir: string;
  proj: string;
}

async function harness(driver: FakeRuntimeDriver = new FakeRuntimeDriver()): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-advisory-"));
  const repoDir = path.join(tmpDir, "repo");
  initRepo(repoDir);

  const workers = await startWorkerPool(driver);
  const daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 200,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    workerPoolUrl: workers.url,
    disableAutoSpawn: true,
  });
  await daemon.start();
  const proj = "audit-advisory-proj";
  daemon.registerProject(proj, repoDir);
  return { daemon, workers, driver, tmpDir, proj };
}

async function teardown(h: Harness): Promise<void> {
  await h.daemon.stop();
  await h.workers.close();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
}

function auditStartedCount(h: Harness, taskId: string): number {
  return h.daemon.getTaskEvents(h.proj, taskId).filter((e) => e.type === "audit_started").length;
}

function latestAuditSession(h: Harness, taskId: string): string {
  const spawned = h.daemon
    .getTaskEvents(h.proj, taskId)
    .filter((e) => e.type === "agent_spawned") as Array<{ sessionId?: string }>;
  const last = spawned[spawned.length - 1]?.sessionId;
  assert.ok(last, "監査人が起きていない");
  return last!;
}

async function taskInAuditing(h: Harness, taskId: string): Promise<void> {
  h.daemon.createTask(h.proj, taskId, `作業 ${taskId}`, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
  });
  h.daemon.transition(h.proj, taskId, "queued", "test");
  h.daemon.transition(h.proj, taskId, "ready", "test");
  await h.daemon.spawnTask(h.proj, taskId);
  h.daemon.transition(h.proj, taskId, "implementing", "test");
  h.daemon.transition(h.proj, taskId, "auditing", "test");
  await until(() => auditStartedCount(h, taskId) >= 1);
}

function auditVerdictOf(
  h: Harness,
  taskId: string
): { verdict?: string; byDefault?: boolean; defaultReason?: string } | undefined {
  return h.daemon
    .getTaskEvents(h.proj, taskId)
    .findLast((e) => e.type === "audit_verdict") as
    | { verdict?: string; byDefault?: boolean; defaultReason?: string }
    | undefined;
}

function hasTaskFailed(h: Harness, taskId: string): boolean {
  return h.daemon.getTaskEvents(h.proj, taskId).some((e) => e.type === "task_failed");
}

describe("[a1・a4] 判定を出さずに報告しても failed にならず、次段へ進む", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("audit_report を呼ばずに done:true で報告 → failed にならず review.policy 通りに進む", async () => {
    const taskId = "task-a1-1";
    await taskInAuditing(h, taskId);
    const sessionId = latestAuditSession(h, taskId);
    h.workers.pool.report(sessionId, "見ました。良さそうです", { done: true });

    await until(() => h.daemon.getTask(h.proj, taskId)?.status !== "auditing");
    const task = h.daemon.getTask(h.proj, taskId);
    assert.ok(
      task?.status === "merging" || task?.status === "review-ready",
      `既定通過後の状態が想定外: ${task?.status}`
    );
    assert.equal(hasTaskFailed(h, taskId), false, "failed になっている");

    const verdict = auditVerdictOf(h, taskId);
    assert.equal(verdict?.verdict, "pass");
    assert.equal(verdict?.byDefault, true, "既定通過の印（a4）が付いていない");
    assert.match(verdict?.defaultReason ?? "", /audit_report/, "既定通過の理由が書かれていない");
  });
});

describe("[a2・a4] 判定を出さずに再試行の上限まで落ちても、既定で通る", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("2回とも判定を出さずに落ちる → failed にならず既定で通る", async () => {
    const taskId = "task-a2-1";
    await taskInAuditing(h, taskId);

    h.driver.exit(latestAuditSession(h, taskId), null, "SIGKILL");
    await until(() => auditStartedCount(h, taskId) === 2);

    h.driver.exit(latestAuditSession(h, taskId), null, "SIGKILL");
    await until(() => h.daemon.getTask(h.proj, taskId)?.status !== "auditing");

    const task = h.daemon.getTask(h.proj, taskId);
    assert.ok(
      task?.status === "merging" || task?.status === "review-ready",
      `既定通過後の状態が想定外: ${task?.status}`
    );
    assert.equal(hasTaskFailed(h, taskId), false, "failed になっている——再試行を使い切っても通すはず");
    assert.equal(auditStartedCount(h, taskId), 2, "再試行の上限を超えて起こしている");

    const verdict = auditVerdictOf(h, taskId);
    assert.equal(verdict?.byDefault, true);
    assert.match(verdict?.defaultReason ?? "", /audit_session_exited_without_verdict/);
    assert.match(verdict?.defaultReason ?? "", /2回試行/, "何回試したのかが残っていない（I2）");
  });
});

describe("[a2・a4] 監査セッションの spawn 自体が失敗しても、既定で通る", () => {
  class ThrowOnAuditSpawnDriver extends FakeRuntimeDriver {
    failFor = new Set<string>();
    override async spawn(opts: Parameters<FakeRuntimeDriver["spawn"]>[0]) {
      if (this.failFor.has(opts.taskId)) {
        throw new Error("boom: audit spawn failed (test)");
      }
      return super.spawn(opts);
    }
  }

  let h: Harness;
  let driver: ThrowOnAuditSpawnDriver;
  before(async () => {
    driver = new ThrowOnAuditSpawnDriver();
    h = await harness(driver);
  });
  after(async () => {
    await teardown(h);
  });

  it("audit の spawn が例外を投げても failed にならず既定で通る", async () => {
    const taskId = "task-a2-2";
    driver.failFor.add(`${taskId}:audit`);

    h.daemon.createTask(h.proj, taskId, `作業 ${taskId}`, {
      kind: "feature",
      scope: { paths: [`src/${taskId}/**`] },
      acceptance: [{ id: "a1", text: "動くこと", verify: "npm test" }],
    });
    h.daemon.transition(h.proj, taskId, "queued", "test");
    h.daemon.transition(h.proj, taskId, "ready", "test");
    await h.daemon.spawnTask(h.proj, taskId);
    h.daemon.transition(h.proj, taskId, "implementing", "test");
    h.daemon.transition(h.proj, taskId, "auditing", "test");

    await until(() => h.daemon.getTask(h.proj, taskId)?.status !== "auditing");
    const task = h.daemon.getTask(h.proj, taskId);
    assert.ok(
      task?.status === "merging" || task?.status === "review-ready",
      `既定通過後の状態が想定外: ${task?.status}`
    );
    assert.equal(hasTaskFailed(h, taskId), false, "failed になっている——spawn 失敗でも通すはず");
    assert.equal(auditStartedCount(h, taskId), 0, "起こせていないので audit_started は無いはず");

    const verdict = auditVerdictOf(h, taskId);
    assert.equal(verdict?.byDefault, true);
    assert.match(verdict?.defaultReason ?? "", /audit session spawn failed/);
  });
});

describe("[a3] verdict=\"fail\" を明示したときだけ、これまでどおり差し戻しになる", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("明示の fail は既定通過ではなく rework になる", async () => {
    const taskId = "task-a3-1";
    await taskInAuditing(h, taskId);

    const result = h.daemon.handleAuditVerdict(h.proj, taskId, "fail", ["a1 が未検証"]);
    assert.equal(result.ok, true);

    await until(() => h.daemon.getTask(h.proj, taskId)?.status === "implementing");
    const verdict = auditVerdictOf(h, taskId);
    assert.equal(verdict?.verdict, "fail");
    assert.notEqual(verdict?.byDefault, true, "明示の fail に既定通過の印が付いている");
  });

  it("既定通過は verdict=fail によるブロックを迂回しない（fail は今までどおり止める）", async () => {
    const taskId = "task-a3-2";
    await taskInAuditing(h, taskId);
    h.daemon.handleAuditVerdict(h.proj, taskId, "fail", ["1回目"]);
    await until(() => h.daemon.getTask(h.proj, taskId)?.status === "implementing");
    // 実物のやり直し（rework）の報告を待たず、直接もう一度監査へ回す（既存試験と同じ手筋）
    h.daemon.transition(h.proj, taskId, "auditing", "test");
    await until(() => auditStartedCount(h, taskId) >= 2);
    h.daemon.handleAuditVerdict(h.proj, taskId, "fail", ["2回目"]);
    await until(() => h.daemon.getTask(h.proj, taskId)?.status === "failed");
    assert.equal(hasTaskFailed(h, taskId), true, "2回連続の明示 fail は今までどおり failed のはず");
  });
});

// ── a11: diff の外を読んだ理由が audit_verdict に残る（両経路）────────────────

describe("[a11] 監査人が diff の外を読んだ理由が audit_verdict に残る", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(async () => {
    await teardown(h);
  });

  it("HTTP 経由（claude-agent 経路が実際に叩く受け口）で consultedBeyondDiff が audit_verdict に刻まれる", async () => {
    const taskId = "task-a11-1";
    await taskInAuditing(h, taskId);
    const base = `http://127.0.0.1:${h.daemon.port}`;
    const res = await fetch(`${base}/api/v1/projects/${h.proj}/tasks/${taskId}/audit-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        verdict: "pass",
        findings: [],
        consultedBeyondDiff: ["thread-store.ts: a2 の判断に既存の振る舞いが要ったため"],
      }),
    });
    assert.equal(res.status, 200);

    const verdict = h.daemon
      .getTaskEvents(h.proj, taskId)
      .findLast((e) => e.type === "audit_verdict") as { consultedBeyondDiff?: string[] } | undefined;
    assert.ok(verdict?.consultedBeyondDiff, "consultedBeyondDiff が audit_verdict に刻まれていない");
    assert.match(verdict!.consultedBeyondDiff![0] ?? "", /thread-store\.ts/);
  });

  it("pi 経路（DaemonClient.auditReport）も同じ受け口を通して consultedBeyondDiff を運べる", async () => {
    const taskId = "task-a11-2";
    await taskInAuditing(h, taskId);
    const client = new DaemonClient(`http://127.0.0.1:${h.daemon.port}`);
    await client.auditReport(h.proj, taskId, "pass", [], ["b3 の判断に config.ts の既定値が要ったため"]);

    const verdict = h.daemon
      .getTaskEvents(h.proj, taskId)
      .findLast((e) => e.type === "audit_verdict") as { consultedBeyondDiff?: string[] } | undefined;
    assert.ok(verdict?.consultedBeyondDiff, "pi 経路からの consultedBeyondDiff が届いていない");
    assert.match(verdict!.consultedBeyondDiff![0] ?? "", /config\.ts/);
  });

  it("consultedBeyondDiff は自己申告であって判定材料ではない、とコードのコメントに書かれている（I1）", () => {
    const daemonSrc = fs.readFileSync(
      path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "..",
        "packages",
        "banto-daemon",
        "src",
        "daemon.ts"
      ),
      "utf-8"
    );
    assert.match(daemonSrc, /consultedBeyondDiff[\s\S]{0,400}(自己申告|判断材料ではない|I1)/);
  });
});
