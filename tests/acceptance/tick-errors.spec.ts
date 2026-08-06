/**
 * AC-Scc9152-3-2: Tick job failures are recorded as events; daemon stays alive.
 *
 * Verifies I2: errors from tick jobs are NOT silently swallowed.
 * A failing job must produce a tick_job_failed event in the log and the
 * daemon must remain responsive (GET /api/v1/health still returns 200).
 *
 * Uses a real daemon with tickIntervalMs=200 to keep test time short.
 * The failing job is registered via daemon.registerTickJob (public API).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

describe("[AC-Scc9152-3-2] Tick errors: failed jobs recorded as events, daemon survives", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-tick-err-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, tickIntervalMs: 200, disableAutoSpawn: true });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register a project so we can use project-scoped APIs in assertions.
    await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-tick-err", repoPath: "/repos/proj-tick-err" }),
    });

    // Register a tick job that always throws (simulates a broken periodic job).
    daemon.registerTickJob("failing-job", () => {
      throw new Error("simulated-tick-failure");
    });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-Scc9152-3-2] daemon stays alive after repeated tick job failures", async () => {
    // Step 1: Wait for ≥2 tick cycles (200ms × 3 = 600ms) while the failing job runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 700));

    // Step 2: Daemon must still respond to health check (I2: failure does not crash the daemon)
    const healthRes = await fetch(`${base}/api/v1/health`);
    assert.equal(healthRes.status, 200, "daemon must still be alive after tick job failures");
    const healthBody = await healthRes.json() as { status: string };
    assert.equal(healthBody.status, "ok");
  });

  it("[AC-Scc9152-3-2] tick job failure is recorded as tick_job_failed event (I2: not swallowed)", async () => {
    // Wait to ensure at least one tick cycle fired with the failing job
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    // Query daemon-wide events endpoint to find tick_job_failed events
    const eventsRes = await fetch(`${base}/api/v1/events`);
    assert.equal(eventsRes.status, 200);
    const eventsBody = await eventsRes.json() as {
      events: Array<{ type: string; jobName?: string; error?: string; projectTag: string }>;
    };
    assert.ok(Array.isArray(eventsBody.events), "events must be an array");

    // Find tick_job_failed events for our failing job
    const failedEvents = eventsBody.events.filter(
      (e) => e.type === "tick_job_failed" && e.jobName === "failing-job"
    );
    assert.ok(
      failedEvents.length >= 1,
      `Expected at least one tick_job_failed event for 'failing-job', ` +
        `got ${failedEvents.length}. All events: ${JSON.stringify(eventsBody.events.map((e) => e.type))}`
    );

    // Verify the error message was recorded (I2: error is NOT swallowed)
    const evt = failedEvents[0];
    assert.ok(
      typeof evt.error === "string" && evt.error.includes("simulated-tick-failure"),
      `tick_job_failed.error must contain the original error message, ` +
        `got: ${JSON.stringify(evt.error)}`
    );

    // Verify projectTag sentinel for daemon-internal events
    assert.equal(
      evt.projectTag,
      "daemon",
      "tick_job_failed events use projectTag='daemon' (daemon-internal sentinel)"
    );
  });
});
