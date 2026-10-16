// コメントの引用（選んだ文）が、描いた文字のどこに当たるか（PDF の文字の層・Word の本文）。
//
// 選んだ文は要素の境目に空白や改行が入るので、**空白を無視し、大文字と小文字を区別せずに**探す（最初に当たったところ）。
// 当たった所の Range を返す——印（蛍光ペン）は Range の矩形で描き、余白のコメントはその高さに並べる。

/** root の中の文字で、引用に最初に当たる所。無ければ undefined */
export function quoteRange(root: Node, quote: string): Range | undefined {
  const needle = quote.replace(/\s+/g, "").toLowerCase();
  if (!needle) return undefined;
  let joined = "";
  // joined の1字ごとに、元の文字ノードとその中の位置
  const at: Array<[Text, number]> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;
      if (/\s/.test(ch)) continue;
      const low = ch.toLowerCase();
      joined += low;
      for (let k = 0; k < low.length; k++) at.push([node, i]);
    }
  }
  const start = joined.indexOf(needle);
  if (start < 0) return undefined;
  const [startNode, startOffset] = at[start]!;
  const [endNode, endOffset] = at[start + needle.length - 1]!;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset + 1);
  return range;
}

/**
 * Range の矩形のうち、幅と高さのあるもの。**空白だけの文字ノードは数えない**——PDF の文字の層は語の間の空白を別の部品で
 * 置くので、それも塗ると隣と重なって濃く出る
 */
export function rangeRects(range: Range): DOMRect[] {
  const out: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  const nodes: Text[] = [];
  if (root.nodeType === Node.TEXT_NODE) nodes.push(root as Text);
  else {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) if (range.intersectsNode(node)) nodes.push(node);
  }
  for (const node of nodes) {
    if (!node.data.trim()) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    for (const r of part.getClientRects()) if (r.width > 1 && r.height > 1) out.push(r);
  }
  return out;
}
