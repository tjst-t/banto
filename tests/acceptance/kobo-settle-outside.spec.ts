/**
 * 第2便: **工場の外で決着したものの終い方**（`kobo.settle`・imp-0019 の4番）。
 *
 * **困っていたこと**：`kobo.abandon` は `failed` のタスクにしか効かない。
 * queued / paused / review-ready のまま「中身が別の経路で main に入った」ものを
 * 帳簿の上で畳む手段が無く、2026-08-13 の棚卸しで番頭が実際にここで詰まった
 * ——判定を帳簿へ書き戻せず、improvement 文書が代わりの記録になった。
 *
 * **必ず守ること**：
 *   1. `failed` と**区別される**。失敗ではないので `task_failed` を積まない
 *   2. **記録は消えない**。それまでの経緯も、なぜ畳めるのかも帳簿に残る
 *   3. 理由が**必ず**残る（分類＋根拠の自由文）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";
import { createKoboTools } from "../../packages/banto-daemon/src/kobo-tools.js";
import { PRESENTED_TOOL_NAMES } from "../../packages/banto-host/src/presented-tools.js";
import { EventLog, StateMachine, type TaskStatus } from "../../packages/banto-core/src/index.js";

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const PROJ = "settleproj";
let daemon: Daemon;
let tmpDir: string;
let call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-settle-"));
  const repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  git(["init", "-b", "main"], repoDir);
  git(["config", "user.email", "t@example.com"], repoDir);
  git(["config", "user.name", "t"], repoDir);
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("[第2便] 工場の外で決着したものを、どの途中の状態からでも畳める", () => {
  it("queued から畳める（`kobo.abandon` が届かなかったところ）", async () => {
    const id = "task-4001";
    driveTo(id, ["queued"]);

    const r = await call("kobo.settle", {
      projectTag: PROJ,
      taskId: id,
      outcome: "landed_elsewhere",
      reason: "マージ 539bdb0 で main に入っている",
    });

    assert.equal(r["status"], "closed");
    assert.equal(r["from"], "queued");
    assert.equal(daemon.getTask(PROJ, id)?.status, "closed");
  });

  it("implementing / review-ready からも畳める（imp-0019 で実際に詰まった状態）", async () => {
    for (const [id, states] of [
      ["task-4002", ["queued", "ready", "planning", "implementing"]],
      ["task-4003", ["queued", "ready", "planning", "implementing", "auditing", "review-ready"]],
    ] as const) {
      driveTo(id, [...states]);
      const r = await call("kobo.settle", {
        projectTag: PROJ,
        taskId: id,
        outcome: "no_longer_needed",
        reason: "前提が変わり、この変更はもう要らない",
      });
      assert.equal(daemon.getTask(PROJ, id)?.status, "closed", `${id} を畳めていない`);
      assert.equal(r["status"], "closed");
    }
  });

  /**
   * `paused` はいまの Kobo に公開の入口が無い（職人の質問で機構が入れる状態）ので、
   * 規則そのものを直に確かめる。**imp-0019 で番頭が詰まった状態はここに含まれる。**
   */
  it("規則: paused からは畳める。merging / 終端からは畳めない", () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "settle-rule-"));
    const log = EventLog.open(logDir);
    try {
      const settleable: TaskStatus[] = [
        "draft",
        "queued",
        "ready",
        "planning",
        "implementing",
        "auditing",
        "review-ready",
        "in-review",
        "approved",
        "paused",
      ];
      for (const from of settleable) {
        const r = StateMachine.settleOutside(
          log,
          `t-${from}`,
          { currentStatus: from, by: "banto", outcome: "landed_elsewhere", reason: "別経路で入った" },
          PROJ
        );
        assert.equal(r.ok, true, `${from} から畳めない`);
      }
      // 着地の最中と終端は畳ませない（横から閉じるとキューが自分の対象を失う）
      for (const from of ["merging", "failed", "closed", "merged", "superseded"] as TaskStatus[]) {
        const r = StateMachine.settleOutside(
          log,
          `t-no-${from}`,
          { currentStatus: from, by: "banto", outcome: "landed_elsewhere", reason: "x" },
          PROJ
        );
        assert.equal(r.ok, false, `${from} から畳めてしまう`);
      }
    } finally {
      log.close();
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("[第2便] **failed とは区別される**（失敗ではない）", () => {
  it("task_failed を積まず、failed を経由もしない", async () => {
    const id = "task-4010";
    driveTo(id, ["queued", "ready"]);
    await call("kobo.settle", {
      projectTag: PROJ,
      taskId: id,
      outcome: "handled_directly",
      reason: "番頭が職人へ直接投げて片づけた",
    });

    const events = daemon.getTaskEvents(PROJ, id);
    assert.equal(
      events.some((e) => e.type === "task_failed"),
      false,
      "失敗ではないのに task_failed が積まれている"
    );
    assert.equal(
      events.some((e) => e.type === "state_transitioned" && e.to === "failed"),
      false,
      "failed を経由して畳んでいる（経緯が「落ちた」と読める）"
    );

    // **記録は消えない**：どこから畳んだか・なぜ畳めるのかが残る
    const settled = events.find((e) => e.type === "task_settled_outside") as unknown as
      | Record<string, unknown>
      | undefined;
    assert.ok(settled, "task_settled_outside が積まれていない");
    assert.equal(settled["outcome"], "handled_directly");
    assert.equal(settled["settled_from"], "ready");
    assert.match(String(settled["reason"]), /直接投げて/);
    assert.equal(settled["settledBy"], "banto");

    // タスクの記録にも、失敗ではないことが残る（failureReason に混ぜない）
    const task = daemon.getTask(PROJ, id)!;
    assert.equal(task["settledOutcome"], "handled_directly");
    assert.equal(task["failureReason"], undefined, "失敗の理由欄に書かれている");
  });

  it("それまでの経緯は消えない（畳んでも遷移の並びは残る）", () => {
    const events = daemon.getTaskEvents(PROJ, "task-4010");
    const path_ = events
      .filter((e) => e.type === "state_transitioned")
      .map((e) => (e as { to: string }).to);
    assert.deepEqual(path_, ["queued", "ready", "closed"]);
  });

  it("落ちたもの（failed）はこの口では畳めない——`kobo.abandon` の領分", async () => {
    const id = "task-4011";
    driveTo(id, ["queued", "ready", "planning", "implementing"]);
    assert.equal(daemon.transition(PROJ, id, "failed", "テスト：落とす").ok, true);
    assert.equal(daemon.getTask(PROJ, id)?.status, "failed");

    await assert.rejects(
      () =>
        call("kobo.settle", {
          projectTag: PROJ,
          taskId: id,
          outcome: "no_longer_needed",
          reason: "もう要らない",
        }),
      // **どこへ行けばよいかまで言う**（断るだけだと、番頭はまた同じ口を叩く）
      /kobo\.abandon/,
      "failed から畳めてしまう（失敗と区別する意味が消える）"
    );
    assert.equal(daemon.getTask(PROJ, id)?.status, "failed", "断ったのに状態が動いている");
  });

  it("片が付いたもの（closed）を二度畳まない", async () => {
    await assert.rejects(
      () =>
        call("kobo.settle", {
          projectTag: PROJ,
          taskId: "task-4010",
          outcome: "no_longer_needed",
          reason: "二度目",
        }),
      /畳めません/
    );
  });
});

describe("[第2便] 道具として番頭の手に届く", () => {
  it("`kobo.settle` が Kobo の在庫にある", () => {
    const tools = createKoboTools(daemon).map((t) => t.name);
    assert.ok(tools.includes("kobo.settle"), "在庫に無い");
  });

  it("**提示の一覧にも載っている**（載せないと、在庫にあってもモデルには見えない・決定82）", () => {
    assert.ok(
      PRESENTED_TOOL_NAMES.includes("kobo.settle"),
      "presented-tools.ts に無い——第1便で踏みかけた罠と同じ形"
    );
  });

  it("理由と分類を書かずには呼べない（帳簿に根拠が必ず残る）", () => {
    const tool = createKoboTools(daemon).find((t) => t.name === "kobo.settle")!;
    const params = tool.parameters as unknown as { required?: string[] };
    for (const key of ["projectTag", "taskId", "outcome", "reason"]) {
      assert.ok(params.required?.includes(key), `${key} が必須になっていない`);
    }
  });
});
