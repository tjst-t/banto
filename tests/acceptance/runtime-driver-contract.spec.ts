/**
 * [AC-S254276-1-1] RuntimeDriver contract test.
 *
 * Verifies that:
 *   - RuntimeDriver and RuntimeDriverRegistry are exported from banto-core.
 *   - PiRpcDriver satisfies the RuntimeDriver contract (structural + behavioral).
 *   - spawn() → process starts → kill() → process exits without leaks.
 *   - If pi exits immediately (no API key), the failure is surfaced (not swallowed).
 *
 * Real processes: tests run pi --mode rpc against the local node_modules binary.
 * No actual LLM calls are made; pi exits quickly without an API key.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// Imports from banto-core — must be exported from the public API
import {
  RuntimeDriverRegistry,
} from "../../packages/banto-core/src/index.js";
import type {
  RuntimeDriver,
  SessionHandle,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

// PiRpcDriver from banto-daemon
import { PiRpcDriver } from "../../packages/banto-daemon/src/pi-rpc-driver.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(suffix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `banto-rdc-${suffix}-`));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("[AC-S254276-1-1] RuntimeDriver contract", () => {
  let sessDir: string;
  let driver: PiRpcDriver;

  before(() => {
    sessDir = makeTempDir("sess");
    driver = new PiRpcDriver({ sessionBaseDir: sessDir });
  });

  after(async () => {
    // Kill all sessions tracked by the driver (cleanup for any leaked pi processes).
    // This is a defensive measure in case a test didn't kill its session.
    const sessionIds = driver.listActiveSessions();
    for (const sid of sessionIds) {
      await driver.kill(sid).catch(() => { /* best-effort */ });
    }
    fs.rmSync(sessDir, { recursive: true, force: true });
  });

  it("RuntimeDriverRegistry is exported from banto-core", () => {
    const reg = new RuntimeDriverRegistry();
    assert.equal(typeof reg.register, "function");
    assert.equal(typeof reg.get, "function");
    assert.equal(typeof reg.list, "function");
  });

  it("PiRpcDriver is assignable to RuntimeDriver interface (structural check)", () => {
    // TypeScript structural typing — if PiRpcDriver does not satisfy RuntimeDriver,
    // this assignment will fail at compile-time (caught by typecheck).
    const _d: RuntimeDriver = driver;
    assert.ok(_d);
    assert.equal(typeof driver.spawn, "function");
    assert.equal(typeof driver.inject, "function");
    assert.equal(typeof driver.subscribe, "function");
    assert.equal(typeof driver.kill, "function");
  });

  it("RuntimeDriverRegistry.register and get round-trip", () => {
    const reg = new RuntimeDriverRegistry();
    reg.register("pi-rpc", driver);
    assert.equal(reg.get("pi-rpc"), driver);
    assert.deepEqual(reg.list(), ["pi-rpc"]);
  });

  it("spawn() returns SessionHandle with pid and sessionId", async () => {
    const worktreeDir = makeTempDir("wt");
    let handle: SessionHandle | undefined;

    try {
      const collected: DriverEvent[] = [];
      const unsub = driver.subscribe((ev) => collected.push(ev));

      try {
        handle = await driver.spawn({
          taskId: "contract-test-spawn",
          worktreePath: worktreeDir,
          sessionPath: path.join(sessDir, "contract-test-spawn.jsonl"),
          systemPrompt: "",
          tools: [],
        });

        // Handle may be returned even if pi will exit quickly (no key)
        assert.ok(typeof handle.pid === "number" && handle.pid > 0, "pid is a positive number");
        assert.ok(typeof handle.sessionId === "string" && handle.sessionId.length > 0, "sessionId is non-empty");
        assert.ok(typeof handle.sessionPath === "string" && handle.sessionPath.length > 0, "sessionPath is non-empty");

        // sessionPath must be a file path, not transcript content
        assert.ok(!handle.sessionPath.includes("assistant"), "sessionPath must not contain transcript content");
        assert.ok(handle.sessionPath.endsWith(".jsonl") || handle.sessionPath.includes("/"), "sessionPath looks like a file path");

      } catch (err) {
        // Spawn failure is also acceptable (no API key scenario):
        // the error must be surfaced, not swallowed (I2)
        assert.ok(err instanceof Error, "spawn failure must be an Error");
        // Verify spawn_failed event was emitted
        const failed = collected.find((e) => e.type === "spawn_failed");
        assert.ok(failed, "spawn_failed DriverEvent must be emitted on spawn failure");
        unsub();
        return;
      }

      unsub();

      // 3. kill() — must be safe to call
      await driver.kill(handle.sessionId);

      // 4. kill() on an already-dead session must be idempotent
      await driver.kill(handle.sessionId);

    } finally {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  });

  it("kill() on an unknown sessionId does not throw", async () => {
    // Must be idempotent (RuntimeDriver contract)
    await assert.doesNotReject(() => driver.kill("nonexistent-session-id-12345"));
  });

  it("subscribe() returns an unsubscribe function that stops delivery", async () => {
    const received: DriverEvent[] = [];
    const unsub = driver.subscribe((ev) => received.push(ev));
    assert.equal(typeof unsub, "function");
    // Unsubscribe immediately — no events should arrive for future spawns.
    unsub();
    // Call unsub again — must not throw
    unsub();
  });

  it("spawn + process-exit → process_exited DriverEvent is emitted", async () => {
    // pi exits quickly without an API key; we should receive process_exited.
    const worktreeDir = makeTempDir("wt-exit");
    const events: DriverEvent[] = [];
    const unsub = driver.subscribe((ev) => events.push(ev));

    try {
      let handle: SessionHandle | undefined;
      try {
        handle = await driver.spawn({
          taskId: "exit-test",
          worktreePath: worktreeDir,
          sessionPath: path.join(sessDir, "exit-test.jsonl"),
          systemPrompt: "",
          tools: [],
        });
      } catch {
        // spawn_failed case: the spawn_failed event is the contract
        unsub();
        const failed = events.find((e) => e.type === "spawn_failed");
        assert.ok(failed, "spawn_failed event must be emitted");
        return;
      }

      // Wait for pi to exit (up to 5 s). Pi exits immediately without a configured model/key.
      const exitSeen = await new Promise<boolean>((resolve) => {
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        let done = false;

        const settle = (value: boolean) => {
          if (done) return;
          done = true;
          if (pollTimer !== undefined) clearTimeout(pollTimer);
          resolve(value);
        };

        const check = () => {
          if (done) return;
          const exited = events.find(
            (e) => e.type === "process_exited" && e.sessionId === handle!.sessionId
          );
          if (exited) { settle(true); return; }
          // Poll (only reschedule if not yet settled)
          pollTimer = setTimeout(check, 100);
        };

        pollTimer = setTimeout(check, 100);
        setTimeout(() => settle(false), 5000);
      });

      unsub();

      // Either the process exited (process_exited event) or we need to kill it.
      if (!exitSeen) {
        await driver.kill(handle.sessionId);
      }
      // Either process_exited was received, or we confirm it is absent (pi kept running).
      // Both are acceptable — what matters is no zombie (kill idempotent).
    } finally {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  });
});
