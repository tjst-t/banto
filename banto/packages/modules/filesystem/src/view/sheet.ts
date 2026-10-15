// **表（xlsx）を画面に描くための形**（v4-modules.md §2.2「PDF・Office…」の xlsx、Backlog #306、2026-10-15）。
//
// 読むのは SheetJS（`XLSX.read`、画面では `globalThis.XLSX`）が返した workbook。ここはそれを、画面が描く形に直すだけ：
//   - シートの名前（隠したシートは出さない）
//   - セルの値は **SheetJS が数の書式で書いた文字（`w`）**——`#,##0`・`0.0%`・日付の書式もここで効く
//   - 列の幅・行の高さ（px）と、その積み上げ（見えている範囲を二分探索で引くため）
//   - 結合したセル（左上のセルが全体を描き、ほかは描かない）
//
// 値そのものは変換役（LibreOffice）が計算し直した写しに入っている（AI が openpyxl で作った xlsx には式の値が無い）。
// DOM に触らない（試験から直接読むため）。

/** SheetJS のセル（この画面が使うところだけ） */
export interface XlsxCell {
  /** 種類：n 数・s 文字・b 真偽・e エラー・d 日付・z 空 */
  t: string;
  v?: unknown;
  /** 書式で書いた文字 */
  w?: string;
  /** 式（頭の = は付かない） */
  f?: string;
}

export interface XlsxRange {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/** SheetJS のシート（`dense: true` で読んだもの） */
export interface XlsxSheet {
  "!data"?: Array<Array<XlsxCell | undefined> | undefined>;
  "!merges"?: XlsxRange[];
  "!cols"?: Array<{ width?: number; wpx?: number; hidden?: boolean } | undefined>;
  "!rows"?: Array<{ hpt?: number; hpx?: number; hidden?: boolean } | undefined>;
}

export interface XlsxWorkbook {
  SheetNames: string[];
  Sheets: Record<string, XlsxSheet>;
  Workbook?: { Sheets?: Array<{ name?: string; Hidden?: number }> };
}

/** 幅の指定が無い列（Excel の既定 8.43 字＝64px） */
export const DEFAULT_COL_PX = 64;
/** 高さの指定が無い行（Excel の既定 15pt＝20px） */
export const DEFAULT_ROW_PX = 20;
/** 文字の幅の単位（Excel の Calibri 11 の「数字1字」の幅）。ファイルの列の幅は字数で書かれている */
const MAX_DIGIT_PX = 7;

export type CellKind = "number" | "text" | "boolean" | "error" | "empty";

export interface CellView {
  text: string;
  kind: CellKind;
  /** 式（`=` から） */
  formula?: string;
}

export interface SheetView {
  name: string;
  /** 描く行・列の数（中身と結合の届くところまで。`!ref` は信じない——空の書式だけの行が百万行あることがある） */
  rows: number;
  cols: number;
  /** 列の左端の位置（px）。長さ cols+1、最後が全体の幅 */
  colX: number[];
  /** 行の上端の位置（px）。長さ rows+1、最後が全体の高さ */
  rowY: number[];
  merges: XlsxRange[];
  cell(r: number, c: number): CellView | undefined;
  /** そのセルを覆っている結合（左上を含む）。無ければ undefined */
  mergeAt(r: number, c: number): XlsxRange | undefined;
}

/** 列の番号（0 から）→ A・B…・Z・AA… */
export function columnName(c: number): string {
  let name = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** セルの番地（`B4`）、範囲なら `B4:D6` */
export function rangeName(range: XlsxRange): string {
  const a = `${columnName(range.s.c)}${range.s.r + 1}`;
  const b = `${columnName(range.e.c)}${range.e.r + 1}`;
  return a === b ? a : `${a}:${b}`;
}

/** 番地（`B4`・`B4:D6`）→ 範囲。読めなければ undefined */
export function parseRange(text: string): XlsxRange | undefined {
  const cell = (s: string) => {
    const m = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(s);
    if (!m) return undefined;
    const c = [...m[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    return { r: Number(m[2]) - 1, c };
  };
  const [a, b = a] = text.toUpperCase().split(":");
  const s = cell(a ?? "");
  const e = cell(b ?? "");
  if (!s || !e) return undefined;
  return { s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) }, e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) } };
}

/** ファイルの列の幅（字数）→ px（ECMA-376 の式。字数は余白込みで書かれている） */
export function columnWidthPx(width: number): number {
  return Math.max(0, Math.trunc(((256 * width + Math.trunc(128 / MAX_DIGIT_PX)) / 256) * MAX_DIGIT_PX));
}

function cellKind(cell: XlsxCell): CellKind {
  switch (cell.t) {
    case "n":
    case "d":
      return "number";
    case "b":
      return "boolean";
    case "e":
      return "error";
    case "z":
      return "empty";
    default:
      return "text";
  }
}

function cellView(cell: XlsxCell | undefined): CellView | undefined {
  if (!cell) return undefined;
  const kind = cellKind(cell);
  const text = cell.w ?? (cell.v === undefined || cell.v === null ? "" : String(cell.v));
  if (kind === "empty" && !cell.f) return undefined;
  return { text, kind, ...(cell.f ? { formula: `=${cell.f}` } : {}) };
}

