"use client";

// **実機でキーボードを開閉したときに何が起きているかを、その場で見るための覗き窓。**
// （追加・2026-09-09。エミュレータでは実機のキーボード動作を再現できないため）
//
// `?kbdebug=1` を付けて開いたときだけ出る。普段は描かれない。
//
// 見たいのは3つ：
//   1. **レイアウトの高さが縮んでいるか**（`interactive-widget=resizes-content` が
//      実機で効いているか。効いていなければ `innerHeight` は変わらず、
//      `visualViewport.height` だけが変わる）
//   2. キーボードの開閉で **resize が何段来るか**（多段アニメーションか）
//   3. その間に **scrollTop がどう動いたか**（誰が動かしたか）

import { useEffect, useRef, useState } from "react";

type Row = { t: number; what: string; inner: number; vv: number; client: number; top: number; reserve: number };

export function KeyboardDebugOverlay() {
  const [rows, setRows] = useState<Row[]>([]);
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const viewport = markerRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;
    const start = performance.now();

    const push = (what: string) => {
      const reserve = viewport.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]");
      const row: Row = {
        t: Math.round(performance.now() - start),
        what,
        inner: window.innerHeight,
        vv: Math.round(window.visualViewport?.height ?? 0),
        client: viewport.clientHeight,
        top: Math.round(viewport.scrollTop),
        reserve: reserve ? Math.round(reserve.getBoundingClientRect().height) : -1,
      };
      setRows((prev) => [...prev.slice(-13), row]);
    };

    const onScroll = () => push("scroll");
    viewport.addEventListener("scroll", onScroll, { passive: true });
    const observer = new ResizeObserver(() => push("器resize"));
    observer.observe(viewport);
    const onVv = () => push("視覚resize");
    window.visualViewport?.addEventListener("resize", onVv);
    const onWin = () => push("窓resize");
    window.addEventListener("resize", onWin);
    push("開始");

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", onVv);
      window.removeEventListener("resize", onWin);
    };
  }, []);

  return (
    <>
      <span ref={markerRef} hidden />
      <div className="pointer-events-none fixed top-12 right-1 z-50 max-w-[92vw] rounded-md bg-surface-2 p-1.5 font-mono text-xs leading-tight text-foreground ring-1 ring-border">
        <div className="opacity-70">時刻 種類 窓/視覚/器 位置 余白</div>
        {rows.map((r, i) => (
          <div key={i}>
            {r.t} {r.what} {r.inner}/{r.vv}/{r.client} {r.top} {r.reserve}
          </div>
        ))}
      </div>
    </>
  );
}
