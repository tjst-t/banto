"use client";

// **会話は最新の 20 件だけ描き、古い分は人が頼んだら足す**（決定・2026-09-29、ユーザー。
// 実測は docs/notes/2026-09-29-long-thread-render.md）。
//
// 画面の重さは描いている発言の数に比例していた——発言ごとの部品が見た目を問い合わせ（Radix の
// Presence）、会話の面が中身の変化のたびに全体の高さを測り直し（assistant-ui の自動スクロール）、
// 入力欄の1文字ごとに描いている全発言へ知らせが配られる。180 件の会話から立てた Fork は親の分も
// 合わせて 375 件を描き、CPU を 4 倍遅くした条件で開くのに 5〜9 秒かかっていた。
//
// - ランタイムには全件を持たせたまま、**描くのを窓の中だけにする**（記録の流し込み・走っているターンの
//   仕組みには触れない）
// - 窓の始まりは**発言の id で覚える**（件数で覚えると、返事が増えるたびに窓が下へずれ、上を読んで
//   いる人の足元が消える）。新しい発言は窓の中に足されていく
// - 古い分は上端のボタンで 20 件ずつ足す。スクロールで勝手に足さない（上へ辿ると位置がずれる問題を
//   2026-09-10 に直した経緯がある）。足したときは、見ていた場所を動かさない
// - 読んでいた場所へ戻す（`RememberScrollPosition`）ときは、その発言が窓に入るところから始める

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** 最初に描く件数と、ボタン1回で足す件数 */
export const MESSAGE_WINDOW_STEP = 20;

export function useMessageWindow(
  ids: readonly string[],
  mustInclude: string | undefined,
): { visible: readonly string[]; hiddenCount: number; showEarlier: () => void; anchorRef: RefObject<HTMLDivElement | null> } {
  // 窓の始まりの発言。null はまだ決めていない（中身が届く前）
  const [startId, setStartId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  // 足した直後に「見ていた場所」を保つための目印：押したとき器の中に見えていた最初の発言と、
  // 器の上端からの距離。器は押したときに掴んでおく——全部足し終えるとボタンは消える
  const keepAnchor = useRef<{ viewport: HTMLElement; messageId: string; offset: number } | null>(null);

  let start = startId === null ? -1 : ids.indexOf(startId);
  if (start < 0) {
    // 決めていない・流し込み直しで居なくなった——最新の 20 件から（戻す先があればそこまで広げる）
    start = Math.max(0, ids.length - MESSAGE_WINDOW_STEP);
    if (mustInclude) {
      const at = ids.indexOf(mustInclude);
      if (at >= 0 && at < start) start = at;
    }
  }
  const resolvedStartId = ids[start] ?? null;
  // 決めた始まりを覚える（描いている最中に state を変えるのは、React が許す「前の描画から導く」形）
  if (resolvedStartId !== null && resolvedStartId !== startId) setStartId(resolvedStartId);

  const showEarlier = () => {
    const viewport = anchorRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (viewport) {
      const top = viewport.getBoundingClientRect().top;
      for (const el of viewport.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom <= top) continue;
        keepAnchor.current = { viewport, messageId: el.dataset.messageId ?? "", offset: rect.top - top };
        break;
      }
    }
    const next = Math.max(0, start - MESSAGE_WINDOW_STEP);
    setStartId(ids[next] ?? null);
  };

  // 上に足したぶん、見ていた発言が下へ押し出されないようにする。描く前に置き直し、足した発言の高さが
  // 数フレーム遅れて揃うので、しばらく置き直し続ける（1回だけだと 109px ずれた、実測・2026-09-30）。
  // 人が動かしたらすぐやめる
  useLayoutEffect(() => {
    const saved = keepAnchor.current;
    if (saved === null) return;
    keepAnchor.current = null;
    const { viewport } = saved;
    const place = () => {
      const el = viewport.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(saved.messageId)}"]`);
      if (!el) return;
      const delta = el.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset;
      if (Math.abs(delta) > 1) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: "instant" });
    };
    place();
    let frames = 0;
    let raf = requestAnimationFrame(function tick() {
      place();
      if (++frames < 30) raf = requestAnimationFrame(tick);
    });
    const stop = () => {
      cancelAnimationFrame(raf);
      frames = 30;
    };
    viewport.addEventListener("wheel", stop, { passive: true, once: true });
    viewport.addEventListener("touchstart", stop, { passive: true, once: true });
    viewport.addEventListener("keydown", stop, { once: true });
    return () => {
      stop();
      viewport.removeEventListener("wheel", stop);
      viewport.removeEventListener("touchstart", stop);
      viewport.removeEventListener("keydown", stop);
    };
  }, [start]);

  return { visible: ids.slice(start), hiddenCount: start, showEarlier, anchorRef };
}

export function ShowEarlierMessages({
  hiddenCount,
  onShow,
  anchorRef,
}: {
  hiddenCount: number;
  onShow: () => void;
  anchorRef: RefObject<HTMLDivElement | null>;
}) {
  if (hiddenCount === 0) return null;
  return (
    <div ref={anchorRef} className="flex justify-center">
        <button
          type="button"
          data-testid="show-earlier-messages"
          onClick={onShow}
          className="rounded-full border border-border px-3 py-1 text-xs text-ink-3 hover:bg-accent hover:text-foreground"
        >
          それより前の {Math.min(hiddenCount, MESSAGE_WINDOW_STEP)} 件を表示（残り {hiddenCount} 件）
        </button>
    </div>
  );
}
