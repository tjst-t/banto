"use client";

// **一番下にいたなら、画面の高さが変わっても一番下のまま**
// （決定・2026-09-07、ユーザー要望）。
//
// 携帯でキーボードが出ると、履歴の器の高さが縮む（`interactive-widget=resizes-content`）。
// このとき位置（scrollTop）はそのままなので、**一番下にいた人は最後の発言を見失う**
// ——実測：最後の発言と入力欄の間隔が +35px → −384px（入力欄の下に隠れた）。
//
// **一番下以外では何もしない。** 途中を読んでいる人の位置を勝手に動かすのは、
// 読んでいるものを奪うことになる（ユーザー指示：一番下以外は今の動きでよい）。
//
// なぜライブラリ任せにできないか：`ThreadPrimitive.Viewport` は `turnAnchor="top"`
// で使っている（ターンの先頭を上に置く）ため、`autoScroll` が既定で無効になり、
// 大きさが変わったときの追従も働かない（`useThreadViewportAutoScroll`）。
// **その設定は変えない**——ターンの見せ方は今のままがよいので、
// 「大きさが変わったとき」だけをここで補う。

import { useEffect, useRef } from "react";

/** 一番下にいるか。1px の丸め誤差では判定を変えない。 */
function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
}

export function KeepBottomOnResize() {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const viewport = markerRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;

    // **変わる前の状態**を覚えておく——高さが変わってから測ると、
    // もう「一番下だったか」が分からない
    let followingBottom = isAtBottom(viewport);
    const onScroll = () => {
      followingBottom = isAtBottom(viewport);
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    const stickToBottom = () => {
      if (!followingBottom) return;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    };

    // 器そのものの大きさが変わったとき（キーボード・URL バー・画面回転）。
    // **中身が増えたときは発火しない**——器の箱は変わらないので、
    // 流れてくる返事を追いかけて位置を奪うことはない
    const observer = new ResizeObserver(stickToBottom);
    observer.observe(viewport);
    // レイアウトが縮まない設定の端末（`resizes-visual`）でも合わせておく
    window.visualViewport?.addEventListener("resize", stickToBottom);

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", stickToBottom);
    };
  }, []);

  return <span ref={markerRef} hidden />;
}
