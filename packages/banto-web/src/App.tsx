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
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
// D6: 末尾追従は Vercel AI Elements と同じ use-stick-to-bottom に任せる。自前だと
// ResizeObserver 追従・spring・選択中の扱いを全部書くことになり、体験を合わせきれない
import { useStickToBottom } from "use-stick-to-bottom";
// D6: ストリーミング途中の未完 Markdown を補って描く（AI Elements の Streamdown 同等）。
// Streamdown 本体は Tailwind 前提で入らないが、補正の核はこの純関数だけで足りる
import remend from "remend";
import type { Attachment, TranscriptAttachment, TranscriptEntry } from "@banto/host/protocol";
import { useBantoSession, type CurrentModel } from "./useBantoSession.js";
import { highlightToHtml, useColorScheme } from "./views/fileHighlight.js";
import { callModuleTool } from "./views/useModuleTool.js";
import type { LlmModelInfo } from "@banto/core";
import { resolveCanvasView } from "./views/registry.js";
import { ThreadTabs } from "./ThreadTabs.js";
import { ThreadHistory } from "./ThreadHistory.js";
import { SettingsPanel } from "./views/SettingsPanel.js";
import { useViewLocation } from "./viewLocation.js";

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

/** 考え終わってから思考を畳むまで（AI Elements の `AUTO_CLOSE_DELAY`）。 */
const REASONING_AUTO_CLOSE_MS = 1000;

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
 * 応答待ちの独楽（AI Elements の `Loader`）。
 *
 * 8本の線の濃さをずらして回す。**点滅ではなく回転**にするのは、止まったのか進んで
 * いるのかが一目で分かるため。
 */
function Loader({ size = 16 }: { size?: number }): React.ReactElement {
  const spokes = [
    { d: "M8 0V4", opacity: 1 },
    { d: "M8 16V12", opacity: 0.5 },
    { d: "M3.29773 1.52783L5.64887 4.7639", opacity: 0.9 },
    { d: "M12.7023 1.52783L10.3511 4.7639", opacity: 0.1 },
    { d: "M12.7023 14.472L10.3511 11.2361", opacity: 0.4 },
    { d: "M3.29773 14.472L5.64887 11.2361", opacity: 0.6 },
    { d: "M15.6085 5.52783L11.8043 6.7639", opacity: 0.2 },
    { d: "M0.391602 10.472L4.19583 9.23598", opacity: 0.7 },
    { d: "M15.6085 10.4722L11.8043 9.23615", opacity: 0.3 },
    { d: "M0.391602 5.52783L4.19583 6.7639", opacity: 0.8 },
  ];
  return (
    <svg className="loader" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {spokes.map((s) => (
        <path key={s.d} d={s.d} stroke="currentColor" strokeWidth="1.5" opacity={s.opacity} />
      ))}
    </svg>
  );
}

