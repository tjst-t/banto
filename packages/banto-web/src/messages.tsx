/**
 * 発話の描き方（AI Elements 由来）。**チャット欄と職人ビューアで同じものを使う**。
 *
 * 職人のセッション出力は「番頭とPOのやり取り」と同じ構造（発話・思考・ツール呼び出し）を
 * しているのに、別の描き方を持っていた——同じものが2通りに見えると、読む側は毎回
 * 読み替えることになる。ここに1つ置いて、両方から使う。
 *
 * D5: 判断は無い。渡されたものをそう見えるように描くだけ。
 */

import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
// D6: ストリーミング途中の未完 Markdown を補って描く（AI Elements の Streamdown 同等）
import remend from "remend";
import type { TranscriptAttachment, TranscriptEntry } from "@banto/host/protocol";
import { highlightToHtml, useColorScheme } from "./views/fileHighlight.js";
import { Icon } from "./icons.js";
import { MarkdownLink } from "./links.js";
import { Linkify, rehypeLinkify, splitPathAndLine, type LinkTargets } from "./linkify.js";
import { UtsuwaRow } from "./Utsuwa.js";
import { BranchCard, BranchNoteRow, BranchResultRow } from "./Branch.js";

/** 考え終わってから思考を畳むまで（AI Elements の `AUTO_CLOSE_DELAY`）。 */
const REASONING_AUTO_CLOSE_MS = 1000;

/**
 * 応答待ちの独楽（AI Elements の `Loader`）。
 *
 * 8本の線の濃さをずらして回す。**点滅ではなく回転**にするのは、止まったのか進んで
 * いるのかが一目で分かるため。
 */
