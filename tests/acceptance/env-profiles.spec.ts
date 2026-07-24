/**
 * AC-S9d7fdb-1-1: meta/environments.yaml のprofilesがdaemonに読み込まれ、
 * GET /api/v1/projects/:proj/environments でプロファイル一覧を確認できる。
 *
 * Scenario-1: PO defines profiles once in meta/environments.yaml and confirms them via the API.
 *
 * Preconditions:
 *   - daemon running with a registered project whose repoPath contains meta/environments.yaml
 *     defining: dev {driver: process, config: {cmd, port}, ttl: 8h}, test {driver: docker,
 *     config: {compose: docker/test.yaml}, ttl: 30m}, staging {driver: ./meta/drivers/fake-vm,
 *     credentials: staging-creds, ttl: 24h, quota: {max_instances: 2}}
 *
 * Story type: api — real HTTP client against a running daemon. No mocked internals.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Daemon } from "@banto/daemon";

describe("[AC-S9d7fdb-1-1] Environment profiles loaded from meta/environments.yaml", () => {
  let tmpDataDir: string;
  let tmpRepoDir: string;
  let daemon: Daemon;
  let base: string;

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-env-data-"));
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-env-repo-"));

    // Create meta/environments.yaml per scenario preconditions
    fs.mkdirSync(path.join(tmpRepoDir, "meta"), { recursive: true });
    const yamlContent = `profiles:
  dev:
    driver: process
    config:
      cmd: npm run dev
      port: 5173
    ttl: 8h
  test:
    driver: docker
    config:
      compose: docker/test.yaml
    ttl: 30m
  staging:
    driver: ./meta/drivers/fake-vm
    credentials: staging-creds
    ttl: 24h
    quota:
      max_instances: 2
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
      body: JSON.stringify({ id: "proj-env", repoPath: tmpRepoDir }),
    });
    assert.equal(res.status, 201, "project registration should succeed");
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  it("[AC-S9d7fdb-1-1] GET /api/v1/projects/:proj/environments returns 200 with profile list", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-env/environments`);
    assert.equal(res.status, 200, "environments endpoint should return 200");

    const body = await res.json() as {
      profiles: Array<{
        name: string;
        driver: string;
        config?: Record<string, unknown>;
        ttlMs: number;
        quota?: { max_instances: number };
        credentials?: string;
      }>;
    };
    assert.ok(Array.isArray(body.profiles), "body.profiles must be an array");
    assert.equal(body.profiles.length, 3, "should have 3 profiles (dev, test, staging)");

    const names = body.profiles.map((p) => p.name);
    assert.ok(names.includes("dev"), "profiles must include dev");
    assert.ok(names.includes("test"), "profiles must include test");
    assert.ok(names.includes("staging"), "profiles must include staging");
  });

  it("[AC-S9d7fdb-1-1] dev profile has correct driver and normalized ttlMs (8h = 28800000)", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-env/environments`);
    assert.equal(res.status, 200);
    const body = await res.json() as { profiles: Array<Record<string, unknown>> };

    const dev = body.profiles.find((p) => p["name"] === "dev");
    assert.ok(dev, "dev profile must be present");
    assert.equal(dev["driver"], "process", "dev.driver must be 'process'");
    assert.equal(dev["ttlMs"], 28800000, "dev.ttlMs must be 28800000 (8h in ms)");
    // Config is carried through (driver-specific, opaque)
    const config = dev["config"] as Record<string, unknown> | undefined;
    assert.ok(config !== undefined, "dev.config must be present");
  });

  it("[AC-S9d7fdb-1-1] test profile has docker driver and normalized ttlMs (30m = 1800000)", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-env/environments`);
    assert.equal(res.status, 200);
    const body = await res.json() as { profiles: Array<Record<string, unknown>> };

    const test = body.profiles.find((p) => p["name"] === "test");
    assert.ok(test, "test profile must be present");
    assert.equal(test["driver"], "docker", "test.driver must be 'docker'");
    assert.equal(test["ttlMs"], 1800000, "test.ttlMs must be 1800000 (30m in ms)");
  });

  it("[AC-S9d7fdb-1-1] staging profile has quota.max_instances and credentials as reference name only", async () => {
    const res = await fetch(`${base}/api/v1/projects/proj-env/environments`);
    assert.equal(res.status, 200);
    const body = await res.json() as { profiles: Array<Record<string, unknown>> };

    const staging = body.profiles.find((p) => p["name"] === "staging");
    assert.ok(staging, "staging profile must be present");
    assert.equal(staging["driver"], "./meta/drivers/fake-vm", "staging.driver must be the path");
    assert.equal(staging["ttlMs"], 86400000, "staging.ttlMs must be 86400000 (24h in ms)");
    // quota
    const quota = staging["quota"] as { max_instances: number } | undefined;
    assert.ok(quota !== undefined, "staging.quota must be present");
    assert.equal(quota.max_instances, 2, "staging.quota.max_instances must be 2");
    // credentials: reference name only (spec §4)
    assert.equal(staging["credentials"], "staging-creds", "staging.credentials must be reference name only");
  });

  it("[AC-S9d7fdb-1-1] credentials field carries reference name only (never a secret value)", async () => {
    // The staging profile has credentials: staging-creds — this is a REFERENCE NAME.
    // spec §4: actual secrets never appear in API responses.
    const res = await fetch(`${base}/api/v1/projects/proj-env/environments`);
    const body = await res.json() as { profiles: Array<Record<string, unknown>> };
    const staging = body.profiles.find((p) => p["name"] === "staging");
    assert.ok(staging, "staging profile must be present");
    // credentials should be a string reference name (not an object with secret values)
    assert.equal(typeof staging["credentials"], "string", "credentials must be a string reference name");
    // Not a secret: it's the name "staging-creds" as written in environments.yaml
    assert.equal(staging["credentials"], "staging-creds");
  });
});
