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
import { useListNav } from "../listNav.js";
import {
  Button,
  Chip,
  CopyButton,
  EmptyState,
  ErrorNote,
  IconButton,
  Loading,
  Modal,
  Scroll,
  SearchField,
  Segmented,
  SplitView,
  Toggle,
  ViewBar,
  ViewShell,
  formatBytes,
  useRetractOnScroll,
} from "./ui.js";
import {
  classifyDiffLine,
  codeLangOfPath,
  extOfPath,
  isRawKind,
  kindOfPath,
  PREVIEW_MAX_LINES,
} from "./filePreview.js";
import { fileRawUrl } from "./fileRaw.js";
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

/**
 * 長いパスは**頭を落として末尾を残す**（spec-file-browser §5.2）。
 *
 * `direction: rtl` は使わない——先頭の `/` が中立文字として末尾へ回り、
 * `home/ubuntu/…/` のように壊れて見える（`spec-design` が `PlacePicker` で実測済み）。
 * 見たいのはファイル名なので、切るのは頭でよい。
 */
export function shortenPath(p: string, maxSegments = 2): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  if (parts.length <= maxSegments) return p;
  return `…/${parts.slice(-maxSegments).join("/")}`;
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

/**
 * 一致した箇所を行の中で強調する（spec-file-browser §10 ③27）。
 *
 * 中身の検索は正規表現なので、**組み立てに失敗したらそのまま出す**（I2：探した結果を
 * 落とさない）。名前の検索は素の部分一致で照らす。
 */