export function Loader({ size = 16 }: { size?: number }): React.ReactElement {
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

/** 考えている間の見出し（AI Elements の `Shimmer`）。文字の上を光が流れる。 */
export function Shimmer({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="shimmer">{children}</span>;
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
    ? child.props.className ?? ""
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
        <Icon name={copied ? "check" : "copy"} size={14} />
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

/**
 * ファイル面を開く先（PO要望 2026-08-11）。
 *
 * 会話の中のパスを押したときに開く。**上から配る**——`StreamingMarkdown` は会話の
 * あちこち（応答・知らせ・思考・職人のログ）で使われるので、使う側ごとに渡させると
 * 渡し忘れた場所だけ押せなくなる。
 */
const FileLinkContext = React.createContext<LinkTargets | undefined>(undefined);

export function FileLinkProvider({
  targets,
  children,
}: {
  targets: LinkTargets;
  children: React.ReactNode;
}): React.ReactElement {
  return <FileLinkContext.Provider value={targets}>{children}</FileLinkContext.Provider>;
}

/** `rehypeLinkify` が印を付けた span を、押せるものに差し替える。 */
function PathSpan({
  children,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement> & { "data-banto-path"?: string }): React.ReactElement {
  const targets = React.useContext(FileLinkContext);
  const path = rest["data-banto-path"];
  if (!path || !targets?.openFile) return <span {...rest}>{children}</span>;
  const { path: file, line } = splitPathAndLine(path);
  return (
    <button
      type="button"
      className="linkify-path"
      title={`${file}${line ? `:${line}` : ""} をファイル面で開く`}
      onClick={() => targets.openFile?.(file, line)}
    >
      {children}
    </button>
  );
}

/**
 * コードブロックとリンクだけ差し替える。他の要素は react-markdown の既定のまま。
 * リンクは外に出るものを別タブへ（`links.tsx`）——会話ごと差し替わると書きかけが消える。
 * パスは押すとファイル面が開く（`rehypeLinkify` が印を付けたものを `span` で受ける）。
 */
const MARKDOWN_COMPONENTS = { pre: CodeBlock, a: MarkdownLink, span: PathSpan };

/**
 * ストリーミング中の Markdown。
 *
 * **未完のまま描かない**——`**強調` の途中や閉じていないコードフェンスをそのまま
 * react-markdown に渡すと、記号が生で見えたり段落が崩れたりして、文字が届くたびに
 * 画面がちらつく。remend が未完のトークンを閉じてから描く（AI Elements と同じ挙動）。
 */
export const StreamingMarkdown = React.memo(({ text }: { text: string }): React.ReactElement => (
  // remark-gfm: 表・打ち消し線・タスクリスト等。素の react-markdown は CommonMark のみ
  <Markdown
    remarkPlugins={[remarkGfm]}
    // 文中のファイルパスを押せるようにする（PO要望 2026-08-11）
    rehypePlugins={[rehypeLinkify]}
    components={MARKDOWN_COMPONENTS}
  >
    {remend(text)}
  </Markdown>
));

/**
 * **Markdown にしない行**（POの発言・職人への指示・解釈できなかった行）を描く。
 *
 * 書いたとおりに出しつつ、URL とパスだけ押せるようにする（PO要望 2026-08-11）。
 * Markdown で描いてしまうと、PO が書いた `*` や `#` が消えて別の文になる。
 */
export function PlainText({ text }: { text: string }): React.ReactElement {
  const targets = React.useContext(FileLinkContext);
  return <Linkify text={text} {...(targets ? { targets } : {})} />;
}

/** 考えていた時間の文言。測れていないときは秒数を騙らない（I1）。 */
function thoughtLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs <= 0) return "数秒間考えました";
  return `${Math.ceil(durationMs / 1000)}秒間考えました`;
}

/**
 * 思考（AI Elements の `<Reasoning>`）。
 *
 * **考えている間は開いておき、終わったら1秒後に一度だけ畳む**——進んでいることが
 * 見えるのが大事で、読み終わる頃には本文の邪魔になるため。畳んだあとは自分で開ける。
 * 一度でも自分で開け閉めしたら、そこから先は自動で動かさない（勝手に閉じられると
 * 読んでいる途中で消える）。
 */
export function ReasoningRow({
  text,
  durationMs,
  isStreaming,
  defaultOpen = true,
}: {
  text: string;
  durationMs?: number;
  isStreaming: boolean;
  /** 済んだ記録を読むとき（職人の出力）は畳んで始める。 */
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
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
          <Icon name="sparkle" size={13} />
        </span>
        {isStreaming ? <Shimmer>考えています</Shimmer> : <span>{thoughtLabel(durationMs)}</span>}
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} className="reasoning-caret" />
      </button>
      {open && (
        <div className="markdown reasoning-body">
          <StreamingMarkdown text={text} />
        </div>
      )}
    </div>
  );
}

/** ツールの状態の見せ方（AI Elements の `ToolUIPart` の札に合わせる）。 */
const TOOL_BADGE: Record<string, string> = {
  running: "実行中",
  ok: "完了",
  failed: "失敗",
};

/** 引数・結果を読める形にする。文字列はそのまま、構造は JSON にして出す。 */
export function formatPayload(value: unknown): string {
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
export function ToolRow({
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
        {hasDetail && <Icon name={open ? "chevron-down" : "chevron-right"} size={14} className="tool-caret" />}
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
 * 知らせの出所ごとの札。
 *
 * **外から入る知らせを全部「職人」で出さない**（PO報告 2026-07-31）——番頭が別の会話を
 * 開いたときの最初の一言まで職人に見えていた。知らない出所はそのまま出す（隠さない）。
 */
const NOTICE_LABELS: Record<string, string> = {
  worker: "職人",
  thread: "別の会話",
  system: "知らせ",
  // 検証環境の衛生（畳み忘れ・畳み損ね・孤児。task-0067）
  env: "検証環境",
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
            <span className="msg-attachment-file"><Icon name="file" size={14} />{item.name}</span>
          )}
        </a>
      ))}
    </div>
  );
}

/**
 * 会話の1行（発話・思考・道具・知らせ・失敗）。
 *
 * **チャット欄と履歴で同じものを使う**（PO報告 2026-08-06）——履歴は同じ会話を素の
 * Markdown で並べ直しており、落款も思考も道具の呼び出しも出ていなかった。畳んだあとに
 * 読み返すのは、たった今まで見ていたものと同じ会話なので、2通りの姿を持たせない。
 *
 * React.memo: text_delta で session.chat が入れ替わっても、変更無しの行は再描画をスキップ。
 */
