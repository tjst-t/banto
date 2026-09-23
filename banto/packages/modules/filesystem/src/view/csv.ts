// CSV / TSV を表として読み書きする（RFC 4180）。
//
// **引用符の中の区切り・改行・二重引用符を正しく扱う**——モックの簡易版
// （`split(",")`）では、引用符つきのセルを1つでも含むファイルを保存すると
// 中身が壊れる。表の編集は「読んで、セルを変えて、書き戻す」なので、
// 書き戻しの形（改行コード・末尾の改行）も元に合わせる。
//
// DOM に触らない（試験から直接読むため）。

export interface CsvDocument {
  rows: string[][];
  /** 元の改行コード（書き戻しで変えない） */
  eol: "\n" | "\r\n";
  /** 元が改行で終わっていたか */
  trailingNewline: boolean;
}

export function parseCsv(source: string, delimiter: string = ","): CsvDocument {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  // 行の区切りを見たか（空のファイルに空の行を1つ作らないため）
  let sawAny = false;

  while (i < source.length) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      sawAny = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      sawAny = true;
      i++;
      continue;
    }
    if (c === "\r" && source[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
      i += 2;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
      i++;
      continue;
    }
    field += c;
    sawAny = true;
    i++;
  }
  if (sawAny || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const trailingNewline = source.endsWith("\n");
  return { rows, eol, trailingNewline };
}

function quoteField(value: string, delimiter: string): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function serializeCsv(doc: CsvDocument, delimiter: string = ","): string {
  const body = doc.rows.map((row) => row.map((v) => quoteField(v, delimiter)).join(delimiter)).join(doc.eol);
  return doc.trailingNewline && doc.rows.length > 0 ? body + doc.eol : body;
}

/** 表として並べるときの列数（行ごとに長さが違っても揃えて描く）。 */
export function columnCount(rows: readonly (readonly string[])[]): number {
  return rows.reduce((max, r) => Math.max(max, r.length), 0);
}
