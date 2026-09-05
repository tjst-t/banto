// docs/specs/v4-architecture.md §2.5「health check（実装上の留保への対応）」の実装。
// Runner↔代理サーバは実HTTP接続（§2.5、docs/notes/2026-09-03-agent-relay-http-transport.md）
// ——ネットワーク越しの接続が実際に確立したかを確認する。
// 壊れたら黙って動かない、ではなく名前を挙げてターンを中断する（規則2）。

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export class RelayHealthError extends Error {}

/**
 * system/init メッセージの mcp_servers を見て、配線した代理サーバが
 * 全て connected か確認する。1つでも connected でなければ例外を投げる——
 * このターンをそのまま進めない。
 */
export function assertRelayHealthy(messages: SDKMessage[], expectedServerNames: string[]): void {
  const init = messages.find((m) => m.type === "system" && m.subtype === "init");
  if (!init || init.type !== "system" || init.subtype !== "init") {
    throw new RelayHealthError("system/init メッセージが届いていません");
  }
  const servers = (init as { mcp_servers?: Array<{ name: string; status: string }> }).mcp_servers ?? [];
  const byName = new Map(servers.map((s) => [s.name, s.status]));

  const unhealthy = expectedServerNames.filter((name) => byName.get(name) !== "connected");
  if (unhealthy.length > 0) {
    throw new RelayHealthError(
      `代理サーバが connected になっていません: ${unhealthy.join(", ")}` +
        `（実際の状態: ${JSON.stringify(Object.fromEntries(byName))}）。`,
    );
  }
}
