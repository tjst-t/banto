"use client";

// **画面の高さが変わっても、履歴と入力欄の位置関係を保つ**
// （決定・2026-09-07、ユーザー要望。最初は「一番下のときだけ」で作り、
//  比べたうえで**どこにいても**保つ形に広げた）。
//
// 携帯でキーボードが出ると、履歴の器の高さが縮む（`interactive-widget=resizes-content`）。
// このとき位置（scrollTop）はそのままなので、**器の上端を基準に**内容が留まり、
// 入力欄のすぐ上にあったものは入力欄の下へ隠れる
// ——実測：一番下にいた人の最後の発言が、発言の下端703／入力欄の上端319 になった。
//
// **保つのは「下からの距離」**（`scrollHeight - scrollTop - clientHeight`）。
// 一番下にいる場合はこれが 0 なので、「一番下のまま」は**この規則の特別な場合**に
// なる——別の分岐を持たない（規則3）。
//
// なぜライブラリ任せにできないか：`ThreadPrimitive.Viewport` は `turnAnchor="top"`
// で使っている（ターンの先頭を上に置く）ため `autoScroll` が既定で無効になり、
// 大きさが変わったときの追従も働かない（`useThreadViewportAutoScroll`）。
// **その設定は変えない**——ターンの見せ方は今のままがよいので、
// 「大きさが変わったとき」だけをここで補う。

import { useEffect, useRef } from "react";

export function KeepBottomDistanceOnResize() {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const viewport = markerRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;

    const bottomDistance = () =>
      Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);

    // **変わる前の距離**を覚えておく——高さが変わってから測っても、
    // もう「どこを見ていたか」は分からない。
    // **人が動かしたときだけ**更新する：大きさが変わっている最中は、自分で
    // 戻した分や、ブラウザが詰めた分（clientHeight が伸びると scrollTop は
    // 上限へ切り詰められる）でも scroll が飛んでくる。それを「見ていた場所」
    // として拾うと、戻す先がずれて**二度動く**
    let lastBottomDistance = bottomDistance();
    let settling = false;
    const onScroll = () => {
      if (settling) return;
      lastBottomDistance = bottomDistance();
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    const restore = () => {
      const target = viewport.scrollHeight - viewport.clientHeight - lastBottomDistance;
      const clamped = Math.max(0, Math.min(target, viewport.scrollHeight - viewport.clientHeight));
      // **描く前に、その場で直す**（ResizeObserver は描画の前に呼ばれる）
      // ——次のフレームに回すと、直す前の姿が一度描かれて「カクン」と見える
      settling = true;
      if (Math.abs(clamped - viewport.scrollTop) > 1) {
        viewport.scrollTo({ top: clamped, behavior: "instant" });
      }
      // このフレームのあいだに飛んでくる scroll は「人が動かした」と数えない
      requestAnimationFrame(() => {
        settling = false;
      });
    };

    // 器そのものの大きさが変わったとき（キーボード・URL バー・画面回転）。
    // **中身が増えたときは発火しない**——器の箱は変わらないので、
    // 流れてくる返事を追いかけて位置を奪うことはない
    const observer = new ResizeObserver(restore);
    observer.observe(viewport);
    // レイアウトが縮まない設定の端末（`resizes-visual`）でも合わせておく
    window.visualViewport?.addEventListener("resize", restore);

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", restore);
    };
  }, []);

  return <span ref={markerRef} hidden />;
}
