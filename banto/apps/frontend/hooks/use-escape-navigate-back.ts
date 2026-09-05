"use client";

// Escapeで1つ前の画面へ戻る。/settings のように overlay ではなく通常の
// route として開く画面向け——Dialog/Sheetはコンポーネント自身がEscapeを
// 処理するのでこのhookは要らない。
// 他のDialog/AlertDialog（RoleListの無効化確認等）が開いているときは、
// そちらのEscapeが優先されるべきなので何もしない——同時に2つのことが
// 起きるのを避ける。
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function useEscapeNavigateBack() {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const otherOverlayOpen = document.querySelector(
        '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
      if (otherOverlayOpen) return;
      router.back();
    }
    // capture フェーズで登録する——bubble フェーズだと、Radix 側の Escape
    // ハンドラ（同期的に閉じる）が先に走り、その時点でこの判定が手遅れになる
    // （実測：bubble だと alertdialog が既に消えた後にこの判定が走っていた）
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [router]);
}
