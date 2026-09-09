"use client";

// **器（履歴のスクロール領域）の高さが変わっても、見えているものを保つ。**
// （決定・2026-09-09、根本見直し。経緯は docs/notes/ を参照）
//
// 携帯でキーボードが出ると、器の高さが縮む（`interactive-widget=resizes-content`）。
// このとき何をすべきかは、**入力欄のすぐ上に何が見えているか**で決まる：
//
// - **実内容が入力欄の下にまだ続いている**（途中を読んでいる／長い返事の下端）
//   → 入力欄との間隔を保つ（器が Δ 縮んだら scrollTop を Δ 足し、伸びたら引く）
// - **見えている中身の下は「最後のターンの下の余白」だけ**
//   → 履歴は動かさない。余白の伸縮はライブラリ（assistant-ui の
//   `turnAnchor="top"`）が行う
//
// なぜ二本立てか：`turnAnchor="top"` のとき assistant-ui は、最後のターンを器の
// 上端に固定するために **reserve（余白の div）を最後のターンの直後に置き、器の
// 高さの変化を reserve の伸縮で吸収する**（`mountTopAnchorReserve` →
// `computeTopAnchorReserve` が clientHeight に線形——実測：器 746→326 で
// reserve 412→0）。この領域を見ているときに scrollTop を動かすと、ライブラリと
// 位置の取り合いになる。前の実装（「器の高さが変わった分だけ動かす」）はここで
// 衝突し、キーボードを閉じたときにブラウザの切り詰め（clamp）−Δ と自前の −Δ が
// **二重に効いて前のターンまで戻っていた**（実測：scrollTop 2136 → 1304、−832）。
//
// reserve の伸縮は **1フレーム遅れる**（ライブラリは requestAnimationFrame で
// 高さを再計算する）。閉じたとき、reserve が伸びる前にブラウザが scrollTop を
// 上限へ切り詰めることがあるので、**戻し先を覚えておき、reserve が伸びたら
// 続きを戻す**（戻し先は最初に一度だけ決める——後から来る変化を追いかけない）。
//
// **中身の高さの変化には反応しない**（流れてくる返事を追いかけて位置を奪わない。
// 中身が上のほうで伸び縮みしたときの補正は、ブラウザの scroll anchoring に任せる）。
//
// ## URL バーの出入り——3回試して、動かさないに落ち着いた（2026-09-09）
//
// Android は**キーボードを閉じると高さが2段階で戻る**：まず URL バーが隠れた
// ままの高さになり、少し遅れて URL バーが戻る（実測：442→783→755、2段目は
// 130〜150ms後）。桁が違う（キーボードは数百px、URL バーは実測28px）ので、
// 「キーボードの開閉」と「URL バーの出入り」は別扱いにしている
// （`KEYBOARD_MIN_CHANGE` で判定）。URL バーぶんへの対応は3回変えた：
//
// 1. **同じ強さで追う** → 2段目が独立した「カクン」に見えた（−341 → +28 の
//    二度動き）
// 2. **ブラウザの `behavior: "smooth"` になめらかに寄せる** → 所要時間を
//    選べない（Chrome で約300〜500ms）。実機の2段目は130〜150ms後に来るので、
//    移動が終わる前に次の resize が割り込み、`onScroll` が「アニメーション
//    途中の座標」を拾って次の補正の基準にしてしまい、position がずれた
// 3. **自前の短いアニメーション**（120ms・ease-out、割り込みに強い形）に
//    差し替えた → それでも実機でカクついた。原因は別にあった：**AI が返事を
//    流し込んでいる最中は main thread が混み合っており、requestAnimationFrame
//    が均等に来ない**（実測・覗き窓：窓/視覚/器の寸法が変わっていないのに、
//    scrollTop が 13154→13182 の28pxを、+1,+1,+0,+1,+1,+3,+5,+5,+5,+4,+2 という
//    不規則な歩幅で、約200msかけて進んでいた——120ms で終わるはずのものが
//    コマ落ちして伸びていた）。**「なめらかに動かす」こと自体が、返事が
//    流れている最中には筋が悪い**——動かす限り、混雑との競合が残る
//
// **採った形（4回目）：動かさない。** 残るのは実測28px（本文1行に満たない）の
// 静的なずれだけ——動きが無いので、カクつく余地も無い。

import { useEffect, useRef } from "react";

/** 入力欄の下端ぎりぎりの誤差はゼロ扱いにする（丸め・境界線ぶん） */
const EPSILON = 4;

/**
 * ここから上を「キーボードの開閉」とみなす高さの変化（px）。これ未満は
 * 「URL バーの出入り」とみなし、**動かさずに無視する**。
 *
 * 実機の実測（2026-09-09、Android Chrome）：キーボード **313px**、
 * URL バーの出入り **28px**。桁が違うので、間を取って 100px で分ける。
 * 境目は多少ずれてもよい（キーボードが 100px 未満の端末は無い）。
 */
const KEYBOARD_MIN_CHANGE = 100;

