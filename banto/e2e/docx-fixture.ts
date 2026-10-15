// **試験用の docx を作る**（追加・2026-10-15、Word の画面の E2E）。依存を足さず（fflate は既にある）、docx の XML をそのまま書く。
//
// 中身は見出し（Heading1・Heading2 の書式）・表（枠つき）・箇条書き（numbering.xml の bullet）・本文。どれも日本語。
// Word・LibreOffice が書く形のうち、docx-preview が読む最小限だけを置く

import { strToU8, zipSync } from "fflate";

export interface DocxFixture {
  title: string;
  paragraphs: string[];
  subtitle: string;
  bullets: string[];
  table: string[][];
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${run(text)}</w:p>`;

export function makeJapaneseDocx(doc: DocxFixture): Buffer {
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`;
  const table =
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${doc.table[0]!.map(() => '<w:gridCol w:w="3000"/>').join("")}</w:tblGrid>` +
    doc.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(cell)}</w:tc>`).join("")}</w:tr>`).join("") +
    "</w:tbl>";
  const body = [
    para(doc.title, '<w:pStyle w:val="Heading1"/>'),
    ...doc.paragraphs.map((p) => para(p)),
    para(doc.subtitle, '<w:pStyle w:val="Heading2"/>'),
    ...doc.bullets.map((b) => para(b, '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')),
    table,
    para("以上。"),
  ].join("");
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";
  const style = (id: string, name: string, rPr: string, pPr = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:rPr>${rPr}</w:rPr></w:style>`;
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}>` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="21"/></w:rPr></w:style>' +
    style("Heading1", "heading 1", '<w:b/><w:sz w:val="36"/>', '<w:outlineLvl w:val="0"/>') +
    style("Heading2", "heading 2", '<w:b/><w:sz w:val="28"/>', '<w:outlineLvl w:val="1"/>') +
    style("ListParagraph", "List Paragraph", "", '<w:ind w:left="720"/>') +
    "</w:styles>";
  const numberingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}>` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
  const rel = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  const rels = (items: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    override("/word/document.xml", "document.main") +
    override("/word/styles.xml", "styles") +
    override("/word/numbering.xml", "numbering") +
    "</Types>";
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels(rel("rId1", "officeDocument", "word/document.xml"))),
      "word/document.xml": strToU8(documentXml),
      "word/styles.xml": strToU8(stylesXml),
      "word/numbering.xml": strToU8(numberingXml),
      "word/_rels/document.xml.rels": strToU8(rels(rel("rId1", "styles", "styles.xml") + rel("rId2", "numbering", "numbering.xml"))),
    }),
  );
}
