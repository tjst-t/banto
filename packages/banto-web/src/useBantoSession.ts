/**
 * 番頭ホストへのWS接続を React から扱うフック。
 *
 * D3/D5: キャンバスの表示状態も会話履歴もホストが真実を持つ。UIは配信されたものを描き、
 *        タブ操作もホストへ投げ返す（UI側に別の状態を作らない）。
 *        接続時に history が届くので、リロードしても会話は消えない。
 *
 * **会話スレッド（番頭の分身。決定2・task-0035/0037）**：ホストは会話を複数持ち、
 * イベントには常に `threadId` が載る。ここではスレッドごとに会話とキャンバスを分けて
 * 持ち、**どれを見ているか（activeThreadId）だけが UI 側の状態**になる。
 * 混ぜて持つと、あるスレッドの発話が別のスレッドのチャットに流れ込む。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CanvasTabView,
  CatalogEntryView,
  ServerEvent,
  ThreadView,
  TranscriptEntry,
} from "@banto/host/protocol";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** スレッド1本分の見えている状態。 */
interface ThreadState {
  chat: TranscriptEntry[];
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  busy: boolean;
  /** 見ていない間に届いた知らせ・発話があるか（決定35c：見えていない≠届いていない）。 */
  unread: boolean;
}

const EMPTY_THREAD: ThreadState = {
  chat: [],
  tabs: [],
  activeTabId: undefined,
  busy: false,
  unread: false,
};

export interface BantoSession {
  status: ConnectionStatus;
  sessionId: string | undefined;
  tools: string[];
  catalog: CatalogEntryView[];
  /** 開いている分身（タブに並ぶ）。 */
  threads: ThreadView[];
  /** 畳んだ分身（履歴に並ぶ）。新しく畳んだものが先頭。 */
  closedThreads: ThreadView[];
  activeThreadId: string | undefined;
  /** 見ているスレッドの状態。 */
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  chat: TranscriptEntry[];
  busy: boolean;
  /** 未読の印がついているスレッドID。 */
  unreadThreadIds: string[];
  /** 特定スレッドの会話を読む（履歴の読み取り用）。 */
  chatOf(threadId: string): TranscriptEntry[];
  send(text: string): void;
  abort(): void;
  switchTab(tabId: string): void;
  closeTab(tabId: string): void;
  /** タブをドラッグで並べ替える。順序の真実はホスト側（D3）。 */
  reorderTab(tabId: string, toIndex: number): void;
  /** POがカタログから自分でGUIを開く（決定25の人側の経路）。 */
  openView(kind: string): void;
  newSession(): void;
  /** 分身を切り替える。UI側だけの状態（ホストは全スレッドを同時に進めている）。 */
  switchThread(threadId: string): void;
  openThread(title?: string): void;
  closeThread(threadId: string): void;
  reopenThread(threadId: string): void;
}

