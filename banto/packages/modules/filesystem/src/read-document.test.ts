import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConvertedStore, ConverterPreparingError, DocumentConversions, type Converter, type ConvertTarget } from "./converted.js";
import { INSTALLING_MESSAGE } from "./relay-converter.js";
import { READ_DOCUMENT_PREPARING_MESSAGE, formatPages, parsePages } from "./read-document.js";
import { spreadsheetToCsv } from "./spreadsheet-text.js";
import { createFileSystemServer } from "./server.js";

// ---- 試験の文書（依存を足さず、形をそのまま書く）----

function utf16beHex(text: string): string {
  return [...text].map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, "0")).join("").toUpperCase();
}

/**
 * ページごとの行を書いた PDF。日本語は埋め込まないフォント（Adobe-Japan1、`UniJIS-UCS2-H`）——読むには pdf.js 同梱の
 * CMap が要る（ファイルで読ませていることの確かめ）
 */
function makePdf(pages: string[][]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (s: string) => {
    const b = Buffer.from(s, "latin1");
    chunks.push(b);
    length += b.length;
  };
  const object = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push("%PDF-1.7\n");
  const first = 5;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${first + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  object(3, "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [4 0 R] >>");
  object(4, "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /DW 1000 >>");
  pages.forEach((lines, i) => {
    const page = first + i * 2;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const ops = lines.map((line, j) => `BT /F1 14 Tf 60 ${770 - j * 36} Td <${utf16beHex(line)}> Tj ET`).join("\n");
    object(page + 1, `<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
  });
  const total = first + pages.length * 2;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** LibreOffice が書き出すのと同じ形の xlsx（共有の文字列・インラインの文字列・式の値・真偽） */
function makeXlsx(): Buffer {
  const files: Record<string, string> = {
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="売上" sheetId="1" state="visible" r:id="rId2"/><sheet name="メモ &amp; 注" sheetId="2" state="visible" r:id="rId3"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="…/styles" Target="styles.xml"/><Relationship Id="rId2" Type="…/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId3" Type="…/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
    "xl/sharedStrings.xml":
      '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
      "<si><t>品目</t></si><si><t>単価</t></si><si><r><t>りん</t></r><r><t>ご</t></r></si><si><t>a,b \"c\"</t></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="str"><f>"合計"</f><v>合計</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="1"><v>120</v></c><c r="C2"><f>B2*10</f><v>1200</v></c></row>' +
      '<row r="4"><c r="A4" t="s"><v>3</v></c><c r="D4" t="b"><v>1</v></c></row></sheetData></worksheet>',
    "xl/worksheets/sheet2.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      '<row r="1"><c r="B1" t="inlineStr"><is><t>改行\nあり</t></is></c></row></sheetData></worksheet>',
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
}

const D1 = { version: "lo 24.2; recipe 1", fonts: "f1" };

/** 偽の変換役：docx・pptx・xlsx を決めた PDF に、表を計算し直した xlsx に、PDF のページを「絵」にする */
function fakeConverter(pdfs: Record<string, Buffer>, opts: { preparing?: boolean; imageBytes?: number } = {}) {
  const calls: Array<{ kind: ConvertTarget | "renderPage"; extension?: string; page?: number; bytes: number }> = [];
  const converter: Converter = {
    async describe() {
      if (opts.preparing) throw new ConverterPreparingError(INSTALLING_MESSAGE);
      return D1;
    },
    async convert(target, extension, data) {
      calls.push({ kind: target, extension, bytes: data.length });
      if (opts.preparing) throw new ConverterPreparingError(INSTALLING_MESSAGE);
      const out = target === "spreadsheet" ? makeXlsx() : pdfs[extension];
      if (!out) throw new Error(`試験の変換役は ${extension} を知らない`);
      return { data: out, converter: D1, ms: 3 };
    },
    async renderPage(pdf, page) {
      calls.push({ kind: "renderPage", page, bytes: pdf.length });
      const data = Buffer.alloc(opts.imageBytes ?? 16, 0);
      data.write(`png:${page}`);
      return { data, mimeType: "image/png" };
    },
  };
  return { converter, calls };
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function withServer(
  converter: Converter | undefined,
  fn: (call: (args: Record<string, unknown>) => Promise<Block[]>, root: string, client: Client) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "banto-readdoc-root-"));
  const data = await mkdtemp(join(tmpdir(), "banto-readdoc-data-"));
  const server = createFileSystemServer({
    projectRoot: root,
    ...(converter ? { conversions: new DocumentConversions(new ConvertedStore(join(data, "converted")), converter) } : {}),
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    await fn(async (args) => {
      // client.callTool は結果を CallToolResultSchema で検査する——image の形が違えばここで落ちる
      const r = await client.callTool({ name: "readDocument", arguments: args });
      if (r.isError) throw new Error((r.content as Block[])[0]?.text);
      return r.content as Block[];
    }, root, client);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

const textOf = (blocks: Block[]) => blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");

// ---- 引数 ----

test("pages は \"3\"・\"2-5\"・\"1,4,6-8\" を受け、21 ページ以上・0・逆向きは断る", () => {
  assert.equal(parsePages(undefined), undefined);
  assert.deepEqual(parsePages("3"), [3]);
  assert.deepEqual(parsePages(3), [3]);
  assert.deepEqual(parsePages("6-8, 1,4,7"), [1, 4, 6, 7, 8]);
  assert.throws(() => parsePages("1-21"), /20 ページまで/);
  assert.throws(() => parsePages("1-15,30-40"), /20 ページまで/);
  assert.throws(() => parsePages("0"), /1 から数える/);
  assert.throws(() => parsePages("5-2"), /1 から数える/);
  assert.throws(() => parsePages("三"), /の形の文字列/);
  assert.equal(formatPages([4, 5, 6, 9, 11, 12]), "4-6,9,11-12");
});

// ---- PDF ----

test("readDocument は AI に見える。readFile の形はそのまま（PDF は base64 の resource）", async () => {
  await withServer(undefined, async (_call, root, client) => {
    await writeFile(join(root, "a.pdf"), makePdf([["one"]]));
    const { tools } = await client.listTools();
    assert.equal(tools.find((t) => t.name === "readDocument")?._meta?.["dev.banto/visibility"], "agent");
    const read = await client.callTool({ name: "readFile", arguments: { path: "a.pdf" } });
    assert.equal((read.content as { type: string }[])[0]!.type, "resource");
  });
});

test("PDF：指したページの文字を返す（日本語も。変換役に繋がっていなくても読める）", async () => {
  await withServer(undefined, async (call, root) => {
    await writeFile(join(root, "plan.pdf"), makePdf([["受信箱の見直しについて", "二行目"], ["二ページ目の本文"], ["三ページ目の結論"]]));
    const all = textOf(await call({ path: "plan.pdf" }));
    assert.match(all, /^plan\.pdf（PDF・全 3 ページ）/);
    assert.match(all, /=== ページ 1 ===\n受信箱の見直しについて\n二行目/);
    assert.match(all, /=== ページ 3 ===\n三ページ目の結論/);
    const one = textOf(await call({ path: join(root, "plan.pdf"), pages: "3" }));
    assert.match(one, /=== ページ 3 ===\n三ページ目の結論/);
    assert.doesNotMatch(one, /受信箱/);
    await assert.rejects(call({ path: "plan.pdf", pages: "9" }), /全 3 ページです/);
    await assert.rejects(call({ path: "../plan.pdf" }), /根の外/);
  });
});

test("PDF：何も指さなければ 20 ページまで読み、続きのページを示す", async () => {
  await withServer(undefined, async (call, root) => {
    await writeFile(join(root, "long.pdf"), makePdf(Array.from({ length: 23 }, (_, i) => [`page${i + 1}`])));
    const t = textOf(await call({ path: "long.pdf" }));
    assert.match(t, /全 23 ページ/);
    assert.match(t, /=== ページ 20 ===\npage20/);
    assert.doesNotMatch(t, /=== ページ 21 ===/);
    assert.match(t, /続きは pages: "21-23"/);
  });
});

test("PDF の絵：指したページを変換役に描かせ、image で返す", async () => {
  const fake = fakeConverter({});
  await withServer(fake.converter, async (call, root) => {
    const pdf = makePdf([["a"], ["b"], ["c"]]);
    await writeFile(join(root, "plan.pdf"), pdf);
    const blocks = await call({ path: "plan.pdf", pages: "1,3", asImage: true });
    assert.deepEqual(
      blocks.map((b) => (b.type === "image" ? `image ${b.mimeType} ${Buffer.from(b.data!, "base64").toString().replace(/\0+$/, "")}` : b.text)),
      ["plan.pdf（PDF・全 3 ページ）", "=== ページ 1 ===", "image image/png png:1", "=== ページ 3 ===", "image image/png png:3"],
    );
    // 渡したのは元の PDF そのもの（pdf.js に読ませた後でも中身が欠けていない）
    assert.deepEqual(fake.calls, [
      { kind: "renderPage", page: 1, bytes: pdf.length },
      { kind: "renderPage", page: 3, bytes: pdf.length },
    ]);
  });
});

test("絵は合計 10MB までで切り、続きのページを示す", async () => {
  const fake = fakeConverter({}, { imageBytes: 4 * 1024 * 1024 });
  await withServer(fake.converter, async (call, root) => {
    await writeFile(join(root, "plan.pdf"), makePdf([["a"], ["b"], ["c"], ["d"]]));
    const blocks = await call({ path: "plan.pdf", asImage: true });
    assert.equal(blocks.filter((b) => b.type === "image").length, 2);
    assert.match(textOf(blocks), /10MB までで切りました。続きは pages: "3-4"/);
  });
});

// ---- Office ----

test("docx・pptx：変換役で PDF にしたもの（置き場に残る）のページの文字と絵。pptx はスライドで数える", async () => {
  const fake = fakeConverter({
    docx: makePdf([["第一章"], ["第二章の本文"]]),
    pptx: makePdf([["表紙のスライド"], ["二枚目のスライド"]]),
  });
  await withServer(fake.converter, async (call, root) => {
    await writeFile(join(root, "plan.docx"), "DOCX");
    await writeFile(join(root, "deck.pptx"), "PPTX");
    const doc = textOf(await call({ path: "plan.docx", pages: "2" }));
    assert.match(doc, /^plan\.docx（docx を PDF にしたもの・全 2 ページ）/);
    assert.match(doc, /=== ページ 2 ===\n第二章の本文/);
    const deck = textOf(await call({ path: "deck.pptx" }));
    assert.match(deck, /全 2 スライド/);
    assert.match(deck, /=== スライド 1 ===\n表紙のスライド\n\n=== スライド 2 ===\n二枚目のスライド/);
    const img = await call({ path: "deck.pptx", pages: "2", asImage: true });
    assert.equal(img.filter((b) => b.type === "image").length, 1);
    assert.match(textOf(img), /=== スライド 2 ===/);
    // 同じ中身は変換し直さない（人の画面と同じ置き場）
    await call({ path: "plan.docx", pages: "1" });
    assert.deepEqual(
      fake.calls.filter((c) => c.kind !== "renderPage").map((c) => `${c.kind}:${c.extension}`),
      ["pdf:docx", "pdf:pptx"],
    );
  });
});

test("xlsx：計算し直した写しをシートごとの CSV で返す。pages はシートの番号。絵は PDF にしたときのページ", async () => {
  const fake = fakeConverter({ xlsx: makePdf([["売上の表"]]) });
  await withServer(fake.converter, async (call, root) => {
    await writeFile(join(root, "book.xlsx"), "XLSX-without-values");
    const all = textOf(await call({ path: "book.xlsx" }));
    assert.match(all, /^book\.xlsx（表・全 2 シート：1「売上」・2「メモ & 注」）/);
    assert.match(all, /LibreOffice で計算し直した/);
    assert.match(all, /=== シート 1「売上」 ===\n品目,単価,合計\nりんご,120,1200\n\n"a,b ""c""",,,TRUE\n/);
    assert.match(all, /=== シート 2「メモ & 注」 ===\n,"改行\nあり"/);
    const second = textOf(await call({ path: "book.xlsx", pages: "2" }));
    assert.doesNotMatch(second, /=== シート 1/);
    await assert.rejects(call({ path: "book.xlsx", pages: "3" }), /全 2 シートです/);
    const img = await call({ path: "book.xlsx", asImage: true });
    assert.match(textOf(img), /^book\.xlsx（xlsx を PDF にしたもの・全 1 ページ）/);
    assert.equal(img.filter((b) => b.type === "image").length, 1);
    assert.deepEqual(
      fake.calls.filter((c) => c.kind !== "renderPage").map((c) => `${c.kind}:${c.extension}`),
      ["spreadsheet:xlsx", "pdf:xlsx"],
    );
  });
});

test("変換役を入れている途中なら「あとでもう一度呼んでください」を返す。ほかの種類は readFile へ案内する", async () => {
  await withServer(fakeConverter({}, { preparing: true }).converter, async (call, root) => {
    await writeFile(join(root, "plan.docx"), "DOCX");
    assert.deepEqual(await call({ path: "plan.docx" }), [{ type: "text", text: READ_DOCUMENT_PREPARING_MESSAGE }]);
    await writeFile(join(root, "note.txt"), "x");
    await assert.rejects(call({ path: "note.txt" }), /readFile で読んでください/);
  });
  await withServer(undefined, async (call, root) => {
    await writeFile(join(root, "plan.docx"), "DOCX");
    await assert.rejects(call({ path: "plan.docx" }), /変換役に繋がっていません/);
  });
});

test("spreadsheetToCsv：xlsx でないものは理由を出す", () => {
  assert.throws(() => spreadsheetToCsv(Buffer.from("not a zip")), /表を読めません/);
});

// ---- 読むだけの回（追加・2026-10-20、アーキ仕様 §4.4）----

test("読むだけの印：readFile・readDocument・listDirectory・searchFiles・getFileInfo だけに付き、書く tool には付かない", async () => {
  await withServer(undefined, async (_call, _root, client) => {
    const { tools } = await client.listTools();
    const marked = tools.filter((t) => t._meta?.["dev.banto/effect"] === "read").map((t) => t.name).sort();
    assert.deepEqual(marked, ["getFileInfo", "listDirectory", "readDocument", "readFile", "searchFiles"]);
  });
});

test("読むだけの回の readDocument は PDF の文字だけ。ほかの形式と絵は変換役を呼ばずに断る", async () => {
  const fake = fakeConverter({});
  await withServer(fake.converter, async (_call, root, client) => {
    await writeFile(join(root, "plan.pdf"), makePdf([["見回りで読める"]]));
    await writeFile(join(root, "sheet.xlsx"), makeXlsx());
    const readOnly = { "dev.banto/restriction": "read-only" };
    const pdf = await client.callTool({ name: "readDocument", arguments: { path: "plan.pdf" }, _meta: readOnly });
    assert.equal(pdf.isError, undefined);
    assert.match(textOf(pdf.content as Block[]), /見回りで読める/);
    for (const args of [{ path: "sheet.xlsx" }, { path: "plan.pdf", asImage: true }]) {
      const refused = await client.callTool({ name: "readDocument", arguments: args, _meta: readOnly });
      assert.equal(refused.isError, true, JSON.stringify(args));
      assert.match(textOf(refused.content as Block[]), /この形式は見回りでは読めません/);
    }
    assert.equal(fake.calls.length, 0, "読むだけの回で変換役を呼んだ");
    // 印の無い呼び出しは今までどおり（表は変換役で読む）
    const normal = await client.callTool({ name: "readDocument", arguments: { path: "sheet.xlsx" } });
    assert.equal(normal.isError, undefined, textOf(normal.content as Block[]));
    assert.ok(fake.calls.length > 0);
  });
});
