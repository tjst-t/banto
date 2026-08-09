/**
 * ファイルの中身の**描き方**（spec-file-browser §5・§5.9・§5.10）。
 *
 * ファイル閲覧の面（`FileBrowser`）と、別タブの1枚（`FilePage`）が**同じものを**使う。
 * 種別ごとの姿を2箇所に持つと、片方だけ直った状態が必ず生まれる——「別タブは整形で
 * 開く」（§5.8.4）は、同じ描き手を使っていることが前提の決めなので、ここに集める。
 *
 * ここに判断は置かない（D5）。**どの種別をどう描くかは `filePreview.ts`（純粋）が決め、
 * 何を読むか・どのモードで出すかは呼ぶ側が決める。** ここは受け取ったものを描くだけ。
 */

import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "../links.js";
import { ErrorNote, Loading } from "./ui.js";
import {
  classifyDiffLine,
  codeLangOfPath,
  extOfPath,
  type FilePreviewKind,
} from "./filePreview.js";
import {
  highlightCode,
  highlightToHtml,
  type HighlightedLine,
  type HighlightResult,
  type Scheme,
} from "./fileHighlight.js";

/** shiki トークンの装飾（TextMate の fontStyle ビットマスク: 1=italic 2=bold 4=underline）。 */
function tokenStyle(t: HighlightedLine): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (t.color) style.color = t.color;
  if (t.fontStyle) {
    if ((t.fontStyle & 1) !== 0) style.fontStyle = "italic";
    if ((t.fontStyle & 2) !== 0) style.fontWeight = "bold";
    if ((t.fontStyle & 4) !== 0) style.textDecoration = "underline";
  }
  return style;
}

/** Mermaid 描画（task-0053）。mermaid.js は動的インポートで初回ロードに載せない。 */
let mermaidSeq = 0;

