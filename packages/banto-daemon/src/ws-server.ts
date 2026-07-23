/**
 * WebSocket event subscription server.
 *
 * Protocol:
 *   Client → Server: { type: "subscribe", projectTag: string, after_event_id?: number }
 *   Server → Client: { type: "subscribed", projectTag: string }
 *   Server → Client: { type: "event", eventId: number, payload: OrchestrationEvent }
 *
 * Resume semantics: if after_event_id is provided, daemon replays all events
 * with eventId > after_event_id before transitioning to live delivery (zero gap).
 *
 * D5: no logic here beyond pub/sub mechanics — event sourcing lives in banto-core.
 * I2: errors not swallowed; malformed messages are logged and connection closed.
 */

// D6: ws — Node v20 has no built-in WebSocket server API (only the client-side WebSocket is available from v21+).
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import type { OrchestrationEvent } from "@banto/core";

interface SubscribeMessage {
  type: "subscribe";
  projectTag: string;
  after_event_id?: number;
}

/** Per-connection subscription state */
interface Subscriber {
  ws: WebSocket;
  projectTag: string;
}

/** Callback to fetch all events for a project (from EventLog) */
export type EventsFetcher = (projectTag: string) => OrchestrationEvent[];

export class WsEventServer {
  private readonly wss: WebSocketServer;
  private readonly subscribers: Set<Subscriber> = new Set();
  private readonly getEvents: EventsFetcher;

  constructor(httpServer: Server, getEvents: EventsFetcher) {
    this.getEvents = getEvents;
    this.wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
      this.handleConnection(ws);
    });
  }

  private handleConnection(ws: WebSocket): void {
    ws.on("message", (data: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString("utf-8"));
      } catch {
        // I2: malformed message — close with protocol error
        ws.close(1007, "invalid JSON");
        return;
      }

      if (
        typeof msg !== "object" ||
        msg === null ||
        (msg as Record<string, unknown>)["type"] !== "subscribe"
      ) {
        ws.close(1008, "unsupported message type");
        return;
      }

      const sub = msg as SubscribeMessage;
      if (typeof sub.projectTag !== "string") {
        ws.close(1008, "missing projectTag");
        return;
      }

      const subscriber: Subscriber = { ws, projectTag: sub.projectTag };
      this.subscribers.add(subscriber);

      ws.on("close", () => {
        this.subscribers.delete(subscriber);
      });

      // Confirm subscription
      ws.send(JSON.stringify({ type: "subscribed", projectTag: sub.projectTag }));

      // Resume: replay events after after_event_id before live delivery
      if (typeof sub.after_event_id === "number") {
        const afterId = sub.after_event_id;
        const allEvents = this.getEvents(sub.projectTag);
        const catchUpEvents = allEvents.filter((e) => e.eventId > afterId);
        for (const evt of catchUpEvents) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "event", eventId: evt.eventId, payload: evt }));
          }
        }
      }
    });

    ws.on("error", (err: Error) => {
      // I2: log error to stderr, do not swallow
      process.stderr.write(`[banto-daemon] WebSocket error: ${err.message}\n`);
    });
  }

  /**
   * Broadcast a new event to all subscribers for the event's projectTag.
   * Called by the daemon whenever a new event is appended to the EventLog.
   */
  broadcast(event: OrchestrationEvent): void {
    const msg = JSON.stringify({ type: "event", eventId: event.eventId, payload: event });
    for (const sub of this.subscribers) {
      if (sub.projectTag === event.projectTag && sub.ws.readyState === WebSocket.OPEN) {
        sub.ws.send(msg);
      }
    }
  }

  /** Close the WebSocket server gracefully. */
  close(cb?: () => void): void {
    this.wss.close(cb);
  }
}