/** 積み上げ（先頭 0、長さ n+1） */
function prefix(sizes: number[]): number[] {
  const out = [0];
  for (const s of sizes) out.push(out[out.length - 1]! + s);
  return out;
}

/** 隠していないシートの名前（並びはファイルのまま） */
export function visibleSheetNames(book: XlsxWorkbook): string[] {
  const meta = book.Workbook?.Sheets ?? [];
  return book.SheetNames.filter((name, i) => !(meta[i]?.Hidden ?? 0));
}

export function sheetView(book: XlsxWorkbook, name: string): SheetView {
  const sheet = book.Sheets[name];
  if (!sheet) throw new Error(`シート「${name}」がありません`);
  const data = sheet["!data"] ?? [];
  const merges = sheet["!merges"] ?? [];

  // 中身のある最後の行・列（結合の届くところも）
  let rows = 0;
  let cols = 0;
  data.forEach((row, r) => {
    if (!row) return;
    row.forEach((cell, c) => {
      if (!cellView(cell)) return;
      rows = Math.max(rows, r + 1);
      cols = Math.max(cols, c + 1);
    });
  });
  for (const m of merges) {
    rows = Math.max(rows, m.e.r + 1);
    cols = Math.max(cols, m.e.c + 1);
  }

  const colSpec = sheet["!cols"] ?? [];
  const rowSpec = sheet["!rows"] ?? [];
  const colWidths = Array.from({ length: cols }, (_, c) => {
    const spec = colSpec[c];
    if (spec?.hidden) return 0;
    if (typeof spec?.width === "number") return columnWidthPx(spec.width);
    if (typeof spec?.wpx === "number") return spec.wpx;
    return DEFAULT_COL_PX;
  });
  const rowHeights = Array.from({ length: rows }, (_, r) => {
    const spec = rowSpec[r];
    if (spec?.hidden) return 0;
    // SheetJS の hpx は 1pt＝1px で数えていることがあるので、pt から直す
    if (typeof spec?.hpt === "number") return Math.round((spec.hpt * 96) / 72);
    if (typeof spec?.hpx === "number") return spec.hpx;
    return DEFAULT_ROW_PX;
  });

  // 結合に覆われたセル → その結合（左上も含む）
  const covered = new Map<number, XlsxRange>();
  const key = (r: number, c: number) => r * 16384 + c;
  for (const m of merges) {
    for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) covered.set(key(r, c), m);
  }

  return {
    name,
    rows,
    cols,
    colX: prefix(colWidths),
    rowY: prefix(rowHeights),
    merges,
    cell: (r, c) => cellView(data[r]?.[c]),
    mergeAt: (r, c) => covered.get(key(r, c)),
  };
}

/** 積み上げ `edges` の中で、位置 `x` を含む区間の番号（範囲の外は端に寄せる） */
export function indexAt(edges: readonly number[], x: number): number {
  let lo = 0;
  let hi = edges.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid]! <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 範囲を、掛かっている結合をすべて含むまで広げる（Excel と同じ選び方） */
export function expandToMerges(view: SheetView, range: XlsxRange): XlsxRange {
  const out = { s: { ...range.s }, e: { ...range.e } };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of view.merges) {
      const overlaps = m.s.r <= out.e.r && m.e.r >= out.s.r && m.s.c <= out.e.c && m.e.c >= out.s.c;
      if (!overlaps) continue;
      if (m.s.r < out.s.r || m.s.c < out.s.c || m.e.r > out.e.r || m.e.c > out.e.c) {
        out.s.r = Math.min(out.s.r, m.s.r);
        out.s.c = Math.min(out.s.c, m.s.c);
        out.e.r = Math.max(out.e.r, m.e.r);
        out.e.c = Math.max(out.e.c, m.e.c);
        changed = true;
      }
    }
  }
  return out;
}

/** コメントに添える値の上限（FileSystem の `value` は 2,000 字まで） */
const VALUE_MAX_CHARS = 2000;
const VALUE_MAX_CELLS = 100;

/**
 * **コメントに添える値**（計算し直した値、書式のまま）。1つのセルならその値、範囲なら中身のあるセルの値を「、」で
 * つないだもの。多すぎる・長すぎるなら付けない（番地で指せば足りる）
 */
export function rangeValue(view: SheetView, range: XlsxRange): string | undefined {
  const cells = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1);
  const merged = view.mergeAt(range.s.r, range.s.c);
  const single = cells === 1 || (merged && merged.s.r === range.s.r && merged.s.c === range.s.c && merged.e.r === range.e.r && merged.e.c === range.e.c);
  if (single) return view.cell(range.s.r, range.s.c)?.text;
  if (cells > VALUE_MAX_CELLS) return undefined;
  const values: string[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    for (let c = range.s.c; c <= range.e.c; c++) {
      const text = view.cell(r, c)?.text;
      if (text) values.push(text);
    }
  }
  const joined = values.join("、");
  return joined && joined.length <= VALUE_MAX_CHARS ? joined : undefined;
}
