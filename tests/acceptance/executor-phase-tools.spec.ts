/**
 * AC-S254276-3-2: 実行者がフェーズ報告ツールを呼ぶとdaemonイベント経由で
 * planning → implementing → auditing と遷移する
 *
 * S75f66b-3 (DEC-S254276-012 resolved):
 *   report_phase now only supports planning/implementing phases.
 *   report_done transitions to "auditing" (not review-ready).
 *   The executor no longer self-transitions through the audit gate.
 *
 * 検証内容:
 *   - 実 daemon を起動し、プロジェクト/タスクを作成
 *   - reportPhaseTool.execute() を直接呼び出し（ライブラリなのでconsumer-style）
 *   - 遷移がイベントログに state_transitioned として記録されることを確認
 *   - reportDoneTool.execute() は implementing→auditing のみ (not review-ready)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";
import { DaemonClient, DaemonConnectionError, createExecutorTools } from "@banto/core";
import { advanceTask } from "./task-flow.js";

/** task-0025: 依存は Tool を作る関数の引数で受ける。名前で1本引く */
function executorTool(client: DaemonClient, name: string) {
  const tool = createExecutorTools(client).find((t) => t.name === name);
  if (!tool) throw new Error(`unknown executor tool: ${name}`);
  return tool;
}

describe("[AC-S254276-3-2] Executor phase tools drive daemon state transitions", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;
  let client: DaemonClient;

  const proj = "test-project";
  const taskId = "T-phase";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-tools-"));
    // disableAuditSpawn: this suite tests executor phase tools (implements→auditing transition),
    // not the audit session spawn side-effect. Avoid pi CLI resolution failure in CI.
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAuditSpawn: true, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    client = new DaemonClient(base);

    // Register project
    const r1 = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: "/tmp/test-project", profile: "default" }),
    });
    assert.equal(r1.status, 201, "Project registration must succeed");

    // Create task (draft)
    const r2 = await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, title: "Phase test task" }),
    });
    assert.equal(r2.status, 201, "Task creation must succeed");

    // task-0069: ゲートが queued→ready に上げるのを**待ってから** planning へ進める。
    // 「積んだ直後にはもう ready」に頼っていたので、tick が遅れると 400 で落ちていた
    await advanceTask(base, proj, taskId, ["queued", "planning"]);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S254276-3-2] task starts in planning state", async () => {
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "planning");
  });

  it("[AC-S254276-3-2] report_phase(implementing) transitions task to implementing", async () => {
    const result = await executorTool(client, "report_phase").execute({
      phase: "implementing",
      projectTag: proj,
      taskId,
    });

    // Tool returns text content
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.ok(
      result.content[0]?.text.includes("implementing"),
      "Result text should mention the phase"
    );

    // Verify daemon state
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "implementing", "Task must be in implementing state");
  });

  it("[AC-S254276-3-2] state_transitioned event is recorded in the event log", async () => {
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ type: string; from?: string; to?: string }> };

    const transitioned = body.events.filter(
      (e) => e.type === "state_transitioned" && e.from === "planning" && e.to === "implementing"
    );
    assert.equal(transitioned.length, 1, "Exactly one planning→implementing transition event");
  });

  it("[AC-S254276-3-2] report_done(summary) transitions task to auditing (S75f66b-3: executor→auditing, not self→review-ready)", async () => {
    // S75f66b-3 (DEC-S254276-012 resolved): report_done now transitions to "auditing".
    // The executor must NOT self-transition to review-ready.
    // Auditing is the structural gate; the daemon spawns an audit session from there.
    const summary = "Implemented all acceptance criteria";
    const result = await executorTool(client, "report_done").execute({
      summary,
      projectTag: proj,
      taskId,
    });

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.ok(
      result.content[0]?.text.includes("audit"),
      "Done tool result should mention audit (not review-ready)"
    );

    // Verify task is now in "auditing" (not review-ready)
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "auditing", "Task must be in auditing state after report_done");
  });

  it("[AC-S254276-3-2] implementing→auditing transition is in event log (no auditing→review-ready self-transition)", async () => {
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ type: string; from?: string; to?: string }> };

    const toAuditing = body.events.filter(
      (e) => e.type === "state_transitioned" && e.from === "implementing" && e.to === "auditing"
    );
    assert.equal(toAuditing.length, 1, "Exactly one implementing→auditing transition event");

    // There must NOT be an auditing→review-ready self-transition (DEC-S254276-012 resolved).
    const selfTransition = body.events.filter(
      (e) => e.type === "state_transitioned" && e.from === "auditing" && e.to === "review-ready"
    );
    assert.equal(
      selfTransition.length,
      0,
      "S75f66b-3: executor must NOT self-transition auditing→review-ready (DEC-S254276-012 resolved)"
    );
  });

  it("[AC-S254276-3-2] report_done with a separate task: implementing→auditing only", async () => {
    const doneTaskId = "T-done";

    // Create second task and advance to implementing
    await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: doneTaskId, title: "Done test task" }),
    });
    // task-0069: ready に上がるのを待つ（ゲートが上げる。テストが上げるのではない）
    await advanceTask(base, proj, doneTaskId, ["queued", "planning", "implementing"]);

    const summary = "Implemented all acceptance criteria";
    const result = await executorTool(client, "report_done").execute({
      summary,
      projectTag: proj,
      taskId: doneTaskId,
    });

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    // S75f66b-3: result now says "audit" not "review-ready"
    assert.ok(
      result.content[0]?.text.includes(doneTaskId) || result.content[0]?.text.includes("audit"),
      "Done tool result should reference taskId or audit"
    );

    // Verify task status is auditing (not review-ready)
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${doneTaskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "auditing", "Done task must be in auditing state (not review-ready)");
  });
});

// ── Connection error propagation test ────────────────────────────────────────

describe("[AC-S254276-3-2b] report_phase propagates connection errors (I2 / narrow catch)", () => {
  it("[AC-S254276-3-2b] report_phase('implementing') throws DaemonConnectionError when daemon is stopped", async () => {
    // Point client at a port with nothing listening
    const deadClient = new DaemonClient("http://localhost:19999");

    await assert.rejects(
      () =>
        executorTool(deadClient, "report_phase").execute({
          phase: "implementing",
          projectTag: "ghost-proj",
          taskId: "T-ghost",
        }),
      (err: unknown) => {
        assert.ok(
          err instanceof DaemonConnectionError,
          `Expected DaemonConnectionError, got ${err instanceof Error ? err.constructor.name : typeof err}`
        );
        return true;
      },
      "report_phase must propagate DaemonConnectionError instead of swallowing it"
    );
  });
});
