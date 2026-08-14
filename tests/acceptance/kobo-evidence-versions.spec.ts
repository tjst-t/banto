/**
 * 第2便・段1: **証拠に「何に対して」を刻む**。
 *
 * **困っていたこと**：監査の判定にもマージ前ゲートの結果にも、「どの契約に対して・
 * どの基準で・どの環境で・どのコミットの上で」通ったのかが残っていなかった。
 * だから契約が後から変わったとき、その判定がまだ有効かを**計算できず**、
 * 「状態を implementing へ巻き戻す」という乱暴な形で表していた。
 *
 * 第3便で「レビュー職人が OK なら人の承認なしにマージする」へ既定を反転する前に、
 * ここが刻まれている必要がある——刻まれていない証拠で自動着地させるのは危険。
 *
 * 入れたもの:
 *   - `audit_verdict` に `contractVersion` / `checklistVersion`
 *   - `merge_gate_evaluated` に `environmentDigest` / `baseCommit`
 *   - **契約の版は新しく持たない**。帳簿（`task_created` / `task_contract_amended`）から導出
 *
 * **併せて塞いだ穴**：チェックリストは pi 拡張の `before_agent_start` だけで渡して
 * いたので、`extensionPaths` を読まない Claude Agent SDK の監査人には**一度も
 * 届いていなかった**。届いていない基準の指紋を刻むのは証拠ではなく嘘なので、
 * Kobo が指示文で渡す形に変えてある。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon, buildAuditInstruction } from "../../packages/banto-daemon/src/daemon.js";
import { runMergeGate } from "../../packages/banto-daemon/src/merge-gate.js";
import {
  EventLog,
  contractVersionOf,
  envProfileDigest,
  loadPromptAsset,
  promptAssetDigest,
  type EnvProfile,
  type TaskRecord,
} from "../../packages/banto-core/src/index.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "evidenceproj";
let daemon: Daemon;
let tmpDir: string;
let repoDir: string;

function driveTo(taskId: string, states: string[]): void {
  daemon.createTask(PROJ, taskId, taskId, {
    kind: "feature",
    scope: { paths: [`src/${taskId}/**`] },
    acceptance: [{ id: "a1", text: "動く" }],
  });
  for (const to of states) {
    const r = daemon.transition(PROJ, taskId, to, "テスト：進める");
    assert.equal(r.ok, true, `${taskId} → ${to}: ${JSON.stringify(r)}`);
  }
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-evidence-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "README.md"), "x\n");
  git(["add", "."], repoDir);
  git(["commit", "-m", "init"], repoDir);

  daemon = Daemon.create({
    port: 0,
    dataDir: path.join(tmpDir, "data"),
    tickIntervalMs: 99999,
    disableAutoSpawn: true,
    disableAuditSpawn: true,
    disableMergeQueue: true,
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    environmentPoolUrl: "http://127.0.0.1:1/api/environment-pool",
  });
  await daemon.start();
  daemon.registerProject(PROJ, repoDir);
});

after(async () => {
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[段1] 監査の判定に「何に対して」が刻まれる", () => {
  it("audit_verdict に contractVersion と checklistVersion が載る", () => {
    const id = "task-5001";
    driveTo(id, ["queued", "ready", "planning", "implementing", "auditing"]);
    daemon.handleAuditVerdict(PROJ, id, "pass", []);

    const verdict = daemon
      .getTaskEvents(PROJ, id)
      .find((e) => e.type === "audit_verdict") as unknown as Record<string, unknown>;
    assert.ok(verdict, "audit_verdict が積まれていない");

    // **契約の版は帳簿から導出した値**（新しい版番号を持たない）
    const created = daemon
      .getTaskEvents(PROJ, id)
      .find((e) => e.type === "task_created")!;
    assert.equal(
      verdict["contractVersion"],
      created.eventId,
      "契約の版が刻まれていない（契約が変わったとき、判定がまだ有効かを計算できない）"
    );

    // 基準の版＝チェックリストの中身の指紋
    assert.equal(
      verdict["checklistVersion"],
      promptAssetDigest("audit-checklist"),
      "監査基準の版が刻まれていない"
    );
  });

  it("契約を改訂すると版が動く＝古い判定が無効だと**計算できる**", () => {
    const id = "task-5001";
    const before_ = contractVersionOf(daemon.getProjectEvents(PROJ), PROJ, id);
    const verdict = daemon
      .getTaskEvents(PROJ, id)
      .find((e) => e.type === "audit_verdict") as unknown as Record<string, unknown>;
    assert.equal(verdict["contractVersion"], before_, "改訂前は版が一致する");

    // 基準を1つ増やす（＝締める方向。番頭が通せる）。第4便: 変える中身は引数で渡す
    const acceptance = (daemon.getTask(PROJ, id)!["acceptance"] as Array<Record<string, unknown>>).map(
      (a) => ({ id: String(a["id"]), text: String(a["text"]) })
    );
    const amended = daemon.amendTask(
      PROJ,
      id,
      { acceptance: [...acceptance, { id: "a2", text: "落ちたら止まる" }] },
      { reason: "基準を1つ増やす", by: "banto" }
    );
    assert.equal(amended.ok, true, JSON.stringify(amended));

    const after_ = contractVersionOf(daemon.getProjectEvents(PROJ), PROJ, id);
    assert.notEqual(after_, before_, "改訂したのに契約の版が動いていない");
    assert.notEqual(
      verdict["contractVersion"],
      after_,
      "**古い判定はいまの契約に対するものではない**、が計算で言えること"
    );
  });
});

describe("[段1] 監査の基準が、経路に依らず監査人に届いている", () => {
  it("指示文にチェックリストが載る（pi 拡張だけに頼らない）", () => {
    const task = { id: "task-5002", status: "auditing", projectTag: PROJ, title: "t" } as TaskRecord;
    const instruction = buildAuditInstruction(task, PROJ, "task-5002", "/tmp/wt");
    const checklist = loadPromptAsset("audit-checklist");
    assert.ok(
      instruction.includes(checklist),
      "指示文に基準が載っていない——**Agent SDK の監査人には基準が届かない**"
    );
  });

  it("刻む指紋と、実際に渡している中身が同じもの", () => {
    const task = { id: "task-5003", status: "auditing", projectTag: PROJ, title: "t" } as TaskRecord;
    const instruction = buildAuditInstruction(task, PROJ, "task-5003", "/tmp/wt");
    assert.ok(instruction.includes(loadPromptAsset("audit-checklist")));
    assert.equal(promptAssetDigest("audit-checklist").length, 12, "指紋が短い形で出ていない");
  });
});

describe("[段1] マージ前ゲートに「どの環境で・どのコミットの上で」が刻まれる", () => {
  /** ゲートは差分を見るので、番頭が触る repo とは別のリポジトリで回す。 */
  let gateRepo: string;
  const branch = "task/gate-5010";

  before(() => {
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

  it("baseCommit は base を解決した SHA。環境の指紋は立てた環境のものが載る", async () => {
    const logDir = path.join(tmpDir, "gatelog");
    const log = EventLog.open(logDir);
    try {

      const task: TaskRecord = {
        id: "task-5010",
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
        // 偽の runner。**指紋は環境の持ち主が返すもの**で、Kobo は作り直さない
        verifyRunner: {
          async provision() {
            return { envId: "env-fake", profileDigest: "deadbeef1234" };
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

      const gate = log
        .readAllEvents()
        .find((e) => e.type === "merge_gate_evaluated") as unknown as Record<string, unknown>;
      assert.ok(gate, "merge_gate_evaluated が積まれていない");

      const head = childProcess
        .execFileSync("git", ["rev-parse", "main"], { cwd: gateRepo, encoding: "utf-8" })
        .trim();
      assert.equal(gate["baseCommit"], head, "どのコミットの上で検査したかが刻まれていない");
      assert.equal(
        gate["environmentDigest"],
        "deadbeef1234",
        "どの環境で検査したかが刻まれていない"
      );
    } finally {
      log.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("環境を立てないとき（verify が無いとき）は環境の指紋を**付けない**", async () => {
    const logDir = path.join(tmpDir, "gatelog2");
    const log = EventLog.open(logDir);
    try {
      const task: TaskRecord = {
        id: "task-5011",
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
        gate["environmentDigest"],
        undefined,
        "**立てていない環境の指紋を埋めている**（分からないものを埋めると証拠が嘘になる）"
      );
      // 土台のコミットは環境と無関係に分かるので、こちらは付く
      assert.ok(typeof gate["baseCommit"] === "string");
    } finally {
      log.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("[段1] 環境の指紋は**中身**から作る（名前では足りない）", () => {
  const base: EnvProfile = {
    name: "test",
    driver: "docker",
    ttlMs: 3600_000,
    config: { file: "docker/test.yaml", service: "app" },
    setup: "npm ci",
  };

  it("名前を変えても指紋は変わらない（同じ環境を別物と言わない）", () => {
    assert.equal(envProfileDigest(base), envProfileDigest({ ...base, name: "verify" }));
  });

  it("鍵の順序では変わらない", () => {
    const reordered: EnvProfile = {
      ...base,
      config: { service: "app", file: "docker/test.yaml" },
    };
    assert.equal(envProfileDigest(base), envProfileDigest(reordered));
  });

  it("**中身が変われば指紋が変わる**（土台や setup が変われば結果も変わりうる）", () => {
    assert.notEqual(envProfileDigest(base), envProfileDigest({ ...base, setup: "npm install" }));
    assert.notEqual(
      envProfileDigest(base),
      envProfileDigest({ ...base, config: { file: "docker/test.yaml", service: "app2" } })
    );
  });
});
