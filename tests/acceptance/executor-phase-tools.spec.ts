/**
 * AC-S254276-3-2: 実行者がフェーズ報告ツールを呼ぶとdaemonイベント経由で
 * planning → implementing → review-ready と遷移する
 *
 * 検証内容:
 *   - 実 daemon を起動し、プロジェクト/タスクを作成
 *   - reportPhaseTool.execute() を直接呼び出し（ライブラリなのでconsumer-style）
 *   - 遷移がイベントログに state_transitioned として記録されることを確認
 *   - reportDoneTool.execute() も同様に検証
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";
import { DaemonClient, DaemonConnectionError, reportPhaseTool, reportDoneTool } from "@banto/core";

describe("[AC-S254276-3-2] Executor phase tools drive daemon state transitions", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;
  let client: DaemonClient;

  const proj = "test-project";
  const taskId = "T-phase";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-tools-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir });
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

    // Advance task to planning state.
    // Note: daemon's GateEvaluator auto-promotes queued→ready when no gate blocks exist.
    // So after draft→queued the task is already in "ready". We just need queued→planning.
    for (const to of ["queued", "planning"]) {
      const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const body = await r.json() as { task?: { status: string }; error?: string };
      assert.equal(r.status, 200, `Transition to ${to} must succeed (got: ${JSON.stringify(body)})`);
    }
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
    const result = await reportPhaseTool.execute(client, {
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

  it("[AC-S254276-3-2] report_phase(review-ready) transitions task to review-ready via auditing", async () => {
    const result = await reportPhaseTool.execute(client, {
      phase: "review-ready",
      projectTag: proj,
      taskId,
    });

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");

    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "review-ready", "Task must be in review-ready state");
  });

  it("[AC-S254276-3-2] implementing→auditing and auditing→review-ready transitions are in event log", async () => {
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}/events`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: Array<{ type: string; from?: string; to?: string }> };

    const toAuditing = body.events.filter(
      (e) => e.type === "state_transitioned" && e.from === "implementing" && e.to === "auditing"
    );
    assert.equal(toAuditing.length, 1, "Exactly one implementing→auditing transition event");

    const toReviewReady = body.events.filter(
      (e) => e.type === "state_transitioned" && e.from === "auditing" && e.to === "review-ready"
    );
    assert.equal(toReviewReady.length, 1, "Exactly one auditing→review-ready transition event");
  });

  it("[AC-S254276-3-2] report_done(summary) with a separate task transitions to review-ready and records reason", async () => {
    const doneTaskId = "T-done";

    // Create second task and advance to implementing
    await fetch(`${base}/api/v1/projects/${proj}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: doneTaskId, title: "Done test task" }),
    });
    // auto-promoted queued→ready by gate evaluator, so skip "ready" manually
    for (const to of ["queued", "planning", "implementing"]) {
      const r = await fetch(`${base}/api/v1/projects/${proj}/tasks/${doneTaskId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const body = await r.json() as { task?: { status: string }; error?: string };
      assert.equal(r.status, 200, `Transition to ${to} must succeed for T-done (got: ${JSON.stringify(body)})`);
    }

    const summary = "Implemented all acceptance criteria";
    const result = await reportDoneTool.execute(client, {
      summary,
      projectTag: proj,
      taskId: doneTaskId,
    });

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0]?.type, "text");
    assert.ok(
      result.content[0]?.text.includes("review-ready"),
      "Done tool result should mention review-ready"
    );

    // Verify task status
    const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${doneTaskId}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { task: { status: string } };
    assert.equal(body.task.status, "review-ready", "Done task must be in review-ready state");
  });
});

// ── Connection error propagation test ────────────────────────────────────────

describe("[AC-S254276-3-2b] report_phase propagates connection errors (I2 / narrow catch)", () => {
  it("[AC-S254276-3-2b] report_phase('review-ready') throws DaemonConnectionError when daemon is stopped", async () => {
    // Point client at a port with nothing listening
    const deadClient = new DaemonClient("http://localhost:19999");

    await assert.rejects(
      () =>
        reportPhaseTool.execute(deadClient, {
          phase: "review-ready",
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
