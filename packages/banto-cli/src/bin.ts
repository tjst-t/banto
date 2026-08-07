#!/usr/bin/env node
/**
 * kobo CLI entry point（Kobo＝統治基盤のクライアント）。
 *
 * **bin 名は `kobo`**（task-0061 a4）。以前は `banto` で、番頭ホスト（`@banto/host`）と
 * 衝突しており、どちらが起動するかが導入順に依存していた。`banto` は番頭のもの——
 * PO が打つのは番頭で、これは Kobo の帳簿を覗くための道具である。
 *
 * Subcommands:
 *   kobo status              - Show daemon health, registered projects, task summary
 *   kobo ready               - いま着手できる仕事（依存・スコープ重複・quota を通ったもの）
 *   kobo events --follow     - Stream events via WebSocket (SIGINT → exit 0)
 *   kobo events --follow --after <id>  - Resume from after_event_id
 *
 * D5: no logic here; delegates to DaemonClient (HTTP) and WsEventFollower (WS).
 * I2: connection errors exit with code 1 + stderr message.
 * D6: ws package used for WebSocket client (Node v20 has no built-in WS client;
 *     ws is already a workspace dependency in banto-daemon, reused here).
 */

import { DaemonClient, DaemonConnectionError, DaemonApiError } from "@banto/core";
import { cmdStatus } from "./cmd-status.js";
import { cmdEvents } from "./cmd-events.js";
import { cmdReady } from "./cmd-ready.js";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "status": {
      const client = new DaemonClient();
      await cmdStatus(client);
      break;
    }
    case "ready": {
      // いま着手できる仕事（task-0001）。`--project` で絞れる
      const projectIdx = args.indexOf("--project");
      const projectTag = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
      if (projectIdx !== -1 && (!projectTag || projectTag.startsWith("--"))) {
        process.stderr.write("--project には名前が要ります\n");
        process.exit(1);
      }
      const client = new DaemonClient();
      await cmdReady(client, projectTag);
      break;
    }
    case "events": {
      const followIdx = args.indexOf("--follow");
      if (followIdx === -1) {
        process.stderr.write("Usage: kobo events --follow [--after <event_id>]\n");
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
          "  kobo status\n" +
          "  kobo ready [--project <name>]\n" +
          "  kobo events --follow [--after <event_id>]\n"
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
