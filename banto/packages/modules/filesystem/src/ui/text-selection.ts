// PDF の文字の層で、人のドラッグの選択が乱れないようにする（pdf.js 本家のビューアの TextLayerBuilder の #bindMouse と
// #enableGlobalSelectionListener を写したもの。pdf.js は文字の層を描く部品 TextLayer にはこれを入れておらず、ビューア側で持つ）。
//
// 文字の層の span は位置を指定して置くので、余白や行間（span の無い所）にマウスが出るとブラウザは選択の端を層の先頭や
// 末尾に跳ばす——行の右へ出ただけで下の段落まで全部選ばれていた（2026-10-16、ユーザー報告）。層ごとに「終わり」の div を
// 置き、選んでいる間だけそれを層の全面に広げ、選択の端の span のすぐ後ろへ動かす。そうすると、文字の無い所では選択の端が
// いま選んでいる位置に留まる。

const layers = new Map<HTMLElement, HTMLElement>();
let listening = false;

/** 描いた文字の層に「終わり」の div を足し、選択を見張る（層を捨てたら forgetTextLayer） */
export function bindTextLayer(layer: HTMLElement): void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  layer.addEventListener("mousedown", () => layer.classList.add("selecting"));
  layers.set(layer, end);
  // 捨てられた層（描き直し・ページの外）を忘れる
  for (const known of [...layers.keys()]) if (!known.isConnected && known !== layer) layers.delete(known);
  listen();
}

function reset(end: HTMLElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  layer.classList.remove("selecting");
}

function resetAll(): void {
  for (const [layer, end] of layers) reset(end, layer);
}

function listen(): void {
  if (listening) return;
  listening = true;
  let pointerDown = false;
  document.addEventListener("pointerdown", () => (pointerDown = true));
  document.addEventListener("pointerup", () => {
    pointerDown = false;
    resetAll();
  });
  window.addEventListener("blur", () => {
    pointerDown = false;
    resetAll();
  });
  document.addEventListener("keyup", () => {
    if (!pointerDown) resetAll();
  });
  let prevRange: Range | undefined;
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) {
      resetAll();
      return;
    }
    const active = new Set<HTMLElement>();
    for (let i = 0; i < selection.rangeCount; i++) {
      const range = selection.getRangeAt(i);
      for (const layer of layers.keys()) if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add("selecting");
      else reset(end, layer);
    }
    const range = selection.getRangeAt(0);
    const modifyStart =
      prevRange !== undefined &&
      (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!modifyStart && range.endOffset === 0 && anchor) {
      do {
        while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && anchor.childNodes.length === 0);
    }
    const parentLayer = (anchor as Element | null)?.parentElement?.closest<HTMLElement>(".textLayer");
    const end = parentLayer ? layers.get(parentLayer) : undefined;
    if (parentLayer && end && anchor) {
      end.style.width = parentLayer.style.width;
      end.style.height = parentLayer.style.height;
      end.style.userSelect = "text";
      (anchor as Element).parentElement?.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}
