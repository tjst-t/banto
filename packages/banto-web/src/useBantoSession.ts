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
 *
 * **その「どれを見ているか」は自分では持たない**——真実は URL（`viewLocation.ts`）に
 * 置き、ここは渡されたものを見る（D3）。持ってしまうと、戻る／進むとリロードで
 * 画面の記憶と URL が食い違う。ホストの都合で移らざるを得ないとき（見ていた会話が
 * 畳まれた等）は `onActiveThread` で呼び手へ返す。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Attachment,
  CanvasTabView,
  CatalogEntryView,
  ServerEvent,
  ThreadView,
  ModuleEndpointView,
  TranscriptEntry,
} from "@banto/host/protocol";

/** 接続の状態。`reconnecting` は切れて繋ぎ直している最中——画面はそのまま使える。 */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** スレッド1本分の見えている状態。 */
interface ThreadState {
  chat: TranscriptEntry[];
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  /**
   * この会話のキャンバスの状態が届いたか。**「タブが無い」と「まだ分からない」を
   * 分ける**——届く前に空だと決めつけると、URL から復元しようとしているタブを
   * 自分で捨ててしまう（接続直後は `canvas_state` が会話ごとに1通ずつ後から届く）。
   */
  canvasKnown: boolean;
  busy: boolean;
  /** 見ていない間に届いた知らせ・発話があるか（決定35c：見えていない≠届いていない）。 */
  unread: boolean;
  /** この会話で使っているモデル。**会話ごと**に持つ（PO裁定 2026-08-04）。 */
  model?: CurrentModel;
  /** 直近のターンで運んだトークン数。分かるまでは undefined（0 と偽らない）。 */
  contextTokens?: number;
  /** 書きかけの下書き。会話を移っても混ざらないよう、ここに置く。 */
  draft: string;
}

const EMPTY_THREAD: ThreadState = {
  chat: [],
  tabs: [],
  activeTabId: undefined,
  canvasKnown: false,
  busy: false,
  unread: false,
  draft: "",
};

/** いま番頭が使っているモデル（`model_state` の写し）。 */
export interface CurrentModel {
  provider: string;
  id: string;
  /** 画像を読めるか。添付の可否判定に使う。 */
  vision: boolean;
  /** 文脈に入る最大トークン数（分かるときだけ）。使用率の分母。 */
  contextWindow?: number;
}

export interface BantoSession {
  status: ConnectionStatus;
  sessionId: string | undefined;
  tools: string[];
  catalog: CatalogEntryView[];
  /** 開いている分身（タブに並ぶ）。 */
  threads: ThreadView[];
  /** 登録されているモジュールと到達先（GUI を持たないものも含む）。 */
  modules: ModuleEndpointView[];
  /** 畳んだ分身（履歴に並ぶ）。新しく畳んだものが先頭。 */
  closedThreads: ThreadView[];
  activeThreadId: string | undefined;
  /** 見ているスレッドの状態。 */
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  chat: TranscriptEntry[];
  busy: boolean;
  /** 見ている会話のキャンバスの状態が届いたか（空なのか、まだ分からないのか）。 */
  canvasKnown: boolean;
  /** 未読の印がついているスレッドID。 */
  unreadThreadIds: string[];
  /** 特定スレッドの会話を読む（履歴の読み取り用）。 */
  chatOf(threadId: string): TranscriptEntry[];
  send(text: string, attachments?: Attachment[]): void;
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
  /** いま見ている会話が使っているモデル（届くまでは undefined）。 */
  model: CurrentModel | undefined;
  /** いま見ている会話のモデルを変える。効いたかは `model` が入れ替わることで分かる。 */
  setModel(provider: string, model: string): void;
  /** いま見ている会話の書きかけ。 */
  draft: string;
  setDraft(text: string): void;
  /** いま見ている会話が直近のターンで運んだトークン数（分かるまでは undefined）。 */
  contextTokens: number | undefined;
}

/** 見る先が変わったことの伝え方。 */
export interface ActiveThreadChange {
  /**
   * 履歴に積むか。**POが自分で選んだ移動だけ積む**——番頭が別の分身を開いた・見ていた
   * 会話が畳まれた、を積むと、戻るがもう無い場所へ帰ろうとする。
   */
  push: boolean;
}

