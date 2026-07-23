/**
 * banto events --follow: stream events from all projects via WebSocket.
 *
 * Protocol (mirrors ws-server.ts):
 *   Client → { type: "subscribe", projectTag: string, after_event_id?: number }
 *   Server → { type: "subscribed", projectTag: string }
 *   Server → { type: "event", eventId: number, payload: OrchestrationEvent }
 *
 * Because a single WS connection subscribes to one projectTag at a time,
 * this command fetches the project list first, then opens one WS connection
 * per project and multiplexes output to stdout.
 *
 * SIGINT → close all connections cleanly → exit 0 (I2: no error on SIGINT).
 *
 * D5: display logic only; all data from daemon.
 * D6: ws package (Node v20 has no built-in WebSocket client; ws is already
 *     a workspace dependency in banto-daemon, reused here).
 */

import { WebSocket } from "ws";
import { DaemonClient, DaemonConnectionError } from "@banto/core";

/** Convert the HTTP base URL to a WS URL. */
function toWsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://") + "/ws";
}

interface WsEventMessage {
  type: "event";
  eventId: number;
  payload: Record<string, unknown>;
}

interface WsSubscribedMessage {
  type: "subscribed";
  projectTag: string;
}

type WsMessage = WsEventMessage | WsSubscribedMessage | { type: string };

export async function cmdEvents(client: DaemonClient, afterEventId?: number): Promise<void> {
  // Ensure daemon is reachable (throws DaemonConnectionError if not)
  await client.health();

  const projects = await client.listProjects();
  const wsUrl = toWsUrl(client.baseUrl);

  if (projects.length === 0) {
    process.stdout.write(`Listening for events (no projects registered yet)...\n`);
    // Keep open so future projects can be added; wait for SIGINT
    await waitForSigint([]);
    return;
  }

  process.stdout.write(`Connecting to ${wsUrl}...\n`);

  const connections: WebSocket[] = [];

  for (const project of projects) {
    const ws = new WebSocket(wsUrl);
    connections.push(ws);

    ws.on("open", () => {
      const msg: Record<string, unknown> = {
        type: "subscribe",
        projectTag: project.id,
      };
      if (typeof afterEventId === "number") {
        msg["after_event_id"] = afterEventId;
      }
      ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data: Buffer) => {
      let msg: WsMessage;
      try {
        msg = JSON.parse(data.toString("utf-8")) as WsMessage;
      } catch {
        // I2: malformed message logged to stderr, not swallowed
        process.stderr.write(`[banto events] malformed message from server\n`);
        return;
      }

      if (msg.type === "subscribed") {
        const subMsg = msg as WsSubscribedMessage;
        process.stdout.write(`Listening for events on project: ${subMsg.projectTag}\n`);
      } else if (msg.type === "event") {
        const evtMsg = msg as WsEventMessage;
        const payload = evtMsg.payload;
        const timestamp = typeof payload["timestamp"] === "string" ? payload["timestamp"] : "";
        const type = typeof payload["type"] === "string" ? payload["type"] : "unknown";
        const taskId = typeof payload["taskId"] === "string" ? ` taskId=${payload["taskId"]}` : "";
        const projTag = typeof payload["projectTag"] === "string" ? ` project=${payload["projectTag"]}` : "";
        process.stdout.write(
          `event #${evtMsg.eventId} [${timestamp}] ${type}${projTag}${taskId}\n`
        );
      }
    });

    ws.on("error", (err: Error) => {
      // I2: log to stderr, do not swallow
      process.stderr.write(`[banto events] WebSocket error: ${err.message}\n`);
    });

    ws.on("close", (_code: number, reason: Buffer) => {
      const reasonStr = reason.toString("utf-8");
      if (reasonStr) {
        process.stderr.write(`[banto events] connection closed: ${reasonStr}\n`);
      }
    });
  }

  await waitForSigint(connections);
}

function waitForSigint(connections: WebSocket[]): Promise<void> {
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      for (const ws of connections) {
        try {
          ws.close();
        } catch {
          // best-effort close
        }
      }
      resolve();
      // Force exit after cleanup: the ws library may keep the event loop
      // alive with internal timers even after socket.close(). Using
      // process.exit(0) ensures SIGINT always results in a clean exit 0.
      process.exit(0);
    };
    process.once("SIGINT", cleanup);
  });
}

export { DaemonConnectionError };