function HitText({ text, query, regex }: { text: string; query: string; regex: boolean }): React.ReactElement {
  const parts = useMemo(() => {
    if (query.length === 0) return [text];
    try {
      const re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const out: string[] = [];
      let at = 0;
      for (const m of text.matchAll(re)) {
        if (m.index === undefined || m[0].length === 0) continue;
        out.push(text.slice(at, m.index), m[0]);
        at = m.index + m[0].length;
      }
      out.push(text.slice(at));
      return out;
    } catch {
      return [text];
    }
  }, [text, query, regex]);

  return (
    <>
      {parts.map((part, i) =>
        // 奇数番が一致したところ（split の並び）
        i % 2 === 1 ? (
          <mark key={i} className="fb-mark">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/** パンくず1段。 */
interface Crumb {
  name: string;
  path: string;
}

function crumbsOf(dir: string): Crumb[] {
  const parts = dir === "." ? [] : dir.split("/").filter((p) => p.length > 0);
  return [
    { name: "", path: "." },
    ...parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") })),
  ];
}

/** 畳まずに出す段数（ルートを除く）。末尾＝いまいる所と、その1つ上。 */
const CRUMB_TAIL = 2;

/**
 * 畳んだ段を全部出す面（`spec-design` §8.2 の作法：絞る欄＋一覧＋確定・↑↓ Enter・Esc）。
 */
function CrumbModal({
  crumbs,
  onGo,
  onClose,
}: {
  crumbs: readonly Crumb[];
  onGo: (path: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q.length === 0 ? [...crumbs] : crumbs.filter((c) => c.path.toLowerCase().includes(q));
  }, [crumbs, filter]);
  const nav = useListNav(shown, {
    onChoose: (crumb) => {
      onGo(crumb.path);
      onClose();
    },
    resetKey: filter,
  });

  return (
    <Modal title="どこへ戻りますか" onClose={onClose} footer="↑↓ で選ぶ · Enter で決める · Esc で閉じる">
      <div className="place-search">
        <SearchField value={filter} onChange={setFilter} onKeyDown={nav.onKeyDown} placeholder="段を絞る" autoFocus />
      </div>
      <div ref={nav.listRef}>
        {shown.map((crumb, i) => (
          <button
            key={crumb.path}
            type="button"
            className={`place-row ${nav.isOn(i) ? "is-on" : ""}`}
            {...nav.rowProps(i)}
            onClick={() => {
              onGo(crumb.path);
              onClose();
            }}
          >
            <span className="place-row-mark">
              <Icon name={crumb.path === "." ? "home" : "folder"} size={14} />
            </span>
            <span className="place-row-main">
              <span className="place-row-name">
                {crumb.path === "." ? "この場所のいちばん上" : crumb.name}
              </span>
              {crumb.path !== "." && <span className="place-row-sub">{crumb.path}</span>}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * パンくず。**どこにいるかと、どこへ戻れるかを同時に出す**（「↑ 上へ」だけだと辿り直せない）。
 *
 * **末尾優先で畳む。横に流さない**（spec-file-browser §3.2）。以前は `overflow-x: auto` で
 * 逃がしていたが、狭い画面で切れて消えるのが**いまいるディレクトリ**だった（実測 390px で
 * `🏠/docs/spec/deep/nested/` まで出て `place` が器の外）。隠れていることも、どちらへ
 * 送るかも見えない——`spec-canvas-ui` §6 がタブ列に対して決めたのと同じ理由。
 */
function Breadcrumbs({
  dir,
  onGo,
}: {
  dir: string;
  onGo: (path: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const crumbs = crumbsOf(dir);
  // ルート（先頭）は常に出す。畳むのはその間
  const tail = crumbs.slice(Math.max(1, crumbs.length - CRUMB_TAIL));
  const hidden = crumbs.slice(1, Math.max(1, crumbs.length - CRUMB_TAIL));

  const crumbButton = (crumb: Crumb, last: boolean): React.ReactElement => (
    <button
      type="button"
      className={`fb-crumb ${last ? "is-last" : ""}`}
      disabled={last}
      title={crumb.path}
      onClick={() => onGo(crumb.path)}
    >
      {crumb.name}
    </button>
  );

  return (
    <nav className="fb-crumbs" aria-label="いま開いている場所">
      <button
        type="button"
        className={`fb-crumb is-home ${crumbs.length === 1 ? "is-last" : ""}`}
        disabled={crumbs.length === 1}
        title="この場所のいちばん上へ"
        aria-label="この場所のいちばん上へ"
        onClick={() => onGo(".")}
      >
        <Icon name="home" size={14} />
      </button>
      {hidden.length > 0 && (
        <>
          <button
            type="button"
            className="fb-crumb is-more"
            title={`途中の ${hidden.length} 段を出す`}
            aria-label={`途中の ${hidden.length} 段を出す`}
            onClick={() => setOpen(true)}
          >
            …
          </button>
          {open && (
            <CrumbModal crumbs={crumbs} onGo={onGo} onClose={() => setOpen(false)} />
          )}
        </>
      )}
      {tail.map((crumb, i) => (
        <span key={crumb.path} style={{ display: "contents" }}>
          <span className="fb-crumb-sep" aria-hidden="true">
            /
          </span>
          {crumbButton(crumb, i === tail.length - 1)}
        </span>
      ))}
    </nav>
  );
}

/**
 * 中身の頭の「…」に畳むもの（spec-file-browser §5.2）。
 *
 * **読んでいる間に押すものではない**——折り返し・写し・別タブ・落とすは、
 * 開いた直後か読み終わったあとに1度使うだけ。頭に並べておくと、狭い画面では
 * 名前が押し出される。
 */
function FileMenu({
  path,
  text,
  wrap,
  onWrap,
  showWrap,
  rawHref,
  onClose,
}: {
  path: string;
  text: string;
  wrap: boolean;
  onWrap: (next: boolean) => void;
  showWrap: boolean;
  rawHref: string | undefined;
  onClose: () => void;
}): React.ReactElement {
  return (
    <Modal title={path} onClose={onClose}>
      <div className="fb-menu">
        {showWrap && (
          <div className="fb-menu-row">
            <Toggle checked={wrap} onChange={onWrap} title="長い行を折り返す">
              長い行を折り返す
            </Toggle>
          </div>
        )}
        {text.length > 0 && (
          <div className="fb-menu-row">
            <CopyButton text={text} label="本文をコピー" />
            <CopyButton text={path} label="パスをコピー" />
          </div>
        )}
        {rawHref !== undefined && (
          <div className="fb-menu-row">
            {/* 開きっぱなしで使う面を潰さない（spec-design §8.3 と同じ理由） */}
            <a className="cv-btn" href={rawHref} target="_blank" rel="noreferrer">
              <Icon name="external" size={14} /> 別タブで開く
            </a>
            <a className="cv-btn" href={`${rawHref}?dl=1`} download>
              <Icon name="arrow-down" size={14} /> ダウンロード
            </a>
          </div>
        )}
        <p className="fb-menu-path">{path}</p>
      </div>
    </Modal>
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

  /**
   * 出発点。**場所を変えたらルートに戻す**（§8.2）——前の場所のパスは意味を持たないので、
   * そのまま stat し直すと「開けませんでした」の帯が場所を変えるたびに出る。
   */
  const [statPath, setStatPath] = useState(initialPath);
  const stat = useModuleTool<StatInfo>(
    endpoint,
    "file.stat",
    { path: statPath, ...(place ? { place } : {}) },
    place !== undefined
  );
  const [nav, setNav] = useState<{ dir: string; file?: string }>();
  /**
   * 狭いときにどちらを見ているか。**選んだファイルを閉じずに一覧へ戻れる**ようにするため、
   * 「開いているファイル」とは別に持つ——探し直すときも、前に見ていたファイルは残す。
   */
  const [pane, setPane] = useState<"list" | "file">("list");
  const [includeHidden, setIncludeHidden] = useState(false);
  /**
   * 一覧を絞る欄。**同じ欄が探す欄でもある**（§4.3）——打つとその場で絞り、
   * Enter でホストに探させる。口を3つ常設すると、狭い画面で2段を食い、
   * しかも「どれに打てばよいか」が読めない。
   */
  const [filter, setFilter] = useState("");
  /** 開けなかった理由。**動いたら畳む**（§8.2）——いつまでも一覧の上に残さない */
  const [openError, setOpenError] = useState<string>();

  /** 探した結果。探し方（中身／名前）は**探す前に選ばせず**、結果の見出しで切り替える */
  const [searchMode, setSearchMode] = useState<SearchMode>("content");
  const [search, setSearch] = useState<{
    query: string;
    mode: SearchMode;
    hits: Hit[];
    truncated: boolean;
    error?: string;
    loading: boolean;
  }>();

  /**
   * 表示モードと折り返しは**ファイルに紐づけて持つ**。別のファイルへ移れば自動で既定へ戻る
   * ——リセットの effect を置くと、初期値を状況で変えたいとき（§5.4）に競合する。
   */
  const [modeChoice, setModeChoice] = useState<{ path?: string; mode: "preview" | "source" }>({
    mode: "preview",
  });
  const [wrapChoice, setWrapChoice] = useState<{ path?: string; on: boolean }>({ on: true });
  const [menuOpen, setMenuOpen] = useState(false);
  /** プレビューの描画が終わるたびに増える。スクロール復元の再実行に使う */
  const [previewReadyTick, setPreviewReadyTick] = useState(0);
  const bumpPreviewReady = useCallback(() => setPreviewReadyTick((n) => n + 1), []);
  /** モード切替前のスクロール位置（割合）。preview と source で行数が違うため割合で復元する */
  const scrollFrac = useRef(0);
  const restorePending = useRef(false);
  /**
   * 中身のスクロールは**1つの器だけ**が持つ。退かせる判定も復元もここを見る。
   *
   * 器は「読み込み中 → 中身」で作り直されるので、**実体を state にも持つ**——
   * ref だけだと、効果が張られたときには居なかった器を掴んだままになる。
   */
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const attachBody = useCallback((node: HTMLDivElement | null) => {
    bodyScrollRef.current = node;
    setBodyEl(node);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();

  // 場所を変えたら、その場所のルートから見直す（前の場所のパスは意味を持たない）
  useEffect(() => {
    setNav(undefined);
    setSearch(undefined);
    setFilter("");
    setOpenError(undefined);
    setStatPath(".");
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

  // stat が失敗（存在しない等）したらルートから始める。理由は帯で1度だけ出す
  useEffect(() => {
    if (nav || !stat.error) return;
    setNav({ dir: "." });
    setOpenError(stat.error);
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

  /** どこかへ移る。**絞りは持ち越さない**（§4.4）——移った先が空に見える */
  const goDir = (path: string): void => {
    setNav({ dir: path });
    setFilter("");
    setSearch(undefined);
    setOpenError(undefined);
    setPane("list");
  };
  const openFile = (path: string, line?: number): void => {
    setNav({ dir: parentOf(path), file: path });
    if (line !== undefined) setHitLine({ path, line });
    setPane("file");
  };

  const listing = useModuleTool<Listing>(
    endpoint,
    "file.list",
    { path: dir, includeHidden, ...(place ? { place } : {}) },
    nav !== undefined && place !== undefined
  );
  /**
   * §8.1: **いま頼んだものと一致するときだけ描く。** `useModuleTool` は引数が変わっても
   * 次が届くまで前の結果を持ち続けるので、そのまま描くと移った先で前のディレクトリの
   * 一覧が出たままになる。判定用の状態は持たず、返ってきた `path` で導く（D3）。
   */
  const listed = listing.data?.path === dir ? listing.data : undefined;

  // ---- プレビュー種別と表示モード ----
  const kind = file ? kindOfPath(file) : "plain";
  /** 中身を `file.read` で運ばない種別（§5.1）。URL をそのまま渡す */
  const raw = isRawKind(kind);
  const rawHref =
    file !== undefined && place !== undefined ? fileRawUrl(endpoint, place, file) : undefined;

  const mode = modeChoice.path === file ? modeChoice.mode : lineFrom !== undefined ? "source" : "preview";
  const wrap = wrapChoice.path === file ? wrapChoice.on : true;

  /** 画像は原文を持たない。HTML は整形のとき iframe に任せるので本文を読まない */
  const needsText = file !== undefined && kind !== "image" && !(kind === "html" && mode === "preview");
  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    {
      path: file ?? "",
      ...(place ? { place } : {}),
      // 強調したい行が既定の打ち切り範囲より後ろにあると出せないので、届く分だけ広げる
      ...(lineTo !== undefined ? { maxLines: Math.max(400, lineTo + 40) } : {}),
    },
    needsText && place !== undefined
  );
  const body = content.data?.path === file ? content.data : undefined;

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
  const readTo = moreHere?.to ?? body?.to;
  const fileTotalLines = body?.totalLines;
  const partialLine = moreHere?.partialLine ?? body?.partialLine === true;
  // 途中で切った行の残りへは進めない（offset は行単位）。ボタンは次の行があるときだけ
  const hasMore =
    body?.binary === false &&
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

  // 基点を取り直したら継ぎ足しは捨てる。前の基点に繋げた文が残ると行がずれる
  useEffect(() => {
    setMore(undefined);
  }, [file, lineTo]);

  const previewable = kind !== "plain";
  const totalLines = body?.totalLines ?? body?.content?.split("\n").length ?? 0;
  /**
   * 2000行超は preview を無効化して source に落とす（task-0050 a4）。
   * ただし **html / image には効かせない**（§5.9）——`PREVIEW_MAX_LINES` は画面が組む
   * 行への上限であって、iframe と `<img>` には関係がない。
   */
  const previewAllowed = previewable && (raw || totalLines <= PREVIEW_MAX_LINES);
  const effectiveMode = kind === "image" ? "preview" : previewAllowed ? mode : "source";
  const contentText = `${body?.content ?? ""}${moreHere?.text ?? ""}`;
  /**
   * 帯の文言。**どこまで読めているかを言い切る**——「すべて読み込みました」と
   * 「途中で切れています」を混ぜると、見えていないものが有るのか無いのか分からなくなる。
   */
  const readNote = ((): string => {
    if (body?.truncated !== true) {
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
  const codeLang = kind === "code" || kind === "html" ? codeLangOfPath(file ?? "") : undefined;
  const csvDelimiter: "," | "\t" = extOfPath(file ?? "") === "tsv" ? "\t" : ",";

  /** 狭いとき、読んでいる間だけ頭を退かせる（§6.4） */
  const retracted = useRetractOnScroll(bodyEl, pane === "file" && file !== undefined);

  const captureScroll = (): void => {
    const el = bodyScrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    scrollFrac.current = max > 0 ? el.scrollTop / max : 0;
  };

  const switchMode = (next: "preview" | "source"): void => {
    if (next === mode) return;
    captureScroll();
    restorePending.current = true;
    setModeChoice({ ...(file !== undefined ? { path: file } : {}), mode: next });
  };

  // モード切替直後に、スクロール位置を割合で復元する。切替のたびに1回だけ——
  // Mermaid 等の非同期描画完了で何度も実行すると、手動でスクロールした位置を巻き戻す
  useEffect(() => {
    if (!restorePending.current) return;
    restorePending.current = false;
    const el = bodyScrollRef.current;
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

  /**
   * 何も選んでいないときに詳細側へ出すもの（spec-canvas-ui §2・§0 #9）。
   *
   * 広い画面では約 1000×1050px が「ファイルを選ぶと中身が出ます」だけで埋まっていた。
   * **そこに置けるものがあるなら置く**——このディレクトリの README がいちばん見たい。
   */
  const readmeName = listed?.entries.find(
    (e) => e.type === "file" && /^readme(\.md|\.txt)?$/i.test(e.name)
  )?.name;
  const readmePath = readmeName !== undefined ? (dir === "." ? readmeName : `${dir}/${readmeName}`) : undefined;
  const readme = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    { path: readmePath ?? "", ...(place ? { place } : {}) },
    readmePath !== undefined && file === undefined && place !== undefined
  );
  const readmeBody = readme.data?.path === readmePath ? readme.data : undefined;

  const entries = useMemo(() => {
    const all = listed?.entries ?? [];
    const q = filter.trim().toLowerCase();
    return q.length === 0 ? all : all.filter((e) => e.name.toLowerCase().includes(q));
  }, [listed, filter]);

  /**
   * 一覧をキーで辿る（§4.5）。行はどれも `<button>` なので、**焦点を動かすだけでよい**
   * ——Enter と Space はブラウザが押してくれる。当たりを別に持つと、見えている焦点と
   * 二重になる。
   */
  const rowsNow = (): HTMLButtonElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.fb-entry") ?? []);
  const focusRow = (index: number): void => {
    const rows = rowsNow();
    rows[Math.max(0, Math.min(index, rows.length - 1))]?.focus();
  };
  const onListKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing) return;
    const rows = rowsNow();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(at + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(at - 1);
    } else if (event.key === "ArrowLeft") {
      // 親へ。いちばん上なら何もしない（場所の外へは出ない）
      if (dir === ".") return;
      event.preventDefault();
      goDir(parentOf(dir));
    } else if (event.key === "ArrowRight") {
      const entry = at >= 0 ? entries[at] : undefined;
      if (entry?.type !== "dir") return;
      event.preventDefault();
      goDir(join(entry.name));
    }
  };

  const listPane = (
    <>
      {/* 絞ると探すは1つの欄（§4.3）。隠しは札（当たりが 21px しか無かった） */}
      <ViewBar className="fb-find">
        <SearchField
          value={filter}
          onChange={(next) => {
            setFilter(next);
            // 打ち直したら結果を畳んで、いまの一覧を絞る側へ戻る
            if (search) setSearch(undefined);
          }}
          onSubmit={(value) => void runSearch(value, searchMode)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusRow(0);
            }
          }}
          placeholder={
            // 300px の一覧に収まる長さにする。切れると肝心の「Enter で探す」が消える
            listed?.truncated === true ? "絞る／Enter で全部探す" : "絞る／Enter で探す"
          }
        />
        <Chip
          on={includeHidden}
          onClick={() => setIncludeHidden(!includeHidden)}
          title="ドット始まりのファイルや node_modules 等も対象にする"
          aria-label="隠しファイルも対象にする"
        >
          隠
        </Chip>
      </ViewBar>

      {openError !== undefined && (
        <ErrorNote title={`「${initialPath}」を開けませんでした`}>
          {openError}（いちばん上から表示しています）
        </ErrorNote>
      )}
      {listing.error && <ErrorNote onRetry={listing.reload}>{listing.error}</ErrorNote>}

      {/* 探した結果は一覧の代わりに出す。片付けると元の一覧へ戻る */}
      {search ? (
        <Scroll pad={false}>
          <div className="cv-sechead">
            <h3 className="cv-sechead-title">
              「{search.query}」<span className="cv-count">{search.hits.length}</span>
            </h3>
            <div className="cv-sechead-actions">
              {/* 探し方は**探したあとに**選ぶ。使う前に択一を出すと道具立てが1段増える */}
              <Segmented
                label="探し方"
                value={search.mode}
                onChange={(next) => {
                  setSearchMode(next);
                  void runSearch(search.query, next);
                }}
                options={[
                  { value: "content", label: "中身", title: "ファイルの中身を正規表現で探す（file.grep）" },
                  { value: "name", label: "名前", title: "ファイル名で探す（file.find）" },
                ]}
              />
              <Button
                small
                variant="ghost"
                onClick={() => {
                  setSearch(undefined);
                  setFilter("");
                }}
              >
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
                    onClick={() => openFile(hit.path, hit.line)}
                    title={hit.path}
                  >
                    <span className="fb-hit">
                      <span className="fb-hit-path">
                        {shortenPath(hit.path, 3)}
                        {hit.line !== undefined ? `:${hit.line}` : ""}
                      </span>
                      {hit.text !== undefined && (
                        <span className="fb-hit-text">
                          <HitText
                            text={hit.text.trim()}
                            query={search.query}
                            regex={search.mode === "content"}
                          />
                        </span>
                      )}
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
        <Scroll pad={false} ref={listRef}>
          {listed === undefined ? (
            <Loading rows={6} />
          ) : entries.length === 0 ? (
            <EmptyState icon="folder" title={filter ? "当てはまるものがありません" : "空のディレクトリです"}>
              {filter ? "Enter を押すと、この下を探します。" : "ここには何もありません。"}
            </EmptyState>
          ) : (
            /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- 行は
               それぞれ button。ここで受けるのは焦点の移動だけで、押すのはブラウザに任せる */
            <ul className="cv-list" onKeyDown={onListKeyDown}>
              {entries.map((entry) => (
                <li key={entry.name}>
                  <button
                    className={`fb-entry ${entry.type === "dir" ? "is-dir" : ""} ${
                      file === join(entry.name) ? "is-selected" : ""
                    }`}
                    onClick={() => {
                      if (entry.type === "dir") goDir(join(entry.name));
                      else openFile(join(entry.name));
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
              {listed.truncated && (
                <li className="cv-muted" style={{ padding: "8px 10px" }}>
                  … 件数の上限を超えたため一部のみ（全 {listed.total} 件）
                </li>
              )}
            </ul>
          )}
        </Scroll>
      )}
    </>
  );

  const detailPane = !file ? (
    readmeBody?.binary === false && readmeName !== undefined ? (
      <div className="fb-file">
        <div className="fb-file-head">
          <code className="fb-file-path">{readmeName}</code>
          <span className="cv-muted">この場所の案内</span>
          <span className="cv-spacer" />
          <button
            type="button"
            className="cv-btn is-small"
            onClick={() => readmePath !== undefined && openFile(readmePath)}
          >
            開く
          </button>
        </div>
        <div className="fb-body">
          <div className="fb-preview">
            <div className="markdown">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: (props) => (
                    <MarkdownCode {...props} scheme={scheme} onMermaidReady={bumpPreviewReady} />
                  ),
                  a: MarkdownLink,
                }}
              >
                {readmeBody.content ?? ""}
              </Markdown>
            </div>
          </div>
        </div>
      </div>
    ) : (
      // 置けるものが無いときは、面の中央に大きく構えない（上寄せの小さい案内）
      <div className="fb-empty-top">
        <EmptyState icon="file" title="ファイルを選ぶと中身が出ます">
          左の一覧から選ぶか、絞る欄で Enter を押すと中身を探せます。
        </EmptyState>
      </div>
    )
  ) : (
    <div className={`fb-file ${retracted ? "is-retracted" : ""}`}>
      {/* 頭は1段（§5.2）。戻る導線もここに入れる——独立した行にすると 41px 取られる */}
      <div className="fb-file-head">
        <button type="button" className="fb-back" onClick={() => setPane("list")}>
          <Icon name="chevron-left" size={14} /> 一覧
        </button>
        <code className="fb-file-path" title={file}>
          {shortenPath(file, 2)}
        </code>
        {previewable && kind !== "image" && (
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
        {/* HTML と画像は**ブラウザに任せた方が読める**ので、頭に直接出す（§5.8.4） */}
        {raw && rawHref !== undefined && (
          <a className="cv-btn is-small fb-open" href={rawHref} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} /> 別タブ
          </a>
        )}
        <IconButton label="そのほか" onClick={() => setMenuOpen(true)}>
          <Icon name="more" size={16} />
        </IconButton>
      </div>

      {menuOpen && (
        <FileMenu
          path={file}
          text={contentText}
          wrap={wrap}
          onWrap={(next) => setWrapChoice({ path: file, on: next })}
          showWrap={effectiveMode === "source"}
          rawHref={rawHref}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* 行を指されて開いたときは、そこに合わせていることを言う（§5.4） */}
      {lineFrom !== undefined && effectiveMode === "source" && (
        <div className="cv-note" style={{ margin: "8px 12px 0" }}>
          <span style={{ flex: 1 }}>{lineFrom} 行目に合わせています</span>
          {previewAllowed && (
            <button type="button" className="cv-btn is-small" onClick={() => switchMode("preview")}>
              整形で読む
            </button>
          )}
        </div>
      )}

      {(body?.truncated === true || (previewable && !raw && !previewAllowed)) && (
        // 読み切ったら警告色をやめる。見えていないものが無いのに注意を引き続けない
        <div
          className={`cv-note${body?.truncated === true && !hasMore && !partialLine ? "" : " is-warn"}`}
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

      {content.error && needsText ? (
        <ErrorNote onRetry={content.reload}>{content.error}</ErrorNote>
      ) : needsText && body === undefined ? (
        <Loading rows={5} />
      ) : body?.binary === true ? (
        <EmptyState icon="binary" title="バイナリのため表示できません">
          {formatBytes(body.size)} のファイルです。
          {rawHref !== undefined && (
            <>
              {" "}
              <a href={rawHref} target="_blank" rel="noreferrer">
                別タブで開く
              </a>
              {" · "}
              <a href={`${rawHref}?dl=1`} download>
                ダウンロード
              </a>
            </>
          )}
        </EmptyState>
      ) : (
        // 中身のスクロールは**この器だけ**が持つ（頭を退かせる判定も復元もここを見る）
        <div className="fb-body" ref={attachBody}>
          {effectiveMode === "preview" ? (
            <div className="fb-preview">
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
              {kind === "csv" && (
                <div className="fb-scrollx">
                  <CsvTable content={contentText} delimiter={csvDelimiter} />
                </div>
              )}
              {kind === "diff" && <DiffPreview content={contentText} />}
              {kind === "code" && <CodePreview content={contentText} lang={codeLang} scheme={scheme} />}
              {/* 隔離した枠（§5.8.3）。`allow-same-origin` は付けない——付けると
                  リポジトリの中の HTML が Banto のオリジンで動くスクリプトになる */}
              {kind === "html" && rawHref !== undefined && (
                <iframe
                  className="fb-frame"
                  src={rawHref}
                  sandbox="allow-scripts"
                  title={file}
                  referrerPolicy="no-referrer"
                />
              )}
              {kind === "image" && rawHref !== undefined && (
                <img className="fb-image" src={rawHref} alt={file} />
              )}
            </div>
          ) : (
            <CodeBody
              content={contentText}
              {...(lineFrom !== undefined ? { from: lineFrom } : {})}
              {...(lineTo !== undefined ? { to: lineTo } : {})}
              wrap={wrap}
              lang={codeLang}
              scheme={scheme}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <ViewShell className={`fb ${pane === "file" && file !== undefined ? "is-reading" : ""}`}>
      {/* どこを見ているか・どこへ戻れるか。**狭いときは読んでいる間だけ畳む**（§2.3） */}
      <ViewBar className="fb-where">
        <PlacePicker selection={selection} />
        <Breadcrumbs dir={dir} onGo={goDir} />
      </ViewBar>

      <SplitView
        size="md"
        list={listPane}
        detail={detailPane}
        showDetail={pane === "file" && file !== undefined}
      />
    </ViewShell>
  );
}
