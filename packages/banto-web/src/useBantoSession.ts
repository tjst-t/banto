/**
 * 番頭ホストへのWS接続を React から扱うフック。
 *
 * D3/D5: キャンバスの表示状態も会話履歴もホストが真実を持つ。UIは配信されたものを描き、
 *        タブ操作もホストへ投げ返す（UI側に別の状態を作らない）。
 *        接続時に history が届くので、リロードしても会話は消えない。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CanvasTabView,
  CatalogEntryView,
  ServerEvent,
  TranscriptEntry,
} from "@banto/host/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface BantoSession {
  status: ConnectionStatus;
  sessionId: string | undefined;
  tools: string[];
  catalog: CatalogEntryView[];
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  chat: TranscriptEntry[];
  /** ターンが走っている間 true。 */
  busy: boolean;
  send(text: string): void;
  abort(): void;
  switchTab(tabId: string): void;
  closeTab(tabId: string): void;
  newSession(): void;
}

/** 差分イベントを履歴へ畳み込む。ホスト側の record() と同じ規則。 */
function applyDelta(prev: TranscriptEntry[], event: ServerEvent): TranscriptEntry[] {
  switch (event.type) {
    case "po_message":
      return [...prev, { role: "po", text: event.text }];

    case "text_delta": {
      const last = prev[prev.length - 1];
      if (last?.role === "banto") {
        return [...prev.slice(0, -1), { role: "banto", text: last.text + event.delta }];
      }
      return [...prev, { role: "banto", text: event.delta }];
    }

    case "tool_start":
      return [...prev, { role: "tool", name: event.name, state: "running" }];

    case "tool_end": {
      const index = prev.findIndex(
        (e) => e.role === "tool" && e.name === event.name && e.state === "running"
      );
      if (index === -1) return prev;
      const next = [...prev];
      next[index] = { role: "tool", name: event.name, state: event.isError ? "failed" : "ok" };
      return next;
    }

    case "turn_end":
      return event.errorMessage ? [...prev, { role: "error", text: event.errorMessage }] : prev;

    case "error":
      return [...prev, { role: "error", text: event.message }];

    default:
      return prev;
  }
}

export function useBantoSession(url: string): BantoSession {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string>();
  const [tools, setTools] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [tabs, setTabs] = useState<CanvasTabView[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [chat, setChat] = useState<TranscriptEntry[]>([]);
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

        case "history":
          // ホストが持つ会話の真実。リロード時はここで復元される
          setChat(event.entries);
          break;

        case "canvas_state":
          setTabs(event.tabs);
          setActiveTabId(event.activeTabId);
          break;

        case "turn_end":
        case "error":
          setBusy(false);
          setChat((prev) => applyDelta(prev, event));
          break;

        default:
          setChat((prev) => applyDelta(prev, event));
      }
    };

    return () => socket.close();
  }, [url]);

  const post = useCallback((message: unknown) => {
    socketRef.current?.send(JSON.stringify(message));
  }, []);

  const send = useCallback(
    (text: string) => {
      // 履歴への追加はホストからの po_message で行う（複数クライアントで揃うため）
      setBusy(true);
      post({ type: "prompt", text });
    },
    [post]
  );

  return {
    status,
    sessionId,
    tools,
    catalog,
    tabs,
    activeTabId,
    chat,
    busy,
    send,
    abort: useCallback(() => post({ type: "abort" }), [post]),
    switchTab: useCallback((tabId: string) => post({ type: "canvas_switch", tabId }), [post]),
    closeTab: useCallback((tabId: string) => post({ type: "canvas_close", tabId }), [post]),
    newSession: useCallback(() => post({ type: "new_session" }), [post]),
  };
}