/** `<pre><code>` の中身を文字列として集める（react-markdown は配列で渡すことがある）。 */
function textOf(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * Markdown 内のコードブロック（AI Elements の `CodeBlock`）。
 *
 * shiki のハイライトと**コピーボタン**を付ける。ハイライトは非同期で降ってくるので、
 * 届くまでは素のまま出す——ストリーミング中は未完のコードが来るのが普通で、
 * 出せるまで待つと文字が消えたように見える。
 */
const CodeBlock = React.memo(({ children }: React.ComponentProps<"pre">): React.ReactElement => {
  const scheme = useColorScheme();
  const child = React.Children.toArray(children)[0];
  const className = React.isValidElement<{ className?: string }>(child)
    ? (child.props.className ?? "")
    : "";
  const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
  const code = textOf(children);
  const [html, setHtml] = useState<string>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    if (lang.length === 0) {
      setHtml(undefined);
      return;
    }
    void highlightToHtml(code, lang, scheme).then((out) => {
      if (live) setHtml(out);
    });
    return () => {
      live = false;
    };
  }, [code, lang, scheme]);

  const copy = (): void => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="codeblock">
      <button className="codeblock-copy" type="button" onClick={copy} title="コピー">
        {copied ? "✓" : "⧉"}
      </button>
      {html === undefined ? (
        <pre>{children}</pre>
      ) : (
        // shiki の出力は自前で組み立てた HTML（外部入力をそのまま流していない）
        <div className="codeblock-shiki" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

/** コードブロックだけ差し替える。他の要素は react-markdown の既定のまま。 */
const MARKDOWN_COMPONENTS = { pre: CodeBlock };

/**
 * ストリーミング中の Markdown。
 *
 * **未完のまま描かない**——`**強調` の途中や閉じていないコードフェンスをそのまま
 * react-markdown に渡すと、記号が生で見えたり段落が崩れたりして、文字が届くたびに
 * 画面がちらつく。remend が未完のトークンを閉じてから描く（AI Elements と同じ挙動）。
 */
const StreamingMarkdown = React.memo(({ text }: { text: string }): React.ReactElement => (
  // remark-gfm: 表・打ち消し線・タスクリスト等。素の react-markdown は CommonMark のみ
  <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
    {remend(text)}
  </Markdown>
));

/**
 * 知らせの出所ごとの札。
 *
 * **外から入る知らせを全部「職人」で出さない**（PO報告 2026-07-31）——番頭が別の会話を
 * 開いたときの最初の一言まで職人に見えていた。知らない出所はそのまま出す（隠さない）。
 */
const NOTICE_LABELS: Record<string, string> = {
  worker: "職人",
  thread: "別の会話",
  system: "知らせ",
};

/**
 * POでも番頭でもない知らせ（決定29）。**既定は畳んでおく**——番頭の報告と違い長くなりがちで、
 * 会話を追う邪魔になるため（PO フィードバック）。クリックで開く。
 */
function NoticeRow({ source, text }: { source: string; text: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  // 1行目を要約として出す。Markdownの強調記号は畳んだ状態では邪魔なので落とす
  const summary = (text.split("\n").find((l) => l.trim().length > 0) ?? "")
    .replace(/\*\*/g, "")
    .trim();

  return (
    <div className={`msg msg--notice ${open ? "is-open" : ""}`}>
      <button className="notice-head" onClick={() => setOpen(!open)} title="クリックで開閉">
        <span className="notice-tag">{NOTICE_LABELS[source] ?? source}</span>
        <span className="notice-caret">{open ? "▾" : "▸"}</span>
        {!open && <span className="notice-summary">{summary}</span>}
      </button>
      {open && (
        <div className="markdown notice-body">
          <StreamingMarkdown text={text} />
        </div>
      )}
    </div>
  );
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

/** 考えている間の見出し（AI Elements の `Shimmer`）。文字の上を光が流れる。 */
function Shimmer({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="shimmer">{children}</span>;
}

/** 考えていた時間の文言。測れていないときは秒数を騙らない（I1）。 */
function thoughtLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs <= 0) return "数秒間考えました";
  return `${Math.ceil(durationMs / 1000)}秒間考えました`;
}

/**
 * 番頭の思考（AI Elements の `<Reasoning>`）。
 *
 * **考えている間は開いておき、終わったら1秒後に一度だけ畳む**——進んでいることが
 * 見えるのが大事で、読み終わる頃には本文の邪魔になるため。畳んだあとは自分で開ける。
 * 一度でも自分で開け閉めしたら、そこから先は自動で動かさない（勝手に閉じられると
 * 読んでいる途中で消える）。
 */
function ReasoningRow({
  text,
  durationMs,
  isStreaming,
}: {
  text: string;
  durationMs?: number;
  isStreaming: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  const [touched, setTouched] = useState(false);
  const [autoClosed, setAutoClosed] = useState(false);

  useEffect(() => {
    if (isStreaming || touched || autoClosed || !open) return;
    const timer = setTimeout(() => {
      setOpen(false);
      setAutoClosed(true);
    }, REASONING_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [isStreaming, touched, autoClosed, open]);

  return (
    <div className={`msg msg--reasoning ${open ? "is-open" : ""}`}>
      <button
        className="reasoning-head"
        type="button"
        onClick={() => {
          setTouched(true);
          setOpen(!open);
        }}
      >
        <span className="reasoning-mark" aria-hidden="true">
          ✻
        </span>
        {isStreaming ? <Shimmer>考えています</Shimmer> : <span>{thoughtLabel(durationMs)}</span>}
        <span className="reasoning-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="markdown reasoning-body">
          <StreamingMarkdown text={text} />
        </div>
      )}
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

/** ツールの状態の見せ方（AI Elements の `ToolUIPart` の札に合わせる）。 */
const TOOL_BADGE: Record<string, string> = {
  running: "実行中",
  ok: "完了",
  failed: "失敗",
};

/** 引数・結果を読める形にする。文字列はそのまま、構造は JSON にして出す。 */
function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * ツールの呼び出し（AI Elements の `<Tool>`）。
 *
 * 見出しに名前と状態の札、開くと引数と結果。**既定では畳んでおく**——ツールは
 * 1ターンに何度も走るので、開いたままだと会話が引数の羅列で埋まる。
 */
function ToolRow({
  name,
  state,
  input,
  output,
}: {
  name: string;
  state: "running" | "ok" | "failed";
  input?: unknown;
  output?: unknown;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const hasDetail = input !== undefined || output !== undefined;

  return (
    <div className={`msg msg--tool is-${state} ${open ? "is-open" : ""}`}>
      <button
        className="tool-head"
        type="button"
        onClick={() => setOpen(!open)}
        disabled={!hasDetail}
        title={hasDetail ? "クリックで引数と結果を見る" : "引数と結果は残っていません"}
      >
        <span className="tool-dot" />
        <span className="tool-name">{name}</span>
        <span className="tool-badge">{TOOL_BADGE[state] ?? state}</span>
        {hasDetail && <span className="tool-caret">{open ? "▾" : "▸"}</span>}
      </button>
      {open && hasDetail && (
        <div className="tool-detail">
          {input !== undefined && (
            <>
              <div className="tool-detail-label">引数</div>
              <pre>{formatPayload(input)}</pre>
            </>
          )}
          {output !== undefined && (
            <>
              <div className="tool-detail-label">結果</div>
              <pre>{formatPayload(output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
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
        <>
          {/* 外側を押したら閉じる。押した先には届かせない */}
          <div className="model-select-backdrop" onClick={() => setOpen(false)} />
          <div className="model-select-menu" role="listbox">
            <input
              className="model-select-search"
              placeholder="モデルを探す…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="model-select-list">
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
                      return (
                        <button
                          key={`${m.providerId}/${m.id}`}
                          className={`model-select-item ${isCurrent ? "is-current" : ""}`}
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          onClick={() => {
                            onSelect(m.providerId, m.id);
                            setOpen(false);
                            setQuery("");
                          }}
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
                          <span className="model-select-check">{isCurrent ? "✓" : ""}</span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 送った添付（AI Elements の `MessageAttachment`）。画像は小さく出し、押すと原寸で開く。 */
function AttachmentChips({ items }: { items: TranscriptAttachment[] }): React.ReactElement {
  return (
    <div className="msg-attachments">
      {items.map((item) => (
        <a
          key={item.url}
          className="msg-attachment"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          title={item.name}
        >
          {item.kind === "image" ? (
            <img src={item.url} alt={item.name} />
          ) : (
            <span className="msg-attachment-file">📄 {item.name}</span>
          )}
        </a>
      ))}
    </div>
  );
}

/** React.memo: text_delta で session.chat が入れ替わっても、変更無しの行は再描画をスキップ。 */
const ChatRow = React.memo(
  ({
    entry,
    isStreaming,
    onDismissError,
  }: {
    entry: TranscriptEntry;
    /** いま届いている最中の行か（思考の見出しを切り替えるのに使う）。 */
    isStreaming?: boolean;
    /** error 行の × が押されたとき（error 以外には渡さない）。 */
    onDismissError?: () => void;
  }): React.ReactElement => {
  switch (entry.role) {
    case "po":
      return (
        <div className="msg msg--po">
          {entry.attachments && entry.attachments.length > 0 && (
            <AttachmentChips items={entry.attachments} />
          )}
          {entry.text}
        </div>
      );
    case "reasoning":
      return (
        <ReasoningRow
          text={entry.text}
          durationMs={entry.durationMs}
          isStreaming={isStreaming === true}
        />
      );
    case "banto":
      // 番頭の応答は Markdown で返るので整形して描く（react-markdown は既定で生HTMLを通さない）
      return (
        <div className="msg msg--banto markdown">
          <StreamingMarkdown text={entry.text} />
        </div>
      );
    case "notice":
      // 外からの知らせ（決定29）。番頭の発話と混ざらないよう見た目を分け、出所も出す
      return <NoticeRow source={entry.source} text={entry.text} />;
    case "tool":
      return (
        <ToolRow
          name={entry.name}
          state={entry.state}
          input={entry.input}
          output={entry.output}
        />
      );
    case "error":
      return (
        <div className="msg msg--error">
          <span className="msg-error-text">{entry.text}</span>
          {onDismissError && (
            <button
              className="msg-error-close"
              type="button"
              onClick={onDismissError}
              aria-label="このエラーを閉じる"
            >
              ×
            </button>
          )}
        </div>
      );
  }
});

export function App(): React.ReactElement {
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
  // スレッドを切り替えたら最新の位置から読み始める。**切替は新しい会話を開いたのと同じ**で、
  // 前のスレッドで上を読んでいた状態（追従の解除）は持ち越さない
  const { scrollToBottom } = chat;
  useEffect(() => {
    void scrollToBottom({ animation: "instant" });
  }, [session.activeThreadId, scrollToBottom]);

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
  /**
   * 見ている面（決定41・prototype の3面構成）。履歴と設定はプロトタイプ三次改訂の
   * 「ピンタブ」に相当し、**キャンバスのタブではなく独立した面**。同時に出るのは1つ。
   *
   * どの面かは URL が持つ——リロードしても設定を見ていたなら設定に戻り、戻るを押せば
   * 会話へ帰る。
   */
  const historyOpen = view.face === "history";
  const settingsOpen = view.face === "settings";
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
    (face: "chat" | "history" | "settings") => {
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

  // カタログは category ごとにまとめて出す（何が開けるか探しやすくするため）
  const catalogGroups = Object.entries(
    session.catalog.reduce<Record<string, typeof session.catalog>>((groups, entry) => {
      const key = entry.category ?? "その他";
      (groups[key] ??= []).push(entry);
      return groups;
    }, {})
  );

  // カタログメニューは外側をクリックしたら閉じる
  useEffect(() => {
    if (!catalogOpen) return;
    const close = (e: MouseEvent): void => {
      if (!(e.target as Element | null)?.closest(".canvas-catalog-wrap")) setCatalogOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [catalogOpen]);

  // Esc で被さっている面（設定・履歴）を閉じて会話へ戻る。
  // **入力中の Esc は IME の変換取り消しに使われる**ので、変換中は何もしない
  useEffect(() => {
    if (!settingsOpen && !historyOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      backToChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, historyOpen, backToChat]);

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

  return (
    <div className={`shell mobile-view-${mobileView}`}>
      <header className="shell-topbar">
        <div className="brand">
          <span className="brand-mark">番</span>
          <span>
            <span className="brand-name">banto</span>
            <span className="brand-sub">番頭</span>
          </span>
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
          onOpen={() => {
            // 開いた会話へ移るのはホストの返事を受けてから（followNewThread）。
            // 面だけは押した時点で戻す——待っている間、設定を見せ続けない
            backToChat();
            session.openThread();
          }}
        />
        <button
          className={`pin-tab ${historyOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("history")}
          title="畳んだ会話の履歴"
          aria-label="履歴"
        >
          🕘
        </button>
        {/* 設定は一級の面（決定41）。会話タブの列とは混ざらないよう、右端に固定する */}
        <button
          className={`pin-tab ${settingsOpen ? "is-active" : ""}`}
          type="button"
          onClick={() => showFace("settings")}
          title="設定"
          aria-label="設定"
        >
          ⚙️
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
            section={view.section}
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
      ) : historyOpen ? (
        <ThreadHistory
          closedThreads={session.closedThreads}
          chatOf={session.chatOf}
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
              ＋ 新しい会話を始める
            </button>
            {session.closedThreads.length > 0 && (
              <button className="btn" onClick={() => showFace("history")}>
                🕘 履歴を見る（{session.closedThreads.length}）
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className="shell-body">
        <main className="canvas-pane">
          <div className="canvas-tabstrip">
            {session.tabs.length === 0 ? (
              <span className="canvas-tab-empty">タブなし</span>
            ) : (
              session.tabs.map((tab, index) => (
                <span
                  key={tab.id}
                  className={`canvas-tab ${tab.id === session.activeTabId ? "is-active" : ""} ${
                    dropIndex === index ? "is-drop-target" : ""
                  }`}
                  draggable
                  onDragStart={() => setDragTabId(tab.id)}
                  onDragEnd={() => {
                    setDragTabId(undefined);
                    setDropIndex(undefined);
                  }}
                  onDragOver={(e) => {
                    if (!dragTabId) return;
                    e.preventDefault();
                    setDropIndex(index);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    // 並べ替えはホストへ投げる。UIは順序を自前で持たない（D3）
                    if (dragTabId) session.reorderTab(dragTabId, index);
                    setDragTabId(undefined);
                    setDropIndex(undefined);
                  }}
                >
                  <button
                    className="canvas-tab-label"
                    /* ホストへ直接投げず URL を動かす。押した経路と戻るの経路を1本にする */
                    onClick={() => navigate((prev) => ({ ...prev, tabId: tab.id }))}
                    title={`${tab.kind}（ドラッグで並べ替え）`}
                  >
                    {tab.title}
                  </button>
                  <button
                    className="canvas-tab-close"
                    onClick={() => session.closeTab(tab.id)}
                    aria-label={`${tab.title} を閉じる`}
                  >
                    ×
                  </button>
                </span>
              ))
            )}

            {/* POが自分でGUIを開く入口（決定25の人側の経路）。省スペースのため「＋」のみ */}
            {session.catalog.length > 0 && (
              <div className="canvas-catalog-wrap">
                <button
                  className="canvas-catalog-btn"
                  onClick={() => setCatalogOpen((v) => !v)}
                  aria-label="カタログを開く"
                  aria-expanded={catalogOpen}
                  title="カタログを開く"
                >
                  ＋
                </button>
                {catalogOpen && (
                  <div className="canvas-catalog-menu">
                    {catalogGroups.map(([category, entries]) => (
                      <div key={category}>
                        <div className="catalog-group-label">{category}</div>
                        {entries.map((entry) => (
                          <button
                            key={entry.kind}
                            className="catalog-item"
                            onClick={() => {
                              // POが自分で開いたGUIなので、戻るで前のタブへ帰れるようにする
                              followOpenedTab.current = true;
                              session.openView(entry.kind);
                              setCatalogOpen(false);
                            }}
                            title={entry.description}
                          >
                            <span className="ci-ico">{entry.icon ?? "▫"}</span>
                            <span className="ci-body">
                              <span className="ci-name">{entry.title}</span>
                              <span className="ci-src">
                                {entry.kind} · {entry.module}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="canvas-body">
            {!activeTab ? (
              <div className="canvas-empty">
                <p className="canvas-empty-title">キャンバスには何も開かれていません</p>
                <p className="canvas-empty-sub">
                  番頭に「テスト用のGUIを開いて」と頼むと、ここに表示されます。
                </p>
                {session.catalog.length > 0 && (
                  <ul className="canvas-empty-catalog">
                    {session.catalog.map((entry) => (
                      <li key={entry.kind}>
                        <code>{entry.kind}</code> — {entry.title}
                        <span className="catalog-module"> / {entry.module}</span>
                      </li>
                    ))}
                  </ul>
                )}
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
              />
            ) : (
              // I2: カタログにあるのにUIが解決できない＝配線漏れ。黙って空にせず理由を出す
              <div className="canvas-empty">
                <p className="canvas-empty-title">描画できません</p>
                <p className="canvas-empty-sub">
                  コンポーネント <code>{activeSpec?.component ?? "(不明)"}</code> がUI側の解決表にありません。
                </p>
              </div>
            )}
          </div>
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
              <div className="chat-title">番頭と相談する</div>
              <div className="chat-sub">
                {session.tools.length > 0 ? `${session.tools.length} tools` : "—"}
                {session.sessionId ? ` · ${session.sessionId.slice(0, 8)}` : ""}
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
            {session.chat.map((entry, i) => {
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
              ↓
            </button>
          )}

          {/* AI Elements の PromptInput：添付・入力欄・道具立てを1つの枠に収める */}
          <div className="chat-composer">
            <div className="composer-box">
            {pending.length > 0 && (
              <div className="attach-list">
                {pending.map((att, i) => (
                  <span className="attach-chip" key={`${att.name}:${i}`}>
                    {att.kind === "image" && att.previewUrl && (
                      <img className="attach-thumb" src={att.previewUrl} alt={att.name} />
                    )}
                    <span className="attach-name" title={att.name}>
                      {att.kind === "image" ? "🖼" : "📄"} {att.name}
                    </span>
                    <button
                      className="attach-remove"
                      type="button"
                      onClick={() => removePending(i)}
                      aria-label={`${att.name} を取り消す`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachError && (
              <div className="attach-error" role="alert">
                <span className="attach-error-text">{attachError}</span>
                <button
                  className="attach-error-close"
                  type="button"
                  onClick={() => setAttachError(undefined)}
                  aria-label="このエラーを閉じる"
                >
                  ×
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
                ＋
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
                  "×"
                ) : (
                  "↵"
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
            💬 チャット
          </button>
          <button
            className={`mobile-footer-btn ${mobileView === "canvas" ? "is-active" : ""}`}
            onClick={() => setMobileView("canvas")}
            title="キャンバス"
          >
            📄 キャンバス
          </button>
        </div>
      </div>
      )}
    </div>
  );
}
