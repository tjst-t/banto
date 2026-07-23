/**
 * AC-S654396-3-2: WebSocketでリアルタイム購読、再接続時にafter_event_id指定で
 * 取りこぼしなく追いつける
 *
 * Uses the `ws` package as a real WebSocket client.
 * Daemon runs on a real socket (port=0, OS-assigned).
 * Handler direct invocation is explicitly prohibited.
 *
 * Dependency: ws (D6 rationale: Node v20 has no built-in WebSocket server API)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { WebSocket } from "ws";
import { Daemon } from "@banto/daemon";

/** Helper: open a WS connection and wait for it to be ready */
async function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Helper: receive the next message from a WS */
async function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("WebSocket message timeout"));
    }, timeoutMs);
    ws.once("message", (data: Buffer) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString("utf-8")));
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: collect N messages from a WS */
async function collectMessages(ws: WebSocket, n: number, timeoutMs = 3000): Promise<unknown[]> {
  const msgs: unknown[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`WebSocket: timeout waiting for ${n} messages, got ${msgs.length}`));
    }, timeoutMs);
    const onMsg = (data: Buffer) => {
      msgs.push(JSON.parse(data.toString("utf-8")));
      if (msgs.length >= n) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msgs);
      }
    };
    ws.on("message", onMsg);
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("[AC-S654396-3-2] WebSocket real-time subscription + resume", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let wsUrl: string;
  let base: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ws-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir });
    await daemon.start();
    base = `http://localhost:${daemon.port}`;
    wsUrl = `ws://localhost:${daemon.port}/ws`;

    // Register a project so tasks can be created
    await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a" }),
    });
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-3-2] step 1: connect and subscribe → receive subscribed ack", async () => {
    const ws = await connectWs(wsUrl);
    try {
      ws.send(JSON.stringify({ type: "subscribe", projectTag: "proj-a" }));
      const msg = await nextMessage(ws) as { type: string; projectTag: string };
      assert.equal(msg.type, "subscribed");
      assert.equal(msg.projectTag, "proj-a");
    } finally {
      ws.close();
    }
  });

  it("[AC-S654396-3-2] step 2: real-time event delivery — create task via REST, receive WS event", async () => {
    const ws = await connectWs(wsUrl);
    try {
      ws.send(JSON.stringify({ type: "subscribe", projectTag: "proj-a" }));
      // Wait for subscribed ack
      const ack = await nextMessage(ws) as { type: string };
      assert.equal(ack.type, "subscribed");

      // Set up the next-message listener BEFORE the fetch so we don't miss
      // the broadcast that fires synchronously during request handling.
      const evtPromise = nextMessage(ws, 3000);

      // Create a task via REST (triggers event broadcast during request handling)
      await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "task-ws-001", title: "WS test task" }),
      });

      // WebSocket must receive the task_created event
      const evt = await evtPromise as {
        type: string;
        eventId: number;
        payload: { type: string; projectTag: string };
      };
      assert.equal(evt.type, "event");
      assert.ok(typeof evt.eventId === "number" && evt.eventId >= 1);
      assert.equal(evt.payload.type, "task_created");
      assert.equal(evt.payload.projectTag, "proj-a");
    } finally {
      ws.close();
    }
  });

  it("[AC-S654396-3-2] step 3+4: disconnect, inject 2 events, reconnect with after_event_id → catch-up delivery", async () => {
    // Step A: subscribe and get the current last eventId
    const ws1 = await connectWs(wsUrl);
    ws1.send(JSON.stringify({ type: "subscribe", projectTag: "proj-a" }));
    await nextMessage(ws1); // subscribed ack

    // Set up listener BEFORE fetch to capture the broadcast
    const liveEvtPromise = nextMessage(ws1, 3000);

    // Inject one event while connected to get a known eventId
    await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-ws-002", title: "catch-up base" }),
    });
    const liveEvt = await liveEvtPromise as { type: string; eventId: number };
    assert.equal(liveEvt.type, "event");
    const lastSeenEventId = liveEvt.eventId;

    // Step B: disconnect
    ws1.close();
    // Give the close a moment to propagate
    await new Promise((r) => setTimeout(r, 50));

    // Step C: inject 2 events while disconnected
    await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-ws-003", title: "missed event 1" }),
    });
    await fetch(`${base}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-ws-004", title: "missed event 2" }),
    });

    // Step D: reconnect with after_event_id = lastSeenEventId
    // Collect ALL 3 messages at once (subscribed ack + 2 catch-up events)
    // to avoid the timing issue where catch-up events fire before the listener
    // is registered on a second await.
    const ws2 = await connectWs(wsUrl);
    try {
      // Register the collector BEFORE sending subscribe so no message is missed
      const allMsgsPromise = collectMessages(ws2, 3, 5000);

      ws2.send(JSON.stringify({
        type: "subscribe",
        projectTag: "proj-a",
        after_event_id: lastSeenEventId,
      }));

      // Expect: [subscribed, event(ws-003), event(ws-004)]
      const allMsgs = await allMsgsPromise as Array<Record<string, unknown>>;

      // First must be subscribed ack
      assert.equal(allMsgs[0]["type"], "subscribed", "First message must be subscribed ack");

      // Remaining 2 must be the catch-up events
      const catchUp = allMsgs.slice(1) as Array<{
        type: string;
        eventId: number;
        payload: { type: string };
      }>;

      assert.equal(catchUp.length, 2, "Must receive exactly the 2 missed events");
      assert.ok(
        catchUp.every((e) => e.eventId > lastSeenEventId),
        "All catch-up events must have eventId > lastSeenEventId"
      );
      // Both must be task_created events
      assert.ok(
        catchUp.every((e) => e.payload.type === "task_created"),
        "Both missed events must be task_created"
      );
      // Events must arrive in eventId order
      assert.ok(
        catchUp[1].eventId > catchUp[0].eventId,
        "Catch-up events must arrive in eventId order"
      );
    } finally {
      ws2.close();
    }
  });
});
