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
import { highlightToHtml, useColorScheme } from "./views/fileHighlight.js";

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
export const StreamingMarkdown = React.memo(({ text }: { text: string }): React.ReactElement => (
  // remark-gfm: 表・打ち消し線・タスクリスト等。素の react-markdown は CommonMark のみ
  <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
    {remend(text)}
  </Markdown>
));

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
