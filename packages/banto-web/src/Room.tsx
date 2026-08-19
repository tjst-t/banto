/**
 * 会話の1列（間）— 幹も枝も同じ器で描く（ADR-0017 決定77・79・80）。
 *
 * 幹と枝は**同じもの**として描く：どちらも会話で、違うのは頭（還す条件・畳む口）だけ。
 * 2通りに描くと、POは「いまどちらを読んでいるか」を見た目から学び直すことになる。
 *
 * **作業する面が開くと、この列は細い帯になる**（決定79）。そこで読むのではなく、
 * **話しかけるための幅**だから——面を見ながら「これ何？」と訊けないのは、番頭が主体の
 * 店として本末転倒。帯の幅はつまんで変えられる。
 *
 * **判断待ちは常設しない**（決定80）。会話の流れの中に立ち、遡ったときだけ↓が朱になる。
 *
 * D3/D5: 会話の真実はホスト。ここは配られたものを描き、押されたことを投げ返すだけ。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
// D6: 末尾追従は Vercel AI Elements と同じ use-stick-to-bottom に任せる
import { useStickToBottom } from "use-stick-to-bottom";
import type { Attachment, InboxItemView, ThreadView } from "@banto/host/protocol";
import type { LlmModelInfo } from "@banto/core";
import { ChatRow, Loader } from "./messages.js";
import { PendingDecisions } from "./Inbox.js";
import { MergeBranchForm } from "./Branch.js";
import { Icon } from "./icons.js";
import { Modal, SearchField } from "./views/ui.js";
import { callModuleTool } from "./views/useModuleTool.js";
import { useListNav } from "./listNav.js";
import { prefersNoAutoFocus } from "./prefersNoAutoFocus.js";
import type { BantoSession, CurrentModel } from "./useBantoSession.js";

/**
 * 中核の Tool の到達先（ADR-0011 決定42）。`llm.*` はモジュールではなく中核のドメイン。
 * 相対パスなので、自分のオリジン（＝開発時は vite、常駐時はホスト）に解決される。
 */
const CORE_TOOL_ENDPOINT = "/api/core";
/** 設定モジュールの口（番頭には渡らない `internalTools`）。 */
const SETTINGS_TOOL_ENDPOINT = "/api/settings";

/** 入力欄の最大の高さ（AI Elements の `max-h-48`）。最低の高さは CSS の min-height。 */
const MAX_COMPOSER_HEIGHT_PX = 192;

/** 思考レベルの選択肢（2026-08-19 提案）。空＝サービス既定に従う。バックエンド側で解釈・変換する。 */
const PI_THINKING_CHOICES: Array<{ value: string; label: string }> = [
  { value: "", label: "思考: 既定" },
  { value: "off", label: "思考: off" },
  { value: "low", label: "思考: low" },
  { value: "medium", label: "思考: medium" },
  { value: "high", label: "思考: high" },
  { value: "xhigh", label: "思考: xhigh" },
  { value: "max", label: "思考: max" },
];

/** Claude Code の思考レベルの選択肢。 */
const CLAUDE_THINKING_CHOICES: Array<{ value: string; label: string }> = [
  { value: "", label: "思考: 既定" },
  { value: "disabled", label: "思考: disabled" },
  { value: "adaptive", label: "思考: adaptive" },
];

/** バックエンドに合った思考レベルの選択肢（pi はレベル、Claude Code は config）。 */
function thinkingChoicesFor(backend?: string): Array<{ value: string; label: string }> {
  return backend === "claude-agent-sdk" ? CLAUDE_THINKING_CHOICES : PI_THINKING_CHOICES;
}

/**
 * チャットに一度に描く発話の数。
 *
 * 200 は「開いた直後に画面を数枚ぶん埋めて、なお余る」量。これ以上増やしても
 * 最初の一画面には出ないが、Markdown の組み立ては全部走ってしまう。
 */
const CHAT_WINDOW = 200;

