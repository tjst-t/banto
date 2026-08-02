/**
 * ファイル／ディレクトリ表示（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * データは自分を提供しているモジュール（workspace）のデータAPIから取る。番頭のToolは
 * 呼ばない——同じTool契約だが経路が違う（決定25）。到達先は props の endpoint。
 *
 * `params.path` はディレクトリでもファイルでもよい。どちらかを先に file.stat で確かめて、
 * ファイルなら親ディレクトリを開いてそのファイルを選択した状態で始める。
 * `params.line`（と `endLine`）を渡すとその行まで自動スクロールして強調する——
 * file.grep で見つけた箇所をそのまま見せられるように。
 *
 * プレビューモード（epic-0011）: 種別に応じてレンダリング表示する。preview/source の
 * トグルはローカル state（ファイル切替でリセット）。preview では行番号を出さず、
 * 行強調（from/to）は source モードでのみ有効。2000行超のファイルは preview を無効化して
 * source に落とす（task-0050 a4）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useModuleTool } from "./useModuleTool.js";
import { PlacePicker, usePlaceSelection } from "./PlacePicker.js";
import type { CanvasViewProps } from "./registry.js";
import {
  classifyDiffLine,
  codeLangOfPath,
  extOfPath,
  kindOfPath,
  PREVIEW_MAX_LINES,
} from "./filePreview.js";
import {
  highlightCode,
  highlightToHtml,
  type HighlightedLine,
  type HighlightResult,
  type Scheme,
} from "./fileHighlight.js";

interface Entry {
  name: string;
  type: "dir" | "file";
  size?: number;
}
interface Listing {
  path: string;
  total: number;
  truncated: boolean;
  entries: Entry[];
}
interface FileContent {
  path: string;
  binary: boolean;
  size: number;
  content?: string;
  totalLines?: number;
  shownLines?: number;
  truncated?: boolean;
}
interface StatInfo {
  path: string;
  type: "dir" | "file";
  size: number;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}

/** システムのライト／ダーク設定（prefers-color-scheme）。shiki のテーマ切替に使う（task-0052 a4）。 */
function useColorScheme(): Scheme {
  const [scheme, setScheme] = useState<Scheme>(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent): void => setScheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return scheme;
}

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

