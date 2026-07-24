/**
 * AC-S9d7fdb-1-2: 不正なプロファイル定義（driver欠落・ttl形式不正・quota型不正）は
 * 理由付きで拒否され、エラーイベントとして観測でき、daemonは落ちずに正常プロファイルを提供し続ける。
 *
 * Scenario-2: Invalid profile definitions are rejected with reasons while valid profiles
 * keep being served.
 *
 * Preconditions:
 *   - environments.yaml contains one valid profile (dev) plus three invalid ones:
 *     no-driver (driver missing), bad-ttl (ttl: '8x'), bad-quota (quota.max_instances: 'two')
 *
 * Steps tested:
 *   1. GET /api/v1/projects/:proj/environments → 200; body.profiles contains only dev; invalid absent
 *   2. GET /api/v1/projects/:proj/events → env_profile_rejected per invalid profile with reason
 *   3. GET /api/v1/health → 200 (daemon didn't crash); second GET /env → same valid profile, NO dup events
 *
 * Story type: api — real HTTP client against a running daemon.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

/** Poll GET until predicate passes or timeout expires. */
async function pollUntil<T>(
  fn: () => Promise<T>,
  pred: (val: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const val = await fn();
    if (pred(val)) return val;
    if (Date.now() >= deadline) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("[AC-S9d7fdb-1-2] Invalid environment profiles rejected with reason events", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-einv-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-einv-repo-"));
    fs.mkdirSync(path.join(tmpRepoDir, "meta"), { recursive: true });

    // Precondition: one valid profile + three invalid ones
    const yamlContent = `profiles:
  dev:
    driver: process
    config:
      cmd: npm run dev
      port: 5173
    ttl: 8h
  no-driver:
    config:
      cmd: something
    ttl: 1h
  bad-ttl:
    driver: process
    ttl: 8x
  bad-quota:
    driver: process
    ttl: 1h
    quota:
      max_instances: two
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

    const res = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-einv", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration should succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[AC-S9d7fdb-1-2] step-1: GET /environments returns 200 with only the valid dev profile", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-einv/environments`);
    assert.equal(res.status, 200, "environments endpoint must return 200");

    const body = await res.json() as { profiles: Array<{ name: string }> };
    assert.ok(Array.isArray(body.profiles), "body.profiles must be an array");

    const names = body.profiles.map((p) => p.name);
    // Only valid profiles returned
    assert.ok(names.includes("dev"), "dev (valid) must be in profiles");
    // Invalid ones must be absent
    assert.ok(!names.includes("no-driver"), "no-driver (invalid) must not appear");
    assert.ok(!names.includes("bad-ttl"), "bad-ttl (invalid) must not appear");
    assert.ok(!names.includes("bad-quota"), "bad-quota (invalid) must not appear");
  });

  it("[AC-S9d7fdb-1-2] step-2: GET /events contains env_profile_rejected per invalid profile with reason", async () => {
    // Trigger a read to ensure events are emitted (first GET /environments call in step-1 already did this,
    // but we poll here to handle timing)
    await fetch(`${base}/api/v1/projects/proj-einv/environments`);

    type EventShape = { type: string; profileName?: string; reason?: string };
    const events = await pollUntil<EventShape[]>(
      async () => {
        const evRes = await fetch(`${base}/api/v1/projects/proj-einv/events`);
        if (evRes.status !== 200) return [];
        const body = await evRes.json() as { events: EventShape[] };
        return body.events;
      },
      (evts) => {
        const rejections = evts.filter((e) => e.type === "env_profile_rejected");
        return rejections.length >= 3;
      },
      5000
    );

    const rejections = events.filter((e) => e.type === "env_profile_rejected");
    assert.ok(rejections.length >= 3, `must have at least 3 env_profile_rejected events, got ${rejections.length}`);

    // Each invalid profile should have a rejection event
    const rejectionNames = rejections.map((e) => e.profileName);
    assert.ok(rejectionNames.includes("no-driver"), "no-driver must have a rejection event");
    assert.ok(rejectionNames.includes("bad-ttl"), "bad-ttl must have a rejection event");
    assert.ok(rejectionNames.includes("bad-quota"), "bad-quota must have a rejection event");

    // Each rejection must have a human-readable reason naming the offending field
    const noDriverRej = rejections.find((e) => e.profileName === "no-driver");
    assert.ok(noDriverRej?.reason, "no-driver rejection must have a reason");
    assert.ok(
      noDriverRej!.reason!.toLowerCase().includes("driver"),
      `no-driver reason must mention 'driver', got: "${noDriverRej!.reason}"`
    );

    const badTtlRej = rejections.find((e) => e.profileName === "bad-ttl");
    assert.ok(badTtlRej?.reason, "bad-ttl rejection must have a reason");
    assert.ok(
      badTtlRej!.reason!.toLowerCase().includes("ttl"),
      `bad-ttl reason must mention 'ttl', got: "${badTtlRej!.reason}"`
    );

    const badQuotaRej = rejections.find((e) => e.profileName === "bad-quota");
    assert.ok(badQuotaRej?.reason, "bad-quota rejection must have a reason");
    assert.ok(
      badQuotaRej!.reason!.toLowerCase().includes("quota"),
      `bad-quota reason must mention 'quota', got: "${badQuotaRej!.reason}"`
    );
  });

  it("[AC-S9d7fdb-1-2] step-3: daemon survived (health 200) and second GET /environments does NOT duplicate rejection events", async () => {
    // Step 3a: Confirm daemon is still running
    const healthRes = await fetch(`${base}/api/v1/health`);
    assert.equal(healthRes.status, 200, "daemon must still be running after invalid profiles");

    // Count rejection events before second read
    const evRes1 = await fetch(`${base}/api/v1/projects/proj-einv/events`);
    const body1 = await evRes1.json() as { events: Array<{ type: string }> };
    const countBefore = body1.events.filter((e) => e.type === "env_profile_rejected").length;
    assert.ok(countBefore >= 3, `must have at least 3 rejection events before second read, got ${countBefore}`);

    // Step 3b: Second GET /environments (same mtime → no new events)
    const res2 = await fetch(`${base}/api/v1/projects/proj-einv/environments`);
    assert.equal(res2.status, 200, "second GET /environments must return 200");

    const body2nd = await res2.json() as { profiles: Array<{ name: string }> };
    const names = body2nd.profiles.map((p) => p.name);
    // Still returns only the valid dev profile
    assert.ok(names.includes("dev"), "dev must still be returned on second read");
    assert.ok(!names.includes("no-driver"), "invalid profiles must still be absent on second read");

    // Wait briefly to ensure no async events fire
    await new Promise((r) => setTimeout(r, 400));

    // Count rejection events after second read — must not have increased (no-flood)
    const evRes2 = await fetch(`${base}/api/v1/projects/proj-einv/events`);
    const bodyAfter = await evRes2.json() as { events: Array<{ type: string }> };
    const countAfter = bodyAfter.events.filter((e) => e.type === "env_profile_rejected").length;

    assert.equal(
      countAfter,
      countBefore,
      `no-flood: rejection event count must not increase on repeated reads with same mtime (before=${countBefore}, after=${countAfter})`
    );
  });
});