/** 差分イベントを履歴へ畳み込む。ホスト側の record() と同じ規則。 */
function applyDelta(prev: TranscriptEntry[], event: ServerEvent): TranscriptEntry[] {
  switch (event.type) {
    case "po_message":
      return [...prev, { role: "po", text: event.text }];

    // 職人からの報告・質問（決定29）。POの発話ではないので別の行として積む
    case "notice":
      return [...prev, { role: "notice", text: event.text }];

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

/** 未読の印をつけるイベントか。自分の発話では立てない（決定35c）。 */
function marksUnread(event: ServerEvent): boolean {
  return event.type === "notice" || event.type === "text_delta";
}

export function useBantoSession(url: string): BantoSession {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string>();
  const [tools, setTools] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [allThreads, setAllThreads] = useState<ThreadView[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [byThread, setByThread] = useState<Record<string, ThreadState>>({});
  const socketRef = useRef<WebSocket>(null);
  /** 見ているスレッドを購読ハンドラから参照する（再接続させないため ref で持つ）。 */
  const activeRef = useRef<string>(undefined);
  activeRef.current = activeThreadId;

  const update = useCallback(
    (threadId: string, patch: (prev: ThreadState) => ThreadState) => {
      setByThread((prev) => ({ ...prev, [threadId]: patch(prev[threadId] ?? EMPTY_THREAD) }));
    },
    []
  );

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
          setAllThreads(event.threads);
          setActiveThreadId((current) => current ?? event.defaultThreadId);
          break;

        case "thread_state":
          setAllThreads(event.threads);
          // 見ていたスレッドが畳まれたら、開いている先頭へ移る（空の面を見せない）
          setActiveThreadId((current) => {
            const still = event.threads.find((t) => t.threadId === current && t.state === "open");
            return still ? current : event.threads.find((t) => t.state === "open")?.threadId;
          });
          break;

        case "history":
          // ホストが持つ会話の真実。リロード時はここで復元される
          update(event.threadId, (prev) => ({ ...prev, chat: event.entries }));
          break;

        case "canvas_state":
          update(event.threadId, (prev) => ({
            ...prev,
            tabs: event.tabs,
            activeTabId: event.activeTabId,
          }));
          break;

        case "turn_end":
          update(event.threadId, (prev) => ({
            ...prev,
            busy: false,
            chat: applyDelta(prev.chat, event),
          }));
          break;

        case "error": {
          // プロトコル違反の返答はスレッドに属さない（宛先を解決する前にも起きる）。
          // 見ている面に出す——どこにも出さないと、操作が黙って失敗したように見える
          const target = activeRef.current;
          if (target) {
            update(target, (prev) => ({ ...prev, busy: false, chat: applyDelta(prev.chat, event) }));
          }
          break;
        }

        default:
          update(event.threadId, (prev) => ({
            ...prev,
            chat: applyDelta(prev.chat, event),
            // 見ていないスレッドに届いたことが分かるように（決定35c）
            unread: prev.unread || (marksUnread(event) && event.threadId !== activeRef.current),
          }));
      }
    };

    return () => socket.close();
  }, [url, update]);

  const post = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  const threads = useMemo(() => allThreads.filter((t) => t.state === "open"), [allThreads]);
  const closedThreads = useMemo(
    () =>
      allThreads
        .filter((t) => t.state === "closed")
        .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
    [allThreads]
  );
  const active = (activeThreadId ? byThread[activeThreadId] : undefined) ?? EMPTY_THREAD;
  const unreadThreadIds = useMemo(
    () => Object.entries(byThread).filter(([, s]) => s.unread).map(([id]) => id),
    [byThread]
  );

  const switchThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      // 見たら未読を落とす
      update(threadId, (prev) => ({ ...prev, unread: false }));
    },
    [update]
  );

  return {
    status,
    sessionId,
    tools,
    catalog,
    threads,
    closedThreads,
    activeThreadId,
    tabs: active.tabs,
    activeTabId: active.activeTabId,
    chat: active.chat,
    busy: active.busy,
    unreadThreadIds,
    chatOf: (threadId) => byThread[threadId]?.chat ?? [],
    send: useCallback(
      (text: string) => {
        const threadId = activeThreadId;
        if (!threadId) return;
        update(threadId, (prev) => ({ ...prev, busy: true }));
        post({ type: "prompt", threadId, text });
      },
      [activeThreadId, post, update]
    ),
    abort: useCallback(
      () => post({ type: "abort", threadId: activeThreadId }),
      [activeThreadId, post]
    ),
    switchTab: useCallback(
      (tabId: string) => post({ type: "canvas_switch", threadId: activeThreadId, tabId }),
      [activeThreadId, post]
    ),
    closeTab: useCallback(
      (tabId: string) => post({ type: "canvas_close", threadId: activeThreadId, tabId }),
      [activeThreadId, post]
    ),
    reorderTab: useCallback(
      (tabId: string, toIndex: number) =>
        post({ type: "canvas_reorder", threadId: activeThreadId, tabId, toIndex }),
      [activeThreadId, post]
    ),
    openView: useCallback(
      (kind: string) => post({ type: "canvas_open", threadId: activeThreadId, kind }),
      [activeThreadId, post]
    ),
    newSession: useCallback(
      () => post({ type: "new_session", threadId: activeThreadId }),
      [activeThreadId, post]
    ),
    switchThread,
    openThread: useCallback(
      (title?: string) => post({ type: "thread_open", ...(title ? { title } : {}) }),
      [post]
    ),
    closeThread: useCallback((threadId: string) => post({ type: "thread_close", threadId }), [post]),
    reopenThread: useCallback(
      (threadId: string) => {
        post({ type: "thread_reopen", threadId });
        switchThread(threadId);
      },
      [post, switchThread]
    ),
  };
}
