/**
 * Banto の画面：チャット＋キャンバスの2ペイン（ADR-0010 決定2）。
 *
 * D3/D5: キャンバスの表示状態も会話履歴もホストが持つ真実をそのまま描く。POのタブ操作も
 *        ホストへ投げ返すので、番頭が canvas.* を呼んだ場合と結果が一致する。
 *
 * **いま見ている場所（面・会話・キャンバスのタブ・設定の区画）は URL が持つ**
 * （`viewLocation.ts`）。だから戻る／進むが効き、リロードしても同じ画面に戻る。
 * 場所を動かすときは URL を動かし、URL に合わせてホストへ操作を投げる——押した経路と
 * 戻るで通る経路を1本にするため。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// D6: 末尾追従は Vercel AI Elements と同じ use-stick-to-bottom に任せる。自前だと
// ResizeObserver 追従・spring・選択中の扱いを全部書くことになり、体験を合わせきれない
import { useStickToBottom } from "use-stick-to-bottom";
import type { Attachment } from "@banto/host/protocol";
import { useBantoSession, type CurrentModel } from "./useBantoSession.js";
// 発話の描き方はチャット・履歴・職人ビューアで共通（messages.tsx）
import { ChatRow, Loader } from "./messages.js";
import { callModuleTool } from "./views/useModuleTool.js";
import type { LlmModelInfo } from "@banto/core";
import { resolveCanvasView } from "./views/registry.js";
import { ThreadTabs } from "./ThreadTabs.js";
import { ThreadHistory } from "./ThreadHistory.js";
import { SettingsPanel } from "./views/SettingsPanel.js";
import { Modal, SearchField } from "./views/ui.js";
import { useViewLocation } from "./viewLocation.js";
import { useTabOverflow } from "./useTabOverflow.js";
import { Icon, iconOfKind } from "./icons.js";
import { InboxFace, PendingDecisions } from "./Inbox.js";
import { CommandPalette, useCommandPalette } from "./CommandPalette.js";
import { useKeyHints } from "./keyHints.js";
import { useListNav } from "./listNav.js";
import { useThemeState } from "./theme/ThemeProvider.js";

/**
 * 既定は**同一オリジンの `/ws`**。開発サーバがそれを番頭ホストへ中継するので、
 * リバースプロキシ（Caddy等）のサブドメイン経由でもそのまま繋がる——`localhost` を
 * 直書きすると、プロキシ越しに開いたときブラウザ側のマシンを指してしまう。
 * 別ホストの番頭に繋ぎたいときは `?host=ws://...` で上書きする。
 *
 * **中継 URL（`{baseUrl}/env/<envId>/`）で開かれたときは、WS も同じ中継パスへ繋ぐ**
 * （案A）。この画面は検証環境のホストが banto の中継を通して出ているもので、
 * 同一オリジンの `/ws` は検証環境ではなく**中継元（banto 本体）**を指してしまう。
 * `/env/<envId>/` の下に開いたことがパスで分かるので、そこへ `ws` を足す。
 */
function defaultWsUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const relay = location.pathname.match(/(\/env\/[^/]+)(?:\/|$)/);
  if (relay) {
    const prefix = location.pathname.slice(0, relay.index! + relay[1].length);
    return `${scheme}//${location.host}${prefix}/ws`;
  }
  return `${scheme}//${location.host}/ws`;
}

const WS_URL = new URLSearchParams(location.search).get("host") ?? defaultWsUrl();

/** チャット欄の幅の記憶先。 */
const CHAT_WIDTH_KEY = "banto.chatWidth";
const CHAT_WIDTH_DEFAULT = 400;
const CHAT_WIDTH_MIN = 300;
/** 入力欄の最大の高さ（AI Elements の `max-h-48`）。最低の高さは CSS の min-height。 */
const MAX_COMPOSER_HEIGHT_PX = 192;

/**
 * チャットに一度に描く発話の数（→ App の `shownCount`）。
 *
 * 200 は「開いた直後に画面を数枚ぶん埋めて、なお余る」量。これ以上増やしても
 * 最初の一画面には出ないが、Markdown の組み立ては全部走ってしまう。
 */
const CHAT_WINDOW = 200;


/**
 * 中核の Tool の到達先（ADR-0011 決定42）。`llm.*` はモジュールではなく中核のドメイン。
 * 相対パスなので、自分のオリジン（＝開発時は vite、常駐時はホスト）に解決される。
 */
const CORE_TOOL_ENDPOINT = "/api/core";

/** テキスト添付の上限。これを超えたら添付せずエラー表示する。 */
const MAX_FILE_BYTES = 100 * 1024;
/**
 * 画像の上限。WS の maxPayload 既定（100MiB）を base64（+33%）込みで割らない安全な値。
 * 会話履歴（JSONL）に残る分の肥大化は許容（スコープ外）。
 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** ファイル選択ダイアログで選べるもの。画像と、テキストとして読めるファイル。 */
const ACCEPT_TYPES =
  "image/*,.txt,.md,.log,.json,.jsonl,.csv,.tsv,.yml,.yaml,.toml,.xml,.html,.css," +
  ".js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php," +
  ".sh,.bash,.sql,.ini,.cfg,.env,.diff,.patch,.gitignore";

/** 会話ごとの添付が空のときに使い回す（毎回 [] を作ると memo が効かない）。 */
const EMPTY_PENDING: PendingFile[] = [];

/** 添付待ちの1ファイル。送信時に FileReader で読み取る。 */
interface PendingFile {
  kind: "image" | "file";
  name: string;
  size: number;
  /** 画像の MIME。送信時に載せる。 */
  mimeType?: string;
  file: File;
  /** 画像のプレビュー用の objectURL。取り消すときに revoke する。 */
  previewUrl?: string;
}

/** キャンバス側が潰れない範囲に収める。 */
function clampChatWidth(width: number): number {
  const max = Math.max(CHAT_WIDTH_MIN, window.innerWidth - 360);
  return Math.min(Math.max(width, CHAT_WIDTH_MIN), max);
}

function readStoredChatWidth(): number {
  try {
    const stored = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampChatWidth(stored) : CHAT_WIDTH_DEFAULT;
  } catch {
    return CHAT_WIDTH_DEFAULT;
  }
}

/**
 * 送ってから最初の一文字が届くまでの間（AI Elements の `status === "submitted"`）。
 *
 * **独楽だけを置く**——番頭が喋り始めたら消える。本文そのものが進んでいる証拠になるので、
 * 言葉を重ねない。読み上げには文言が要るので、そちらだけ隠しテキストで残す。
 */
function ThinkingRow(): React.ReactElement {
  return (
    <div className="msg msg--thinking" role="status" aria-live="polite">
      <Loader />
      <span className="sr-only">考えています</span>
    </div>
  );
}

/** トークン数を読みやすく（1200 → 1.2k）。桁を揃えるより、ひと目で大きさが分かるほうを採る。 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * この会話が文脈をどれだけ使っているか（AI Elements の `Context`）。
 *
 * **実測が届くまで出さない**（I1）——ターンが1度も回っていない会話や、再起動直後は
 * 分からない。0% と出すと「まだ空だ」と読めてしまうが、実際は分からないだけ。
 * 分母（モデルの文脈長）が分からないときはトークン数だけを出す。
 */
function ContextMeter({
  tokens,
  contextWindow,
}: {
  tokens: number | undefined;
  contextWindow: number | undefined;
}): React.ReactElement | null {
  if (tokens === undefined) return null;
  if (!contextWindow) {
    return (
      <span className="context-meter" title={`直近のターンで ${tokens.toLocaleString()} トークン`}>
        {formatTokens(tokens)}
      </span>
    );
  }
  const ratio = Math.min(1, tokens / contextWindow);
  const percent = Math.round(ratio * 100);
  return (
    <span
      className={`context-meter ${ratio >= 0.9 ? "is-full" : ratio >= 0.7 ? "is-warn" : ""}`}
      title={
        `文脈の使用量：${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} トークン` +
        "（直近のターンで運んだ入力＋キャッシュ＋出力の実測）"
      }
    >
      {/* 円弧で残量を出す。数字だけより、逼迫しているかが一目で分かる */}
      <svg className="context-meter-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <circle
          cx="7"
          cy="7"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${ratio * 2 * Math.PI * 6} ${2 * Math.PI * 6}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      {percent}%
    </span>
  );
}

