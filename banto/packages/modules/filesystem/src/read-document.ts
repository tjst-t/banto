// **AI 向けの `readDocument`**（決定・2026-10-15、v4-modules.md §2.2「PDF・Office のファイルを読んでコメントを返す」の
// 「AI の側」、Backlog #308）。
//
// `readFile` で PDF・Office を読むと base64 が返るだけで、AI は中身を読めない（`readFile` の形は変えない）。コメントの
// 「3ページ」を AI が確かめられるよう、**ページごとの文字**と、`asImage` なら**ページの絵**を返す。
//
// - **PDF の文字はここ（pdf.js の Node 版）で取り出す**——変換役を通さないので 7MB を超える PDF も読める
// - Office の文書（docx・pptx・doc・ppt・odt・odp）は人の画面と同じ変換役・同じ置き場で PDF にしてから同じように読む
// - 表（xlsx・xlsm・xls・ods）は「ページ」＝シート。変換役で計算し直した写しをシートごとの CSV 相当にする。絵は表を
//   PDF にしたときのページ
// - ページの絵は変換役（pdftoppm）が描く。変換役に渡せるのは 7MB まで
// - **上限**：1回 20 ページまで・文字は 200,000 字まで・絵は合計 10MB まで（`images/store.ts` の1枚の上限と揃える）。
//   超えたら切って、続きのページを示す

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  CONVERTIBLE_EXTENSIONS,
  ConverterPreparingError,
  SPREADSHEET_EXTENSIONS,
  extensionOf,
  type DocumentConversions,
} from "./converted.js";
import { spreadsheetToCsv } from "./spreadsheet-text.js";

export const READ_DOCUMENT_MAX_PAGES = 20;
export const READ_DOCUMENT_MAX_CHARS = 200_000;
export const READ_DOCUMENT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const READ_DOCUMENT_PREPARING_MESSAGE = "変換役を入れています（初回だけ、数分）。あとでもう一度呼んでください";

const SLIDE_EXTENSIONS = ["pptx", "ppt", "odp"];

export type DocumentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * `pages` の引数（`"3"`・`"2-5"`・`"1,4,6-8"`）→ ページの番号（1 から、重ねず昇順）。無ければ undefined
 */
export function parsePages(v: unknown): number[] | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") throw new Error(`pages は "3"・"2-5"・"1,4,6-8" の形の文字列です: ${JSON.stringify(v)}`);
  const pages = new Set<number>();
  for (const part of v.split(",").map((s) => s.trim())) {
    const m = part.match(/^([0-9]+)(?:\s*-\s*([0-9]+))?$/);
    const from = m ? Number(m[1]) : NaN;
    const to = m?.[2] !== undefined ? Number(m[2]) : from;
    if (!m || from < 1 || to < from) throw new Error(`pages は "3"・"2-5"・"1,4,6-8" の形の文字列です（1 から数える）: ${v}`);
    if (to - from >= READ_DOCUMENT_MAX_PAGES) throw new Error(`1回に読めるのは ${READ_DOCUMENT_MAX_PAGES} ページまでです: ${v}`);
    for (let p = from; p <= to; p++) pages.add(p);
  }
  if (pages.size > READ_DOCUMENT_MAX_PAGES) throw new Error(`1回に読めるのは ${READ_DOCUMENT_MAX_PAGES} ページまでです: ${v}`);
  return [...pages].sort((a, b) => a - b);
}

/** ページの番号の並び → `"4-6,9"` */
export function formatPages(pages: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    parts.push(j === i ? String(pages[i]) : `${pages[i]}-${pages[j]}`);
    i = j;
  }
  return parts.join(",");
}

// ---- pdf.js（Node 版）で文字を取り出す ----

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Promise<PdfjsModule> | undefined;
let pdfjsDir: string | undefined;

/** pdf.js で開いた PDF。終わったら `close` */
interface OpenedPdf {
  numPages: number;
  pageText(page: number): Promise<string>;
  close(): Promise<void>;
}