export interface BantoSessionOptions {
  /** いま見ている会話（真実は URL）。 */
  activeThreadId: string | undefined;
  /** 見る先を変えたい／変えざるを得ないとき。呼び手（＝URL）が受けて動かす。 */
  onActiveThread(threadId: string | undefined, change: ActiveThreadChange): void;
}

/** 差分イベントを履歴へ畳み込む。ホスト側の record() と同じ規則。
 * text_delta と tool_end はオブジェクト参照を維持（React.memo の最適化）。 */
function applyDelta(prev: TranscriptEntry[], event: ServerEvent): TranscriptEntry[] {
  switch (event.type) {
    case "po_message":
      return [
        ...prev,
        {
          role: "po",
          text: event.text,
          ...(event.attachments ? { attachments: event.attachments } : {}),
        },
      ];

    // 職人からの報告・質問（決定29）。POの発話ではないので別の行として積む
    case "notice":
      return [...prev, { role: "notice", source: event.source, text: event.text }];

    case "text_delta": {
      const last = prev[prev.length - 1];
      if (last?.role === "banto") {
        // 既存オブジェクトを in-place 更新して参照を維持
        last.text += event.delta;
        return [...prev];
      }
      return [...prev, { role: "banto", text: event.delta }];
    }

    // 思考の差分。本文と同じく、最後の思考へ足して参照を維持する
    case "reasoning_delta": {
      const last = prev[prev.length - 1];
      if (last?.role === "reasoning") {
        last.text += event.delta;
        return [...prev];
      }
      return [...prev, { role: "reasoning", text: event.delta }];
    }

    // 考え終わり。時間だけを入れる（本文はもう入っている）
    case "reasoning_end": {
      const last = prev[prev.length - 1];
      if (last?.role !== "reasoning") return prev;
      last.durationMs = event.durationMs;
      return [...prev];
    }

    case "tool_start":
      return [
        ...prev,
        {
          role: "tool",
          name: event.name,
          state: "running",
          ...(event.input !== undefined ? { input: event.input } : {}),
        },
      ];

    case "tool_end": {
      const index = prev.findIndex(
        (e) => e.role === "tool" && e.name === event.name && e.state === "running"
      );
      if (index === -1) return prev;
      // in-place mutation: 同一参照を維持して ChatRow の再描画を抑制
      const tool = prev[index] as { role: "tool"; state: string; output?: unknown };
      tool.state = event.isError ? "failed" : "ok";
      if (event.output !== undefined) tool.output = event.output;
      return [...prev];
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
  // 思考も「動き出した」印。本文より先に届くので、これを見落とすと気づくのが遅れる
  return event.type === "notice" || event.type === "text_delta" || event.type === "reasoning_delta";
}

export function useBantoSession(url: string, options: BantoSessionOptions): BantoSession {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sessionId, setSessionId] = useState<string>();
  const [tools, setTools] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntryView[]>([]);
  const [allThreads, setAllThreads] = useState<ThreadView[]>([]);
  const [modules, setModules] = useState<ModuleEndpointView[]>([]);
  const [byThread, setByThread] = useState<Record<string, ThreadState>>({});
  const activeThreadId = options.activeThreadId;
  const socketRef = useRef<WebSocket>(null);
  /** 見ているスレッドを購読ハンドラから参照する（再接続させないため ref で持つ）。 */
  const activeRef = useRef<string>(undefined);
  activeRef.current = activeThreadId;
  /** 見る先の変更の伝え先。**接続を張り直させないため ref 越しに呼ぶ**（下の効果の deps に入れない）。 */
  const onActiveThreadRef = useRef(options.onActiveThread);
  onActiveThreadRef.current = options.onActiveThread;
  /**
   * 自分が開いた会話へ自動で移るための印。
   *
   * ＋ や「新しい会話」を押したのに元の会話に留まるのは、押した意図と食い違う。
   * **自分が開いたときだけ**移る——番頭が別の分身を開いたときに画面を奪われないため
   * （決定2「目の前の話は壊れない」）。
   */
  const followNewThread = useRef(false);
  /** すでに知っているスレッド。新しく現れた1本を見つけるのに使う。 */
  const knownThreadIds = useRef(new Set<string>());

  const update = useCallback(
    (threadId: string, patch: (prev: ThreadState) => ThreadState) => {
      setByThread((prev) => ({ ...prev, [threadId]: patch(prev[threadId] ?? EMPTY_THREAD) }));
    },
    []
  );

  /**
   * ホストが持つ「喋っている最中か」を各スレッドの状態へ反映する（D3）。
   *
   * 再接続・再読み込みのときに要る——`turn_start` は接続前に流れているので、
   * これが無いと**進行中のターンに対して中断ボタンが出ない**まま復帰する。
   */
  const syncStreaming = useCallback(
    (threads: ThreadView[]) => {
      for (const view of threads) {
        update(view.threadId, (prev) =>
          prev.busy === view.streaming ? prev : { ...prev, busy: view.streaming }
        );
      }
    },
    [update]
  );

  /**
   * 各会話が使っているモデルを一覧から取り込む（D3：真実はホスト側）。
   *
   * **新しく開いた会話にも要る**——`model_state` は接続直後と切替のときにしか流れないので、
   * 一覧の更新（`thread_state`）でしか存在を知らない会話はモデルが空のままになる
   * （PO報告 2026-08-04：新規作成した会話でモデルが表示されなかった）。
   */
  const syncModels = useCallback(
    (threads: ThreadView[]) => {
      for (const view of threads) {
        if (!view.model) continue;
        update(view.threadId, (prev) =>
          prev.model?.provider === view.model?.provider && prev.model?.id === view.model?.id
            ? prev
            : { ...prev, model: view.model }
        );
      }
    },
    [update]
  );

  useEffect(() => {
    // 繋ぎ直しのために、この効果の中で1本ずつ張り替える。
    // **切れたら勝手に繋ぎ直す**——ホストを入れ直すたびにPOが手で再読み込みするのは、
    // 会話が残るようになった（task-0036）いま、ただの手間でしかない
    let closedByUs = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const connect = (): void => {
      const socket = new WebSocket(url);
      socketRef.current = socket;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");

    socket.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    socket.onclose = () => {
      if (closedByUs) return;
      setStatus("reconnecting");
      // 待ち時間を伸ばしていく（上限5秒）。ホストが落ちている間、毎秒叩き続けない
      const wait = Math.min(500 * 2 ** attempt, 5000);
      attempt += 1;
      retryTimer = setTimeout(connect, wait);
    };
    // I2: 失敗を握りつぶさない。onclose が続けて呼ばれるので繋ぎ直しはそちらに任せる
    socket.onerror = () => setStatus("reconnecting");

    socket.onmessage = (raw: MessageEvent<string>) => {
      const event = JSON.parse(raw.data) as ServerEvent;
      switch (event.type) {
        case "welcome":
          setSessionId(event.sessionId);
          setTools(event.tools);
          setCatalog(event.catalog);
          setModules(event.modules ?? []);
          setAllThreads(event.threads);
          syncStreaming(event.threads);
          syncModels(event.threads);
          knownThreadIds.current = new Set(event.threads.map((t) => t.threadId));
          // 前に見ていた会話（URL に残っている）がまだ開いていれば、そこへ帰る。
          // 畳まれていた／もう無いときだけ既定へ落とす——**位置を差し替えるだけ**なので
          // 履歴には積まない（戻ると消えた会話へ帰ろうとするため）
          if (!event.threads.some((t) => t.threadId === activeRef.current && t.state === "open")) {
            onActiveThreadRef.current(event.defaultThreadId, { push: false });
          }
          break;

        case "thread_state": {
          const appeared = event.threads.find(
            (t) => !knownThreadIds.current.has(t.threadId) && t.state === "open"
          );
          knownThreadIds.current = new Set(event.threads.map((t) => t.threadId));
          setAllThreads(event.threads);
          syncStreaming(event.threads);
          syncModels(event.threads);
          // 自分が開いた会話へ移る（押した意図に合わせる）。**自分で開いたものは履歴に積む**
          if (appeared && followNewThread.current) {
            followNewThread.current = false;
            onActiveThreadRef.current(appeared.threadId, { push: true });
            break;
          }
          // 見ていたスレッドが畳まれたら、開いている先頭へ移る（空の面を見せない）。
          // こちらは自分で選んだ移動ではないので積まない
          if (!event.threads.some((t) => t.threadId === activeRef.current && t.state === "open")) {
            onActiveThreadRef.current(event.threads.find((t) => t.state === "open")?.threadId, {
              push: false,
            });
          }
          break;
        }

        case "history":
          // ホストが持つ会話の真実。リロード時はここで復元される
          update(event.threadId, (prev) => ({ ...prev, chat: event.entries }));
          break;

        case "canvas_state":
          update(event.threadId, (prev) => ({
            ...prev,
            tabs: event.tabs,
            activeTabId: event.activeTabId,
            canvasKnown: true,
          }));
          break;

        // 忙しさの真実はホストが持つ（D3）。職人の報告で始まったターンもここで拾えるので、
        // POが送ったときだけ中断ボタンが出る、という取りこぼしが起きない
        case "turn_start":
          update(event.threadId, (prev) => ({ ...prev, busy: true }));
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

        // その会話が使っているモデル。会話ごとに持つ（切り替えても他の会話は変わらない）
        case "model_state":
          update(event.threadId, (prev) => ({
            ...prev,
            model: {
              provider: event.provider,
              id: event.id,
              vision: event.vision,
              ...(event.contextWindow ? { contextWindow: event.contextWindow } : {}),
            },
          }));
          break;

        // その会話が文脈をどれだけ使っているか（実測）
        case "context_state":
          update(event.threadId, (prev) => ({ ...prev, contextTokens: event.tokens }));
          break;

        default:
          update(event.threadId, (prev) => ({
            ...prev,
            chat: applyDelta(prev.chat, event),
            // 見ていないスレッドに届いたことが分かるように（決定35c）
            unread: prev.unread || (marksUnread(event) && event.threadId !== activeRef.current),
          }));
      }
    };

    };

    connect();
    return () => {
      closedByUs = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [url, update, syncStreaming, syncModels]);

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
  // memoized: byThread または activeThreadId が変わったときのみ参照が変わる
  // （active_delta で text_delta が連続しても active が作り直されない）
  const active = useMemo<ThreadState>(
    () => (activeThreadId ? byThread[activeThreadId] : undefined) ?? EMPTY_THREAD,
    [activeThreadId, byThread]
  );
  const activeTabs = useMemo(
    () => active.tabs,
    [active.tabs]
  );
  const activeTabId = useMemo(
    () => active.activeTabId,
    [active.activeTabId]
  );
  const activeChat = useMemo(
    () => active.chat,
    [active.chat]
  );
  const activeBusy = useMemo(
    () => active.busy,
    [active.busy]
  );
  const activeModel = useMemo(() => active.model, [active.model]);
  const activeDraft = useMemo(() => active.draft, [active.draft]);
  const activeTokens = useMemo(() => active.contextTokens, [active.contextTokens]);
  const unreadThreadIds = useMemo(
    () => Object.entries(byThread).filter(([, s]) => s.unread).map(([id]) => id),
    [byThread]
  );

  const switchThread = useCallback((threadId: string) => {
    // POが自分で選んだ移動なので履歴に積む（戻るで前の会話へ帰れる）。
    // 未読を落とすのは下の効果——戻る／進むで移ったときも同じように落ちる必要がある
    onActiveThreadRef.current(threadId, { push: true });
  }, []);

  // 見ている会話の未読は落とす。**移った経路を問わない**——タブを押したときだけ落とすと、
  // 戻る／進むやリロードで開いた会話に印が残ったままになる
  useEffect(() => {
    if (!activeThreadId) return;
    setByThread((prev) => {
      const state = prev[activeThreadId];
      // 参照を変えない（無駄な再描画を起こさない）
      if (!state?.unread) return prev;
      return { ...prev, [activeThreadId]: { ...state, unread: false } };
    });
  }, [activeThreadId]);

  const chatOf = (threadId: string): TranscriptEntry[] => byThread[threadId]?.chat ?? [];

  // React.memo on ChatRow 側の再描画を抑えるため、session オブジェクトの参照を安定させる。
  // 内部 state が変わらなくても毎回 new object だと App が無駄に再描画される。
  // コールバックを const 変数として定義し、useMemo deps で安定参照を保証。
  const send = useCallback(
    (text: string, attachments?: Attachment[]) => {
      const threadId = activeThreadId;
      if (!threadId) return;
      update(threadId, (prev) => ({ ...prev, busy: true }));
      post({
        type: "prompt",
        threadId,
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    },
    [activeThreadId, post, update]
  );

  const abort = useCallback(
    () => post({ type: "abort", threadId: activeThreadId }),
    [activeThreadId, post]
  );

  // モデルは会話ごと。**いま見ている会話にだけ**効かせる
  const setModel = useCallback(
    (provider: string, model: string) =>
      post({ type: "set_model", threadId: activeThreadId, provider, model }),
    [activeThreadId, post]
  );

  /**
   * 書きかけを覚える。**会話ごと**に持つ——移った先に前の会話の書きかけが出ると、
   * そのまま送ってしまう（PO報告 2026-08-04）。
   */
  const setDraft = useCallback(
    (text: string) => {
      const threadId = activeThreadId;
      if (!threadId) return;
      update(threadId, (prev) => (prev.draft === text ? prev : { ...prev, draft: text }));
    },
    [activeThreadId, update]
  );

  const switchTab = useCallback(
    (tabId: string) => post({ type: "canvas_switch", threadId: activeThreadId, tabId }),
    [activeThreadId, post]
  );

  const closeTab = useCallback(
    (tabId: string) => post({ type: "canvas_close", threadId: activeThreadId, tabId }),
    [activeThreadId, post]
  );

  const reorderTab = useCallback(
    (tabId: string, toIndex: number) =>
      post({ type: "canvas_reorder", threadId: activeThreadId, tabId, toIndex }),
    [activeThreadId, post]
  );

  const openView = useCallback(
    (kind: string) => post({ type: "canvas_open", threadId: activeThreadId, kind }),
    [activeThreadId, post]
  );

  const newSession = useCallback(() => {
    followNewThread.current = true;
    post({ type: "new_session", threadId: activeThreadId });
  }, [activeThreadId, post]);

  const openThread = useCallback(
    (title?: string) => {
      followNewThread.current = true;
      post({ type: "thread_open", ...(title ? { title } : {}) });
    },
    [post]
  );

  const closeThread = useCallback(
    (threadId: string) => post({ type: "thread_close", threadId }),
    [post]
  );

  const reopenThread = useCallback(
    (threadId: string) => {
      post({ type: "thread_reopen", threadId });
      switchThread(threadId);
    },
    [post, switchThread]
  );

  const session = useMemo<BantoSession>(
    () => ({
      status,
      sessionId,
      tools,
      catalog,
      modules,
      threads,
      closedThreads,
      activeThreadId,
      tabs: active.tabs,
      activeTabId: active.activeTabId,
      canvasKnown: active.canvasKnown,
      chat: active.chat,
      busy: active.busy,
      unreadThreadIds,
      chatOf,
      send,
      abort,
      switchTab,
      closeTab,
      reorderTab,
      openView,
      newSession,
      switchThread,
      openThread,
      closeThread,
      reopenThread,
      model: active.model,
      setModel,
      draft: active.draft,
      setDraft,
      contextTokens: active.contextTokens,
    }),
    [
      status,
      sessionId,
      tools,
      catalog,
      modules,
      threads,
      closedThreads,
      activeThreadId,
      activeTabs,
      activeTabId,
      activeChat,
      activeBusy,
      unreadThreadIds,
      byThread,
      send,
      abort,
      switchTab,
      closeTab,
      reorderTab,
      openView,
      newSession,
      switchThread,
      openThread,
      closeThread,
      reopenThread,
      chatOf,
      setModel,
      setDraft,
      activeModel,
      activeDraft,
      activeTokens,
    ]
  );

  return session;
}