/** テキスト添付の上限。これを超えたら添付せずエラー表示する。 */
const MAX_FILE_BYTES = 100 * 1024;
/** 画像の上限。WS の maxPayload 既定（100MiB）を base64（+33%）込みで割らない安全な値。 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** ファイル選択ダイアログで選べるもの。画像と、テキストとして読めるファイル。 */
const ACCEPT_TYPES =
  "image/*,.txt,.md,.log,.json,.jsonl,.csv,.tsv,.yml,.yaml,.toml,.xml,.html,.css," +
  ".js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.php," +
  ".sh,.bash,.sql,.ini,.cfg,.env,.diff,.patch,.gitignore";

/** 添付待ちの1ファイル。送信時に FileReader で読み取る。 */
export interface PendingFile {
  kind: "image" | "file";
  name: string;
  size: number;
  mimeType?: string;
  file: File;
  previewUrl?: string;
}

/** トークン数を読みやすく（1200 → 1.2k）。 */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * 送ってから最初の一文字が届くまでの間（AI Elements の `status === "submitted"`）。
 * **独楽だけを置く**——番頭が喋り始めたら消える。
 */
function ThinkingRow(): React.ReactElement {
  return (
    <div className="msg msg--thinking" role="status" aria-live="polite">
      <Loader />
      <span className="sr-only">考えています</span>
    </div>
  );
}

/**
 * この会話が文脈をどれだけ使っているか（AI Elements の `Context`）。
 * **実測が届くまで出さない**（I1）。
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
 * **バックエンド → プロバイダ → モデル の3段**（PO裁定 2026-08-13）。バックエンドは
 * プロバイダの上位の階層で、同じ `opus` が pi（opencode zen）経由でも Claude Code 経由でも
 * 選べる——だからモデル名からは決まらず、人が選ぶ。**ここで選べば会話の途中でも切り替わる**
 * （再起動は要らない）。
 *
 * 一覧は `settings.harness_models` から取る（番頭には渡さない口）。選んだ結果は自分で
 * 覚えない。ホストが `model_state` を配り直したときに変わる（D3）。
 * **押した脇に開くドロップダウンは使わない**（`Modal`。PO報告 2026-08-06）。
 */
interface BackendOption {
  id: string;
  label: string;
  unavailable?: string;
  providers: Array<{
    id: string;
    models: Array<{ id: string; name?: string; vision?: boolean; contextWindow?: number }>;
  }>;
}

/** 画面の一覧に並べる1行（バックエンドとプロバイダを畳んだ形）。 */
interface Choice {
  backend: string;
  backendLabel: string;
  provider: string;
  id: string;
  name: string;
}

