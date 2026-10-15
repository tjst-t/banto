// **変換役の試験の文書**（追加・2026-10-15、Backlog #304 office-converter）。依存を足さず（fflate は既にある）、Office の XML を
// そのまま書く。どれも LibreOffice 24.2 が読める最小限（道具用のコンテナと同じ作りの箱で、PDF にできることを確かめた）
//
// - `makeTrapDocx`：外の画像を**リンク**で指す docx（`r:link`。埋め込みではない）。囲いの外の LibreOffice は `http://` を
//   取りに行き、`file:///` を PDF に埋め込んだ（実測）——囲いの中では、どちらも起きないことを確かめる
// - `makeFormulaXlsx`：式だけで値の入っていない xlsx（AI が openpyxl で作ったものと同じ形）
// - `makeSlidesPptx`：2枚のスライド
import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** 赤一色の PNG（埋め込まれたら PDF に画像が1つ増える） */
export function redPng(size = 40): Buffer {
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 本文と、外の画像をリンクで指す図（`imageUrls` の数だけ） */
export function makeTrapDocx(text: string, imageUrls: string[]): Buffer {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${RELS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
  const pic = (i: number) =>
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="${i + 1}" name="p${i}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${i + 1}" name="p${i}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:link="rImg${i}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}">${imageUrls
      .map((u, i) => `<Relationship Id="rImg${i}" Type="${RELS}/image" Target="${esc(u)}" TargetMode="External"/>`)
      .join("")}</Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p>${imageUrls.map((_, i) => pic(i)).join("")}</w:body></w:document>`,
  });
}

/** シート1：B2=12・C2=100・D2=B2*C2・D3=SUM(D2,7)。式の値（`<v>`）は入れない */
export function makeFormulaXlsx(): Buffer {
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${RELS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${RELS}"><sheets><sheet name="シート1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="B2"><v>12</v></c><c r="C2"><v>100</v></c><c r="D2"><f>B2*C2</f></c></row><row r="3"><c r="D3"><f>SUM(D2,7)</f></c></row></sheetData></worksheet>`,
  });
}

/** 文字だけのスライド（枚数は `titles` の数） */
export function makeSlidesPptx(titles: string[]): Buffer {
  const P = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${RELS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const slide = (t: string) =>
    `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="ja-JP" sz="3200"/><a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${titles
      .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
      .join("")}</Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    "ppt/_rels/presentation.xml.rels": `<?xml version="1.0"?><Relationships xmlns="${PKG_RELS}">${titles
      .map((_, i) => `<Relationship Id="rS${i}" Type="${RELS}/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join("")}</Relationships>`,
    "ppt/presentation.xml": `<?xml version="1.0"?><p:presentation ${P}><p:sldIdLst>${titles
      .map((_, i) => `<p:sldId id="${256 + i}" r:id="rS${i}"/>`)
      .join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  };
  titles.forEach((t, i) => (files[`ppt/slides/slide${i + 1}.xml`] = slide(t)));
  return zip(files);
}
