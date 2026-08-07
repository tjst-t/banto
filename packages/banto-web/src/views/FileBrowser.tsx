/**
 * ファイル閲覧（基本GUIセット・ADR-0010 決定18・24・25）。
 *
 * データは自分を提供しているモジュール（workspace）のデータAPIから取る。番頭のToolは
 * 呼ばない——同じTool契約だが経路が違う（決定25）。到達先は props の endpoint。
 *
 * **一覧と中身を1枚で扱う。** 狭いときは一覧→中身のドリルダウンになる（§8）。
 *
 * 開く位置は `params` が決める：
 *   - `path` … ディレクトリならその中身、ファイルならそのファイル
 *   - `line` / `endLine` … その行まで自動スクロールして強調（file.grep の結果をそのまま見せる）
 *
 * 探す口も持つ（`file.find` / `file.grep`）。番頭に頼まずPOが自分で辿れるようにするため——
 * 「どこにあるか」が分からないままツリーを掘るのが、この面で一番時間を食う。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useModuleTool, callModuleTool } from "./useModuleTool.js";
import { PlacePicker, usePlaceSelection } from "./PlacePicker.js";
import type { CanvasViewProps } from "./registry.js";
import { Icon, iconOfFile, type IconName } from "../icons.js";
import { MarkdownLink } from "../links.js";
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorNote,
  Loading,
  Scroll,
  SearchField,
  Segmented,
  SplitView,
  Toggle,
  ViewBar,
  ViewShell,
  formatBytes,
} from "./ui.js";
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
  useColorScheme,
  type HighlightedLine,
  type HighlightResult,
  type Scheme,
} from "./fileHighlight.js";

/** 「続きを読む」1回で足す行数。ホスト側のサイズ上限に当たればそこで止まる。 */
const READ_MORE_LINES = 2000;

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
  /** 返ってきた範囲（1始まり）。続きを読むときの起点になる。 */
  from?: number;
  to?: number;
  /** 最後の行を途中で切ったか（1行がホストのサイズ上限より大きいとき）。 */
  partialLine?: boolean;
  truncated?: boolean;
}
interface StatInfo {
  path: string;
  type: "dir" | "file";
  size: number;
}
/** file.grep の1件。file.find は line を持たない。 */
interface Hit {
  path: string;
  line?: number;
  text?: string;
  size?: number;
}

type SearchMode = "name" | "content";

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}