function MermaidBlock({
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
        <div className="fb-error">Mermaid を描けませんでした: {error}</div>
        <pre className="fb-code-plain">
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  if (!svg) {
    return <p className="fb-muted">図を描画中…</p>;
  }
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

  if (!rows) return <p className="fb-muted">テーブルをパースしています…</p>;
  if (rows.length === 0) return <p className="fb-muted">空のファイルです</p>;

  // 1行目をヘッダとして強調する（task-0054 a2）。列数は全行の最大に揃える
  const header = rows[0];
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

/** diff/patch の unified 色分け（task-0055）。既存の gv-add / gv-del / gv-hunk を流用。 */
function DiffPreview({ content }: { content: string }): React.ReactElement {
  return (
    <pre className="gv-diff">
      {content.split("\n").map((line, i) => (
        <span key={i} className={classifyDiffLine(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/** コードのハイライト表示（行番号なし）。Markdown 内コードブロック（task-0052 a2）と preview モードのコードファイルに使う。 */
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
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
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
  /** react-markdown が渡すノード情報（ここでは使わない）。 */
  node?: unknown;
  scheme: Scheme;
  onMermaidReady: () => void;
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
    return <MermaidBlock code={text} scheme={scheme} onReady={onMermaidReady} />;
  }
  return <ShikiBlock code={text} lang={lang} scheme={scheme} />;
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
 * ファイル内容を行番号つきで描き、指定範囲を強調して自動スクロールする。
 * 番頭が「この行を見て」と言えるようにするための面（PO要望）。
 *
 * コード種別ファイルは shiki で色分けする（task-0052 a1）。行番号・行強調（from/to）は
 * 論理行（\n 区切り）基準で、折り返し（wrap）は表示だけの問題——どちらも既存機能を保つ。
 */
function CodeBody({
  content,
  from,
  to,
  wrap,
  lang,
  scheme,
  scrollRef,
}: {
  content: string;
  from?: number;
  to?: number;
  wrap?: boolean;
  /** shiki の言語ID。無ければ素の表示（行番号は常に出る）。 */
  lang?: string;
  scheme: Scheme;
  scrollRef: React.RefObject<HTMLPreElement | null>;
}): React.ReactElement {
  const targetRef = useRef<HTMLSpanElement>(null);
  const lines = content.split("\n");
  const start = from ?? 0;
  const end = to ?? from ?? 0;
  const [highlight, setHighlight] = useState<HighlightResult>();

  useEffect(() => {
    // 強調行が画面外にあるときだけ寄せる。中央に置くと前後の文脈が見える
    targetRef.current?.scrollIntoView({ block: "center" });
  }, [from, to, content]);

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
      ref={scrollRef}
      style={
        useHighlight
          ? { backgroundColor: highlight.bg, color: highlight.fg }
          : undefined
      }
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

export function FileBrowser({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialPath = typeof params["path"] === "string" ? params["path"] : ".";
  const initialLine = typeof params["line"] === "number" ? params["line"] : undefined;
  const initialEndLine = typeof params["endLine"] === "number" ? params["endLine"] : undefined;

  // どの場所を見るか（決定36e）。番頭が指定していなければ先頭に落ちる
  const selection = usePlaceSelection(endpoint, typeof params["place"] === "string" ? params["place"] : undefined);
  const place = selection.place;

  // 渡されたパスがディレクトリかファイルかを先に確かめる
  const stat = useModuleTool<StatInfo>(
    endpoint,
    "file.stat",
    { path: initialPath, ...(place ? { place } : {}) },
    place !== undefined
  );
  const [nav, setNav] = useState<{ dir: string; file?: string }>();

  // preview/source トグルと折り返しはローカル state（task-0051 a4）。ファイル切替でリセット
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [wrap, setWrap] = useState(false);
  /** プレビューの内容（Mermaid 等）の描画が終わるたびに増える。スクロール復元の再実行に使う */
  const [previewReadyTick, setPreviewReadyTick] = useState(0);
  const bumpPreviewReady = useCallback(() => setPreviewReadyTick((n) => n + 1), []);
  /** モード切替前のスクロール位置（割合）。preview と source で行数が違うため割合で復元する（a5） */
  const scrollFrac = useRef(0);
  /** モード切替直後に1回だけ復元するためのフラグ（非同期描画完了で何度も巻き戻さない） */
  const restorePending = useRef(false);
  const codeScrollRef = useRef<HTMLPreElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();

  // 場所を変えたら、その場所のルートから見直す（前の場所のパスは意味を持たない）
  useEffect(() => {
    setNav(undefined);
  }, [place]);

  useEffect(() => {
    if (nav || !stat.data) return;
    setNav(
      stat.data.type === "dir"
        ? { dir: stat.data.path }
        : { dir: parentOf(stat.data.path), file: stat.data.path }
    );
  }, [stat.data, nav]);

  // stat が失敗（存在しない等）したらルートから始める。理由は下のバナーで出す
  useEffect(() => {
    if (!nav && stat.error) setNav({ dir: "." });
  }, [stat.error, nav]);

  const dir = nav?.dir ?? ".";
  const file = nav?.file;
  // 強調は「番頭が指定したファイルを見ているとき」だけ。別のファイルを選んだら外す
  const highlightFrom = file === initialPath ? initialLine : undefined;
  const highlightTo = file === initialPath ? (initialEndLine ?? initialLine) : undefined;

  const listing = useModuleTool<Listing>(
    endpoint,
    "file.list",
    { path: dir, ...(place ? { place } : {}) },
    nav !== undefined && place !== undefined
  );
  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    {
      path: file ?? "",
      ...(place ? { place } : {}),
      // 強調したい行が既定の打ち切り範囲より後ろにあると出せないので、届く分だけ広げる
      ...(highlightTo !== undefined ? { maxLines: Math.max(400, highlightTo + 40) } : {}),
    },
    file !== undefined && place !== undefined
  );

  // ファイル切替でトグル状態をリセットする（task-0051 a4）
  useEffect(() => {
    setMode("preview");
    setWrap(false);
    scrollFrac.current = 0;
  }, [file]);

  // ---- プレビュー種別と表示モード ----
  const kind = file ? kindOfPath(file) : "plain";
  const previewable = kind !== "plain";
  // 2000行超のファイルは preview を無効化して source に落とす（task-0050 a4）
  const totalLines = content.data?.totalLines ?? content.data?.content?.split("\n").length ?? 0;
  const previewAllowed = previewable && totalLines <= PREVIEW_MAX_LINES;
  const effectiveMode = previewAllowed ? mode : "source";
  const contentText = content.data?.content ?? "";
  const codeLang = kind === "code" ? codeLangOfPath(file ?? "") : undefined;
  const csvDelimiter: "," | "\t" = extOfPath(file ?? "") === "tsv" ? "\t" : ",";

  const captureScroll = (): void => {
    const el = codeScrollRef.current ?? previewScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    scrollFrac.current = max > 0 ? el.scrollTop / max : 0;
  };

  const switchMode = (next: "preview" | "source"): void => {
    if (next === mode) return;
    captureScroll();
    restorePending.current = true;
    setMode(next);
  };

  // モード切替直後に、スクロール位置を割合で復元する（a5）。
  // 復元は切替のたびに1回だけ——Mermaid 等の非同期描画完了（previewReadyTick）で
  // 何度も実行すると、切替後に手動でスクロールした位置を巻き戻してしまう
  useEffect(() => {
    if (!restorePending.current) return;
    restorePending.current = false;
    const el = codeScrollRef.current ?? previewScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = scrollFrac.current * max;
  }, [mode, previewReadyTick, effectiveMode]);

  const join = (name: string): string => (dir === "." ? name : `${dir}/${name}`);

  return (
    <div className="fb">
      <div className="fb-bar">
        <PlacePicker selection={selection} />
        <button
          className="fb-up"
          disabled={dir === "."}
          onClick={() => setNav({ dir: parentOf(dir) })}
        >
          ↑ 上へ
        </button>
        <code className="fb-path">{listing.data?.path ?? dir}</code>
        {listing.data && <span className="fb-count">{listing.data.total} 件</span>}
      </div>

      {/* I2: 指定パスが解決できなかったことを黙って隠さない */}
      {stat.error && (
        <div className="fb-error">
          「{initialPath}」を開けなかったためルートを表示しています: {stat.error}
        </div>
      )}
      {listing.error && <div className="fb-error">読み込めません: {listing.error}</div>}

      <div className="fb-body">
        <ul className="fb-list">
          {(listing.loading || nav === undefined) && <li className="fb-muted">読み込み中…</li>}
          {listing.data?.entries.map((entry) => (
            <li key={entry.name}>
              <button
                className={`fb-entry ${entry.type === "dir" ? "is-dir" : ""} ${
                  file === join(entry.name) ? "is-selected" : ""
                }`}
                onClick={() =>
                  setNav(
                    entry.type === "dir" ? { dir: join(entry.name) } : { dir, file: join(entry.name) }
                  )
                }
              >
                <span className="fb-icon">{entry.type === "dir" ? "📁" : "📄"}</span>
                {entry.name}
                {entry.size !== undefined && <span className="fb-size">{entry.size}</span>}
              </button>
            </li>
          ))}
          {listing.data?.truncated && <li className="fb-muted">… 上限を超えたため一部のみ表示</li>}
        </ul>

        <div className="fb-preview">
          {!file ? (
            <p className="fb-muted">ファイルを選ぶと中身が出ます</p>
          ) : content.error ? (
            <div className="fb-error">読み込めません: {content.error}</div>
          ) : content.loading ? (
            <p className="fb-muted">読み込み中…</p>
          ) : content.data?.binary ? (
            <p className="fb-muted">バイナリのため表示できません（{content.data.size} bytes）</p>
          ) : (
            <>
              <div className="fb-preview-head">
                <code>{content.data?.path}</code>
                {content.data?.truncated && (
                  <span className="fb-muted">
                    （{content.data.shownLines} / {content.data.totalLines} 行のみ表示）
                  </span>
                )}
                {previewable && !previewAllowed && (
                  <span className="fb-muted">
                    大きいファイルのためプレビューを無効にしました（{totalLines} 行）
                  </span>
                )}
                <span className="fb-preview-controls">
                  {previewable && (
                    <span className="fb-seg" role="group" aria-label="表示モード">
                      <button
                        type="button"
                        className={`fb-seg-btn ${effectiveMode === "preview" ? "is-active" : ""}`}
                        disabled={!previewAllowed}
                        onClick={() => switchMode("preview")}
                      >
                        preview
                      </button>
                      <button
                        type="button"
                        className={`fb-seg-btn ${effectiveMode === "source" ? "is-active" : ""}`}
                        onClick={() => switchMode("source")}
                      >
                        source
                      </button>
                    </span>
                  )}
                  {effectiveMode === "source" && (
                    <label className="fb-wrap-toggle">
                      <input
                        type="checkbox"
                        checked={wrap}
                        onChange={(e) => setWrap(e.target.checked)}
                      />
                      折り返し
                    </label>
                  )}
                </span>
              </div>

              {effectiveMode === "preview" ? (
                <div className="fb-preview-scroll" ref={previewScrollRef}>
                  {kind === "markdown" && (
                    <div className="markdown">
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          code: (props) => (
                            <MarkdownCode
                              {...props}
                              scheme={scheme}
                              onMermaidReady={bumpPreviewReady}
                            />
                          ),
                        }}
                      >
                        {contentText}
                      </Markdown>
                    </div>
                  )}
                  {kind === "mermaid" && (
                    <MermaidBlock code={contentText} scheme={scheme} onReady={bumpPreviewReady} />
                  )}
                  {kind === "csv" && <CsvTable content={contentText} delimiter={csvDelimiter} />}
                  {kind === "diff" && <DiffPreview content={contentText} />}
                  {kind === "code" && (
                    <CodePreview content={contentText} lang={codeLang} scheme={scheme} />
                  )}
                </div>
              ) : (
                <CodeBody
                  content={contentText}
                  {...(highlightFrom !== undefined ? { from: highlightFrom } : {})}
                  {...(highlightTo !== undefined ? { to: highlightTo } : {})}
                  wrap={wrap}
                  lang={kind === "code" ? codeLang : undefined}
                  scheme={scheme}
                  scrollRef={codeScrollRef}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
