import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { columnName, columnWidthPx, expandToMerges, indexAt, parseRange, rangeName, rangeValue, sheetView, visibleSheetNames, type XlsxWorkbook } from "./sheet.js";

// 画面と同じ読み手（SheetJS の mini を、画面と同じ設定で）
const require = createRequire(import.meta.url);
const reader = require("xlsx/dist/xlsx.mini.min.js") as { read(data: Buffer, o: object): XlsxWorkbook };
// 試験の表を作る側（書けるのは全部入りの方だけ）
const XLSX = require("xlsx") as {
  utils: {
    book_new(): unknown;
    aoa_to_sheet(rows: unknown[][]): Record<string, unknown>;
    book_append_sheet(book: unknown, sheet: unknown, name: string): void;
  };
  write(book: unknown, o: object): Buffer;
};

/** 3枚のシート（1枚は隠す）・数の書式・結合・列の幅・式の値（計算し直した写しと同じく、値が入っている） */
function workbook(): XlsxWorkbook {
  const book = XLSX.utils.book_new() as { Workbook?: { Sheets: Array<{ Hidden: number }> } };
  const sales = XLSX.utils.aoa_to_sheet([
    ["品目", "数量", "単価", "金額"],
    ["りんご", 12, 100, { t: "n", v: 1200, f: "B2*C2" }],
    ["みかん", 30, 45.5, { t: "n", v: 1365, f: "B3*C3" }],
    ["合計", null, null, { t: "n", v: 2565, f: "SUM(D2:D3)", z: "#,##0" }],
    [],
    ["結合したセル"],
  ]);
  (sales.C3 as { z?: string }).z = "0.00";
  sales["!merges"] = [{ s: { r: 5, c: 0 }, e: { r: 5, c: 3 } }];
  sales["!cols"] = [{ width: 20 }];
  sales["!rows"] = [undefined, { hpt: 30 }];
  XLSX.utils.book_append_sheet(book, sales, "売上");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["隠したシート"]]), "隠し");
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[{ t: "n", v: 0.4678, z: "0.0%" }, true, { t: "e", v: 7, w: "#DIV/0!" }]]), "集計");
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] };
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  return reader.read(bytes, { type: "buffer", dense: true, cellStyles: true, cellFormula: true, cellHTML: false });
}

test("表：隠したシートはタブに出さない", () => {
  assert.deepEqual(visibleSheetNames(workbook()), ["売上", "集計"]);
});

test("表：値は数の書式で書いた文字、式は = から、数は数・文字は文字", () => {
  const view = sheetView(workbook(), "売上");
  assert.deepEqual(view.cell(1, 3), { text: "1200", kind: "number", formula: "=B2*C2" });
  assert.deepEqual(view.cell(3, 3), { text: "2,565", kind: "number", formula: "=SUM(D2:D3)" });
  assert.equal(view.cell(2, 2)?.text, "45.50");
  assert.deepEqual(view.cell(0, 0), { text: "品目", kind: "text" });
  assert.equal(view.cell(4, 0), undefined);
  const summary = sheetView(workbook(), "集計");
  assert.deepEqual(summary.cell(0, 0), { text: "46.8%", kind: "number" });
  assert.equal(summary.cell(0, 1)?.kind, "boolean");
  assert.equal(summary.cell(0, 1)?.text, "TRUE");
  assert.deepEqual(summary.cell(0, 2), { text: "#DIV/0!", kind: "error" });
});

test("表：列の幅・行の高さ（px）と、中身の届くところまでの大きさ", () => {
  const view = sheetView(workbook(), "売上");
  assert.equal(view.rows, 6);
  assert.equal(view.cols, 4);
  assert.equal(view.colX[1], columnWidthPx(20));
  assert.equal(view.colX[2]! - view.colX[1]!, 64);
  assert.equal(view.rowY[1], 20);
  assert.equal(view.rowY[2]! - view.rowY[1]!, 40);
  assert.equal(columnWidthPx(9.140625), 64);
});

test("表：結合したセルは左上が全体を指し、選ぶと結合ごと広がる", () => {
  const view = sheetView(workbook(), "売上");
  const merge = view.mergeAt(5, 2);
  assert.ok(merge);
  assert.equal(rangeName(merge), "A6:D6");
  assert.equal(view.mergeAt(4, 2), undefined);
  assert.equal(rangeName(expandToMerges(view, { s: { r: 4, c: 1 }, e: { r: 5, c: 1 } })), "A5:D6");
  // 結合したセル1つを選んだら、その値
  assert.equal(rangeValue(view, merge), "結合したセル");
  assert.equal(rangeValue(view, { s: { r: 1, c: 3 }, e: { r: 2, c: 3 } }), "1200、1365");
});

test("表：番地の読み書きと、位置からの行・列", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(16383), "XFD");
  assert.deepEqual(parseRange("b4:d6"), { s: { r: 3, c: 1 }, e: { r: 5, c: 3 } });
  assert.deepEqual(parseRange("D6:B4"), { s: { r: 3, c: 1 }, e: { r: 5, c: 3 } });
  assert.deepEqual(parseRange("AA1"), { s: { r: 0, c: 26 }, e: { r: 0, c: 26 } });
  assert.equal(parseRange("売上!B4"), undefined);
  const edges = [0, 10, 30, 60];
  assert.equal(indexAt(edges, 0), 0);
  assert.equal(indexAt(edges, 9.9), 0);
  assert.equal(indexAt(edges, 10), 1);
  assert.equal(indexAt(edges, 59), 2);
  assert.equal(indexAt(edges, 1000), 2);
});
