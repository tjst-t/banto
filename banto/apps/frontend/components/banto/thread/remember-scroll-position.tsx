"use client";

// **読んでいた場所を覚え、会話の面が作り直されたらそこへ戻す**（決定・2026-09-28、ユーザー要望
// 「Canvas や Fork を閉じたときは、スレッドの位置は保存してほしい」）。
//
// 会話の面は、Fork と Canvas を両方開くと描かれなくなり（Base は帯だけになる）、閉じると新しく
// 作られる。記録から組み直したときも同じ。新しい面は assistant-ui が一番下へ送るので、
// 読んでいた場所を失っていた（実測・`thread-view-persist.spec.ts`：閉じると 4887px 下へ飛んだ）。
//
// - 見ている場所は scroll のたびに `lib/thread-scroll-memory.ts` へ写す——一番下なら「一番下」、
//   そうでなければ**器の上端にかかっているメッセージと、その中の位置**（幅が変わっても同じ所を指す）
// - 面が作られたとき、覚えた場所が「一番下」以外なら、ライブラリの「最初に一番下へ」を止めて
//   （`restoreTo` を持つ側が `scrollToBottomOnInitialize` を切る）その場所へ戻す
// - 中身の高さ（最後のターンの下の余白＝turnAnchor="top" の reserve など）は数フレーム遅れて揃うので、
//   **しばらくは戻し続ける**。人が動かしたら（ホイール・タッチ・キー・つかむ）すぐやめる

import { useLayoutEffect, useRef } from "react";
import { useThreadId } from "@/components/banto/thread/thread-id-context";
import { rememberThreadScroll, type ScrollAnchor } from "@/lib/thread-scroll-memory";

/** 一番下とみなす誤差（px） */
const BOTTOM_EPSILON = 8;
/** 戻し続けるフレーム数（約0.5秒）——中身の高さが揃うまで */
const RESTORE_FRAMES = 30;
const MESSAGE_SELECTOR = "[data-message-id]";

/** いま器の上端にかかっているメッセージと、その中の位置 */
function anchorOf(viewport: HTMLElement): ScrollAnchor | null {
  const top = viewport.getBoundingClientRect().top;
  const messages = viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);
  for (let index = 0; index < messages.length; index += 1) {
    const el = messages[index]!;
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const ratio = rect.height > 0 ? Math.min(1, Math.max(0, (top - rect.top) / rect.height)) : 0;
    return { messageId: el.dataset.messageId ?? "", index, ratio };
  }
  return null;
}

/** 覚えた場所に当たる scrollTop（見つからなければ null） */
function scrollTopFor(viewport: HTMLElement, anchor: ScrollAnchor): number | null {
  const messages = viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR);
  let el: HTMLElement | undefined;
  for (const m of messages) {
    if (m.dataset.messageId === anchor.messageId) {
      el = m;
      break;
    }
  }
  el ??= messages[anchor.index];
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const offset = rect.top - viewport.getBoundingClientRect().top + anchor.ratio * rect.height;
  return viewport.scrollTop + offset;
}

export function RememberScrollPosition({ restoreTo }: { restoreTo: ScrollAnchor | undefined }) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const threadId = useThreadId();

  useLayoutEffect(() => {
    const viewport = markerRef.current?.closest<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!viewport || !threadId) return;

    // 作られたときに1回だけ決まる戻し先。戻し終えたら（または人が動かしたら）undefined
    let target = restoreTo;
    const place = () => {
      if (!target) return;
      const top = scrollTopFor(viewport, target);
      if (top !== null && Math.abs(viewport.scrollTop - top) > 1) {
        viewport.scrollTo({ top, behavior: "instant" });
      }
    };
    place();
    let frames = 0;
    let raf = 0;
    const tick = () => {
      if (!target) return;
      place();
      frames += 1;
      if (frames < RESTORE_FRAMES) raf = requestAnimationFrame(tick);
      else target = undefined;
    };
    if (target) raf = requestAnimationFrame(tick);

    const stopRestoring = () => {
      target = undefined;
      cancelAnimationFrame(raf);
    };
    // scroll のたびに測ると重いので、1フレームに1回だけ覚える
    let pending = 0;
    const onScroll = () => {
      // 戻している最中の scroll は人の操作ではない——覚えている場所を書き換えない
      if (target || pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        if (target) return;
        const fromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        if (fromBottom < BOTTOM_EPSILON) {
          rememberThreadScroll(threadId, "bottom");
          return;
        }
        const anchor = anchorOf(viewport);
        if (anchor) rememberThreadScroll(threadId, anchor);
      });
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    viewport.addEventListener("wheel", stopRestoring, { passive: true });
    viewport.addEventListener("touchstart", stopRestoring, { passive: true });
    viewport.addEventListener("pointerdown", stopRestoring);
    viewport.addEventListener("keydown", stopRestoring);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(pending);
      viewport.removeEventListener("scroll", onScroll);
      viewport.removeEventListener("wheel", stopRestoring);
      viewport.removeEventListener("touchstart", stopRestoring);
      viewport.removeEventListener("pointerdown", stopRestoring);
      viewport.removeEventListener("keydown", stopRestoring);
    };
    // 戻し先は作られたときに決まる（`restoreTo` は持つ側が最初の1回だけ読む）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  return <span ref={markerRef} hidden />;
}