function ModelSelect({
  current,
  onSelect,
}: {
  current: CurrentModel | undefined;
  onSelect: (provider: string, model: string, backend: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [backends, setBackends] = useState<BackendOption[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || backends) return;
    void callModuleTool<{ backends: BackendOption[] }>(
      SETTINGS_TOOL_ENDPOINT,
      "settings.harness_models",
      {}
    )
      .then((data) => setBackends(data.backends))
      // I2: 取れなかったことを黙らない。空の一覧を「モデルが無い」と誤読させない
      .catch((err: unknown) => setError(String(err)));
  }, [open, backends]);

  const all: Choice[] = (backends ?? [])
    .filter((b) => !b.unavailable)
    .flatMap((b) =>
      b.providers.flatMap((p) =>
        p.models.map((m) => ({
          backend: b.id,
          backendLabel: b.label,
          provider: p.id,
          id: m.id,
          name: m.name ?? m.id,
        }))
      )
    );
  const matched = all.filter((c) => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return true;
    return `${c.backendLabel} ${c.provider} ${c.name} ${c.id}`.toLowerCase().includes(q);
  });
  // バックエンド → プロバイダ の順に畳む（見出しは2段）
  const groups: Array<{ backend: string; backendLabel: string; provider: string; rows: Choice[] }> =
    [];
  for (const c of matched) {
    const last = groups[groups.length - 1];
    if (last && last.backend === c.backend && last.provider === c.provider) last.rows.push(c);
    else
      groups.push({
        backend: c.backend,
        backendLabel: c.backendLabel,
        provider: c.provider,
        rows: [c],
      });
  }
  const ordered = groups.flatMap((g) => g.rows);
  const blocked = (backends ?? []).filter((b) => b.unavailable);

  const close = (): void => {
    setOpen(false);
    setQuery("");
  };
  const pick = (c: Choice): void => {
    onSelect(c.provider, c.id, c.backend);
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
              {error === undefined && backends === undefined && (
                <div className="model-select-empty">読み込んでいます…</div>
              )}
              {backends !== undefined && matched.length === 0 && (
                <div className="model-select-empty">
                  {all.length === 0
                    ? "選べるモデルがありません。設定の「LLM・モデル」で採用してください。"
                    : "見つかりません"}
                </div>
              )}
              {groups.map((g) => (
                <div key={`${g.backend}/${g.provider}`}>
                  {/* **バックエンドはプロバイダの上位**。同じ opus が両方に出るのが正しい */}
                  <div className="model-select-group">
                    {g.backendLabel} <span aria-hidden>›</span> {g.provider}
                  </div>
                  {g.rows.map((c) => {
                    const isCurrent =
                      (current?.backend ?? "pi") === c.backend &&
                      current?.provider === c.provider &&
                      current?.id === c.id;
                    const index = ordered.indexOf(c);
                    return (
                      <button
                        key={`${c.backend}/${c.provider}/${c.id}`}
                        className={`model-select-item ${isCurrent ? "is-current" : ""} ${
                          nav.isOn(index) ? "is-on" : ""
                        }`}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        onClick={() => pick(c)}
                        {...nav.rowProps(index)}
                      >
                        <span className="model-select-item-name">{c.name}</span>
                        <span className="model-select-check">
                          {isCurrent && <Icon name="check" size={14} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
              {/* I2: 選べないバックエンドは黙って消さず、理由を出す */}
              {blocked.map((b) => (
                <div key={b.id} className="model-select-empty" title={b.unavailable}>
                  {b.label}：{b.unavailable}
                </div>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export interface RoomProps {
  session: BantoSession;
  /** この列が描いている会話（幹または枝）。 */
  thread: ThreadView;
  /** 作業する面が開いていて、この列が細い帯になっているか（決定79）。 */
  slim?: boolean;
  /** 狭い画面で、下から上がってきた紙として出ているか（決定79）。 */
  raised?: boolean;
  /** この会話に関わる判断待ち（決定80：会話の流れの中に立つ）。 */
  pending: InboxItemView[];
  onAnswerInbox(itemId: string, actionId: string): void;
  onOpenInbox(itemId: string): void;
  /** 枝の札から別の枝へ移る。 */
  onOpenBranch(threadId: string): void;
  /** 器の「面への口」。 */
  onOpenView(kind: string, params?: Record<string, unknown>): void;
  /** 枝を閉じて幹へ戻る（枝のときだけ）。 */
  onCloseBranch?(): void;
  /** 枝を畳んで幹へ還す（枝のときだけ）。 */
  onMergeBranch?(conclusion: string): void;
  /** 細い帯の幅をつまんで変える（決定79）。 */
  onGrip?(e: React.PointerEvent<HTMLDivElement>): void;
  /** いま見ている枝（札の強調に使う）。 */
  activeBranchId?: string;
  /**
   * 番頭への入力へ移れ、という合図（PO要望 2026-08-06）。
   *
   * **数が増えたら移る。** キーで会話へ飛んだのに、話しかけるのにマウスへ持ち替えるのでは
   * 近道にならない。面を見に行くときは移さない（見に行ったのであって、話しかけに行った
   * のではない）ので、呼び手が増やすかどうかを決める。
   */
  focusSeq?: number;
}

/**
 * 会話の1列。
 *
 * **末尾追従はこの列が持つ**——幹と枝が並ぶので、1つの hook を共有できない
 * （片方のスクロールがもう片方を動かす）。
 */
export function Room({
  session,
  thread,
  slim = false,
  raised = false,
  pending,
  onAnswerInbox,
  onOpenInbox,
  onOpenBranch,
  onOpenView,
  onCloseBranch,
  onMergeBranch,
  onGrip,
  activeBranchId,
  focusSeq = 0,
}: RoomProps): React.ReactElement {
  const threadId = thread.threadId;
  const isBranch = thread.kind === "branch";
  /*
   * **いま見ている幹の枝の一覧は、ここには置かない**（PO報告 2026-08-14）。
   * ADR-0022 決定112 でチャット欄の上に「流れない枝一覧」を敷いたが、`flex: none` の
   * 帯なので会話の中身にかかわらず常時 240px を占め、900px の窓では会話の3分の1が
   * 埋まっていた。置き場は履歴の面の「枝」タブ（`ThreadHistory`）へ移した——
   * 流れない場所に結論を残す、という決定112 の狙いはそちらで満たす。
   */
  /**
   * 畳んだ会話（PO報告 2026-08-10）。
   *
   * **入力欄を出さない。** 還したはずの枝で話が続くと、幹に還した結論と食い違う。
   * 代わりに結論と「開き直す」を出す——畳んでも消えない（決定30c）ので、続きは話せる。
   */
  const closed = thread.state === "closed";
  const chat = useMemo(() => session.chatOf(threadId), [session, threadId]);
  const busy = session.busyOf(threadId);
  const draft = session.draftOf(threadId);
  const model = session.modelOf(threadId);

  /**
   * 末尾追従。**最初の貼り付きだけ瞬間移動にする**——保存された会話を丸ごと復元してから
   * 貼り付くので、滑らせると先頭から最下部まで延々と動いて見える。
   */
  const stick = useStickToBottom({ initial: "instant", resize: "smooth" });
  const { scrollToBottom } = stick;

  /**
   * **追従が切れてよいのは、POが自分で上へ動かしたときだけ**（inc-0045・inc-0048）。
   *
   * 切れた理由が2つある。**POが読み返そうと上げた**のと、**追従の1フレームが
   * 切り詰められてライブラリが「上げられた」と誤読した**（inc-0045 の上流バグ）の2つ。
   * 前者なら従い、後者なら貼り直す——見分けが要る。
   *
   * 見分けは「**器が実際に上へ動いたか**」で付く。誤読のときは `scrollTop` が一度も
   * 下がらない（inc-0045 の実測。追従は代入するだけなので値は増える方向にしか動かない）。
   * POが上げたときだけ下がる。
   *
   * **掛け金にするのが要点**（inc-0048）。以前は「直前 400ms に仕草があったか」で
   * 見ていたが、猶予は仕草からの経過で測るのに**判定が走る時刻は選べない**。
   * POが上げたまま読んでいる最中に `isAtBottom` が一度揺れると、そのときには猶予を
   * 過ぎていて貼り直してしまう——負荷が高いほど揺れが遅れて出るので、混んでいるときだけ
   * 下へ引き戻された。掛け金なら**いつ判定が走っても答えが変わらない**。
   *
   * 外れるのは**本当に最下端まで戻ったとき**だけ（自分で下げる・↓を押す）。
   * ライブラリの `isAtBottom` では外さない——あちらは 70px の遊びを持つので、
   * 60px 上げて読んでいる最中に「最下部にいる」と読み、掛け金がその場で外れてしまう
   * （実測: この読み違いのせいで、掛け金を入れても 6回中1回はまだ引き戻された）。
   */
  const escaped = useRef(false);
  const lastTop = useRef(0);
  const noteScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const top = el.scrollTop;
    // 1px の遊び: 端数の丸めで下がった／届いていないように見えるのを拾わない
    if (top < lastTop.current - 1) escaped.current = true;
    else if (el.scrollHeight - top - el.clientHeight <= 1) escaped.current = false;
    lastTop.current = top;
  }, []);
  useEffect(() => {
    // 別の会話へ移ったら掛け金を戻す（前の会話で上げていたことを持ち越さない）
    escaped.current = false;
    lastTop.current = 0;
    void scrollToBottom({ animation: "instant" });
  }, [threadId, scrollToBottom]);
  useEffect(() => {
    if (stick.isAtBottom || escaped.current) return;
    void scrollToBottom({ animation: "instant" });
  }, [stick.isAtBottom, scrollToBottom]);

  /** 描くのは末尾の何件か。上へ遡りたいときだけ窓を広げる。 */
  const [shownCount, setShownCount] = useState(CHAT_WINDOW);
  useEffect(() => setShownCount(CHAT_WINDOW), [threadId]);
  const shownFrom = Math.max(0, chat.length - shownCount);
  const shownChat = useMemo(() => chat.slice(shownFrom), [chat, shownFrom]);

  const lastEntry = chat[chat.length - 1];
  const chatStatus: "ready" | "submitted" | "streaming" | "error" = busy
    ? lastEntry?.role === "banto" || lastEntry?.role === "tool" || lastEntry?.role === "reasoning"
      ? "streaming"
      : "submitted"
    : lastEntry?.role === "error"
      ? "error"
      : "ready";

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  /** 送るものがあるか。走行中の「足す／止めて話す」の出し分けもここで決まる（imp-0048）。 */
  const hasDraft = draft.trim().length > 0 || pendingFiles.length > 0;
  const [attachError, setAttachError] = useState<string>();
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<number>>(new Set());
  const [merging, setMerging] = useState(false);
  /**
   * 名前を付け直している最中の下書き（PO要望 2026-08-05・決定25 の人側）。
   *
   * **会話のタブが無くなったので、名付けの口は列の頭に移した**（ADR-0017 決定77）。
   * 真実はホスト（D3）——ここでは楽観的に書き換えず、`thread_state` が返るのを待つ。
   */
  const [renaming, setRenaming] = useState<string>();
  /**
   * 章を畳んでいる最中か（PO報告 2026-08-11）。
   *
   * **押しても何も起きないように見えていた**——引き継ぎ資料は別のモデルに書かせるので
   * 十数秒かかることがあり、その間ホストからは何も来ない。真実はホスト側（D3）なので
   * 会話は書き換えず、**押したことだけ**をここで持つ。畳めた印（`chapter`）か
   * しくじり（`error`）が会話に入ったら下ろす。
   */
  const [folding, setFolding] = useState(false);

  // 会話を移ったら添付と読み捨ての記録を落とす（別の会話に付けたつもりのものを送らない）
  useEffect(() => {
    setPendingFiles([]);
    setAttachError(undefined);
    setDismissedErrors(new Set());
    setMerging(false);
    setRenaming(undefined);
    setFolding(false);
  }, [threadId]);

  // 畳めた／畳めなかったが会話に入ったら、押している見た目を下ろす
  useEffect(() => {
    if (!folding) return;
    const last = chat[chat.length - 1];
    if (last?.role === "chapter" || last?.role === "error") setFolding(false);
  }, [chat, folding]);

  /**
   * 合図が来たら入力へ移る。
   *
   * **次のフレームでもう一度掴む。** 押した先（レールの点）へブラウザが焦点を戻すことが
   * あり、1回だけだと押した直後に奪われる——実際に符牒（⌥→数字）で踏んだ。
   *
   * **タッチ端末では移らない**（PO報告 2026-08-15）。切り替えるたびにソフトウェア
   * キーボードが開くと鬱陶しい。入力欄をタップして打つのは `.composer-box` の onClick が
   * 別に持っているので、ここを塞いでも「打ちたいときに打てない」にはならない。
   */
  useEffect(() => {
    if (focusSeq <= 0) return;
    if (prefersNoAutoFocus()) return;
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSeq]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const wanted = el.scrollHeight;
    el.style.height = `${Math.min(wanted, MAX_COMPOSER_HEIGHT_PX)}px`;
    el.style.overflowY = wanted > MAX_COMPOSER_HEIGHT_PX ? "auto" : "hidden";
  }, [draft, slim]);

  const addFiles = (files: FileList | null): void => {
    if (!files) return;
    setAttachError(undefined);
    const accepted: PendingFile[] = [];
    for (const file of Array.from(files)) {
      if (file.type.startsWith("image/")) {
        if (!model?.vision) {
          setAttachError(`${model?.id ?? "現在のモデル"}は画像非対応です`);
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
    if (accepted.length > 0) setPendingFiles((prev) => [...prev, ...accepted]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePending = (index: number): void => {
    setPendingFiles((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  /**
   * クリップボードからの画像ペースト。画像だけを取り出して添付に回し、
   * **テキストには触らない**——preventDefault しないので文字のペーストは既定のまま。
   */
  const handlePaste = (event: React.ClipboardEvent): void => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const transfer = new DataTransfer();
    let foundImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.type.startsWith("image/")) {
        const file = items[i]!.getAsFile();
        if (file) {
          transfer.items.add(file);
          foundImage = true;
        }
      }
    }
    if (foundImage) addFiles(transfer.files);
  };

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

  /**
   * 送る。**走っている最中でも送れる**（imp-0048・提案 §4 案I）。
   *
   * 以前はここに `|| busy` の門番があり、走行中の発話を**黙って捨てていた**。
   * サーバは前から受けられる（`promptEvenWhileBusy`）ので、止めていたのは画面だけ
   * ——「幹で会話できない」の直接原因はこの1行だった（提案 §2.2）。
   *
   * 既定は**「いまの作業に足す」**。走っているターンへ融合する（`steer`）のであって、
   * 割り込んで先に答えさせるのではない。止めて話すときは `interrupt` を渡す。
   */
  const submit = async (options?: { interrupt?: boolean }): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0 && pendingFiles.length === 0) return;
    setAttachError(undefined);
    try {
      const attachments: Attachment[] = [];
      for (const att of pendingFiles) {
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
      session.send(
        threadId,
        text,
        attachments,
        options?.interrupt === true ? { interrupt: true } : undefined
      );
      void stick.scrollToBottom();
      session.setDraft(threadId, "");
      for (const att of pendingFiles) if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      setPendingFiles([]);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const branchOf = useCallback(
    (id: string): ThreadView | undefined => session.threadOf(id),
    [session]
  );
  const branchHasTurn = useCallback(
    (id: string): boolean =>
      // 知らせ（ADR-0022 決定109・110）は判断待ちではない。混ぜると、畳んだだけの枝の札に
      // 「あなたの判断を待っています」の朱が立つ
      session.inbox.some((i) => !i.resolvedAt && !i.notice && i.opens?.threadId === id),
    [session.inbox]
  );

  return (
    <section
      className={[
        "room",
        isBranch ? "room--branch chat-pane" : "room--trunk chat-pane",
        slim ? "is-slim" : "",
        raised ? "is-raised" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-thread={threadId}
    >
      <div className="room-head">
        {isBranch && onCloseBranch && (
          <button
            className="room-back"
            type="button"
            onClick={onCloseBranch}
            aria-label="枝を閉じる"
            title="枝を閉じる（畳むわけではありません）"
          >
            <Icon name="close" size={15} />
          </button>
        )}
        <div className="room-head-t">
          {isBranch && <div className="room-from">◂ 幹から</div>}
          {renaming === undefined ? (
            <h1
              className="room-title"
              title="押すと名前を付け直せます"
              onClick={() => setRenaming(thread.title)}
            >
              {thread.title}
            </h1>
          ) : (
            <input
              className="tt-rename"
              value={renaming}
              autoFocus
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => setRenaming(undefined)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") {
                  // **殻へ渡さない**。渡すと Esc が「枝を閉じる」まで届いて、
                  // 名付けをやめただけのつもりが会話ごと畳まれる
                  e.stopPropagation();
                  // 書きかけは捨てる。**名前は変わらない**（押した意図と食い違わせない）
                  setRenaming(undefined);
                  return;
                }
                if (e.key !== "Enter") return;
                // I2: 空の名前は投げない（ホストも拒むが、往復させる意味がない）
                if (renaming.trim() !== "") session.renameThread(threadId, renaming);
                setRenaming(undefined);
              }}
            />
          )}
          {!slim && isBranch && thread.returnCondition && (
            <div className="room-sub">枝 ・ 還す条件：{thread.returnCondition}</div>
          )}
        </div>
        {/* 畳んだ枝には出さない——還した話をもう一度還すと、幹に結論が二重に並ぶ */}
        {!slim && isBranch && !closed && onMergeBranch && (
          <button className="btn btn--small" type="button" onClick={() => setMerging(true)}>
            畳んで幹に回収
          </button>
        )}
      </div>

      {merging && onMergeBranch && (
        <div className="room-merge">
          <MergeBranchForm
            branch={thread}
            onMerge={(c) => {
              onMergeBranch(c);
              setMerging(false);
            }}
            onCancel={() => setMerging(false)}
          />
        </div>
      )}

      <div
        className="chat-scroll"
        ref={stick.scrollRef}
        onScroll={noteScroll}
      >
        {/* 追従は「中身の高さ」を ResizeObserver で見て決まるので、器と中身を分ける。
            `talk` は器の畳み判定に使うコンテナ（決定78：会話の帯の幅で決まる） */}
        <div className="chat-scroll-content talk" ref={stick.contentRef}>
          {chat.length === 0 && (
            <p className="chat-empty">
              {isBranch
                ? "この枝で番頭に話しかけてください。"
                : "番頭に話しかけてください。長くなる話は枝にすると、幹が読める帯のまま残ります。"}
            </p>
          )}
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
            const i = shownFrom + offset;
            if (entry.role === "error" && dismissedErrors.has(i)) return null;
            return (
              <ChatRow
                key={(entry as { id?: string }).id ?? i}
                entry={entry}
                isStreaming={chatStatus === "streaming" && i === chat.length - 1}
                {...(entry.role === "error"
                  ? {
                      onDismissError: () =>
                        setDismissedErrors((prev) => new Set(prev).add(i)),
                    }
                  : {})}
                branchOf={branchOf}
                branchHasTurn={branchHasTurn}
                {...(activeBranchId ? { activeBranchId } : {})}
                onOpenBranch={onOpenBranch}
                onOpenView={onOpenView}
              />
            );
          })}
          {chatStatus === "submitted" && <ThinkingRow />}

          {/*
            **判断待ちは会話の流れの中に立つ**（決定80）。固定の帯は置かない——
            番頭が判断を求めたなら、それは会話の最新の発言なので、放っておいても一番下にある。
            気づかせるのは横断の通知と、遡ったときの↓（すぐ下）。
          */}
          <PendingDecisions
            items={pending}
            onAnswer={onAnswerInbox}
            onOpen={onOpenInbox}
            variant="chat"
          />
        </div>
      </div>

      {/*
        遡ったときだけ出る↓（`spec-chat-ui` §3.2）。判断待ちがあれば**朱**になる
        （決定80）——読みと入力の間に常設はひとつも無い。
      */}
      {!stick.isAtBottom && chat.length > 0 && (
        <button
          className={`chat-to-bottom ${pending.length > 0 ? "is-turn" : ""}`}
          onClick={() => void stick.scrollToBottom()}
          title={pending.length > 0 ? "判断待ちがあります" : "一番下へ"}
        >
          {pending.length > 0 && (
            <span className="chat-to-bottom-n">判断待ち {pending.length}</span>
          )}
          <Icon name="arrow-down" size={16} />
        </button>
      )}

      {onGrip && <div className="pane-resizer room-grip" onPointerDown={onGrip} role="separator" aria-orientation="vertical" aria-label="会話の帯の幅を変える" />}

      {closed ? (
        <div className="room-closed">
          <div className="room-closed-h">
            <Icon name="check" size={14} />
            {isBranch ? "この枝は畳んで幹へ還しました" : "この幹は終えました"}
          </div>
          {thread.conclusion && (
            <p className="room-closed-c">
              <span className="bres-label">結論：</span>
              {thread.conclusion}
            </p>
          )}
          <button
            className="btn btn--primary btn--small"
            type="button"
            onClick={() => session.reopenThread(threadId)}
          >
            開き直して続ける
          </button>
        </div>
      ) : (
      <div className="chat-composer">
        <div className="composer-box" data-key="c" onClick={() => inputRef.current?.focus()}>
          {pendingFiles.length > 0 && (
            <div className="attach-list">
              {pendingFiles.map((att, i) => (
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
            placeholder={
              // **走行中でも入る**（imp-0048）。「考えています」だけだと、打てるのに
              // 打てないと読める——**足すのか、止めるのか**をここで言い切る
              busy
                ? "考えています（そのまま送ると、いまの作業に足します）"
                : isBranch
                  ? "この枝で番頭に話す"
                  : "番頭に相談する（幹）"
            }
            rows={1}
            onChange={(e) => session.setDraft(threadId, e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Backspace" && e.currentTarget.value === "" && pendingFiles.length > 0) {
                e.preventDefault();
                removePending(pendingFiles.length - 1);
              }
            }}
          />
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
            <ModelSelect
              current={model}
              onSelect={(provider, id, backend) => session.setModel(threadId, provider, id, backend)}
            />
            <select
              className="chat-thinking"
              value={model?.thinking ?? ""}
              aria-label="思考レベル"
              title="思考レベル（サービス既定を上書き。未指定＝既定に従う）"
              onChange={(e) => {
                if (model) {
                  session.setModel(threadId, model.provider, model.id, model.backend, e.target.value);
                }
              }}
            >
              {thinkingChoicesFor(model?.backend).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ContextMeter tokens={session.contextTokensOf(threadId)} contextWindow={model?.contextWindow} />
            {/*
              **区切りは人にも分かる**（提案§3.2 の人側）。自動で畳むのは文脈の量が
              閾値に達したときだけで、「この話は終わった」は量では拾えない。
              文脈の目盛りの隣に置く——押す気になるのは、目盛りを見たときだから（D7）
            */}
            <button
              className={`chapter-close ${folding ? "is-folding" : ""}`}
              type="button"
              onClick={() => {
                setFolding(true);
                session.closeChapter(threadId);
              }}
              // **ターンが走っている間は押せない**（喋り出す前の間も含む）。道具を呼んで
              // いる途中で文脈が消えると、番頭は自分が何をしていたか分からなくなる
              // 畳んでいる最中も押せない——二度押しても2章にはならない（帳簿が弾く）
              disabled={busy || folding}
              title={
                folding
                  ? "引き継ぎ資料を書いています（畳めたら会話に区切りの線が入ります）"
                  : busy
                    ? "番頭の返事が終わってから区切れます"
                    : "ここまでを1章として畳む（前のやり取りは失われません）"
              }
              aria-label="ここまでを章として畳む"
            >
              <Icon name="chapter" size={14} />
            </button>
            {/*
              **止めるのと送るのを併存させる**（imp-0048・提案 §4 案I）。
              1つのボタンが「送る」と「中断」を兼ねていたので、走っている間は
              送る手段が画面から消えていた。
              下書きがあれば**止めて話す**——中断と発話をホストへ1通で渡すので、
              「止めたつもりが融合していた」が起きない（D5：判断は画面に持たせない）。
            */}
            {busy && (
              <button
                className="composer-stop"
                type="button"
                onClick={() =>
                  hasDraft ? void submit({ interrupt: true }) : session.abort(threadId)
                }
                aria-label={hasDraft ? "止めて話す" : "止める"}
                title={
                  hasDraft
                    ? "止めて話す（いまのターンを中断してから、この発言で始め直します）"
                    : "止める（いまのターンを中断します）"
                }
              >
                <span className="composer-submit-stop" />
              </button>
            )}
            <button
              className={`composer-submit is-${chatStatus}`}
              type="button"
              onClick={() => void submit()}
              disabled={!hasDraft}
              aria-label={busy ? "いまの作業に足す" : "送る"}
              title={
                busy
                  ? "いまの作業に足す（走っているターンへ渡します。割り込んで先に答えるのではありません）"
                  : "送る"
              }
            >
              {/*
                走行中も**送るボタンのまま**にする。考えている印は会話側の独楽
                （`ThinkingRow`）と、隣に出る止めるボタンが担う——ここに独楽を置くと
                「押せない」に見える
              */}
              {chatStatus === "error" ? (
                <Icon name="close" size={15} />
              ) : (
                <Icon name="enter" size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
      )}
    </section>
  );
}
