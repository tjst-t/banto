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
  InboxItemView,
  TranscriptEntry,
} from "@banto/host/protocol";

/** 接続の状態。`reconnecting` は切れて繋ぎ直している最中——画面はそのまま使える。 */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** スレッド1本分の見えている状態。 */
interface ThreadState {
  chat: TranscriptEntry[];
  /**
   * この会話の履歴が届いているか。**「発言が無い」と「まだ取っていない」を分ける**——
   * 接続時に配られるのは見ている会話の分だけなので（`history_request`）、
   * 空の chat は「まだ取っていない」ことのほうが多い。
   *
   * 繋ぎ直したら全部 false に戻す。切れている間の差分を取りこぼしているので、
   * 手元の写しはもう当てにできない（移った先で取り直す）。
   */
  historyLoaded: boolean;
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
  historyLoaded: false,
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
  /** 登録されているモジュールと到達先（GUI を持たないものも含む）。 */
  modules: ModuleEndpointView[];
  /**
   * 幹の一覧（＝**プロジェクトの一覧**。PO裁定 2026-08-09）。レールに並ぶ列。
   * ホストが立ち上がりきる前だけ空——空状態として扱う。
   */
  trunks: ThreadView[];
  /** 開いている枝。**レールの点**として全部出る（埋没しない不変条件の③）。 */
  branches: ThreadView[];
  /** 畳んだ会話（履歴に並ぶ。幹・枝を問わない）。新しく畳んだものが先頭。 */
  closedThreads: ThreadView[];
  /** 会話を1本引く（枝の札は参照なので、描くたびにここから引き直す）。 */
  threadOf(threadId: string): ThreadView | undefined;
  /** いま見ている会話（幹または枝）。 */
  activeThreadId: string | undefined;
  /** 見ている会話のキャンバス（＝作業する面。決定79）。 */
  tabs: CanvasTabView[];
  activeTabId: string | undefined;
  /** 見ている会話のキャンバスの状態が届いたか（空なのか、まだ分からないのか）。 */
  canvasKnown: boolean;
  /** 未読の印がついている会話ID。 */
  unreadThreadIds: string[];
  /** その会話の発話。**列ごとに引く**——幹と枝が同時に出るため。 */
  chatOf(threadId: string): TranscriptEntry[];
  /** その会話でいま番頭が喋っているか。 */
  busyOf(threadId: string): boolean;
  /** その会話の書きかけ。 */
  draftOf(threadId: string): string;
  /** その会話が使っているモデル。 */
  modelOf(threadId: string): CurrentModel | undefined;
  /** その会話が直近のターンで運んだトークン数（分かるまでは undefined）。 */
  contextTokensOf(threadId: string): number | undefined;
  /**
   * その会話の履歴を手元に用意する（無ければホストへ頼む）。
   * 中身を出す面は描く前にこれを呼ぶ——接続時に届くのは見ている会話の分だけ。
   */
  ensureHistory(threadId: string): void;
  /** その会話の履歴が手元にあるか。「発言が無い」と「まだ取っていない」を分ける。 */
  historyLoaded(threadId: string): boolean;
  send(threadId: string, text: string, attachments?: Attachment[]): void;
  abort(threadId: string): void;
  setDraft(threadId: string, text: string): void;
  setModel(threadId: string, provider: string, model: string): void;
  switchTab(tabId: string): void;
  closeTab(tabId: string): void;
  /** タブをドラッグで並べ替える。順序の真実はホスト側（D3）。 */
  reorderTab(tabId: string, toIndex: number): void;
  /** POがカタログから自分で面を開く（決定25の人側の経路）。 */
  openView(kind: string, params?: Record<string, unknown>): void;
  /** 見る会話を移る。 */
  switchThread(threadId: string): void;
  /**
   * 枝を開く（決定77）。**還す条件と理由は必須**——書けないものは枝にしない。
   * どの幹の枝になるかは `threadId`（いま居る会話）で決まる。
   */
  openBranch(spec: {
    threadId?: string;
    title: string;
    returnCondition: string;
    reason: string;
  }): void;
  /** 枝を畳んで幹へ還す（決定77）。結論は必須。 */
  mergeBranch(threadId: string, conclusion: string): void;
  /** 畳んだ枝を開き直す。 */
  reopenThread(threadId: string): void;
  /** 会話に名前を付け直す（番頭の `thread.rename` と同じ結果。決定25の人側）。 */
  renameThread(threadId: string, title: string): void;
  /**
   * **いま章を畳む**（提案§3.2 の人側）。閾値に達していなくても畳む。
   * 畳めたことは知らせとして会話に出る——ここでは楽観的に何も書き換えない（D3）。
   */
  closeChapter(threadId: string): void;
  /** 取次に積まれているもの（答えの出たものも含む）。会話に紐づかない。 */
  inbox: InboxItemView[];
  /** まだ答えの出ていない数。レールの札に出る唯一の数字。 */
  inboxPending: number;
  /** 一通に答える。会話と面はホストが同時に開く。 */
  answerInbox(itemId: string, actionId: string): void;
  /** 答えずに、その件の会話と面だけ開く。 */
  openInbox(itemId: string): void;
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

/**
 * 差分イベントを履歴へ畳み込む。ホスト側の record() と同じ規則。
 *
 * **変わった行は必ず新しいオブジェクトにする。**
 * 以前は「参照を維持すれば `React.memo` の最適化になる」として既存の行を in-place で
 * 書き換えていたが、これは逆——`ChatRow` は `React.memo` なので、参照が同じなら
 * 「props は変わっていない」と判断して**描き直しを飛ばす**。結果、届いた分が画面に出ず、
 * 数文字で止まって見えた（PO報告 2026-08-05：リロードすると全文が出る＝止まっていたのは
 * 通信ではなく描画の側）。差し替えれば、変わった行だけが描き直される——それが memo の
 * 効かせ方。1差分につきオブジェクト1つの割り当ては、描画を1回飛ばす損失より遥かに軽い。
 */
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
        return replaceLast(prev, { ...last, text: last.text + event.delta });
      }
      return [...prev, { role: "banto", text: event.delta }];
    }

    // 思考の差分。本文と同じく、最後の思考へ足す
    case "reasoning_delta": {
      const last = prev[prev.length - 1];
      if (last?.role === "reasoning") {
        return replaceLast(prev, { ...last, text: last.text + event.delta });
      }
      return [...prev, { role: "reasoning", text: event.delta }];
    }

    // 考え終わり。時間だけを入れる（本文はもう入っている）
    case "reasoning_end": {
      const last = prev[prev.length - 1];
      if (last?.role !== "reasoning") return prev;
      return replaceLast(prev, { ...last, durationMs: event.durationMs });
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
      const tool = prev[index];
      if (tool === undefined || tool.role !== "tool") return prev;
      const next = [...prev];
      next[index] = {
        ...tool,
        state: event.isError ? "failed" : "ok",
        // 引数は開始のときにしか来ない。終了で消さない
        ...(event.output !== undefined ? { output: event.output } : {}),
      };
      return next;
    }

    // 器（決定78・81）。**凍る**ので、積んだあと差分は来ない
    case "utsuwa":
      return [...prev, { role: "utsuwa", utsuwa: event.utsuwa }];

    // 枝の札（決定77）。指しているだけなので中身は持たない
    case "branch_card":
      return [...prev, { role: "branch", branchId: event.branchId }];

    // 枝が幹へ還った1行（決定77）。こちらは記録なので凍る
    case "branch_result":
      return [
        ...prev,
        {
          role: "branch_result",
          branchId: event.branchId,
          title: event.title,
          conclusion: event.conclusion,
          at: event.at,
        },
      ];

    case "turn_end":
      return event.errorMessage ? [...prev, { role: "error", text: event.errorMessage }] : prev;

    case "error":
      return [...prev, { role: "error", text: event.message }];

    default:
      return prev;
  }
}

