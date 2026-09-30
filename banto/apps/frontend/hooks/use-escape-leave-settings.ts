"use client";

// Escape で**設定から抜ける**（改訂・2026-09-28、ユーザー要望）。節をいくつ移っていても一発で。
// 設定はいまの画面の上に重ねる面なので、抜ける＝重ねた印を外す（下の画面はそのまま、
// `lib/settings-link.ts`）。
//
// 他のDialog/AlertDialog（RoleListの無効化確認等）が開いているときは、
// そちらのEscapeが優先されるべきなので何もしない——同時に2つのことが
// 起きるのを避ける。
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isOverlayOpen } from "@/lib/overlay-open";
import { settingsCloseHref } from "@/lib/settings-link";

export function useEscapeLeaveSettings() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (isOverlayOpen({ exceptSettings: true })) return;
      router.push(settingsCloseHref(pathname, new URLSearchParams(search)), { scroll: false });
    }
    // capture フェーズで登録する——bubble フェーズだと、Radix 側の Escape
    // ハンドラ（同期的に閉じる）が先に走り、その時点でこの判定が手遅れになる
    // （実測：bubble だと alertdialog が既に消えた後にこの判定が走っていた）
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [router, pathname, search]);
}
