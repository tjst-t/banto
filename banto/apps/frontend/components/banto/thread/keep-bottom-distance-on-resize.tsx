"use client";

// **画面の高さが変わっても、履歴と入力欄の位置関係を保つ**
// （決定・2026-09-07、ユーザー要望）。
//
// 携帯でキーボードが出ると、履歴の器の高さが縮む（`interactive-widget=resizes-content`）。
// このとき位置（scrollTop）はそのままなので、**器の上端を基準に**内容が留まり、
// 入力欄のすぐ上にあったものは入力欄の下へ隠れる
// ——実測：一番下にいた人の最後の発言が、発言の下端703／入力欄の上端319 になった。
//
// **動かすのは「器の高さが変わった分」だけ。**
//   器が Δ 縮んだら scrollTop を Δ 足す（＝下端に見えていた内容が下端のまま）。
// 一番下にいる場合はそのまま一番下に留まるので、「一番下のまま」は
// **この規則の特別な場合**になる（分岐を持たない、規則3）。
//
// **中身の高さの変化には反応しない**（改訂・2026-09-07、ユーザー報告
// 「閉じたときに一度動いたあと、少しだけまた動く」）。
// 大きさが変わった**後から**中の寸法が動くことがある——実測：高さを縮めると
// 器の中身が 16,970 → 19,048 に伸び、戻しても戻らなかった。入力欄
// （器の中にあり、下端に貼り付いている）が一度縮んでから戻る、という指摘も同じ形。
// 「下からの距離」を保とうとすると、**その遅れた変化のたびに位置を直すことになり、
// それが二度目の動きとして見える**。器の高さだけを見れば、遅れて来る変化では
// 何もしないので、動きは一度きりになる。
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

    let lastClientHeight = viewport.clientHeight;

    const onGeometryChange = () => {
      const clientHeight = viewport.clientHeight;
      const delta = lastClientHeight - clientHeight;
      lastClientHeight = clientHeight;
      if (delta === 0) return;

      const maxScrollTop = Math.max(0, viewport.scrollHeight - clientHeight);
      const next = Math.max(0, Math.min(viewport.scrollTop + delta, maxScrollTop));
      // **描く前に、その場で直す**（ResizeObserver は描画の前に呼ばれる）
      // ——次のフレームに回すと、直す前の姿が一度描かれて「カクン」と見える
      if (Math.abs(next - viewport.scrollTop) > 1) {
        viewport.scrollTo({ top: next, behavior: "instant" });
      }
    };

    // 器そのものの大きさが変わったとき（キーボード・URL バー・画面回転）。
    // **中身が増えたときは発火しない**——器の箱は変わらないので、
    // 流れてくる返事を追いかけて位置を奪うことはない
    const observer = new ResizeObserver(onGeometryChange);
    observer.observe(viewport);
    // レイアウトが縮まない設定の端末（`resizes-visual`）でも合わせておく
    window.visualViewport?.addEventListener("resize", onGeometryChange);

    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", onGeometryChange);
    };
  }, []);

  return <span ref={markerRef} hidden />;
}
