/**
 * 番頭ホストへのWS接続を React から扱うフック。
 *
 * D3/D5: キャンバスの表示状態はホストが持つ真実をそのまま保持するだけで、UI側で加工・
 *        再計算しない。チャットの表示履歴だけは描画のためにUIが組み立てる。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CanvasTabView,
  CatalogEntryView,
  ServerEvent,
} from "@banto/host/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** チャットに描くための1行。 */
export type ChatEntry =
  | { kind: "po"; text: string }
  | { kind: "banto"; text: string }
  | { kind: "tool"; name: string; state: "running" | "ok" | "failed" }
  | { kind: "error"; text: string };

export interface BantoSession {
  status: ConnectionStatus;
  sessionId: string | undefined;
  tools: string[];
  catalog: CatalogEntryView[];
  /** ホストから配信されたキャンバスの表示状態（D3：UIは独自state を持たない）。 */
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  chat: ChatEntry[];
  /** ターンが走っている間 true。 */
  busy: boolean;
  send(text: string): void;
  abort(): void;
}

export function useBantoSession(url: string): BantoSession {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string>();
  const [tools, setTools] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [tabs, setTabs] = useState<CanvasTabView[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const socketRef = useRef<WebSocket>(null);

  useEffect(() => {
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setStatus("open");
    socket.onclose = () => setStatus("closed");

    socket.onmessage = (raw: MessageEvent<string>) => {
      const event = JSON.parse(raw.data) as ServerEvent;
      switch (event.type) {
        case "welcome":
          setSessionId(event.sessionId);
          setTools(event.tools);
          setCatalog(event.catalog);
          break;

        case "canvas_state":
          setTabs(event.tabs);
          setActiveTabId(event.activeTabId);
          break;

        case "text_delta":
          // 直前が番頭の発話ならそこへ追記、そうでなければ新しい行を起こす
          setChat((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === "banto") {
              return [...prev.slice(0, -1), { kind: "banto", text: last.text + event.delta }];
            }
            return [...prev, { kind: "banto", text: event.delta }];
          });
          break;

        case "tool_start":
          setChat((prev) => [...prev, { kind: "tool", name: event.name, state: "running" }]);
          break;

        case "tool_end":
          setChat((prev) => {
            const index = prev.findIndex(
              (e) => e.kind === "tool" && e.name === event.name && e.state === "running"
            );
            if (index === -1) return prev;
            const next = [...prev];
            next[index] = { kind: "tool", name: event.name, state: event.isError ? "failed" : "ok" };
            return next;
          });
          break;

        case "turn_end":
          setBusy(false);
          if (event.errorMessage) {
            setChat((prev) => [...prev, { kind: "error", text: event.errorMessage! }]);
          }
          break;

        case "error":
          setBusy(false);
          setChat((prev) => [...prev, { kind: "error", text: event.message }]);
          break;
      }
    };

    return () => socket.close();
  }, [url]);

  const send = useCallback((text: string) => {
    setChat((prev) => [...prev, { kind: "po", text }]);
    setBusy(true);
    socketRef.current?.send(JSON.stringify({ type: "prompt", text }));
  }, []);

  const abort = useCallback(() => {
    socketRef.current?.send(JSON.stringify({ type: "abort" }));
  }, []);

  return { status, sessionId, tools, catalog, tabs, activeTabId, chat, busy, send, abort };
}