async function openPdf(data: Buffer): Promise<OpenedPdf> {
  pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const lib = await pdfjs;
  pdfjsDir ??= dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  // 日本語の CMap・標準フォントは pdfjs-dist に入っているものをファイルで読ませる（画面と同じもの）。WASM は使わない。
  // 中身は写しを渡す——pdf.js は受けた ArrayBuffer を手放させることがあり、呼び元はこの後も同じ中身を変換役に渡す
  const task = lib.getDocument({
    data: new Uint8Array(data),
    cMapUrl: join(pdfjsDir, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(pdfjsDir, "standard_fonts") + "/",
    useWasm: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy();
    throw new Error(`PDF を開けません: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    numPages: doc.numPages,
    async pageText(page) {
      const content = await (await doc.getPage(page)).getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      return text.trim();
    },
    close: () => task.destroy(),
  };
}

// ---- 本体 ----

type Kind = "pdf" | "office" | "spreadsheet";

function kindOf(extension: string): Kind {
  if (extension === "pdf") return "pdf";
  if ((SPREADSHEET_EXTENSIONS as readonly string[]).includes(extension)) return "spreadsheet";
  if ((CONVERTIBLE_EXTENSIONS as readonly string[]).includes(extension)) return "office";
  throw new Error(
    `readDocument が読めるのは PDF と Office の文書（${["pdf", ...CONVERTIBLE_EXTENSIONS].join("・")}）だけです。` +
      `ほかのファイルは readFile で読んでください: ${extension || "拡張子の無いファイル"}`,
  );
}

class Preparing extends Error {}

/** 変換役の「用意している途中」を AI 向けの文に言い換えるための印に変える */
async function unlessPreparing<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ConverterPreparingError) throw new Preparing();
    throw err;
  }
}

/** 変換したもの（置き場）を読む。変換役を入れている途中なら `Preparing` */
async function convertedBytes(conversions: DocumentConversions, abs: string, target: "pdf" | "spreadsheet"): Promise<Buffer> {
  const outcome = await unlessPreparing(conversions.convert(abs, target));
  if (outcome.status === "preparing") throw new Preparing();
  return readFile(await conversions.convertedPath(abs, target));
}

/** 読むページを決める。何も指していなければ 1 から 20 ページまで */
function choosePages(requested: number[] | undefined, total: number, unit: string): { pages: number[]; rest: number[] } {
  if (total === 0) return { pages: [], rest: [] };
  if (!requested) {
    const pages = Array.from({ length: Math.min(total, READ_DOCUMENT_MAX_PAGES) }, (_, i) => i + 1);
    const rest = total > READ_DOCUMENT_MAX_PAGES ? Array.from({ length: total - READ_DOCUMENT_MAX_PAGES }, (_, i) => i + READ_DOCUMENT_MAX_PAGES + 1) : [];
    return { pages, rest };
  }
  const pages = requested.filter((p) => p <= total);
  if (pages.length === 0) throw new Error(`全 ${total} ${unit}です。1〜${total} の中で指してください`);
  return { pages, rest: [] };
}

export interface ReadDocumentOptions {
  pages?: number[];
  asImage?: boolean;
}

/**
 * `readDocument` の本体。返すのは MCP の content block の並び（見出しの文、ページごとの文、または見出しと絵）。
 * 変換役を入れている途中なら、その文を1つだけ返す
 */
export async function readDocument(
  abs: string,
  rel: string,
  options: ReadDocumentOptions,
  conversions: DocumentConversions | undefined,
): Promise<DocumentBlock[]> {
  const extension = extensionOf(abs);
  const kind = kindOf(extension);
  const needConversions = () => {
    if (!conversions) throw new Error("変換役に繋がっていません（banto の中継・Module の置き場が渡されていません）");
    return conversions;
  };
  try {
    if (kind === "spreadsheet" && !options.asImage) return await readSheets(abs, rel, options.pages, needConversions());
    const pdf = kind === "pdf" ? await readFile(abs) : await convertedBytes(needConversions(), abs, "pdf");
    const unit = SLIDE_EXTENSIONS.includes(extension) ? "スライド" : "ページ";
    const what = kind === "pdf" ? "PDF" : `${extension} を PDF にしたもの`;
    const opened = await openPdf(pdf);
    try {
      const { pages, rest } = choosePages(options.pages, opened.numPages, unit);
      const header = `${rel}（${what}・全 ${opened.numPages} ${unit}）`;
      return options.asImage
        ? await pageImages(header, unit, pages, rest, pdf, needConversions())
        : await pageTexts(header, unit, pages, rest, opened);
    } finally {
      await opened.close();
    }
  } catch (err) {
    if (err instanceof Preparing) return [{ type: "text", text: READ_DOCUMENT_PREPARING_MESSAGE }];
    throw err;
  }
}

function continuation(rest: readonly number[], why: string): string {
  return rest.length > 0 ? `\n（${why}。続きは pages: "${formatPages(rest)}"）` : "";
}

/** ページごとの文字。200,000 字を超えたら、そのページの前で切る（最初のページだけで超えたら、そのページを切る） */
async function pageTexts(header: string, unit: string, pages: number[], rest: number[], pdf: OpenedPdf): Promise<DocumentBlock[]> {
  let text = header;
  let used = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    let body = await pdf.pageText(page);
    if (used + body.length > READ_DOCUMENT_MAX_CHARS) {
      if (i > 0) {
        text += continuation([...pages.slice(i), ...rest], `${READ_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} 字までで切りました`);
        return [{ type: "text", text }];
      }
      body = `${body.slice(0, READ_DOCUMENT_MAX_CHARS)}\n（${unit} ${page} は ${READ_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} 字で切りました）`;
    }
    used += body.length;
    text += `\n\n=== ${unit} ${page} ===\n${body || "（文字がありません。絵は asImage: true で見られます）"}`;
  }
  text += continuation(rest, `1回 ${READ_DOCUMENT_MAX_PAGES} ${unit}まで`);
  return [{ type: "text", text }];
}

/** ページの絵。合計 10MB を超えたら、そのページの前で切る */
async function pageImages(
  header: string,
  unit: string,
  pages: number[],
  rest: number[],
  pdf: Buffer,
  conversions: DocumentConversions,
): Promise<DocumentBlock[]> {
  const blocks: DocumentBlock[] = [{ type: "text", text: header }];
  let bytes = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    const image = await unlessPreparing(conversions.renderPage(pdf, page));
    if (bytes + image.data.length > READ_DOCUMENT_MAX_IMAGE_BYTES) {
      blocks.push({ type: "text", text: continuation([...pages.slice(i), ...rest], "絵は合計 10MB までで切りました").trim() });
      return blocks;
    }
    bytes += image.data.length;
    blocks.push({ type: "text", text: `=== ${unit} ${page} ===` });
    blocks.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
  }
  const tail = continuation(rest, `1回 ${READ_DOCUMENT_MAX_PAGES} ${unit}まで`).trim();
  if (tail) blocks.push({ type: "text", text: tail });
  return blocks;
}

/** 表：シートごとの CSV 相当（計算し直した写しから） */
async function readSheets(abs: string, rel: string, requested: number[] | undefined, conversions: DocumentConversions): Promise<DocumentBlock[]> {
  const sheets = spreadsheetToCsv(await convertedBytes(conversions, abs, "spreadsheet"));
  const { pages, rest } = choosePages(requested, sheets.length, "シート");
  let text =
    `${rel}（表・全 ${sheets.length} シート：${sheets.map((s, i) => `${i + 1}「${s.name}」`).join("・")}）\n` +
    "値は LibreOffice で計算し直したもの（Excel と違うことがある）。数の書式は当てていない（日付は通し番号のまま）";
  let used = 0;
  for (let i = 0; i < pages.length; i++) {
    const n = pages[i]!;
    const sheet = sheets[n - 1]!;
    let body = sheet.csv;
    if (used + body.length > READ_DOCUMENT_MAX_CHARS) {
      if (i > 0) {
        text += continuation([...pages.slice(i), ...rest], `${READ_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} 字までで切りました`);
        return [{ type: "text", text }];
      }
      body = `${body.slice(0, READ_DOCUMENT_MAX_CHARS)}\n（シート ${n} は ${READ_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} 字で切りました）`;
    }
    used += body.length;
    text += `\n\n=== シート ${n}「${sheet.name}」 ===\n${body || "（空です）"}`;
  }
  text += continuation(rest, `1回 ${READ_DOCUMENT_MAX_PAGES} シートまで`);
  return [{ type: "text", text }];
}
