import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { RuntimeConfigStore } from "./runtime.js";

async function withStore(fn: (store: RuntimeConfigStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-runtime-config-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new RuntimeConfigStore(dir, log);
    await store.load();
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("project override wins over instance default", async () => {
  await withStore(async (store) => {
    await store.setInstanceDefault("defaultModel", "sonnet");
    assert.equal(store.resolve("defaultModel", "proj-1"), "sonnet");

    await store.setProjectOverride("proj-1", "defaultModel", "opus");
    assert.equal(store.resolve("defaultModel", "proj-1"), "opus");
    assert.equal(store.resolve("defaultModel", "proj-2"), "sonnet", "other project unaffected");
    assert.equal(store.resolve("defaultModel"), "sonnet", "no projectId falls back to instance");
  });
});

test("unsetting a project override reverts to instance default", async () => {
  await withStore(async (store) => {
    await store.setInstanceDefault("effort", "medium");
    await store.setProjectOverride("proj-1", "effort", "high");
    assert.equal(store.resolve("effort", "proj-1"), "high");
    await store.unsetProjectOverride("proj-1", "effort");
    assert.equal(store.resolve("effort", "proj-1"), "medium");
  });
});