export function KeepScrollPositionOnResize() {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const viewport = markerRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport) return;

    let lastClientHeight = viewport.clientHeight;
    // **「人が見ていた場所」を scroll イベントで追う。**
    let lastScrollTop = viewport.scrollTop;
    // 器が伸びたのに reserve がまだ伸びておらず届かなかった戻し先。
    // reserve が伸びたら（＝上限が戻ったら）続きを戻す
    let pendingTarget: number | null = null;

    const onScroll = () => {
      // **器の高さが変わったのにまだ処理していない間の scroll は、人の操作ではない**
      // ——器が伸びた瞬間、ブラウザは scrollTop を上限へ切り詰め（clamp）、その
      // scroll イベントは ResizeObserver より先に届くことがある（実測：閉じたとき
      // 2144→1724 の切り詰めを拾ってしまい、そこからさらに −420 して前のターンまで
      // 戻っていた）。タイミングではなく「高さが食い違っている」という測れる条件で弾く
      if (viewport.clientHeight !== lastClientHeight) return;
      const top = viewport.scrollTop;
      // 自分が置いた覚えのない場所へ動いた＝人が動かした。戻しかけは取り下げる
      if (pendingTarget !== null && Math.abs(top - lastScrollTop) > EPSILON) {
        pendingTarget = null;
      }
      lastScrollTop = top;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    /** 即座に合わせる（ResizeObserver は描画の前に呼ばれるので、その場で
     *  直せば「カクン」と見えない）。 */
    const jumpTo = (top: number) => {
      if (Math.abs(top - viewport.scrollTop) > 1) {
        viewport.scrollTo({ top, behavior: "instant" });
      }
      lastScrollTop = top;
    };

    const reserveObserver = new ResizeObserver(() => {
      // reserve の伸縮そのもの。届かなかった戻し先があれば、届く範囲で近づける。
      // **1回で使い切る**——持ち越すと、次のターンの流し込み（reserve が頻繁に
      // 動く）で古い戻し先が発火し、読んでいる位置を奪ってしまう
      if (pendingTarget === null) return;
      const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      jumpTo(Math.min(pendingTarget, max));
      pendingTarget = null;
    });
    let observedReserve: Element | null = null;
    const findReserve = () => {
      const reserve = viewport.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]");
      if (reserve && reserve !== observedReserve) {
        if (observedReserve) reserveObserver.unobserve(observedReserve);
        reserveObserver.observe(reserve);
        observedReserve = reserve;
      }
      return reserve;
    };

    const onViewportResize = () => {
      const clientHeight = viewport.clientHeight;
      const shrink = lastClientHeight - clientHeight; // 正＝縮んだ（キーボードが出た）
      if (shrink === 0) return;

      // **URL バーぶんの小さな変化は、動かさずに無視する**（上のファイル冒頭の
      // 説明を参照——3回試した末の結論）。**無視した分は基準にも入れない**——
      // 基準を更新してしまうと、次に大きく変わったときに無視したはずの分まで
      // 一緒に動かしてしまう（実測：キーボードが24px高くなったのを無視したのに、
      // 閉じるときの補正が本来の−341ではなく−365になり、52pxずれた）
      if (Math.abs(shrink) < KEYBOARD_MIN_CHANGE) return;
      lastClientHeight = clientHeight;

      pendingTarget = null;

      const prevTop = lastScrollTop;
      const prevClientHeight = clientHeight + shrink;

      // **変わる前の、入力欄の上端の位置（中身の座標）。**
      // 入力欄（sticky な footer）は器の下端に貼り付くので、上端＝下端 − footer の高さ
      const footer = viewport.querySelector<HTMLElement>(".aui-thread-viewport-footer");
      const composerTopBefore = prevTop + prevClientHeight - (footer?.offsetHeight ?? 0);

      // **実内容の下端＝ reserve の上端**（中身の座標。今の rect から出すので、
      // 中身の高さが後から揺れていても狂わない）。reserve がまだ無いスレッド
      // （読み込み直後・最初のターンの前）は「実内容が下に続いている」扱い
      // ——全量を動かす、従来どおりの素直な形になる
      const reserve = findReserve();
      let hiddenContent = Number.POSITIVE_INFINITY; // 入力欄の下に隠れている実内容の量
      let visibleBlank = 0; // 入力欄の上に見えている reserve 由来の余白の量
      if (reserve) {
        const contentEnd =
          reserve.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop;
        hiddenContent = Math.max(0, contentEnd - composerTopBefore);
        visibleBlank = Math.min(
          Math.max(0, composerTopBefore - contentEnd),
          reserve.offsetHeight,
        );
      }

      let target: number;
      if (shrink > 0) {
        // 縮んだ：余白を先に食い、足りない分だけ履歴を入力欄と一緒に持ち上げる
        target = prevTop + Math.max(0, shrink - visibleBlank);
      } else if (hiddenContent > EPSILON) {
        // 伸びた・実内容が下に続いている：間隔を保つ（入力欄と一緒に下ろす）
        target = prevTop + shrink;
      } else {
        // 伸びた・下は余白だけ：履歴は動かさない（余白はライブラリが伸ばす）
        target = prevTop;
      }

      const max = Math.max(0, viewport.scrollHeight - clientHeight);
      jumpTo(Math.max(0, Math.min(target, max)));
      // reserve がまだ伸びていなくて届かないなら、伸びたときに続きを戻す
      if (target > max + 1) pendingTarget = target;
    };

    // 器そのものの大きさが変わったとき（キーボード・URL バー・画面回転）だけ動く。
    // 中身が増えても器の箱は変わらないので、ここは発火しない
    const viewportObserver = new ResizeObserver(onViewportResize);
    viewportObserver.observe(viewport);
    findReserve();

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewportObserver.disconnect();
      reserveObserver.disconnect();
    };
  }, []);

  return <span ref={markerRef} hidden />;
}
