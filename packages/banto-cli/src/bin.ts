#!/usr/bin/env node
/**
 * banto CLI entry point.
 *
 * Subcommands:
 *   banto status              - Show daemon health, registered projects, task summary
 *   banto events --follow     - Stream events via WebSocket (SIGINT → exit 0)
 *   banto events --follow --after <id>  - Resume from after_event_id
 *
 * D5: no logic here; delegates to DaemonClient (HTTP) and WsEventFollower (WS).
 * I2: connection errors exit with code 1 + stderr message.
 * D6: ws package used for WebSocket client (Node v20 has no built-in WS client;
 *     ws is already a workspace dependency in banto-daemon, reused here).
 */

import { DaemonClient, DaemonConnectionError, DaemonApiError } from "@banto/core";
import { cmdStatus } from "./cmd-status.js";
import { cmdEvents } from "./cmd-events.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "status": {
      const client = new DaemonClient();
      await cmdStatus(client);
      break;
    }
    case "events": {
      const followIdx = args.indexOf("--follow");
      if (followIdx === -1) {
        process.stderr.write("Usage: banto events --follow [--after <event_id>]\n");
        process.exit(1);
      }
      const afterIdx = args.indexOf("--after");
      const afterId = afterIdx !== -1 ? parseInt(args[afterIdx + 1] ?? "", 10) : undefined;
      if (afterIdx !== -1 && (isNaN(afterId as number))) {
        process.stderr.write("--after requires a numeric event ID\n");
        process.exit(1);
      }
      const client = new DaemonClient();
      await cmdEvents(client, afterId);
      break;
    }
    default: {
      process.stderr.write(
        `banto: unknown subcommand '${subcommand ?? ""}'\n` +
          "Usage:\n" +
          "  banto status\n" +
          "  banto events --follow [--after <event_id>]\n"
      );
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof DaemonConnectionError || err instanceof DaemonApiError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`Unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
