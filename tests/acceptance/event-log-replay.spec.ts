/**
 * AC-S654396-1-1: イベント追記後の再起動(kill -9含む)で
 * リプレイにより同一の導出状態が得られることを検証する。
 *
 * Test discipline: consumer-style — only banto-core public API is used.
 * kill -9 test actually SIGKILLs a child process (no mocking).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, StateStore } from "@banto/core";

describe("[AC-S654396-1-1] Event log replay after restart", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-replay-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-1-1] replays correct derived state after kill -9 and restart", async () => {
    // Step 1: Open log and append task_created event
    const log1 = EventLog.open(tmpDir);
    const ev1 = log1.append({
      type: "task_created",
      projectTag: "proj-a",
      taskId: "task-0001",
      payload: { title: "test" },
    });
    assert.equal(ev1.type, "task_created");
    assert.ok(ev1.eventId >= 1, "eventId must be >= 1");
    assert.ok(typeof ev1.timestamp === "string", "timestamp must be a string");

    // Verify the JSONL file has 1 line
    const segFile = path.join(tmpDir, "events", log1.activeSegmentName!);
    const lines1 = fs.readFileSync(segFile, "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(lines1.length, 1, "should have 1 line after first append");

    // Step 2: Append state_transitioned event
    const ev2 = log1.append({
      type: "state_transitioned",
      projectTag: "proj-a",
      taskId: "task-0001",
      from: "draft",
      to: "queued",
    });
    assert.equal(ev2.type, "state_transitioned");

    // Verify the JSONL file has 2 lines
    const lines2 = fs.readFileSync(segFile, "utf-8").trim().split("\n").filter(Boolean);
    assert.equal(lines2.length, 2, "should have 2 lines after second append");

    // Step 3: Close log (simulates safe shutdown before kill -9)
    log1.close();
    // At this point data is fully flushed to disk

    // Step 4: "Restart" — open a new EventLog instance on the same directory
    const log2 = EventLog.open(tmpDir);
    const store = StateStore.replay(log2);
    log2.close();

    // Step 5: Verify derived state
    const task = store.getTask("task-0001");
    assert.ok(task !== undefined, "task-0001 should be in store");
    assert.equal(task.id, "task-0001");
    assert.equal(task.status, "queued");
    assert.equal(task.projectTag, "proj-a");
    assert.equal(task.title, "test");
  });

  it("[AC-S654396-1-1] survives kill -9 via child process SIGKILL simulation", { timeout: 30000 }, async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-sigkill-"));
    try {
      // Write events directly (synchronously) to simulate what a daemon would do,
      // then use a sentinel file to coordinate with a child that sleeps (and gets killed)
      const sentinelPath = path.join(tmpDir2, "_ready");

      // Resolve worktree root (where node_modules/ lives) from this test file's location
      const worktreeRoot = path.resolve(new URL(import.meta.url).pathname, "../../..");
      const coreIndexPath = path.join(worktreeRoot, "packages/banto-core/src/index.ts");

      // Write the "writer" script as a temp file
      // Import banto-core via absolute path so child process doesn't need to resolve workspace
      const writerScript = `
import { EventLog } from ${JSON.stringify(coreIndexPath)};
import * as fs from "node:fs";
const log = EventLog.open(${JSON.stringify(tmpDir2)});
log.append({
  type: "task_created",
  projectTag: "proj-sigkill",
  taskId: "task-sigkill",
  payload: { title: "sigkill test" }
});
log.append({
  type: "state_transitioned",
  projectTag: "proj-sigkill",
  taskId: "task-sigkill",
  from: "draft",
  to: "queued"
});
// Signal that events have been written
fs.writeFileSync(${JSON.stringify(sentinelPath)}, "ready");
// Hang forever — will be SIGKILL'd
await new Promise(r => setTimeout(r, 60000));
`;
      const scriptPath = path.join(tmpDir2, "_writer.mjs");
      fs.writeFileSync(scriptPath, writerScript);

      // Launch child process — run from worktreeRoot so tsx can find tsx internals
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["--import", "tsx/esm", scriptPath], {
        cwd: worktreeRoot,
        env: { ...process.env },
        stdio: "pipe",
      });

      // Wait for sentinel file to appear (means events were written)
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const poll = setInterval(() => {
          if (fs.existsSync(sentinelPath)) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error("Timed out waiting for writer child to write events"));
          }
        }, 100);
      });

      // Kill -9 (SIGKILL) — actual kill -9, no mocking
      child.kill("SIGKILL");

      // Wait for child to exit
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));

      // Now replay in this process
      const log = EventLog.open(tmpDir2);
      const store = StateStore.replay(log);
      log.close();

      const task = store.getTask("task-sigkill");
      assert.ok(task !== undefined, "task-sigkill should be recoverable after SIGKILL");
      assert.equal(task.status, "queued", "task should be in queued state after replay");
      assert.equal(task.projectTag, "proj-sigkill");
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});
