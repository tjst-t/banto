// **表（xlsx）をシートごとの CSV 相当にする**（AI 向けの `readDocument`、v4-modules.md §2.2「AI の側」、Backlog #308）。
//
// 読むのは**変換役で計算し直した写し**（式の値が入っている——AI が Python 等で作った xlsx には値が無い）。写しは
// LibreOffice が書き出した xlsx なので、形は決まっている：`xl/workbook.xml` のシートの名前と順、`_rels` で引く
// シートの XML、`sharedStrings.xml`。依存は足さない（zip は既にある fflate、XML は要る要素だけを拾う）。
//
// 値は**セルに入っている値そのもの**（数の書式は当てない——日付は通し番号のまま）。結合したセルは左上にだけ値がある

import { strFromU8, unzipSync } from "fflate";

export interface SheetText {
  name: string;
  csv: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decodeXml(m[1]!) : undefined;
}

/** `<t>` の中身をつなぐ（読み仮名 `<rPh>` は除く） */
function textOf(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]!)).join("");
}

/** `B12` → 列の番号（0 から）と行の番号（1 から） */
function cellRef(ref: string): { col: number; row: number } | undefined {
  const m = ref.match(/^([A-Z]+)([0-9]+)$/);
  if (!m) return undefined;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function sheetCsv(xml: string, shared: string[]): string {
  const rows = new Map<number, string[]>();
  let maxRow = 0;
  let maxCol = 0;
  let nextRow = 1;
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(attr(rowMatch[1]!, "r") ?? nextRow);
    nextRow = rowNo + 1;
    let nextCol = 0;
    for (const c of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = c[1]!;
      const ref = attr(tag, "r");
      const col = ref ? (cellRef(ref)?.col ?? nextCol) : nextCol;
      nextCol = col + 1;
      const inner = c[2] ?? "";
      const type = attr(tag, "t");
      const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value: string;
      if (type === "s") value = v !== undefined ? (shared[Number(v)] ?? "") : "";
      else if (type === "inlineStr") value = textOf(inner);
      else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else value = v !== undefined ? decodeXml(v) : "";
      if (value === "") continue;
      const cells = rows.get(rowNo) ?? [];
      cells[col] = value;
      rows.set(rowNo, cells);
      maxRow = Math.max(maxRow, rowNo);
      maxCol = Math.max(maxCol, col + 1);
    }
  }
  const lines: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const cells = rows.get(r) ?? [];
    const fields = Array.from({ length: maxCol }, (_, i) => csvField(cells[i] ?? ""));
    lines.push(fields.join(",").replace(/,+$/, ""));
  }
  return lines.join("\n");
}

/** xlsx の中身 → シートごとの CSV（シートの順は workbook.xml の順） */
export function spreadsheetToCsv(xlsx: Buffer): SheetText[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(xlsx));
  } catch (err) {
    throw new Error(`表を読めません（xlsx として開けない）: ${err instanceof Error ? err.message : String(err)}`);
  }
  const read = (path: string) => (files[path] ? strFromU8(files[path]!) : undefined);
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("表を読めません（xl/workbook.xml がありません）");
  const targets = new Map<string, string>();
  for (const m of (read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id");
    const target = attr(m[1]!, "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  return [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const name = attr(m[1]!, "name") ?? "";
    const target = targets.get(attr(m[1]!, "r:id") ?? "");
    const xml = target ? read(target) : undefined;
    if (xml === undefined) throw new Error(`表を読めません（シート「${name}」の中身がありません）`);
    return { name, csv: sheetCsv(xml, shared) };
  });
}