export function MermaidBlock({
  code,
  scheme,
  onReady,
}: {
  code: string;
  scheme: Scheme;
  onReady?: () => void;
}): React.ReactElement {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLDivElement>(null);
  const bindRef = useRef<((el: HTMLElement) => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    setError(undefined);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, theme: scheme === "dark" ? "dark" : "default" });
        const id = `fb-mermaid-${++mermaidSeq}`;
        const { svg: rendered, bindFunctions } = await mermaid.render(id, code);
        if (cancelled) return;
        bindRef.current = bindFunctions;
        setSvg(rendered);
        onReady?.();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        onReady?.();
      }
    })();
    return () => {
      cancelled = true;
    };
    // onReady は親の安定したコールバック（useCallback([])）。依存に入れると毎描画で再描画になる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, scheme]);

  // bindFunctions は SVG が DOM に入ってから呼ぶ（図中のリンク等をクリック可能にする）
  useEffect(() => {
    if (svg && bindRef.current && ref.current) bindRef.current(ref.current);
  }, [svg]);

  if (error) {
    return (
      <div className="fb-mermaid">
        <ErrorNote title="図を描けませんでした">{error}</ErrorNote>
        <pre className="fb-code-plain">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) return <Loading label="図を描いています…" rows={2} />;
  return <div className="fb-mermaid" ref={ref} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** CSV/TSV のテーブル表示（task-0054）。papaparse は動的インポートで遅延読み込み。 */
function CsvTable({
  content,
  delimiter,
}: {
  content: string;
  delimiter: "," | "\t";
}): React.ReactElement {
  const [rows, setRows] = useState<string[][]>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const Papa = (await import("papaparse")).default;
      const res = Papa.parse<string[]>(content, { delimiter, skipEmptyLines: true });
      if (!cancelled) setRows(res.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [content, delimiter]);

  if (!rows) return <Loading label="表を読んでいます…" rows={2} />;
  if (rows.length === 0) return <p className="cv-muted">空のファイルです</p>;

  // 1行目をヘッダとして強調する（task-0054 a2）。列数は全行の最大に揃える
  const header = rows[0]!;
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  return (
    <table className="fb-csv">
      <thead>
        <tr>
          {header.map((cell, i) => (
            <th key={i} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(1).map((row, i) => (
          <tr key={i}>
            {Array.from({ length: cols }, (_, j) => (
              <td key={j}>{row[j] ?? ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** diff/patch の unified 色分け（task-0055）。GitViewer と同じ語彙を使う。 */
function DiffPreview({ content }: { content: string }): React.ReactElement {
  return (
    <pre className="gv-diff">
      {content.split("\n").map((line, i) => (
        <span key={i} className={`gv-diff-line ${classifyDiffLine(line) ?? ""}`}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** コードのハイライト表示（行番号なし）。Markdown 内コードブロックと preview に使う。 */
function ShikiBlock({
  code,
  lang,
  scheme,
}: {
  code: string;
  lang: string;
  scheme: Scheme;
}): React.ReactElement {
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setHtml(undefined);
    void highlightToHtml(code, lang, scheme).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, scheme]);

  // 読み込み中・言語非対応でも素のコードを出して読める状態を保つ
  if (html === undefined) {
    return (
      <pre className="fb-code-plain">
        <code>{code}</code>
      </pre>
    );
  }
  if (html === "") return <pre />;
  return <div className="fb-code-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * react-markdown のコード要素。適用順は task-0053 b: ①mermaid を検出 ②それ以外は shiki
 * （二重適用を防ぐ——mermaid ブロックを shiki に渡さない）。
 */
function MarkdownCode({
  node: _node,
  className,
  children,
  scheme,
  onMermaidReady,
  ...rest
}: React.JSX.IntrinsicElements["code"] & {
  node?: unknown;
  scheme: Scheme;
  onMermaidReady?: () => void;
}): React.ReactElement {
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];

  // 言語指定なし＝インラインコード。そのまま描く
  if (!lang) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  if (lang.toLowerCase() === "mermaid") {
    return <MermaidBlock code={text} scheme={scheme} {...(onMermaidReady ? { onReady: onMermaidReady } : {})} />;
  }
  return <ShikiBlock code={text} lang={lang} scheme={scheme} />;
}

/** Markdown の整形表示。会話側（`.markdown`）と同じ語彙で描く。 */
export function MarkdownBody({
  content,
  scheme,
  onReady,
}: {
  content: string;
  scheme: Scheme;
  onReady?: () => void;
}): React.ReactElement {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (props) => (
            <MarkdownCode {...props} scheme={scheme} {...(onReady ? { onMermaidReady: onReady } : {})} />
          ),
          // 外に出るリンクは別タブへ（links.tsx）。読んでいる面ごと差し替わらない
          a: MarkdownLink,
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

/** コード種別ファイルの preview 表示（ハイライト・行番号なし）。 */
function CodePreview({
  content,
  lang,
  scheme,
}: {
  content: string;
  lang?: string;
  scheme: Scheme;
}): React.ReactElement {
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setHtml(undefined);
    const task: Promise<string | undefined> = lang
      ? highlightToHtml(content, lang, scheme)
      : Promise.resolve(undefined);
    void task.then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [content, lang, scheme]);

  if (html === undefined) {
    return (
      <pre className="fb-code-plain">
        <code>{content}</code>
      </pre>
    );
  }
  if (html === "") return <div className="fb-code-html" />;
  return <div className="fb-code-html" dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * 種別ごとの整形表示（§5.1 の表）。**器（`.fb-preview`）ごとここが持つ**——面と別タブで
 * 余白が違うと、同じファイルが違うものに見える。
 *
 * `plain` は整形の姿を持たない（原文で出す種別）ので、ここへ来たら何も描かない。
 * 呼ぶ側がモードを決める（§5.3）。
 */
export function FilePreviewBody({
  path,
  kind,
  content,
  rawHref,
  scheme,
  onReady,
}: {
  path: string;
  kind: FilePreviewKind;
  content: string;
  /** `html` / `image` の src（§5.8 の raw URL）。無ければその種別は描けない */
  rawHref?: string;
  scheme: Scheme;
  /** 非同期に描き終わるもの（Mermaid）が済んだとき。スクロール復元の合図に使う */
  onReady?: () => void;
}): React.ReactElement {
  const codeLang = kind === "code" || kind === "html" ? codeLangOfPath(path) : undefined;
  const csvDelimiter: "," | "\t" = extOfPath(path) === "tsv" ? "\t" : ",";

  return (
    <div className="fb-preview">
      {kind === "markdown" && (
        <MarkdownBody content={content} scheme={scheme} {...(onReady ? { onReady } : {})} />
      )}
      {kind === "mermaid" && (
        <MermaidBlock code={content} scheme={scheme} {...(onReady ? { onReady } : {})} />
      )}
      {kind === "csv" && (
        <div className="fb-scrollx">
          <CsvTable content={content} delimiter={csvDelimiter} />
        </div>
      )}
      {kind === "diff" && <DiffPreview content={content} />}
      {kind === "code" && <CodePreview content={content} lang={codeLang} scheme={scheme} />}
      {/* 隔離した枠（§5.8.3）。`allow-same-origin` は付けない——付けると
          リポジトリの中の HTML が Banto のオリジンで動くスクリプトになる */}
      {kind === "html" && rawHref !== undefined && (
        <iframe
          className="fb-frame"
          src={rawHref}
          sandbox="allow-scripts"
          title={path}
          referrerPolicy="no-referrer"
        />
      )}
      {kind === "image" && rawHref !== undefined && <img className="fb-image" src={rawHref} alt={path} />}
    </div>
  );
}

/**
 * ファイル内容を行番号つきで描き、指定範囲を強調して自動スクロールする。
 * 番頭が「この行を見て」と言えるようにするための面。
 */
export function CodeBody({
  content,
  from,
  to,
  wrap,
  lang,
  scheme,
}: {
  content: string;
  from?: number;
  to?: number;
  wrap?: boolean;
  lang?: string;
  scheme: Scheme;
}): React.ReactElement {
  const targetRef = useRef<HTMLSpanElement>(null);
  const lines = content.split("\n");
  const start = from ?? 0;
  const end = to ?? from ?? 0;
  const [highlight, setHighlight] = useState<HighlightResult>();

  /**
   * 強調行へ寄せるのは**基点が変わったときだけ**（spec-file-browser §5.4）。
   * 依存に `content` を入れていたので、「続きを読む」で中身が伸びるたびに寄せ直し、
   * 読んでいた位置から強調行へ引き戻していた。
   */
  useEffect(() => {
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [from, to]);

  useEffect(() => {
    if (!lang) {
      setHighlight(undefined);
      return;
    }
    let cancelled = false;
    setHighlight(undefined);
    void highlightCode(content, lang, scheme).then((res) => {
      if (!cancelled) setHighlight(res);
    });
    return () => {
      cancelled = true;
    };
  }, [content, lang, scheme]);

  const width = String(lines.length).length;
  const useHighlight = highlight !== undefined && highlight.lines.length === lines.length;

  return (
    <pre
      className={`fb-code ${wrap ? "is-wrap" : ""}`}
      style={useHighlight ? { backgroundColor: highlight.bg, color: highlight.fg } : undefined}
    >
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const highlighted = lineNo >= start && lineNo <= end;
        const tokens = useHighlight ? highlight.lines[i] : undefined;
        return (
          <span
            key={i}
            className={`fb-line ${highlighted ? "is-highlight" : ""}`}
            ref={lineNo === start ? targetRef : undefined}
          >
            <span className="fb-lineno">{String(lineNo).padStart(width, " ")}</span>
            {tokens && tokens.length > 0
              ? tokens.map((t, j) => (
                  <span key={j} style={tokenStyle(t)}>
                    {t.content}
                  </span>
                ))
              : line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
