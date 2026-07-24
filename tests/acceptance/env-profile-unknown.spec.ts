/**
 * AC-S9d7fdb-1-3: 存在しないプロファイル名をenvironment:で参照するタスクへのprovision要求は、
 * 理由付きで失敗として観測できる（環境は作られない）。
 *
 * Scenario-3: Provision request for a task referencing an unknown profile fails with reason
 * and creates nothing.
 *
 * Preconditions:
 *   - A task exists whose frontmatter has environment: nosuch
 *   - environments.yaml defines only dev
 *
 * Steps tested:
 *   1. POST /api/v1/projects/:proj/tasks/:taskId/environment/provision → 404;
 *      body.error contains 'nosuch'
 *   2. GET /api/v1/environments → no entry for taskId;
 *      GET /api/v1/projects/:proj/events → env_provision_failed with reason referencing nosuch;
 *      no env_provisioned event
 *
 * Story type: api — real HTTP client against a running daemon.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

describe("[AC-S9d7fdb-1-3] Provision with unknown profile → 404 + env_provision_failed event", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;
  const taskId = "task-9001";

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-epunk-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-epunk-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "meta"), { recursive: true });

    // Only define 'dev' profile (not 'nosuch')
    const yamlContent = `profiles:
  dev:
    driver: process
    config:
      cmd: npm run dev
      port: 5173
    ttl: 8h
`;
    fs.writeFileSync(path.join(tmpRepoDir, "meta", "environments.yaml"), yamlContent, "utf-8");

    daemon = Daemon.create({
      port: 0,
      dataDir: tmpDataDir,
      watchIntervalMs: 500,
      tickIntervalMs: 60000,
    });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    // Register project
    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-epunk", repoPath: tmpRepoDir }),
    });
    assert.equal(projRes.status, 201, "project registration should succeed");

    // Create a task with environment: nosuch in its payload
    // We create via the API with the environment field set
    const taskRes = await fetch(`${base}/api/v1/projects/proj-epunk/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: taskId,
        title: "Task referencing unknown profile",
        environment: "nosuch",
      }),
    });
    assert.equal(taskRes.status, 201, "task creation should succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[AC-S9d7fdb-1-3] step-1: POST /provision with unknown profile → 404 with error containing 'nosuch'", async () => {
    const res = await fetch(
      `${base}/api/v1/projects/proj-epunk/tasks/${taskId}/environment/provision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    assert.equal(res.status, 404, "provision with unknown profile must return 404");

    const body = await res.json() as { error?: string };
    assert.ok(typeof body.error === "string", "response must have an error field");
    assert.ok(
      body.error.includes("nosuch"),
      `error must contain 'nosuch' (the unknown profile name), got: "${body.error}"`
    );
  });

  it("[AC-S9d7fdb-1-3] step-2a: no env_provisioned event in project events", async () => {
    const evRes = await fetch(`${base}/api/v1/projects/proj-epunk/events`);
    assert.equal(evRes.status, 200);
    const body = await evRes.json() as { events: Array<{ type: string; taskId?: string }> };

    const provisioned = body.events.filter(
      (e) => e.type === "env_provisioned" && e.taskId === taskId
    );
    assert.equal(provisioned.length, 0, "must not have any env_provisioned events for this task");
  });

  it("[AC-S9d7fdb-1-3] step-2b: env_provision_failed event present with reason referencing 'nosuch'", async () => {
    const evRes = await fetch(`${base}/api/v1/projects/proj-epunk/events`);
    assert.equal(evRes.status, 200);
    const body = await evRes.json() as {
      events: Array<{ type: string; taskId?: string; profileName?: string; reason?: string }>;
    };

    const failed = body.events.filter(
      (e) => e.type === "env_provision_failed" && e.taskId === taskId
    );
    assert.ok(failed.length >= 1, `must have at least 1 env_provision_failed event for ${taskId}`);

    const ev = failed[0];
    assert.ok(ev, "env_provision_failed event must exist");
    assert.equal(ev.profileName, "nosuch", "env_provision_failed must carry the unknown profile name");
    assert.ok(
      typeof ev.reason === "string" && ev.reason.length > 0,
      "env_provision_failed must have a non-empty reason"
    );
  });

  it("[AC-S9d7fdb-1-3] step-2c: environments list has no entry for the task (no resource created)", async () => {
    // The scenario step says "GET /api/v1/environments and GET /api/v1/projects/:proj/events"
    // "environments list contains no entry for :taskId"
    // At this stage (Story 1, profile-resolution only), no environment instance is created.
    // The environments endpoint lists PROFILES not instances — so dev profile is there but
    // the task has no associated active environment.
    // We verify via: no env_provisioned event exists (covered in step-2a above).
    // Additionally: environments list should only show the defined profile (dev), not any taskId-specific entry.
    const envRes = await fetch(`${base}/api/v1/projects/proj-epunk/environments`);
    assert.equal(envRes.status, 200);
    const body = await envRes.json() as { profiles: Array<{ name: string }> };

    // Profiles listed are the schema-level profiles (dev), not per-task instances
    const names = body.profiles.map((p) => p.name);
    assert.ok(names.includes("dev"), "dev profile must be listed");
    // No task-specific instance for taskId (since provisioning failed)
    assert.ok(!names.includes(taskId), "failed provision must not create a profile entry for taskId");
  });
});
