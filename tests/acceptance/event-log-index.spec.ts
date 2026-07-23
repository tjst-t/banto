/**
 * AC-S654396-1-3: 全イベントにeventId+projectタグ。
 * タスク別経緯ビューをインデックスから導出することを検証する。
 *
 * Test discipline: consumer-style — only banto-core public API is used.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventLog, EventIndex } from "@banto/core";

describe("[AC-S654396-1-3] Event IDs, project tags, and task index", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-test-index-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-1-3] all events have eventId and projectTag; task index derives history", async () => {
    // Step 1: Append events for two projects and multiple tasks (mixed order)
    const log = EventLog.open(tmpDir);

    const e1 = log.append({
      type: "task_created",
      projectTag: "proj-a",
      taskId: "task-0001",
      payload: { title: "task A1" },
    });

    const e2 = log.append({
      type: "task_created",
      projectTag: "proj-b",
      taskId: "task-0002",
      payload: { title: "task B1" },
    });

    const e3 = log.append({
      type: "state_transitioned",
      projectTag: "proj-a",
      taskId: "task-0001",
      from: "draft",
      to: "queued",
    });

    const e4 = log.append({
      type: "state_transitioned",
      projectTag: "proj-b",
      taskId: "task-0002",
      from: "draft",
      to: "planning",
    });

    const e5 = log.append({
      type: "task_created",
      projectTag: "proj-a",
      taskId: "task-0003",
      payload: { title: "task A2" },
    });

    // Verify eventId is monotonically increasing on all events
    const events = [e1, e2, e3, e4, e5];
    for (let i = 0; i < events.length; i++) {
      assert.ok(typeof events[i].eventId === "number", `event ${i} must have numeric eventId`);
      assert.ok(typeof events[i].projectTag === "string", `event ${i} must have projectTag`);
      if (i > 0) {
        assert.ok(
          events[i].eventId > events[i - 1].eventId,
          `eventId must be monotonically increasing (${events[i - 1].eventId} < ${events[i].eventId})`
        );
      }
    }

    // Step 2: getEventsByTask for task-0001
    const task0001Events = log.getEventsByTask("task-0001");
    assert.equal(task0001Events.length, 2, "task-0001 should have 2 events");
    for (const e of task0001Events) {
      assert.equal(e.projectTag, "proj-a", "task-0001 events must have projectTag=proj-a");
      assert.ok(typeof e.eventId === "number");
    }

    // Step 3: getEventsByProject for proj-b
    const projBEvents = log.getEventsByProject("proj-b");
    assert.equal(projBEvents.length, 2, "proj-b should have 2 events");
    for (const e of projBEvents) {
      assert.equal(e.projectTag, "proj-b");
    }
    // Ensure no proj-a events leaked in
    const projAInB = projBEvents.filter((e) => e.projectTag === "proj-a");
    assert.equal(projAInB.length, 0, "no proj-a events should appear in proj-b query");

    log.close();

    // Step 4: Build EventIndex and get task history
    const log2 = EventLog.open(tmpDir);
    const index = EventIndex.build(log2);
    log2.close();

    const task0001History = index.getTaskHistory("task-0001", "proj-a");
    assert.equal(task0001History.length, 2, "task-0001 history should have 2 entries");
    // Verify sorted by eventId
    assert.ok(
      task0001History[0].eventId < task0001History[1].eventId,
      "history must be sorted by eventId"
    );
    // All events in history must have projectTag
    for (const e of task0001History) {
      assert.equal(e.projectTag, "proj-a");
      assert.ok(typeof e.eventId === "number");
    }

    // Index is derived only — not persisted (D3)
    const snapshotPath = path.join(tmpDir, "snapshot.json");
    // No snapshot should exist unless explicitly rotated
    assert.equal(
      fs.existsSync(snapshotPath),
      false,
      "EventIndex.build() must not write snapshot (D3)"
    );
  });
});
