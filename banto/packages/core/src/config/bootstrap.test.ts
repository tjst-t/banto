import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("試験だけの差し替え（testOnlySelfUpdate）は config に書いたときだけ。形が違えば止まる。環境変数では効かない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-config-test-"));
  const saved = { systemctl: process.env.BANTO_UPDATE_SYSTEMCTL, codeDir: process.env.BANTO_UPDATE_CODE_DIR };
  try {
    await mkdir(join(dir, "config"));
    const configPath = join(dir, "config", "config.json");
    process.env.BANTO_UPDATE_SYSTEMCTL = "/tmp/fake-systemctl";
    process.env.BANTO_UPDATE_CODE_DIR = "/tmp/fake-code";
    await writeFile(configPath, JSON.stringify({ dataDir: join(dir, "data") }));
    assert.equal(loadOrCreateBootstrapConfig(configPath).testOnlySelfUpdate, undefined, "環境変数で差し替わった");

    await writeFile(configPath, JSON.stringify({ dataDir: join(dir, "data"), testOnlySelfUpdate: { systemctl: "/x/systemctl", codeDir: "/x/current/banto" } }));
    assert.deepEqual(loadOrCreateBootstrapConfig(configPath).testOnlySelfUpdate, { systemctl: "/x/systemctl", codeDir: "/x/current/banto" });

    await writeFile(configPath, JSON.stringify({ dataDir: join(dir, "data"), testOnlySelfUpdate: { systemctl: "/x/systemctl" } }));
    assert.throws(() => loadOrCreateBootstrapConfig(configPath), /testOnlySelfUpdate/);
  } finally {
    if (saved.systemctl === undefined) delete process.env.BANTO_UPDATE_SYSTEMCTL;
    else process.env.BANTO_UPDATE_SYSTEMCTL = saved.systemctl;
    if (saved.codeDir === undefined) delete process.env.BANTO_UPDATE_CODE_DIR;
    else process.env.BANTO_UPDATE_CODE_DIR = saved.codeDir;
    await rm(dir, { recursive: true, force: true });
  }
});