export const ChatRow = React.memo(
  ({
    entry,
    isStreaming,
    onDismissError,
    branchOf,
    activeBranchId,
    branchHasTurn,
    onOpenBranch,
    onOpenView,
  }: {
    entry: TranscriptEntry;
    /** いま届いている最中の行か（思考の見出しを切り替えるのに使う）。 */
    isStreaming?: boolean;
    /** error 行の × が押されたとき（error 以外には渡さない）。 */
    onDismissError?: () => void;
    /**
     * 枝の札は**参照**（決定77）なので、描くときに帳簿から引き直す。
     * 渡さないと札は畳んだ姿だけで出る（履歴・職人ビューアはそれでよい）。
     */
    branchOf?: (branchId: string) => import("@banto/host/protocol").ThreadView | undefined;
    activeBranchId?: string;
    branchHasTurn?: (branchId: string) => boolean;
    onOpenBranch?: (threadId: string) => void;
    /** 器の「面への口」が押されたとき。渡さないと押せない（描けない面は出さない・決定12）。 */
    onOpenView?: (kind: string, params?: Record<string, unknown>) => void;
  }): React.ReactElement => {
    switch (entry.role) {
      case "po":
        return (
          <div className="msg msg--po">
            {entry.attachments && entry.attachments.length > 0 && (
              <AttachmentChips items={entry.attachments} />
            )}
            {/* PO の発言は Markdown で描かない（書いたとおりに出す）。URL とパスだけ押せる */}
            <PlainText text={entry.text} />
          </div>
        );
      case "reasoning":
        return (
          <ReasoningRow
            text={entry.text}
            durationMs={entry.durationMs}
            /* **考え終わりは durationMs が決める**——ターンが続いていても、思考そのものは
               `reasoning_end` で終わっている。busy だけで見ると、本文を喋り出すまで
               「考えています」と言い続ける */
            isStreaming={isStreaming === true && entry.durationMs === undefined}
            /* 済んだ記録（履歴）は畳んで始める。読み返したいのは本文のほう */
            defaultOpen={isStreaming === true || entry.durationMs === undefined}
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
      case "chapter":
        /**
         * ここで章を畳んだ（PO要望 2026-08-11）。**細い線1本と、何の話だったか**。
         *
         * 発言ではないので吹き出しにしない——読み返したときに「ここで区切った」が
         * 一目で分かればよい。前のやり取りは消えていないので、線は切断ではなく仕切り。
         */
        return (
          <div className="chapter-mark" title={`第${entry.chapter}章：${entry.topic}`}>
            <span className="chapter-mark-rule" aria-hidden="true" />
            <span className="chapter-mark-t">
              第{entry.chapter}章までを畳みました
              {entry.topic && <span className="chapter-mark-topic">{entry.topic}</span>}
            </span>
            <span className="chapter-mark-rule" aria-hidden="true" />
          </div>
        );
      case "branch":
        // 枝の札（決定77）。**写しではなく参照**なので、帳簿から引き直して描く
        return (
          <BranchCard
            branch={branchOf?.(entry.branchId)}
            active={activeBranchId === entry.branchId}
            hasTurn={branchHasTurn?.(entry.branchId) ?? false}
            {...(onOpenBranch ? { onOpen: onOpenBranch } : {})}
          />
        );
      case "branch_result":
        // 還った1行（決定77）。**記録なので凍る**——ここで帳簿は引かない
        return (
          <BranchResultRow
            branchId={entry.branchId}
            title={entry.title}
            conclusion={entry.conclusion}
            at={entry.at}
            {...(entry.hasDetail ? { hasDetail: true } : {})}
            {...(onOpenBranch ? { onOpen: onOpenBranch } : {})}
          />
        );
      case "branch_note":
        // 畳む前に枝から還った一言（決定107）。札と結論と同じ列に並べる（知らせに混ぜない）
        return (
          <BranchNoteRow
            branchId={entry.branchId}
            title={entry.title}
            kind={entry.kind}
            text={entry.text}
            at={entry.at}
            {...(onOpenBranch ? { onOpen: onOpenBranch } : {})}
          />
        );
      case "utsuwa":
        // Tool の戻り値を中核の器で描く（決定78・81）。器も凍る
        return <UtsuwaRow u={entry.utsuwa} {...(onOpenView ? { onOpenView } : {})} />;
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
            <Icon name="error" size={14} />
            <span className="msg-error-text">{entry.text}</span>
            {onDismissError && (
              <button
                className="msg-error-close"
                type="button"
                onClick={onDismissError}
                aria-label="このエラーを閉じる"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        );
    }
  }
);