/** 末尾の行を差し替える（他の行の参照はそのまま＝描き直されない）。 */
function replaceLast(prev: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  const next = [...prev];
  next[next.length - 1] = entry;
  return next;
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
  /**
   * 取次（POを待たせているもの）。**会話に紐づかない唯一の状態**なので、
   * スレッド単位の byThread ではなくここが持つ。真実はホスト（D3）。
   */
  const [inbox, setInbox] = useState<InboxItemView[]>([]);
  const [byThread, setByThread] = useState<Record<string, ThreadState>>({});
  const activeThreadId = options.activeThreadId;
  const socketRef = useRef<WebSocket>(null);
  /** 見ているスレッドを購読ハンドラから参照する（再接続させないため ref で持つ）。 */
  const activeRef = useRef<string>(undefined);
  activeRef.current = activeThreadId;
  /**
   * すでに頼んだ会話。同じ履歴を二重に取りに行かないための控え
   * （切替を往復すると効果が何度も走る）。繋ぎ直したら忘れる。
   */
  const requested = useRef<Set<string>>(new Set());
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
      // 見ている会話をここで名乗る。ホストはその1本ぶんの履歴だけを接続時に配る
      // （残りは移ったときに `history_request`）。welcome を待ってから頼むと
      // 往復が1回増え、細い回線ほどそれが効く
      const target = new URL(url, window.location.href);
      if (activeRef.current) target.searchParams.set("thread", activeRef.current);
      const socket = new WebSocket(target);
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
          // 繋ぎ直した合図。**手元の履歴は全部「取っていない」に戻す**——切れている間の
          // 差分は誰も届けてくれないので、写しに穴が空いている可能性がある。
          // 中身は消さない（見えているものが一瞬消えるほうが害が大きい）。
          // 直後に届く見ている会話の history が、その1本を本物に差し替える
          setByThread((prev) => {
            const next: Record<string, ThreadState> = {};
            for (const [id, state] of Object.entries(prev)) {
              next[id] = state.historyLoaded ? { ...state, historyLoaded: false } : state;
            }
            return next;
          });
          requested.current.clear();
          // 見ている会話は `?thread=` で頼んである（この直後に history が届く）。
          // 控えておかないと、下の効果がもう一度頼んで同じ履歴が二重に流れる
          if (activeRef.current) requested.current.add(activeRef.current);
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
          // ホストが持つ会話の真実。リロード時はここで復元される。
          // **丸ごと差し替える**——ホストは transcript へ記録してから配るので、
          // 頼んでから届くまでに流れた差分もこの中に入っている
          update(event.threadId, (prev) => ({
            ...prev,
            chat: event.entries,
            historyLoaded: true,
          }));
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

        // 取次は会話に紐づかない。ここだけスレッド単位の更新を通さない
        case "inbox_state":
          setInbox(event.items);
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

  /** 送れたら true。**送れたかどうかを返す**のは、履歴の要求が握り潰されないため（→ `ensureHistory`）。 */
  const post = useCallback((message: Record<string, unknown>): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  /**
   * 幹＝プロジェクト（PO裁定 2026-08-09）。開いているものがレールに並ぶ。
   * **帳場は必ず先頭**（PO裁定 2026-08-10）——店にただ1つで、消えない場所だから。
   */
  const trunks = useMemo(
    () =>
      allThreads
        .filter((t) => t.kind === "trunk" && t.state === "open")
        .sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0)),
    [allThreads]
  );
  /** 開いている枝。レールの点として全部出る（埋没しない不変条件の③） */
  const branches = useMemo(
    () => allThreads.filter((t) => t.kind === "branch" && t.state === "open"),
    [allThreads]
  );
  /** 畳んだ会話。**幹・枝を問わない**——履歴は「畳んだもの」の置き場（決定30c） */
  const closedThreads = useMemo(
    () =>
      allThreads
        .filter((t) => t.state === "closed")
        .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
    [allThreads]
  );
  const threadOf = useCallback(
    (threadId: string): ThreadView | undefined =>
      allThreads.find((t) => t.threadId === threadId),
    [allThreads]
  );
  // memoized: byThread または activeThreadId が変わったときのみ参照が変わる
  const active = useMemo<ThreadState>(
    () => (activeThreadId ? byThread[activeThreadId] : undefined) ?? EMPTY_THREAD,
    [activeThreadId, byThread]
  );
  const unreadThreadIds = useMemo(
    () => Object.entries(byThread).filter(([, s]) => s.unread).map(([id]) => id),
    [byThread]
  );

  const switchThread = useCallback((threadId: string) => {
    // POが自分で選んだ移動なので履歴に積む（戻るで前の会話へ帰れる）。
    // 未読を落とすのは下の効果——戻る／進むで移ったときも同じように落ちる必要がある
    onActiveThreadRef.current(threadId, { push: true });
  }, []);

  // 見ている会話の未読は落とす。**移った経路を問わない**
  useEffect(() => {
    if (!activeThreadId) return;
    setByThread((prev) => {
      const state = prev[activeThreadId];
      if (!state?.unread) return prev;
      return { ...prev, [activeThreadId]: { ...state, unread: false } };
    });
  }, [activeThreadId]);

  /**
   * 会話ごとの状態を引く口。
   *
   * **列ごとに引く**（決定79）——幹と枝が同時に画面へ出るので、「いま見ている1本」に
   * 寄せた口だと片方しか描けない。
   */
  const chatOf = useCallback(
    (threadId: string): TranscriptEntry[] => byThread[threadId]?.chat ?? [],
    [byThread]
  );
  const busyOf = useCallback(
    (threadId: string): boolean => byThread[threadId]?.busy ?? false,
    [byThread]
  );
  const draftOf = useCallback(
    (threadId: string): string => byThread[threadId]?.draft ?? "",
    [byThread]
  );
  const modelOf = useCallback(
    (threadId: string): CurrentModel | undefined => byThread[threadId]?.model,
    [byThread]
  );
  const contextTokensOf = useCallback(
    (threadId: string): number | undefined => byThread[threadId]?.contextTokens,
    [byThread]
  );
  const historyLoaded = useCallback(
    (threadId: string): boolean => byThread[threadId]?.historyLoaded ?? false,
    [byThread]
  );

  /**
   * その会話の履歴を手元に用意する。まだ無ければホストへ頼む。
   *
   * 接続時に届くのは見ている会話の分だけなので、**中身を出す面はここを通す**。
   */
  const ensureHistory = useCallback(
    (threadId: string) => {
      if (requested.current.has(threadId)) return;
      // **送れたときだけ控える**。まだ繋がっていないのに控えると、繋がったあとも
      // 「頼んだ」と思い込んで永久に取りに行かない
      if (post({ type: "history_request", threadId })) requested.current.add(threadId);
    },
    [post]
  );

  // 見ている会話の履歴を用意する。**移った経路を問わない**
  useEffect(() => {
    if (!activeThreadId) return;
    if (byThread[activeThreadId]?.historyLoaded) return;
    ensureHistory(activeThreadId);
  }, [activeThreadId, byThread, ensureHistory]);

  /**
   * 幹の履歴も先に用意する（決定77）。
   *
   * **枝を見ているときも幹は画面に居る**（重なりの地）ので、移ってから取りに行くと
   * 枝を開いた瞬間に幹が空になる。
   */
  useEffect(() => {
    const focused = activeThreadId ? allThreads.find((t) => t.threadId === activeThreadId) : undefined;
    const trunkId = focused?.kind === "branch" ? focused.parentId : focused?.threadId;
    if (!trunkId) return;
    if (byThread[trunkId]?.historyLoaded) return;
    ensureHistory(trunkId);
  }, [activeThreadId, allThreads, byThread, ensureHistory]);

  const send = useCallback(
    (threadId: string, text: string, attachments?: Attachment[]) => {
      update(threadId, (prev) => ({ ...prev, busy: true }));
      post({
        type: "prompt",
        threadId,
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      });
    },
    [post, update]
  );

  const abort = useCallback(
    (threadId: string) => post({ type: "abort", threadId }),
    [post]
  );

  /**
   * 取次の一通に答える。**会話と面はホストが動かす**——画面が別々に操作すると、
   * 片方だけ動いた状態が一瞬見える。
   */
  const answerInbox = useCallback(
    (itemId: string, actionId: string) => post({ type: "inbox_answer", itemId, actionId }),
    [post]
  );
  /** 答えずに、その件の会話と面だけ開く。 */
  const openInbox = useCallback((itemId: string) => post({ type: "inbox_open", itemId }), [post]);

  // モデルは会話ごと
  const setModel = useCallback(
    (threadId: string, provider: string, model: string) =>
      post({ type: "set_model", threadId, provider, model }),
    [post]
  );

  /**
   * 書きかけを覚える。**会話ごと**に持つ——移った先に前の会話の書きかけが出ると、
   * そのまま送ってしまう（PO報告 2026-08-04）。
   */
  const setDraft = useCallback(
    (threadId: string, text: string) => {
      update(threadId, (prev) => (prev.draft === text ? prev : { ...prev, draft: text }));
    },
    [update]
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

  /**
   * 面を開く。**開く先は「いま見ている会話」のキャンバス**（決定2・79）——
   * どこから開いたかは、その面がどちらのキャンバスに載っているかで表される。
   * 幹から開けば枝は視界から外れ、枝から開けば枝が左に残る。
   */
  const openView = useCallback(
    (kind: string, params?: Record<string, unknown>) =>
      post({
        type: "canvas_open",
        threadId: activeThreadId,
        kind,
        ...(params ? { params } : {}),
      }),
    [activeThreadId, post]
  );

  /**
   * 枝を開く（決定77）。**還す条件と理由は必須**——帳簿も拒むが、ここでも書かせる。
   * 開いた枝へは自動で移る（押した意図に合わせる）。
   */
  const openBranch = useCallback(
    (spec: { threadId?: string; title: string; returnCondition: string; reason: string }) => {
      followNewThread.current = true;
      post({ type: "thread_open", ...spec });
    },
    [post]
  );

  /** 枝を畳んで幹へ還す（決定77）。幹は畳めない（ホストが拒む）。 */
  const mergeBranch = useCallback(
    (threadId: string, conclusion: string) => post({ type: "thread_merge", threadId, conclusion }),
    [post]
  );

  const reopenThread = useCallback(
    (threadId: string) => {
      post({ type: "thread_reopen", threadId });
      switchThread(threadId);
    },
    [post, switchThread]
  );

  /**
   * 会話に名前を付け直す（PO要望 2026-08-05）。**名前の真実はホスト**（D3）——
   * ここでは楽観的に画面を書き換えず、`thread_state` が返ってくるのを待つ。
   */
  const renameThread = useCallback(
    (threadId: string, title: string) => post({ type: "thread_rename", threadId, title }),
    [post]
  );

  /**
   * PO が「ここまで」と区切る（提案§3.2 の人側）。
   *
   * 結果はホストが知らせとして流す（畳めたときも、畳めなかったときも）。**画面が
   * 先に何かを書き換えることはしない**——真実はホストの側にある（D3）。
   */
  const closeChapter = useCallback(
    (threadId: string) => post({ type: "chapter_close", threadId }),
    [post]
  );

  const session = useMemo<BantoSession>(
    () => ({
      status,
      sessionId,
      tools,
      catalog,
      modules,
      trunks,
      branches,
      closedThreads,
      threadOf,
      activeThreadId,
      tabs: active.tabs,
      activeTabId: active.activeTabId,
      canvasKnown: active.canvasKnown,
      unreadThreadIds,
      chatOf,
      busyOf,
      draftOf,
      modelOf,
      contextTokensOf,
      ensureHistory,
      historyLoaded,
      send,
      abort,
      setDraft,
      setModel,
      switchTab,
      closeTab,
      reorderTab,
      openView,
      switchThread,
      openBranch,
      mergeBranch,
      reopenThread,
      renameThread,
      closeChapter,
      inbox,
      /** まだ答えの出ていない数。レールの札に出る唯一の数字（導出なので持たない） */
      inboxPending: inbox.filter((i) => !i.resolvedAt).length,
      answerInbox,
      openInbox,
    }),
    [
      status,
      sessionId,
      tools,
      catalog,
      modules,
      trunks,
      branches,
      closedThreads,
      threadOf,
      activeThreadId,
      active,
      unreadThreadIds,
      chatOf,
      busyOf,
      draftOf,
      modelOf,
      contextTokensOf,
      ensureHistory,
      historyLoaded,
      send,
      abort,
      setDraft,
      setModel,
      switchTab,
      closeTab,
      reorderTab,
      openView,
      switchThread,
      openBranch,
      mergeBranch,
      reopenThread,
      renameThread,
      closeChapter,
      inbox,
      answerInbox,
      openInbox,
    ]
  );

  return session;
}