/**
 * モデル選択（AI Elements の `PromptInputModelSelect`）。
 *
 * 一覧は中核の `llm.list`（ADR-0011 決定42 で `/api/core/tools/` に出ている）から取る。
 * **番頭が使ってよいモデルだけ**を出す（`hostUsable`）——職人向けの安いモデルまで並べると、
 * 選んではいけないものが選べてしまう。
 *
 * 選んだ結果は自分で覚えない。ホストが `model_state` を配り直したときに変わる（D3）——
 * 切替に失敗したら表示は前のモデルのまま、が正しい。
 *
 * **押した脇に開くドロップダウンをやめた**（PO報告 2026-08-06）——チャット欄は右端に
 * 寄っていて幅も可変なので、脇に開いた瞬間に画面からはみ出し、横スクロールが生えて
 * 画面全体が横へずれていた。`Modal` に同じ裁定が既に書いてある（`views/ui.tsx`）：
 * 画面に対して置けば、広さに関係なく収まる。場所選び・キャンバスに開くものと同じ形になる。
 */
function ModelSelect({
  current,
  onSelect,
}: {
  current: CurrentModel | undefined;
  onSelect: (provider: string, model: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<LlmModelInfo[]>();
  const [error, setError] = useState<string>();

  // 開いたときに取りに行く（起動のたびに全モデルを引かない）
  useEffect(() => {
    if (!open || models) return;
    // **採用しているものだけ**を取る（ADR-0011 決定47）。数百のモデルを並べても選べない
    void callModuleTool<{ models: LlmModelInfo[] }>(CORE_TOOL_ENDPOINT, "llm.list", {
      adopted: true,
      limit: 200,
    })
      .then((data) => setModels(data.models.filter((m) => m.hostUsable)))
      // I2: 取れなかったことを黙らない。空の一覧を「モデルが無い」と誤読させない
      .catch((err: unknown) => setError(String(err)));
  }, [open, models]);

  const matched = (models ?? []).filter((m) => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return true;
    return `${m.providerId} ${m.name} ${m.id}`.toLowerCase().includes(q);
  });
  const providers = [...new Set(matched.map((m) => m.providerId))];
  /** 描く順に均した並び。キーで動かす通し番号は、目に見えている順と一致していないと読めない */
  const ordered = providers.flatMap((providerId) =>
    matched.filter((m) => m.providerId === providerId)
  );

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };
  const pick = (m: LlmModelInfo): void => {
    onSelect(m.providerId, m.id);
    close();
  };
  const nav = useListNav(ordered, { onChoose: pick, resetKey: query });

  return (
    <div className="model-select">
      <button
        className="model-select-trigger"
        type="button"
        onClick={() => setOpen(!open)}
        title={current ? `${current.provider} / ${current.id}` : "モデルを選ぶ"}
      >
        <span className="model-select-name">{current?.id ?? "モデル"}</span>
        <span className="model-select-caret">▾</span>
      </button>
      {open && (
        <Modal
          title="モデルを選ぶ"
          onClose={close}
          footer={<span className="picker-hint">↑↓ で選ぶ · Enter で決める · Esc で閉じる</span>}
        >
          <div className="model-select-menu">
            <div className="model-select-search">
              <SearchField
                value={query}
                onChange={setQuery}
                onKeyDown={nav.onKeyDown}
                placeholder="モデルを探す…"
                autoFocus
              />
            </div>
            <div className="model-select-list" role="listbox" ref={nav.listRef}>
              {error !== undefined && <div className="model-select-error">{error}</div>}
              {error === undefined && models === undefined && (
                <div className="model-select-empty">読み込んでいます…</div>
              )}
              {models !== undefined && matched.length === 0 && (
                <div className="model-select-empty">
                  {(models ?? []).length === 0
                    ? "採用しているモデルがありません。設定の「LLM・モデル」で採用してください。"
                    : "見つかりません"}
                </div>
              )}
              {providers.map((providerId) => (
                <div key={providerId}>
                  <div className="model-select-group">{providerId}</div>
                  {matched
                    .filter((m) => m.providerId === providerId)
                    .map((m) => {
                      const isCurrent =
                        current?.provider === m.providerId && current.id === m.id;
                      const index = ordered.indexOf(m);
                      return (
                        <button
                          key={`${m.providerId}/${m.id}`}
                          className={`model-select-item ${isCurrent ? "is-current" : ""} ${
                            nav.isOn(index) ? "is-on" : ""
                          }`}
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          onClick={() => pick(m)}
                          {...nav.rowProps(index)}
                        >
                          <span className="model-select-item-name">{m.name}</span>
                          {/* 文脈の長さは「どれだけ話を続けられるか」に直結する。
                              分からないものは**分からないと出す**——ハーネスはそれを 0 として
                              扱い、毎ターン要約を走らせてしまうので、選ぶ前に見えている必要がある */}
                          {m.contextWindow ? (
                            <span className="model-select-badge">{formatTokens(m.contextWindow)}</span>
                          ) : (
                            <span
                              className="model-select-badge is-unknown"
                              title="文脈の長さが分かりません。選ぶと毎ターン要約が走る可能性があります"
                            >
                              長さ不明
                            </span>
                          )}
                          {/* 値段は選ぶときの実際の軸（100万トークンあたり） */}
                          {m.cost && (m.cost.input > 0 || m.cost.output > 0) && (
                            <span className="model-select-badge" title="100万トークンあたり 入力/出力">
                              ${m.cost.input}/${m.cost.output}
                            </span>
                          )}
                          {/* 画像を読めるかは添付の可否に直結するので、選ぶ前に見せる */}
                          {m.vision && <span className="model-select-badge">画像可</span>}
                          <span className="model-select-check">{isCurrent && <Icon name="check" size={14} />}</span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function App(): React.ReactElement {
  const theme = useThemeState();
  // ⌘K：既にある場所への近道。ここから新しい状態は生まれない
  const palette = useCommandPalette();
  // 符牒：⌥ を押している間だけ、押せるものにキーが浮く。
  // **帯は出さない**——符牒そのものが説明で、上に言葉を足すと画面がずれる（PO報告 2026-08-06）
  useKeyHints();
  const [view, navigate] = useViewLocation();
  /**
   * ホストの都合で見る先が決まったとき（既定の会話・畳まれた会話からの退避・自分が
   * 開いた会話）。**面は保ったまま**会話だけ動かす——設定を見ている最中に会話が畳まれて
   * 会話面へ飛ばされるのは、押してもいない移動になる。自分で開いた会話へは移る。
   */
  const onActiveThread = useCallback(
    (threadId: string | undefined, { push }: { push: boolean }) => {
      navigate(
        (prev) => {
          const face = push ? "chat" : prev.face;
          return {
            face,
            ...(threadId ? { threadId } : {}),
            // キャンバスのタブは前の会話のもの。持ち越さない。面に属するもの（設定の区画・
            // 履歴で読んでいる会話）は、その面に留まるなら残す
            ...(face === "settings" && prev.section ? { section: prev.section } : {}),
            ...(face === "history" && prev.readThreadId
              ? { readThreadId: prev.readThreadId }
              : {}),
          };
        },
        { replace: !push }
      );
    },
    [navigate]
  );
  const session = useBantoSession(WS_URL, {
    activeThreadId: view.threadId,
    onActiveThread,
  });
  // 下書きは**会話ごと**。ホスト側ではなく画面の状態だが、会話に属する（PO報告 2026-08-04）
  const draft = session.draft;
  const setDraft = session.setDraft;
  /**
   * 末尾追従（AI Elements の `<Conversation>` と同じ設定）。
   *
   * 初回もリサイズも spring で滑らせる。**追従を切る／戻す判断はライブラリに任せる**——
   * 上へ動かした瞬間に止まる・70px 以内へ戻ると再び追う・選択中は止まる、という細かい
   * 呼吸まで含めて体験を合わせたいので、条件を自前で書き直さない。
   */
  /**
   * 末尾追従。
   *
   * **最初の貼り付きだけ瞬間移動にする**（AI Elements は `initial="smooth"`）。向こうは
   * 空の会話から始まるので滑っても一瞬だが、banto は**保存された会話を丸ごと復元してから
   * 貼り付く**ので、先頭から最下部まで延々と滑って見える。これはチャット面が作り直される
   * たび——設定・履歴の面から会話へ戻るたびに起きていた（PO報告 2026-08-04）。
   *
   * 応答が届くときの追従（`resize`）は spring のまま。そちらは「いま伸びた分だけ」動く。
   */
  const chat = useStickToBottom({ initial: "instant", resize: "smooth" });
  /**
   * 最新の位置から読み始める場面は2つ。**どちらも自分で言う。**
   *
   * ① スレッドの切替——**切替は新しい会話を開いたのと同じ**で、前のスレッドで上を
   *    読んでいた状態（追従の解除）は持ち越さない。
   * ② 被さっていた面（設定・履歴・取次）から会話へ戻ったとき。ここは `.chat-scroll` が
   *    **作り直される**——面は条件分岐で描いているので、戻ると器ごと新しくなる。
   *
   * ② を `initial: "instant"` に任せていたのが誤りだった。あれは**この hook が最初に
   *    中身を掴んだ1回**にしか効かず、App は面を開いている間も生きているので二度目は来ない。
   *    戻ったあとは「貼り付き直すかどうか」が競争になり、**実測で3回に1回、会話の
   *    先頭のまま止まっていた**（`tests/chat-ux.spec.ts` の間欠的な失敗はこれ。
   *    中身は全部届いているのに `scrollTop` が 0 のまま動かない）。
   */
  const { scrollToBottom } = chat;
  const chatFace = view.face === "chat";
  useEffect(() => {
    if (!chatFace) return;
    void scrollToBottom({ animation: "instant" });
  }, [session.activeThreadId, chatFace, scrollToBottom]);

  /**
   * 描くのは末尾の何件か（inc: Android/Tailscale から使えない）。
   *
   * **全部描かない。** 長い会話は5千行を超えており、1行ごとに Markdown を組み立てるので
   * （`ChatRow` → `StreamingMarkdown`）、丸ごと描くと開いた瞬間に画面が固まる。転送を
   * 軽くしても、この描画の重さは1バイトも減らない——実機で効くのはこちら。
   *
   * 高さを見積もる本式の仮想スクロールにはしていない。行の高さがまちまち（思考の
   * 折り畳み・コードブロック・添付）なうえ、下に貼り付く追従（`use-stick-to-bottom`）と
   * 噛み合わせる必要があり、**チャットは下から読むもの**なので窓を下端に固定できる。
   * 上へ遡りたいときだけ窓を広げる形にした。
   */
  const [shownCount, setShownCount] = useState(CHAT_WINDOW);
  // 会話を移ったら窓を戻す（前の会話で遡った分を持ち越さない）
  useEffect(() => setShownCount(CHAT_WINDOW), [session.activeThreadId]);
  const shownFrom = Math.max(0, session.chat.length - shownCount);
  const shownChat = useMemo(
    () => session.chat.slice(shownFrom),
    [session.chat, shownFrom]
  );

  /**
   * 送信ボタンと待ち表示の状態（AI Elements の `ChatStatus`）。
   *
   * `submitted`（送ったが返事はまだ）と `streaming`（喋っている最中）を分ける——
   * 待っているのか進んでいるのかで、出すもの（独楽／中断）が変わるため。
   * ホストは busy しか持たないので、**応答が始まったかどうかは履歴の末尾で見る**。
   */
  const lastEntry = session.chat[session.chat.length - 1];
  const chatStatus: "ready" | "submitted" | "streaming" | "error" = session.busy
    ? lastEntry?.role === "banto" || lastEntry?.role === "tool" || lastEntry?.role === "reasoning"
      ? "streaming"
      : "submitted"
    : lastEntry?.role === "error"
      ? "error"
      : "ready";
  const [dragTabId, setDragTabId] = useState<string>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogQuery, setCatalogQuery] = useState("");
  /** 収まらないタブをまとめる ▾ の開閉。 */
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  /**
   * 見ている面（決定41・prototype の3面構成）。履歴と設定はプロトタイプ三次改訂の
   * 「ピンタブ」に相当し、**キャンバスのタブではなく独立した面**。同時に出るのは1つ。
   *
   * どの面かは URL が持つ——リロードしても設定を見ていたなら設定に戻り、戻るを押せば
   * 会話へ帰る。
   */
  const historyOpen = view.face === "history";
  const settingsOpen = view.face === "settings";
  const inboxOpen = view.face === "inbox";
  /**
   * 面を切り替える（POが押した移動なので履歴に積む）。同じ面をもう一度押したら会話へ戻る。
   *
   * 面に属する場所（設定の区画・履歴で読んでいる会話）は、面を離れるときに落とす——
   * 会話に属するキャンバスのタブを会話の切替で落とすのと同じ規則。
   */
  /** 被さっている面を閉じて会話へ戻る（Esc・「会話へ戻る」・会話タブを押したとき）。 */
  const backToChat = useCallback(() => {
    navigate((prev) => ({
      face: "chat",
      ...(prev.threadId ? { threadId: prev.threadId } : {}),
      ...(prev.tabId ? { tabId: prev.tabId } : {}),
    }));
  }, [navigate]);
  const showFace = useCallback(
    (face: "chat" | "history" | "settings" | "inbox") => {
      navigate((prev) => {
        const next = prev.face === face ? "chat" : face;
        return {
          face: next,
          ...(prev.threadId ? { threadId: prev.threadId } : {}),
          ...(prev.tabId ? { tabId: prev.tabId } : {}),
          ...(next === "settings" && prev.section ? { section: prev.section } : {}),
          ...(next === "history" && prev.readThreadId ? { readThreadId: prev.readThreadId } : {}),
        };
      });
    },
    [navigate]
  );
  /**
   * 取次の一通を開く（決定73・75）。
   *
   * **会話と面はホストが動かす**（片方だけ動いた状態を見せないため）。画面が受け持つのは
   * 「どの面を出すか」だけ——設定は会話に被さる面で、キャンバスのタブではないので
   * ホストからは動かせない。
   */
  const openInboxItem = useCallback(
    (itemId: string) => {
      const item = session.inbox.find((i) => i.id === itemId);
      session.openInbox(itemId);
      if (item?.opens?.settings) {
        const section = item.opens.settings.section;
        navigate((prev) => ({
          face: "settings",
          ...(prev.threadId ? { threadId: prev.threadId } : {}),
          ...(prev.tabId ? { tabId: prev.tabId } : {}),
          ...(section ? { section } : {}),
        }));
        return;
      }
      backToChat();
    },
    [session, navigate, backToChat]
  );
  /** チャット欄の幅。境界のドラッグで変えられる（PO要望 2026-07-31）。 */
  const [chatWidth, setChatWidth] = useState(readStoredChatWidth);
  const chatPaneRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 添付待ちのファイル（送信時に読み取る）。 */
  /**
   * 添付待ちのファイル。**会話ごとに分ける**——下書きと同じで、別の会話へ移ったときに
   * 前の会話に付けたつもりのファイルが付いていると、そのまま送ってしまう。
   * ホストへ送るまでの一時的なものなので、画面の側で持つ（送信時に読み取る）。
   */
  const [pendingByThread, setPendingByThread] = useState<Record<string, PendingFile[]>>({});
  const activeThreadKey = session.activeThreadId ?? "";
  const pending = useMemo(
    () => pendingByThread[activeThreadKey] ?? EMPTY_PENDING,
    [pendingByThread, activeThreadKey]
  );
  const setPending = useCallback(
    (next: PendingFile[] | ((prev: PendingFile[]) => PendingFile[])) => {
      setPendingByThread((prev) => {
        const current = prev[activeThreadKey] ?? EMPTY_PENDING;
        const value = typeof next === "function" ? next(current) : next;
        return { ...prev, [activeThreadKey]: value };
      });
    },
    [activeThreadKey]
  );
  /** 添付のクライアント側エラー（サイズ超過・画像非対応など）。 */
  const [attachError, setAttachError] = useState<string>();
  /**
   * × で閉じたエラー行の位置（スレッドごと）。会話はスレッドごとに独立して積まれるので、
   * 位置だけの記憶だと別のスレッドのエラーを誤って隠してしまう——スレッドIDで分ける。
   * エラー行に id が無い（protocol の TranscriptEntry）ため、チャット配列の index で特定する
   * （会話は追記のみで並びが変わらない）。
   */
  const [dismissedErrors, setDismissedErrors] = useState<Record<string, ReadonlySet<number>>>({});

  /**
   * スマホ表示：チャットかキャンバスか（排他）。既定はチャット。
   *
   * 以前は両方を同時に出す split があったが、スマホ幅では二段組にすると
   * どちらも読めない高さになる。番頭との対話が主なので、既定はチャット。
   */
  const [mobileView, setMobileView] = useState<"chat" | "canvas">("chat");

  /** エラー行を1件だけ非表示にする（全部は消さない）。 */
  const dismissError = useCallback((threadId: string, i: number) => {
    setDismissedErrors((prev) => ({
      ...prev,
      [threadId]: new Set(prev[threadId] ?? []).add(i),
    }));
  }, []);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 入力欄を中身の行数に合わせて伸ばす。上限は AI Elements と同じ 192px（`max-h-48`）で、
  // それを超えたら中でスクロールさせる。
  // CSS の `field-sizing: content` は同じことを CSS だけでやるが、Firefox・Safari が
  // まだ持っていないので、どのブラウザでも同じ高さになるよう JS で測る
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const wanted = el.scrollHeight;
    el.style.height = `${Math.min(wanted, MAX_COMPOSER_HEIGHT_PX)}px`;
    el.style.overflowY = wanted > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
  }, [draft, chatWidth]);

  // 次に開いたときも同じ幅で始める。**状態から書く**——ドラッグの終わりに DOM を読むと、
  // React がまだ最後の1手を反映しておらず、記憶する幅が1手ぶんずれる（実測で見つけた）
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(chatWidth));
    } catch {
      // ストレージが使えない環境でも幅の変更自体は効く
    }
  }, [chatWidth]);

  /**
   * 番頭への入力へ移る（PO要望 2026-08-06）。
   *
   * **いま掴めなければ、掴めるまで待つ。** 会話へ飛ぶと、被さっていた面が外れて
   * チャット欄が描き直されることがあり、押した瞬間には入力欄がまだ無い。旗を立てて
   * おいて、描き直しのたびに掴みにいく（掴めたら旗を下ろす）。
   */
  const wantComposer = useRef(false);
  const focusComposer = useCallback(() => {
    wantComposer.current = true;
  }, []);
  useEffect(() => {
    if (!wantComposer.current) return;
    const el = inputRef.current;
    if (!el) return;
    wantComposer.current = false;
    el.focus();
  });

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = chatPaneRef.current?.clientWidth ?? chatWidth;
    const onMove = (move: PointerEvent): void => {
      // チャットは右側にあるので、左へ動かすほど広くなる
      setChatWidth(clampChatWidth(startWidth - (move.clientX - startX)));
    };
    const onUp = (): void => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  /**
   * **この画面で描ける面だけを「開けるもの」として扱う**（決定12・17）。
   *
   * カタログを配るのはホスト、描けるかを知っているのはUI——`component` は文字列で渡るので、
   * **両者は食い違いうる**。実体の無い面を一覧に出すと、押した先が「描けません」になる
   * （PO報告 2026-08-05：畳んだはずのテスト用GUIが、古いまま動いているホストの言い分で
   * 一覧に残っていた）。offer する側で濾すのが正しい層——UI ごとに描けるものは違う。
   *
   * I2: 黙って消さない。食い違いは配線漏れなので、カタログの面に件数と kind を出す。
   */
  const openableCatalog = useMemo(
    () => session.catalog.filter((entry) => resolveCanvasView(entry.component) !== undefined),
    [session.catalog]
  );
  const unresolvedCatalog = useMemo(
    () => session.catalog.filter((entry) => resolveCanvasView(entry.component) === undefined),
    [session.catalog]
  );

  /**
   * カタログは category ごとにまとめて出す（何が開けるか探しやすくするため）。
   * モジュールが増えるほど縦に伸びるので、名前と説明で絞れるようにする。
   */
  const catalogGroups = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    const matched = openableCatalog.filter((entry) =>
      q.length === 0
        ? true
        : `${entry.title} ${entry.description} ${entry.kind} ${entry.module}`.toLowerCase().includes(q)
    );
    return Object.entries(
      matched.reduce<Record<string, typeof session.catalog>>((groups, entry) => {
        const key = entry.category ?? "その他";
        (groups[key] ??= []).push(entry);
        return groups;
      }, {})
    );
  }, [openableCatalog, catalogQuery]);
  /** 束ねる前の並び。キーで動かす通し番号は、目に見えている順と一致させる */
  const catalogOrdered = useMemo(
    () => catalogGroups.flatMap(([, entries]) => entries),
    [catalogGroups]
  );

  // 収納メニューは外側を押したら閉じる
  useEffect(() => {
    if (!tabMenuOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".canvas-more-wrap")) setTabMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [tabMenuOpen]);

  // Esc で被さっている面（設定・履歴）を閉じて会話へ戻る。
  // **入力中の Esc は IME の変換取り消しに使われる**ので、変換中は何もしない
  useEffect(() => {
    if (!settingsOpen && !historyOpen && !inboxOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      backToChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, historyOpen, inboxOpen, backToChat]);

  // 画像添付の可否はモデルの vision 対応で決まる。真実はホストが持ち（`model_state`）、
  // ここは選択時点で添付させないための事前確認。**モデルを切り替えたら即座に効く**——
  // 一度きりの取得だと、切り替えた後も古い可否で判定してしまう
  const modelInfo = session.model;

  /**
   * キャンバスのタブ：URL とホストを合わせる。
   *
   * 真実はホスト（`canvas_state`）。URL は「どのタブを見たいか」の意図で、**動いた側に
   * 合わせて片方を直す**——
   * - URL が動いた（戻る／進む・リロードでの復元・タブを押した）→ ホストへ `canvas_switch`
   * - ホストが動いた（番頭がGUIを開いた・タブが閉じた）→ URL を差し替える（積まない）
   *
   * どちらが動いたかは、最後に合わせた値との差で見分ける。見分けずに URL を優先すると、
   * 番頭が開いたGUIをこちらが押し戻してしまう（決定2「目の前の話は壊れない」）。
   */
  const syncedTabRef = useRef<string>(undefined);
  /** POがカタログから開いた1回だけ履歴に積む（番頭が開いた分は積まない）。 */
  const followOpenedTab = useRef(false);

  /** カタログから1つ開く（押しても、絞ってEnterでも同じ経路を通る）。 */
  const openFromCatalog = (kind: string): void => {
    // POが自分で開いたGUIなので、戻るで前のタブへ帰れるようにする
    followOpenedTab.current = true;
    session.openView(kind);
    setCatalogOpen(false);
    setCatalogQuery("");
  };
  const catalogNav = useListNav(catalogOrdered, {
    onChoose: (entry) => openFromCatalog(entry.kind),
    resetKey: catalogQuery,
  });

  const { activeThreadId, activeTabId, tabs: canvasTabs, canvasKnown, switchTab } = session;
  useEffect(() => {
    if (!activeThreadId) return;
    const urlTab = view.tabId;
    if (urlTab === activeTabId) {
      syncedTabRef.current = activeTabId;
      followOpenedTab.current = false;
      return;
    }
    // URL の指すタブがまだ開いているなら、そこへ合わせる（＝戻る／進む・復元の経路）
    if (urlTab !== undefined && urlTab !== syncedTabRef.current) {
      if (canvasTabs.some((t) => t.id === urlTab)) {
        syncedTabRef.current = urlTab;
        switchTab(urlTab);
        return;
      }
      // まだこの会話の canvas_state が届いていないなら、消さずに待つ——
      // 届く前に消すと、復元したいタブを自分で捨てることになる
      if (!canvasKnown) return;
    }
    const push = followOpenedTab.current;
    followOpenedTab.current = false;
    syncedTabRef.current = activeTabId;
    navigate((prev) => ({ ...prev, tabId: activeTabId }), { replace: !push });
  }, [activeThreadId, activeTabId, canvasTabs, canvasKnown, switchTab, view.tabId, navigate]);

  const activeTab = session.tabs.find((t) => t.id === session.activeTabId);
  const activeSpec = activeTab
    ? session.catalog.find((c) => c.kind === activeTab.kind)
    : undefined;
  const ActiveView = activeSpec ? resolveCanvasView(activeSpec.component) : undefined;
  const settingsEndpoint = session.modules.find((m) => m.name === "settings")?.baseUrl;

  /**
   * モジュール名 → 到達先。GUI がまたぐとき（検証環境の画面が場所の一覧を要る等）に使う。
   * カタログが持っている情報をそのまま引くだけで、UI 側にURLを持たせない（決定25）。
   */
  const endpointOf = useCallback(
    (moduleName: string): string | undefined =>
      // GUI を持たないモジュール（設定など）はカタログに出ないので、モジュールの表を先に見る
      session.modules.find((m) => m.name === moduleName)?.baseUrl ??
      session.catalog.find((entry) => entry.module === moduleName)?.endpoint,
    [session.modules, session.catalog]
  );

  /**
   * 収まらないタブの収納（プロトタイプ六次改訂と同じ計算）。**いま見ているタブは隠さない**
   * ——見えている中身の名前が消えると、何を見ているのか分からなくなる。
   */
  const tabOverflow = useTabOverflow(
    session.tabs.map((t) => t.id),
    { reservePx: 52, gapPx: 3, ...(session.activeTabId ? { pinnedId: session.activeTabId } : {}) }
  );
  const hiddenTabIds = tabOverflow.hiddenIds;
  const hiddenTabs = session.tabs.filter((t) => hiddenTabIds.has(t.id));

  /**
   * スマホ表示：**キャンバスのタブが動いたらキャンバス側へ移る**（プロトタイプ四次改訂）。
   * 番頭が「開きました」と言っているのに何も見えないのが一番困る。最初の描画では動かさない
   * ——復元して開いた会話でいきなりチャットから飛ばされるのを避ける。
   */
  const mobileMounted = useRef(false);
  useEffect(() => {
    if (!mobileMounted.current) {
      mobileMounted.current = true;
      return;
    }
    if (session.activeTabId) setMobileView("canvas");
  }, [session.activeTabId]);

  /** 選択されたファイルを添付待ちに加える。画像は vision 対応を確認してから。 */
  const addFiles = (files: FileList | null): void => {
    if (!files) return;
    setAttachError(undefined);
    const accepted: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        if (!modelInfo?.vision) {
          // 非対応モデルには選択時点で添付させない（サーバー側でももう一度断る）
          setAttachError(`${modelInfo?.id ?? "現在のモデル"}は画像非対応です`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          setAttachError(
            `画像「${file.name}」は大きすぎます（上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB）`
          );
          continue;
        }
        accepted.push({
          kind: "image",
          name: file.name,
          size: file.size,
          mimeType: file.type,
          file,
          previewUrl: URL.createObjectURL(file),
        });
      } else {
        if (file.size > MAX_FILE_BYTES) {
          setAttachError(`テキストファイル「${file.name}」は大きすぎます（上限 100KB）`);
          continue;
        }
        accepted.push({ kind: "file", name: file.name, size: file.size, file });
      }
    }
    if (accepted.length > 0) setPending((prev) => [...prev, ...accepted]);
    // 同じファイルをもう一度選べるようにする
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePending = (index: number): void => {
    setPending((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  /**
   * クリップボードからの画像ペースト。
   *
   * スクショを撮って貼るのが一番短い経路なのに、これまではファイル選択を
   * 経由する必要があった。画像だけを取り出して添付に回し、**テキストには触らない**
   * ——preventDefault しないので、文字のペーストは既定のまま動く。
   */
  const handlePaste = useCallback(
    (event: React.ClipboardEvent): void => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const transfer = new DataTransfer();
      let foundImage = false;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          const file = items[i].getAsFile();
          if (file) {
            transfer.items.add(file);
            foundImage = true;
          }
        }
      }
      if (foundImage) {
        addFiles(transfer.files);
        return;
      }
    },
    [addFiles],
  );

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error(`${file.name} を読み込めません`));
      reader.readAsText(file);
    });

  const readImageAsBase64 = (file: File): Promise<{ dataBase64: string; mimeType: string }> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const comma = dataUrl.indexOf(",");
        if (comma === -1) {
          reject(new Error(`${file.name} を読み込めません`));
          return;
        }
        resolve({
          dataBase64: dataUrl.slice(comma + 1),
          mimeType: file.type || "application/octet-stream",
        });
      };
      reader.onerror = () => reject(new Error(`${file.name} を読み込めません`));
      reader.readAsDataURL(file);
    });

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if ((text.length === 0 && pending.length === 0) || session.busy) return;
    setAttachError(undefined);
    try {
      // 添付は送信時に読む（画像は base64、テキストファイルは内容そのまま）
      const attachments: Attachment[] = [];
      for (const att of pending) {
        if (att.kind === "image") {
          const { dataBase64, mimeType } = await readImageAsBase64(att.file);
          attachments.push({ kind: "image", name: att.name, mimeType, dataBase64 });
        } else {
          const content = await readFileAsText(att.file);
          // NUL を含むものはバイナリ——テキストとして添付すると文脈を壊す（I2）
          if (content.includes("\u0000")) {
            setAttachError(`「${att.name}」はテキストとして読めないため添付できません`);
            return;
          }
          attachments.push({ kind: "file", name: att.name, content });
        }
      }
      session.send(text, attachments);
      // 送ったら最下部へ戻して、そこから応答を追いかける（PO要望）。
      // 上を読んでいる途中で自分が話しかけたなら、見たいのは自分の発話とその返事
      void chat.scrollToBottom();
      setDraft("");
      for (const att of pending) if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      setPending([]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * タブ1つ分。**タブ列と ▾ の中で同じものを描く**——収納されたときだけ別の見た目に
   * すると、同じものが2通りに見える。
   */
  const canvasTab = (
    tab: (typeof session.tabs)[number],
    index: number,
    inMenu: boolean
  ): React.ReactElement => (
    <span
      key={tab.id}
      data-tab-id={tab.id}
      className={[
        inMenu ? "canvas-menu-row" : "canvas-tab",
        tab.id === session.activeTabId ? "is-active" : "",
        !inMenu && dropIndex === index ? "is-drop-target" : "",
        !inMenu && hiddenTabIds.has(tab.id) ? "is-hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={!inMenu}
      onDragStart={() => setDragTabId(tab.id)}
      onDragEnd={() => {
        setDragTabId(undefined);
        setDropIndex(undefined);
      }}
      onDragOver={(e) => {
        if (inMenu || !dragTabId) return;
        e.preventDefault();
        setDropIndex(index);
      }}
      onDrop={(e) => {
        if (inMenu) return;
        e.preventDefault();
        // 並べ替えはホストへ投げる。UIは順序を自前で持たない（D3）
        if (dragTabId) session.reorderTab(dragTabId, index);
        setDragTabId(undefined);
        setDropIndex(undefined);
      }}
    >
      <button
        className="canvas-tab-label"
        /* 符牒。上段の列から、他で取られていない字だけを左から振る
           （i=取次 h=履歴 s=設定 t=明暗 k=⌘K n=新会話 o=開く f=符牒 c=入力 は避ける） */
        {...(inMenu ? {} : { "data-key": "qweryupa"[index] })}
        /* ホストへ直接投げず URL を動かす。押した経路と戻るの経路を1本にする */
        onClick={() => {
          navigate((prev) => ({ ...prev, tabId: tab.id }));
          setTabMenuOpen(false);
        }}
        title={inMenu ? tab.kind : `${tab.kind}（ドラッグで並べ替え）`}
      >
        {/* カタログの絵をタブにも出す。狭い画面では字が切れても、これで見分けがつく */}
        <Icon name={iconOfKind(tab.kind)} size={14} className="canvas-tab-icon" />
        <span className="canvas-tab-text">{tab.title}</span>
      </button>
      <button
        className="canvas-tab-close"
        onClick={() => session.closeTab(tab.id)}
        aria-label={`${tab.title} を閉じる`}
      >
        <Icon name="close" size={13} />
      </button>
    </span>
  );

  return (
    <div className={`shell mobile-view-${mobileView}`}>
      <CommandPalette
        open={palette.open}
        onClose={() => palette.setOpen(false)}
        threads={session.threads}
        closedThreads={session.closedThreads}
        catalog={openableCatalog}
        inbox={session.inbox}
        /* 会話へ飛んだらそのまま話しかけられるようにする（PO要望 2026-08-06）——
           キーで開いたのに、話しかけるのにマウスへ持ち替えるのでは近道にならない。
           面（キャンバスのGUI・取次・設定）へ飛んだときは移さない：見に行ったのであって、
           話しかけに行ったのではない */
        onOpenThread={(id) => {
          session.switchThread(id);
          focusComposer();
        }}
        onReopenThread={(id) => {
          session.reopenThread(id);
          focusComposer();
        }}
        onOpenView={(kind) => {
          followOpenedTab.current = true;
          backToChat();
          session.openView(kind);
        }}
        onOpenInbox={openInboxItem}
        onFace={showFace}
        onNewThread={() => {
          backToChat();
          session.openThread();
          focusComposer();
        }}
        onToggleTheme={theme.toggle}
      />
      <header className="shell-topbar">
        {/* 屋号。明朝の「番頭」と、その下に読みを敷く（spec-design §2.1） */}
        <div className="brand">
          <span className="brand-name">番頭</span>
          <span className="brand-sub">banto</span>
        </div>
        <ThreadTabs
          threads={session.threads}
          activeThreadId={session.activeThreadId}
          unreadThreadIds={session.unreadThreadIds}
          onSwitch={(id) => {
            // 会話を選んだら面も会話へ戻る。**選んだのに設定が出たままなのは、押した意図と
            // 食い違う**（履歴も設定も会話に被さる面なので同じ扱い）。面の切替は
            // switchThread が URL ごと動かす
            session.switchThread(id);
          }}
          onClose={session.closeThread}
          onRename={session.renameThread}
          onOpen={() => {
            // 開いた会話へ移るのはホストの返事を受けてから（followNewThread）。
            // 面だけは押した時点で戻す——待っている間、設定を見せ続けない
            backToChat();
            session.openThread();
          }}
        />
        {/* 取次（spec-design §0④）。常に見えているのはこのボタンと数字だけ */}
        <button
          className={`inbox-tab ${inboxOpen ? "is-active" : ""} ${session.inboxPending === 0 ? "is-empty" : ""}`}
          type="button"
          onClick={() => showFace("inbox")}
          title="取次（番頭に用があるもの）"
          data-key="i"
        >
          <Icon name="inbox" size={17} />
          <span className="inbox-tab-label">取次</span>
          <span className="inbox-n">{session.inboxPending}</span>
        </button>
        <button
          className={`pin-tab ${historyOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("history")}
          title="畳んだ会話の履歴"
          aria-label="履歴"
          data-key="h"
        >
          <Icon name="history" size={17} />
        </button>
        {/* 設定は一級の面（決定41）。会話タブの列とは混ざらないよう、右端に固定する */}
        <button
          className={`pin-tab ${settingsOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("settings")}
          title="設定"
          aria-label="設定"
          data-key="s"
        >
          <Icon name="settings" size={17} />
        </button>
        {/* 明暗の切替。同じトークンの裏返しなので、押しても色の役は動かない（spec-design ③） */}
        <button
          className="pin-tab cmdk-tab"
          type="button"
          onClick={() => palette.setOpen(true)}
          title="横断して引く（⌘K）"
          aria-label="横断して引く"
          data-key="k"
        >
          <Icon name="search" size={16} />
          <kbd className="cmdk-key">⌘K</kbd>
        </button>
        <button
          className="pin-tab"
          type="button"
          onClick={theme.toggle}
          title={`${theme.family.name}：${theme.mode === "dark" ? "明かりを点ける" : "明かりを落とす"}`}
          aria-label="明るさを切り替える"
          data-key="t"
        >
          <Icon name={theme.mode === "dark" ? "sun" : "moon"} size={17} />
        </button>
        <span className={`conn conn--${session.status}`}>
          {session.status === "open"
            ? "接続中"
            : session.status === "connecting"
              ? "接続しています…"
              : session.status === "reconnecting"
                ? "繋ぎ直しています…"
                : "切断"}
        </span>
      </header>

      {settingsOpen ? (
        settingsEndpoint ? (
          <SettingsPanel
            params={{}}
            tabId="settings"
            kind="settings"
            module="settings"
            endpoint={settingsEndpoint}
            endpointOf={endpointOf}
            openCanvas={session.openView}
            section={view.section}
            /* undefined を渡すと区画から出る（狭い画面の「一覧へ戻る」） */
            onSection={(id) => navigate((prev) => ({ ...prev, section: id }))}
          />
        ) : (
          <div className="threads-empty">
            <p className="threads-empty-title">設定を開けません</p>
            <p className="threads-empty-sub">
              設定モジュールが登録されていません（ホストの構成を確認してください）
            </p>
          </div>
        )
      ) : inboxOpen ? (
        <InboxFace
          items={session.inbox}
          onAnswer={session.answerInbox}
          /* 開く先はホストが動かす。動いたら会話（または設定）へ移す——
             面が被さったままだと、開いたものが見えない */
          onOpen={openInboxItem}
          onBack={backToChat}
        />
      ) : historyOpen ? (
        <ThreadHistory
          closedThreads={session.closedThreads}
          chatOf={session.chatOf}
          ensureHistory={session.ensureHistory}
          historyLoaded={session.historyLoaded}
          selectedId={view.readThreadId}
          onSelect={(id) => navigate((prev) => ({ ...prev, readThreadId: id }))}
          /* 再開すると会話面へ移る（reopenThread が URL ごと動かす） */
          onReopen={(id) => session.reopenThread(id)}
          onBack={backToChat}
        />
      ) : !session.activeThreadId ? (
        /* 全部畳んだ空状態（どの会話も畳めるようにした帰結。プロトタイプにも空状態がある） */
        <div className="threads-empty">
          <p className="threads-empty-title">開いている会話はありません</p>
          <p className="threads-empty-sub">
            新しく始めるか、履歴から畳んだ会話を再開してください。
          </p>
          <div className="threads-empty-actions">
            <button className="btn btn--primary" onClick={() => session.openThread()}>
              <Icon name="plus" size={15} /> 新しい会話を始める
            </button>
            {session.closedThreads.length > 0 && (
              <button className="btn" onClick={() => showFace("history")}>
                <Icon name="history" size={15} /> 履歴を見る（{session.closedThreads.length}）
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className="shell-body">
        <main className="canvas-pane">
          {/* タブ列と、収納の ▾ ・「開く」は別の器に置く。**メニューは器の外**に出さないと、
              タブ列の幅で切り取られる（実際に踏んだ） */}
          <div className="canvas-tabbar">
            <div className="canvas-tabstrip" ref={tabOverflow.stripRef}>
              {session.tabs.length === 0 ? (
                <span className="canvas-tab-empty">タブなし</span>
              ) : (
                session.tabs.map((tab, index) => canvasTab(tab, index, false))
              )}
            </div>

            {/* 収まらないタブは ▾ にまとめる。**横に流さない**——端に隠れたタブは、
                在ることも数も見えないまま指で探すことになる */}
            {hiddenTabs.length > 0 && (
              <div className="canvas-more-wrap">
                <button
                  className="canvas-more-btn"
                  type="button"
                  aria-expanded={tabMenuOpen}
                  title={`表示しきれないタブ（${hiddenTabs.length}）`}
                  onClick={() => setTabMenuOpen((v) => !v)}
                >
                  <span className="canvas-more-count">{hiddenTabs.length}</span>
                  <Icon name="chevron-down" size={14} />
                </button>
                {tabMenuOpen && (
                  <div className="canvas-more-menu">
                    {hiddenTabs.map((tab) => canvasTab(tab, session.tabs.indexOf(tab), true))}
                  </div>
                )}
              </div>
            )}

            {/* POが自分でGUIを開く入口（決定25の人側の経路）。省スペースのため「＋」のみ */}
            {openableCatalog.length > 0 && (
              <button
                className="canvas-catalog-btn"
                onClick={() => setCatalogOpen(true)}
                aria-label="開くものを選ぶ"
                aria-expanded={catalogOpen}
                title="開くものを選ぶ"
                data-key="o"
              >
                <Icon name="plus" size={16} />
              </button>
            )}
          </div>

          <div className="canvas-body">
            {/* **この面に関わる判断待ち**を面の中にも出す（spec-design §1.1）。
                取次を開かないと気づけない、では判断が滞る。器の側で出すので、
                個々の面は取次を知らなくてよい（D5） */}
            {activeTab && (
              <PendingDecisions
                items={session.inbox.filter(
                  (i) => !i.resolvedAt && i.opens?.canvas?.kind === activeTab.kind
                )}
                onAnswer={session.answerInbox}
                onOpen={openInboxItem}
              />
            )}
            {!activeTab ? (
              <div className="canvas-empty">
                <div className="canvas-empty-inner">
                  <Icon name="canvas" size={30} stroke={1.2} className="canvas-empty-mark" />
                  <p className="canvas-empty-title">キャンバスには何も開かれていません</p>
                  <p className="canvas-empty-sub">
                    番頭に「〜を開いて」と頼むとここに出ます。自分で開くこともできます。
                  </p>
                  {/* 一覧を読ませるのではなく、そのまま押せるようにする（決定25の人側の経路） */}
                  <div className="canvas-empty-grid">
                    {openableCatalog.map((entry) => (
                      <button
                        key={entry.kind}
                        className="canvas-empty-card"
                        title={entry.description}
                        onClick={() => {
                          followOpenedTab.current = true;
                          session.openView(entry.kind);
                        }}
                      >
                        <Icon name={iconOfKind(entry.kind)} size={17} className="ci-ico" />
                        <span className="canvas-empty-card-name">{entry.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : ActiveView ? (
              // key にタブID＋版を渡す。IDだけだと (a) 同じ種別の別タブで状態が混ざり、
              // (b) タブを使い回して別のパラメータで開き直しても中身が作り直されない
              // （どちらも実際に踏んだ）
              <ActiveView
                key={`${activeTab.id}:${activeTab.rev}`}
                params={activeTab.params}
                tabId={activeTab.id}
                kind={activeTab.kind}
                module={activeSpec!.module}
                endpoint={activeSpec!.endpoint}
                endpointOf={endpointOf}
                openCanvas={session.openView}
              />
            ) : (
              // I2: カタログにあるのにUIが解決できない＝配線漏れ。黙って空にせず理由を出す
              <div className="canvas-empty">
                <div className="canvas-empty-inner">
                  <Icon name="warn" size={30} stroke={1.2} className="canvas-empty-mark" />
                  <p className="canvas-empty-title">この面を描けません</p>
                  <p className="canvas-empty-sub">
                    コンポーネント <code>{activeSpec?.component ?? "(不明)"}</code>{" "}
                    がUI側の解決表にありません（配線漏れです）。
                  </p>
                </div>
              </div>
            )}
          </div>
          {catalogOpen && (
            <Modal
              title="キャンバスに開く"
              onClose={() => setCatalogOpen(false)}
              footer={
                <>
                  <span className="picker-hint">↑↓ で選ぶ · Enter で開く · Esc で閉じる</span>
                  {/* I2: 描けない面があることを黙らない。出所（kind）まで出す——直せるのは
                      「UIの解決表に足す」か「モジュールの登録を外す」のどちらかなので */}
                  {unresolvedCatalog.length > 0 && (
                    <span className="catalog-unresolved">
                      この画面で描けない面が {unresolvedCatalog.length} 件あります（配線漏れ）:{" "}
                      {unresolvedCatalog.map((e) => e.kind).join(", ")}
                    </span>
                  )}
                </>
              }
            >
              <div className="catalog-search">
                <SearchField
                  value={catalogQuery}
                  onChange={setCatalogQuery}
                  onKeyDown={catalogNav.onKeyDown}
                  placeholder="名前・説明で絞る"
                  autoFocus
                />
              </div>
              <div ref={catalogNav.listRef}>
                {catalogGroups.length === 0 ? (
                  <p className="catalog-empty">「{catalogQuery}」に当てはまる面はありません。</p>
                ) : (
                  catalogGroups.map(([category, entries]) => (
                    <div key={category}>
                      <div className="catalog-group-label">{category}</div>
                      {entries.map((entry) => {
                        const opened = session.tabs.some((t) => t.kind === entry.kind);
                        const index = catalogOrdered.indexOf(entry);
                        return (
                          <button
                            key={entry.kind}
                            className={`catalog-item ${catalogNav.isOn(index) ? "is-on" : ""}`}
                            onClick={() => openFromCatalog(entry.kind)}
                            title={`${entry.kind} · ${entry.module}`}
                            {...catalogNav.rowProps(index)}
                          >
                            <Icon name={iconOfKind(entry.kind)} size={17} className="ci-ico" />
                            <span className="ci-body">
                              <span className="ci-name">{entry.title}</span>
                              {/* 何のための面かを一行で。名前だけでは開くまで分からない */}
                              <span className="ci-desc">{entry.description}</span>
                            </span>
                            {/* 既に開いているものは、増やすのではなくそこへ移ると分かるようにする */}
                            {opened && <span className="ci-open">開いています</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </Modal>
          )}
        </main>

        {/* 境界のドラッグでチャット欄の幅を変える（PO要望 2026-07-31）。
            狭い画面では上下に積むので出さない（CSS 側で消す） */}
        <div
          className="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="チャット欄の幅を変える"
          onPointerDown={startResize}
          onDoubleClick={() => setChatWidth(CHAT_WIDTH_DEFAULT)}
          title="ドラッグで幅を変える（ダブルクリックで既定に戻す）"
        />

        <aside className="chat-pane" ref={chatPaneRef} style={{ width: chatWidth }}>
          <div className="chat-head">
            <div className="chat-head-main">
              {/* **いま何の話をしているか**を出す（診断06）。道具の数と接続IDは、
                  どの会話を見ていても同じ値で、見出しの役に立っていなかった */}
              <div className="chat-title">
                {session.threads.find((t) => t.threadId === session.activeThreadId)?.title ?? "番頭と相談する"}
              </div>
            </div>
            <button
              title="いまの会話を畳んで新しく始めます（畳んだ会話は履歴に残ります）"
              className="btn btn--ghost btn--small"
              /* 確認を取らない：畳むだけで消えないので、取り返しがつく（PO要望 2026-07-31） */
              onClick={() => session.newSession()}
              disabled={session.chat.length === 0}
            >
              新しい会話
            </button>
          </div>

          <div className="chat-scroll" ref={chat.scrollRef}>
            {/* 追従は「中身の高さ」を ResizeObserver で見て決まるので、器と中身を分ける */}
            <div className="chat-scroll-content" ref={chat.contentRef}>
            {session.chat.length === 0 && (
              <p className="chat-empty">
                番頭に話しかけてください。キャンバスに何かを出したいときは「〜を開いて」と頼みます。
              </p>
            )}
            {/* 遡って読みたくなったぶんだけ描く。押した分は下に留まる（追従は切れない） */}
            {shownFrom > 0 && (
              <button
                className="chat-load-older"
                type="button"
                onClick={() => setShownCount((n) => n + CHAT_WINDOW)}
              >
                以前の発言を読む（残り {shownFrom} 件）
              </button>
            )}
            {shownChat.map((entry, offset) => {
              // 元の並びでの位置。**窓の中の位置と混ぜない**——読み捨てたエラーの記録も、
              // 「届いている最中の行か」の判定も、会話全体での位置で持っている
              const i = shownFrom + offset;
              const threadId = session.activeThreadId;
              if (entry.role === "error" && threadId && dismissedErrors[threadId]?.has(i)) {
                return null;
              }
              return (
                <ChatRow
                  key={(entry as { id?: string }).id ?? i}
                  entry={entry}
                  // 届いている最中なのは末尾の行だけ。思考の見出し（考えています／X秒間考えました）
                  // の切り替えに使う
                  isStreaming={chatStatus === "streaming" && i === session.chat.length - 1}
                  onDismissError={
                    entry.role === "error" && threadId ? () => dismissError(threadId, i) : undefined
                  }
                />
              );
            })}
            {/* 番頭が喋り始めたら消す——本文そのものが進んでいる証拠になる */}
            {chatStatus === "submitted" && <ThinkingRow />}
            </div>
          </div>

          {/* 一番下にいないときだけ出す。番頭が喋っていることに気づけるようにする */}
          {!chat.isAtBottom && session.chat.length > 0 && (
            <button
              className="chat-to-bottom"
              onClick={() => void chat.scrollToBottom()}
              title="一番下へ"
            >
              <Icon name="arrow-down" size={16} />
            </button>
          )}

          {/*
            **この会話に関わる判断待ちを、入力欄のすぐ上に出す**（PO裁定 2026-08-09）。
            取次にあるのと同じ札で、押した結果も同じ（真実は一箇所・D3）。

            会話の流れに差し込まず固定するのは、遡ると見えなくなる位置だと
            **判断待ちを持ったまま話し続けられてしまう**から。答えると消え、
            番頭の返事が会話の続きとして入る。

            出すのは「この会話宛」と「どの会話でもない」もの——他の会話で頼まれた判断が
            ここに出ると、文脈の無い札を読まされることになる
          */}
          <PendingDecisions
            items={session.inbox.filter(
              (i) =>
                !i.resolvedAt &&
                (i.opens?.threadId === undefined || i.opens.threadId === session.activeThreadId)
            )}
            onAnswer={session.answerInbox}
            onOpen={openInboxItem}
            variant="chat"
          />

          {/* AI Elements の PromptInput：添付・入力欄・道具立てを1つの枠に収める */}
          <div className="chat-composer">
            {/* 符牒 c で番頭に話しかけにいける。器のどこを押しても入力へ移る
                （余白を押しても入力が始まる、という当たり前の挙動も同時に入る） */}
            <div className="composer-box" data-key="c" onClick={() => inputRef.current?.focus()}>
            {pending.length > 0 && (
              <div className="attach-list">
                {pending.map((att, i) => (
                  <span className="attach-chip" key={`${att.name}:${i}`}>
                    {att.kind === "image" && att.previewUrl && (
                      <img className="attach-thumb" src={att.previewUrl} alt={att.name} />
                    )}
                    <span className="attach-name" title={att.name}>
                      <Icon name={att.kind === "image" ? "image" : "file"} size={13} /> {att.name}
                    </span>
                    <button
                      className="attach-remove"
                      type="button"
                      onClick={() => removePending(i)}
                      aria-label={`${att.name} を取り消す`}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError && (
              <div className="attach-error" role="alert">
                <Icon name="error" size={14} />
                <span className="attach-error-text">{attachError}</span>
                <button
                  className="attach-error-close"
                  type="button"
                  onClick={() => setAttachError(undefined)}
                  aria-label="このエラーを閉じる"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
            <textarea
              className="chat-input"
              ref={inputRef}
              value={draft}
              placeholder={session.busy ? "番頭が考えています…" : "番頭に相談する"}
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                // Enter で送信、Shift+Enter で改行。IME変換中の Enter は送信しない
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
                // 空欄での Backspace は最後の添付を取り消す（AI Elements と同じ）。
                // 消したい添付が入力欄のすぐ上にあるので、マウスへ持ち替えずに済む
                if (e.key === "Backspace" && e.currentTarget.value === "" && pending.length > 0) {
                  e.preventDefault();
                  removePending(pending.length - 1);
                }
              }}
            />
            {/* 画像とテキストファイルの選択。添付の可否は選択時に判定する */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={ACCEPT_TYPES}
              onChange={(e) => addFiles(e.target.files)}
            />
            <div className="chat-actions">
              <button
                className="attach-btn"
                type="button"
                onClick={() => fileInputRef.current?.click()}
                title="画像・テキストファイルを添付（貼り付け・ドラッグ＆ドロップも可）"
                aria-label="添付"
              >
                <Icon name="plus" size={16} />
              </button>
              {/* モデルは道具立ての中に置く（AI Elements と同じ位置）。切替はホストが握る */}
              <ModelSelect current={session.model} onSelect={session.setModel} />
              <ContextMeter
                tokens={session.contextTokens}
                contextWindow={session.model?.contextWindow}
              />
              <span className="chat-hint">Enter で送信</span>
              {/*
                状態で姿が変わる1つのボタン（AI Elements の `PromptInputSubmit`）。
                ↵＝送る／独楽＝返事待ち／■＝喋っている最中（押すと中断）／×＝直前が失敗。
                ボタンを増やさないのは、押す場所が動くと目で追い直すことになるため
              */}
              <button
                className={`composer-submit is-${chatStatus}`}
                type="button"
                onClick={() => (chatStatus === "streaming" ? session.abort() : void submit())}
                disabled={
                  chatStatus === "ready" && draft.trim().length === 0 && pending.length === 0
                }
                aria-label={chatStatus === "streaming" ? "中断" : "送る"}
                title={chatStatus === "streaming" ? "中断" : "送る"}
              >
                {chatStatus === "submitted" ? (
                  <Loader />
                ) : chatStatus === "streaming" ? (
                  <span className="composer-submit-stop" />
                ) : chatStatus === "error" ? (
                  <Icon name="close" size={15} />
                ) : (
                  <Icon name="enter" size={15} />
                )}
              </button>
            </div>
            </div>
          </div>
        </aside>

        {/* スマホ用フッター */}
        <div className={`mobile-footer ${session.status === "open" ? "" : "hidden"}`}>
          <button
            className={`mobile-footer-btn ${mobileView === "chat" ? "is-active" : ""}`}
            onClick={() => setMobileView("chat")}
            title="チャット"
          >
            <Icon name="chat" size={16} /> チャット
          </button>
          <button
            className={`mobile-footer-btn ${mobileView === "canvas" ? "is-active" : ""}`}
            onClick={() => setMobileView("canvas")}
            title="キャンバス"
          >
            <Icon name="canvas" size={16} /> キャンバス
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
