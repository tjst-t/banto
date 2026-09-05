import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateBootstrapConfig, assertNoOverlap, ConfigOverlapError } from "./bootstrap.js";

test("creates a new config with random token if none exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-config-test-"));
  try {
    const configPath = join(dir, "config.json");
    const c1 = loadOrCreateBootstrapConfig(configPath);
    assert.ok(c1.authToken.length > 0);
    const c2 = loadOrCreateBootstrapConfig(configPath);
    assert.equal(c1.authToken, c2.authToken, "second load reuses the persisted token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects dataDir that overlaps the config directory", () => {
  assert.throws(
    () => assertNoOverlap("/home/x/.config/banto/config.json", "/home/x/.config/banto"),
    ConfigOverlapError,
  );
  assert.throws(
    () => assertNoOverlap("/home/x/.config/banto/config.json", "/home/x/.config"),
    ConfigOverlapError,
  );
  assert.doesNotThrow(() =>
    assertNoOverlap("/home/x/.config/banto/config.json", "/home/x/.local/share/banto"),
  );
});
