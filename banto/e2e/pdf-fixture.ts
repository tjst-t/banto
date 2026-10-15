// **試験用の PDF を作る**（追加・2026-10-15、PDF の画面の E2E）。依存を足さず、PDF の形をそのまま書く。
//
// 日本語は**埋め込まないフォント**（Adobe-Japan1 の CID フォント、`UniJIS-UCS2-H`）で書く——画面が文字を読むには
// pdf.js 同梱の CMap が要る（Canvas は fetch できないので `readPdfAsset` を通る）。古い日本語の PDF に多い形。
// `padBytes` を渡すと、どこからも指されない大きな stream をページより前に挟む（50MB を超える PDF を、中身を
// 全部は運ばずに開けるかを見るため。ページの物は詰め物の後ろにあるので、範囲で読めないと開けない）

import { randomBytes } from "node:crypto";

function utf16beHex(text: string): string {
  let hex = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) throw new Error(`BMP の外の文字は書けません: ${ch}`);
    hex += code.toString(16).padStart(4, "0");
  }
  return hex.toUpperCase();
}

export function makeJapanesePdf(pages: Array<string[]>, options: { padBytes?: number } = {}): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    chunks.push(buf);
    length += buf.length;
  };
  const object = (n: number, body: Buffer | string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  };

  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  const pageCount = pages.length;
  // 1 カタログ・2 ページの木・3〜5 フォント・6 詰め物・7.. ページと中身
  const firstPage = 7;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const kids = pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  object(3, "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [4 0 R] >>");
  object(
    4,
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 5 >> /FontDescriptor 5 0 R /DW 1000 >>",
  );
  object(
    5,
    "<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] " +
      "/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 114 >>",
  );
  const pad = options.padBytes ?? 0;
  if (pad > 0) {
    object(6, Buffer.concat([Buffer.from(`<< /Length ${pad} >>\nstream\n`, "latin1"), randomBytes(pad), Buffer.from("\nendstream", "latin1")]));
  } else {
    object(6, "null");
  }
  pages.forEach((lines, i) => {
    const pageObj = firstPage + i * 2;
    const contentObj = pageObj + 1;
    object(
      pageObj,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    const ops = lines.map((line, j) => `BT /F1 ${j === 0 ? 24 : 14} Tf 60 ${770 - j * 36} Td <${utf16beHex(line)}> Tj ET`).join("\n");
    object(contentObj, `<< /Length ${Buffer.byteLength(ops, "latin1")} >>\nstream\n${ops}\nendstream`);
  });

  const total = firstPage + pageCount * 2;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
