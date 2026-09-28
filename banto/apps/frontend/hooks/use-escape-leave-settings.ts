"use client";

// Escape で**設定から抜ける**（改訂・2026-09-28、ユーザー要望）。/settings のように overlay ではなく
// 通常の route として開く画面向け——Dialog/Sheet はコンポーネント自身が Escape を処理するので
// この hook は要らない。
//
// 以前は `router.back()`（1つ前の画面へ）だった。設定の中で節を移ると履歴に積まれるので、
// 節を2つ見たあとの Escape は**1つ前の節**に戻るだけで、設定から抜けるまで何度も押す必要があった。
// 抜ける先は `lib/settings-return.ts` が覚えている「設定に入る前に居た画面」。
//
// 他のDialog/AlertDialog（RoleListの無効化確認等）が開いているときは、
// そちらのEscapeが優先されるべきなので何もしない——同時に2つのことが
// 起きるのを避ける。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { isOverlayOpen } from "@/lib/overlay-open";
import { settingsExitHref } from "@/lib/settings-return";

export function useEscapeLeaveSettings(projectId: string | null) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isOverlayOpen()) return;
      router.push(settingsExitHref(projectId));
    }
    // capture フェーズで登録する——bubble フェーズだと、Radix 側の Escape
    // ハンドラ（同期的に閉じる）が先に走り、その時点でこの判定が手遅れになる
    // （実測：bubble だと alertdialog が既に消えた後にこの判定が走っていた）
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [router, projectId]);
}
