/**
 * [AC-S9d7fdb-5-2] Teardown failures are retried; retry exhaustion escalates to cadence card.
 *
 * Entry point (test-discipline rule 2, api story):
 *   Real HTTP client against a running daemon at http://127.0.0.1:<test-port>/api/v1.
 *
 * Scenario (scenario-S9d7fdb-5.json, scenario-2-teardown-retry-escalation):
 *   Preconditions: profile "badneck" uses the REAL fixture driver
 *   tests/fixtures/failing-teardown-driver.ts (NOT a mock) whose teardown ALWAYS fails.
 *   Retry limit configured to 2 for fast test execution.
 *
 *   Step 1: Provision env on "badneck" profile. Let TTL expiry trigger forced teardown.
 *           Poll GET /api/v1/events — expect tick_job_failed events for retry attempts
 *           (I2: each failure is recorded in the event log).
 *   Step 2: After retry limit, poll GET /api/v1/events for card_generated event with
 *           cardType: "cadence" and a cardPath (D3: no card body in the log).
 *           Verify the card file exists at cardPath.
 *           Verify GET /api/v1/environments still contains the entry (marked teardown_failed).
 *
 * Real driver path: tests/fixtures/failing-teardown-driver.ts invoked via tsx.
 * This satisfies the "real project-local driver executable" requirement (NOT an in-process mock).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

import { Daemon } from "../../packages/banto-daemon/src/daemon.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") { s.close(() => reject(new Error("no address"))); return; }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.once("error", reject);
  });
}

async function httpPost(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function httpGet(url: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url);
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 300
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("[AC-S9d7fdb-5-2] teardown retry + cadence escalation on exhaustion", () => {
  let daemon: Daemon;
  let baseUrl: string;
  let dataDir: string;
  let projectDir: string;
  const projId = "teardown-retry-proj";
  const taskId = `task-retry-${Date.now()}`;
  let envId: string | undefined;

  // Path to the failing-teardown fixture driver (resolved relative to this test file).
  const fixtureDriverPath = path.resolve(_thisDir, "../fixtures/failing-teardown-driver.ts");

  before(async () => {
    // Verify the fixture driver exists — fail fast with a clear message.
    assert.ok(
      fs.existsSync(fixtureDriverPath),
      `Fixture driver not found at ${fixtureDriverPath}`
    );

    const daemonPort = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-retry-"));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-retry-proj-"));
    baseUrl = `http://127.0.0.1:${daemonPort}/api/v1`;

    const metaDir = path.join(projectDir, "meta");
    fs.mkdirSync(metaDir, { recursive: true });

    // Profile "badneck": uses the failing-teardown fixture driver, TTL 2s so it triggers fast.
    // Note: config is omitted (optional per spec §2) to avoid inline-map YAML parsing issues.
    fs.writeFileSync(
      path.join(metaDir, "environments.yaml"),
      `profiles:\n  badneck:\n    driver: "${fixtureDriverPath}"\n    ttl: 2s\n`,
      "utf8"
    );

    daemon = Daemon.create({
      port: daemonPort,
      dataDir,
      watchIntervalMs: 10000,
      tickIntervalMs: 300,             // fast tick for TTL enforcer
      reconcileIntervalMs: 3600000,    // suppress spawn-reconcile (not testing that here)
      envReconcileIntervalMs: 3600000, // suppress env reconcile (only testing TTL retry here)
      driverTimeoutMs: 5000,
      ttlTeardownRetryLimit: 2,        // limit to 2 so the test doesn't take too long
      ttlTeardownRetryDelayMs: 50,     // fast retries for test
      disableAutoSpawn: true,
      disableAuditSpawn: true,
    });

    daemon.registerProject(projId, projectDir);
    await daemon.start();

    // Create task with environment: "badneck" so the provision HTTP endpoint resolves the profile.
    await daemon.createTask(projId, taskId, "Teardown retry test task", { environment: "badneck" });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("step 1: provision env on failing-teardown driver", async () => {
    const provResp = await httpPost(
      `${baseUrl}/projects/${projId}/tasks/${taskId}/environment/provision`,
      { profile: "badneck" }
    );
    assert.equal(provResp.status, 201, `Expected 201, got ${provResp.status}: ${JSON.stringify(provResp.body)}`);

    const body = provResp.body as Record<string, unknown>;
    envId = body["envId"] as string;
    assert.ok(typeof envId === "string" && envId.length > 0, "envId should be a string");

    // Verify it appears in GET /environments (it's live before TTL)
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments?: unknown[] };
    const envList = envListBody.environments ?? [];
    const liveEntry = envList.find((e) => (e as Record<string, unknown>)["envId"] === envId);
    assert.ok(liveEntry, "env should appear in GET /environments immediately after provision");
  });

  it("step 2: after TTL, teardown failures are retried (tick_job_failed events recorded)", async () => {
    // Wait for tick_job_failed events from the retry attempts.
    // We expect retryLimit+1 attempts total = 3 tick_job_failed events.
    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/events`);
      if (resp.status !== 200) return false;
      const body = resp.body as { events?: unknown[] };
      const events = body.events ?? [];
      const failures = events.filter((e) => {
        const ev = e as Record<string, unknown>;
        return ev["type"] === "tick_job_failed" && ev["jobName"] === "env-ttl-enforcer";
      });
      // We need at least 2 failures (retryLimit=2 means 3 attempts but first failure too)
      return failures.length >= 2;
    }, 15000, 300);

    const eventsResp = await httpGet(`${baseUrl}/events`);
    assert.equal(eventsResp.status, 200);
    const eventsBody = eventsResp.body as { events?: unknown[] };
    const events = eventsBody.events ?? [];
    const failures = events.filter((e) => {
      const ev = e as Record<string, unknown>;
      return ev["type"] === "tick_job_failed" && ev["jobName"] === "env-ttl-enforcer";
    });
    assert.ok(failures.length >= 2, `Expected >=2 tick_job_failed events, got ${failures.length}`);

    // Each failure event should mention the envId
    for (const f of failures) {
      const ev = f as Record<string, unknown>;
      assert.ok(
        typeof ev["error"] === "string" && ev["error"].includes(envId!),
        `tick_job_failed event should mention envId=${envId}, got: ${JSON.stringify(ev["error"])}`
      );
    }
  });

  it("step 3: after retry exhaustion, card_generated(cadence) is emitted and card file exists", async () => {
    // Wait for the cadence card to appear
    let cardEvent: Record<string, unknown> | undefined;

    await waitFor(async () => {
      const resp = await httpGet(`${baseUrl}/events`);
      if (resp.status !== 200) return false;
      const body = resp.body as { events?: unknown[] };
      const events = body.events ?? [];
      // Find the card for THIS specific envId (not orphan cards from other tests).
      cardEvent = events.find((e) => {
        const ev = e as Record<string, unknown>;
        if (ev["type"] !== "card_generated" || ev["cardType"] !== "cadence") return false;
        if (typeof ev["cardPath"] !== "string") return false;
        try {
          const c = JSON.parse(fs.readFileSync(ev["cardPath"], "utf8")) as Record<string, unknown>;
          return c["envId"] === envId;
        } catch { return false; }
      }) as Record<string, unknown> | undefined;
      return cardEvent !== undefined;
    }, 15000, 300);

    assert.ok(cardEvent, "card_generated(cadence) event should appear after retry exhaustion");

    // D3: event carries cardPath reference only (no card body in the log)
    const cardPath = cardEvent?.["cardPath"] as string | undefined;
    assert.ok(typeof cardPath === "string" && cardPath.length > 0, "cardPath should be a string path");

    // Verify the card file exists on disk (D3: body is in the file, not in the log)
    assert.ok(fs.existsSync(cardPath), `Card file should exist at cardPath=${cardPath}`);

    const cardContent = JSON.parse(fs.readFileSync(cardPath, "utf8")) as Record<string, unknown>;
    assert.equal(cardContent["cardType"], "cadence", "card file should have cardType: cadence");
    assert.ok(
      typeof cardContent["envId"] === "string",
      "card file should reference the envId"
    );
  });

  it("step 4: ledger entry is still in GET /environments marked as teardown_failed (not silently dropped)", async () => {
    // The env ledger entry should still be present even though teardown failed.
    // We use the internal envLedger reference to check teardownFailed flag.
    // Since this is an API test, we check via the HTTP endpoint.

    // GET /environments returns live entries (listLive). A teardown_failed entry
    // is still live (no tornDownAt) — verify it appears.
    const envListResp = await httpGet(`${baseUrl}/environments`);
    assert.equal(envListResp.status, 200);
    const envListBody = envListResp.body as { environments?: unknown[] };
    const envList = envListBody.environments ?? [];
    const failedEntry = envList.find((e) => (e as Record<string, unknown>)["envId"] === envId);

    assert.ok(
      failedEntry !== undefined,
      `Ledger entry for envId=${envId} should still be in GET /environments after teardown failure (I2: not silently removed)`
    );

    // Check the teardownFailed flag via the internal ledger (direct access since this
    // is an integration test with in-process Daemon).
    const internalEntry = daemon.envLedger.get(envId!);
    assert.ok(internalEntry, `Ledger entry ${envId} should still exist internally`);
    assert.equal(
      internalEntry?.teardownFailed,
      true,
      "Ledger entry should be marked teardownFailed=true after retry exhaustion"
    );
  });
});
