"use client";

// `next/link` の代わり。**行き先のパスがいまと同じなら、サーバーに問い合わせずに URL を変える**
// （`lib/url-nav.ts`、2026-09-30）——サイドバーの Fork の行・設定の歯車などは「?」より後ろだけが変わる。
// パスが変わるとき、別タブで開く（Ctrl/⌘/Shift/中クリック）ときは、いつもの `Link` のまま。
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentProps, MouseEvent } from "react";
import { navigateUrl } from "@/lib/url-nav";

export function UrlLink({ onClick, ...props }: ComponentProps<typeof Link>) {
  const router = useRouter();
  const href = typeof props.href === "string" ? props.href : null;
  return (
    <Link
      {...props}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || !href) return;
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (props.target && props.target !== "_self") return;
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== window.location.pathname) return;
        e.preventDefault();
        navigateUrl(router, href);
      }}
    />
  );
}