/** 拡張子でそれらしい絵を選ぶ。中身を開く前の見当がつくだけでよい。対応は icons.tsx。 */
function iconOf(entry: Entry): IconName {
  return iconOfFile(entry.name, entry.type === "dir");
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
 * 番頭が「この行を見て」と言えるようにするための面。
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

/** パンくず。**どこにいるかと、どこへ戻れるかを同時に出す**（「↑ 上へ」だけだと辿り直せない）。 */
function Breadcrumbs({
  dir,
  onGo,
}: {
  dir: string;
  onGo: (path: string) => void;
}): React.ReactElement {
  const parts = dir === "." ? [] : dir.split("/").filter((p) => p.length > 0);
  const crumbs = [{ name: "", path: "." }, ...parts.map((name, i) => ({
    name,
    path: parts.slice(0, i + 1).join("/"),
  }))];
  return (
    <nav className="fb-crumbs" aria-label="いま開いている場所">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={crumb.path} style={{ display: "contents" }}>
            {i > 0 && (
              <span className="fb-crumb-sep" aria-hidden="true">
                /
              </span>
            )}
            <button
              type="button"
              className={`fb-crumb ${last ? "is-last" : ""} ${i === 0 ? "is-home" : ""}`}
              disabled={last}
              title={crumb.path === "." ? "この場所のいちばん上へ" : crumb.path}
              aria-label={crumb.path === "." ? "この場所のいちばん上へ" : crumb.name}
              onClick={() => onGo(crumb.path)}
            >
              {i === 0 ? <Icon name="home" size={14} /> : crumb.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

export function FileBrowser({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const initialPath = typeof params["path"] === "string" ? params["path"] : ".";
  const initialLine = typeof params["line"] === "number" ? params["line"] : undefined;
  const initialEndLine = typeof params["endLine"] === "number" ? params["endLine"] : undefined;

  // どの場所を見るか（決定36e）。番頭が指定していなければ先頭に落ちる
  const selection = usePlaceSelection(
    endpoint,
    typeof params["place"] === "string" ? params["place"] : undefined
  );
  const place = selection.place;

  // 渡されたパスがディレクトリかファイルかを先に確かめる
  const stat = useModuleTool<StatInfo>(
    endpoint,
    "file.stat",
    { path: initialPath, ...(place ? { place } : {}) },
    place !== undefined
  );
  const [nav, setNav] = useState<{ dir: string; file?: string }>();
  /**
   * 狭いときにどちらを見ているか。**選んだファイルを閉じずに一覧へ戻れる**ようにするため、
   * 「開いているファイル」とは別に持つ——探し直すときも、前に見ていたファイルは残す。
   */
  const [pane, setPane] = useState<"list" | "file">("list");
  const [includeHidden, setIncludeHidden] = useState(false);
  /** その場で一覧を絞る（打つたびに効く。サーバへは投げない）。 */
  const [filter, setFilter] = useState("");

  /** 探す（サーバへ投げる）。名前は file.find、中身は file.grep。 */
  const [searchMode, setSearchMode] = useState<SearchMode>("content");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState<{
    query: string;
    mode: SearchMode;
    hits: Hit[];
    truncated: boolean;
    error?: string;
    loading: boolean;
  }>();
  const [searchOpen, setSearchOpen] = useState(false);

  // preview/source トグルと折り返しはローカル state（task-0051 a4）。ファイル切替でリセット
  const [mode, setMode] = useState<"preview" | "source">("preview");
  /** 原文表示の折り返し。**既定は折り返す**——横に流れると、読むのに二方向へ動かすことになる */
  const [wrap, setWrap] = useState(true);
  /** プレビューの描画が終わるたびに増える。スクロール復元の再実行に使う */
  const [previewReadyTick, setPreviewReadyTick] = useState(0);
  const bumpPreviewReady = useCallback(() => setPreviewReadyTick((n) => n + 1), []);
  /** モード切替前のスクロール位置（割合）。preview と source で行数が違うため割合で復元する */
  const scrollFrac = useRef(0);
  const restorePending = useRef(false);
  const codeScrollRef = useRef<HTMLPreElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();

  // 場所を変えたら、その場所のルートから見直す（前の場所のパスは意味を持たない）
  useEffect(() => {
    setNav(undefined);
    setSearch(undefined);
    setFilter("");
  }, [place]);

  useEffect(() => {
    if (nav || !stat.data) return;
    if (stat.data.type === "dir") {
      setNav({ dir: stat.data.path });
      return;
    }
    // 番頭がファイルを指して開いたなら、狭い画面でもそのファイルから見せる
    setNav({ dir: parentOf(stat.data.path), file: stat.data.path });
    setPane("file");
  }, [stat.data, nav]);

  // stat が失敗（存在しない等）したらルートから始める。理由は下の帯で出す
  useEffect(() => {
    if (!nav && stat.error) setNav({ dir: "." });
  }, [stat.error, nav]);

  const dir = nav?.dir ?? ".";
  const file = nav?.file;
  /** 番頭が指定した行の強調は、そのファイルを見ている間だけ。別のファイルを選んだら外す。 */
  const highlightFrom = file === initialPath ? initialLine : undefined;
  const highlightTo = file === initialPath ? initialEndLine ?? initialLine : undefined;
  /** 検索結果から開いたときの行。 */
  const [hitLine, setHitLine] = useState<{ path: string; line: number }>();
  const hitHere = hitLine !== undefined && hitLine.path === file ? hitLine.line : undefined;
  const lineFrom = hitHere ?? highlightFrom;
  const lineTo = hitHere ?? highlightTo;

  const listing = useModuleTool<Listing>(
    endpoint,
    "file.list",
    { path: dir, includeHidden, ...(place ? { place } : {}) },
    nav !== undefined && place !== undefined
  );
  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    {
      path: file ?? "",
      ...(place ? { place } : {}),
      // 強調したい行が既定の打ち切り範囲より後ろにあると出せないので、届く分だけ広げる
      ...(lineTo !== undefined ? { maxLines: Math.max(400, lineTo + 40) } : {}),
    },
    file !== undefined && place !== undefined
  );

  /**
   * 「続きを読む」で継ぎ足した分。file.read は1回に一定量しか返さないので、
   * 続きは offset を進めて取り、画面では前の分に繋げる。
   */
  const [more, setMore] = useState<{
    path: string;
    text: string;
    to: number;
    partialLine: boolean;
    loading: boolean;
    error?: string;
  }>();
  const moreHere = more?.path === file ? more : undefined;
  /** ここまで読めている行。継ぎ足していればその末尾。 */
  const readTo = moreHere?.to ?? content.data?.to;
  const fileTotalLines = content.data?.totalLines;
  const partialLine = moreHere?.partialLine ?? content.data?.partialLine === true;
  // 途中で切った行の残りへは進めない（offset は行単位）。ボタンは次の行があるときだけ
  const hasMore =
    content.data?.binary === false &&
    readTo !== undefined &&
    fileTotalLines !== undefined &&
    readTo < fileTotalLines;

  const readMore = async (): Promise<void> => {
    if (file === undefined || place === undefined || readTo === undefined) return;
    const base = moreHere?.text ?? "";
    setMore({ path: file, text: base, to: readTo, partialLine, loading: true });
    try {
      const next = await callModuleTool<FileContent>(endpoint, "file.read", {
        path: file,
        place,
        offset: readTo + 1,
        maxLines: READ_MORE_LINES,
      });
      setMore({
        path: file,
        text: `${base}\n${next.content ?? ""}`,
        to: next.to ?? readTo,
        partialLine: next.partialLine === true,
        loading: false,
      });
    } catch (err) {
      // I2: 読めなかったことを黙って飲まない。継ぎ足し済みの分は残す
      setMore({ path: file, text: base, to: readTo, partialLine, loading: false, error: String(err) });
    }
  };

  // ファイル切替でトグル状態をリセットする（task-0051 a4）
  useEffect(() => {
    setMode("preview");
    setWrap(true);
    scrollFrac.current = 0;
  }, [file]);

  // 基点を取り直したら継ぎ足しは捨てる。前の基点に繋げた文が残ると行がずれる
  useEffect(() => {
    setMore(undefined);
  }, [file, lineTo]);

  // ---- プレビュー種別と表示モード ----
  const kind = file ? kindOfPath(file) : "plain";
  const previewable = kind !== "plain";
  const totalLines = content.data?.totalLines ?? content.data?.content?.split("\n").length ?? 0;
  // 2000行超のファイルは preview を無効化して source に落とす（task-0050 a4）
  const previewAllowed = previewable && totalLines <= PREVIEW_MAX_LINES;
  const effectiveMode = previewAllowed ? mode : "source";
  const contentText = `${content.data?.content ?? ""}${moreHere?.text ?? ""}`;
  /**
   * 帯の文言。**どこまで読めているかを言い切る**——「すべて読み込みました」と
   * 「途中で切れています」を混ぜると、見えていないものが有るのか無いのか分からなくなる。
   */
  const readNote = ((): string => {
    if (content.data?.truncated !== true) {
      return `${totalLines} 行と大きいため、整形表示ではなく原文で出しています。`;
    }
    if (hasMore) {
      const cut = partialLine ? ` ${readTo} 行目は1行が大きすぎるため、途中までしか出せません。` : "";
      return `大きいファイルのため ${readTo} / ${fileTotalLines} 行まで読んでいます。${cut}`;
    }
    return partialLine
      ? `最後の ${readTo} 行目まで届きましたが、1行が大きすぎるため途中までしか出せません。`
      : `${fileTotalLines} 行すべて読み込みました。`;
  })();
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

  // モード切替直後に、スクロール位置を割合で復元する。切替のたびに1回だけ——
  // Mermaid 等の非同期描画完了で何度も実行すると、手動でスクロールした位置を巻き戻す
  useEffect(() => {
    if (!restorePending.current) return;
    restorePending.current = false;
    const el = codeScrollRef.current ?? previewScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = scrollFrac.current * max;
  }, [mode, previewReadyTick, effectiveMode]);

  const join = (name: string): string => (dir === "." ? name : `${dir}/${name}`);

  /** 探す。**ホストに探させる**——一覧を全部運んで画面で絞ると、大きい木で破綻する。 */
  const runSearch = async (query: string, searchIn: SearchMode): Promise<void> => {
    const q = query.trim();
    // 狭いときは結果が一覧側に出る。開いていたファイルの裏に隠さない
    setPane("list");
    if (q.length === 0) {
      setSearch(undefined);
      return;
    }
    setSearch({ query: q, mode: searchIn, hits: [], truncated: false, loading: true });
    try {
      const at = place ? { place } : {};
      if (searchIn === "name") {
        const res = await callModuleTool<{ matches: Hit[]; truncated: boolean }>(
          endpoint,
          "file.find",
          { pattern: q.includes("*") ? q : `*${q}*`, path: dir, includeHidden, ...at }
        );
        setSearch({ query: q, mode: searchIn, hits: res.matches, truncated: res.truncated, loading: false });
      } else {
        const res = await callModuleTool<{ hits: Hit[]; truncated: boolean }>(endpoint, "file.grep", {
          pattern: q,
          path: dir,
          ignoreCase: true,
          includeHidden,
          ...at,
        });
        setSearch({ query: q, mode: searchIn, hits: res.hits, truncated: res.truncated, loading: false });
      }
    } catch (err) {
      // I2: 探したのに何も起きなかったように見せない
      setSearch({
        query: q,
        mode: searchIn,
        hits: [],
        truncated: false,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const entries = useMemo(() => {
    const all = listing.data?.entries ?? [];
    const q = filter.trim().toLowerCase();
    return q.length === 0 ? all : all.filter((e) => e.name.toLowerCase().includes(q));
  }, [listing.data, filter]);

  const listPane = (
    <>
      <ViewBar>
        <SearchField value={filter} onChange={setFilter} placeholder="この一覧を絞る" />
        <Toggle
          checked={includeHidden}
          onChange={setIncludeHidden}
          title="ドット始まりのファイルや node_modules 等も一覧に出す"
        >
          隠しファイルも表示
        </Toggle>
      </ViewBar>

      {stat.error && (
        <ErrorNote title={`「${initialPath}」を開けませんでした`}>
          {stat.error}（いちばん上から表示しています）
        </ErrorNote>
      )}
      {listing.error && <ErrorNote onRetry={listing.reload}>{listing.error}</ErrorNote>}

      {/* 探した結果は一覧の代わりに出す。片付けると元の一覧へ戻る */}
      {search ? (
        <Scroll pad={false}>
          <div className="cv-sechead">
            <h3 className="cv-sechead-title">
              「{search.query}」{search.mode === "name" ? "（名前）" : "（中身）"}
              <span className="cv-count">{search.hits.length}</span>
            </h3>
            <div className="cv-sechead-actions">
              <Button small variant="ghost" onClick={() => setSearch(undefined)}>
                × やめる
              </Button>
            </div>
          </div>
          {search.error && <ErrorNote>{search.error}</ErrorNote>}
          {search.loading ? (
            <Loading label="探しています…" />
          ) : search.hits.length === 0 && !search.error ? (
            <EmptyState icon="search" title="見つかりませんでした">
              {dir === "." ? "この場所" : `${dir} の下`}には当てはまるものがありません。
            </EmptyState>
          ) : (
            <ul className="cv-list">
              {search.hits.map((hit, i) => (
                <li key={`${hit.path}:${hit.line ?? i}`}>
                  <button
                    className={`cv-row ${file === hit.path ? "is-selected" : ""}`}
                    onClick={() => {
                      setNav({ dir: parentOf(hit.path), file: hit.path });
                      if (hit.line !== undefined) setHitLine({ path: hit.path, line: hit.line });
                      setPane("file");
                    }}
                    title={hit.path}
                  >
                    <span className="fb-hit">
                      <span className="fb-hit-path">
                        {hit.path}
                        {hit.line !== undefined ? `:${hit.line}` : ""}
                      </span>
                      {hit.text !== undefined && <span className="fb-hit-text">{hit.text.trim()}</span>}
                      {hit.size !== undefined && <span className="fb-hit-path">{formatBytes(hit.size)}</span>}
                    </span>
                  </button>
                </li>
              ))}
              {search.truncated && (
                <li className="cv-muted" style={{ padding: "8px 10px" }}>
                  … 上限に達したため一部のみ
                </li>
              )}
            </ul>
          )}
        </Scroll>
      ) : (
        <Scroll pad={false}>
          {listing.loading && !listing.data ? (
            <Loading rows={6} />
          ) : entries.length === 0 ? (
            <EmptyState icon="folder" title={filter ? "当てはまるものがありません" : "空のディレクトリです"}>
              {filter ? "絞り込みを外すと全部出ます。" : "ここには何もありません。"}
            </EmptyState>
          ) : (
            <ul className="cv-list">
              {entries.map((entry) => (
                <li key={entry.name}>
                  <button
                    className={`fb-entry ${entry.type === "dir" ? "is-dir" : ""} ${
                      file === join(entry.name) ? "is-selected" : ""
                    }`}
                    onClick={() => {
                      if (entry.type === "dir") {
                        setNav({ dir: join(entry.name) });
                        setFilter("");
                      } else {
                        setNav({ dir, file: join(entry.name) });
                        setPane("file");
                      }
                    }}
                    title={join(entry.name)}
                  >
                    <Icon name={iconOf(entry)} size={15} className="fb-icon" />
                    <span className="fb-entry-name">{entry.name}</span>
                    {entry.type === "dir" ? (
                      <Icon name="chevron-right" size={13} className="fb-size" />
                    ) : (
                      <span className="fb-size">{formatBytes(entry.size)}</span>
                    )}
                  </button>
                </li>
              ))}
              {listing.data?.truncated && (
                <li className="cv-muted" style={{ padding: "8px 10px" }}>
                  … 件数の上限を超えたため一部のみ（全 {listing.data.total} 件）
                </li>
              )}
            </ul>
          )}
        </Scroll>
      )}
    </>
  );

  const detailPane = !file ? (
    <EmptyState icon="file" title="ファイルを選ぶと中身が出ます">
      左の一覧から選ぶか、「探す」で中身を検索できます。
    </EmptyState>
  ) : (
    <div className="fb-file">
      <div className="fb-file-head">
        <code className="fb-file-path" title={content.data?.path ?? file}>
          {content.data?.path ?? file}
        </code>
        <span className="cv-spacer" />
        {previewable && (
          <Segmented
            label="表示"
            value={effectiveMode}
            onChange={switchMode}
            options={[
              {
                value: "preview",
                label: "整形",
                disabled: !previewAllowed,
                title: previewAllowed ? undefined : `${totalLines} 行と大きいため整形表示は使えません`,
              },
              { value: "source", label: "原文" },
            ]}
          />
        )}
        {effectiveMode === "source" && (
          <Toggle checked={wrap} onChange={setWrap} title="長い行を折り返す">
            折り返し
          </Toggle>
        )}
        {contentText.length > 0 && <CopyButton text={contentText} label="本文をコピー" />}
      </div>

      {(content.data?.truncated || (previewable && !previewAllowed)) && (
        // 読み切ったら警告色をやめる。見えていないものが無いのに注意を引き続けない
        <div
          className={`cv-note${content.data?.truncated === true && !hasMore && !partialLine ? "" : " is-warn"}`}
          style={{ margin: "8px 12px 0" }}
        >
          <span style={{ flex: 1 }}>
            {readNote}
            {moreHere?.error !== undefined && ` 続きが読めませんでした: ${moreHere.error}`}
          </span>
          {hasMore && (
            <button
              type="button"
              className="cv-btn is-small"
              onClick={() => void readMore()}
              disabled={moreHere?.loading === true}
            >
              {moreHere?.loading === true ? "読んでいます…" : "続きを読む"}
            </button>
          )}
        </div>
      )}

      {content.error ? (
        <ErrorNote onRetry={content.reload}>{content.error}</ErrorNote>
      ) : content.loading && !content.data ? (
        <Loading rows={5} />
      ) : content.data?.binary ? (
        <EmptyState icon="binary" title="バイナリのため表示できません">
          {formatBytes(content.data.size)} のファイルです。
        </EmptyState>
      ) : (
        <div className="fb-body">
          {effectiveMode === "preview" ? (
            <div className="fb-preview-scroll" ref={previewScrollRef}>
              {kind === "markdown" && (
                <div className="markdown">
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code: (props) => (
                        <MarkdownCode {...props} scheme={scheme} onMermaidReady={bumpPreviewReady} />
                      ),
                      // 外に出るリンクは別タブへ（links.tsx）。読んでいる面ごと差し替わらない
                      a: MarkdownLink,
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
              {kind === "code" && <CodePreview content={contentText} lang={codeLang} scheme={scheme} />}
            </div>
          ) : (
            <CodeBody
              content={contentText}
              {...(lineFrom !== undefined ? { from: lineFrom } : {})}
              {...(lineTo !== undefined ? { to: lineTo } : {})}
              wrap={wrap}
              lang={kind === "code" ? codeLang : undefined}
              scheme={scheme}
              scrollRef={codeScrollRef}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <ViewShell className="fb">
      {/* どこを見ているか・どこへ戻れるかは、一覧と中身のどちらを見ていても要る */}
      <ViewBar>
        <PlacePicker selection={selection} />
        <Breadcrumbs
          dir={dir}
          onGo={(path) => {
            setNav({ dir: path });
            setSearch(undefined);
            setPane("list");
          }}
        />
        <Button
          small
          variant={searchOpen ? "primary" : "ghost"}
          title="名前・中身から探す"
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Icon name="search" size={14} /> 探す
        </Button>
      </ViewBar>

      {searchOpen && (
        <ViewBar>
          <Segmented
            label="探し方"
            value={searchMode}
            onChange={(next) => {
              setSearchMode(next);
              if (searchDraft.trim().length > 0) void runSearch(searchDraft, next);
            }}
            options={[
              { value: "content", label: "中身", title: "ファイルの中身を正規表現で探す（file.grep）" },
              { value: "name", label: "名前", title: "ファイル名で探す（file.find）" },
            ]}
          />
          <SearchField
            value={searchDraft}
            onChange={setSearchDraft}
            onSubmit={(value) => void runSearch(value, searchMode)}
            placeholder={
              searchMode === "content"
                ? `${dir === "." ? "この場所" : dir} の下を探す（Enter）`
                : "ファイル名の一部（Enter）"
            }
            autoFocus
          />
        </ViewBar>
      )}

      <SplitView
        size="md"
        list={listPane}
        detail={detailPane}
        showDetail={pane === "file" && file !== undefined}
        onBack={() => setPane("list")}
        backLabel="ファイル一覧"
      />
    </ViewShell>
  );
}
