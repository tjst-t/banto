"use client";

// **URL の「?」より後ろだけを変えるときは、サーバーに問い合わせない**（決定・2026-09-30、実測）。
//
// banto の画面は、開いている Fork・Canvas・パレット・設定などを URL の問い合わせ部分に持つ（規則3）。
// それを `router.push` で変えると、Next は**同じページでもサーバーへページのデータ（RSC）を取りに行き**、
// 届いてから描き直す——Ctrl-K を開く・閉じるたびに 1 往復していた（実測・2026-09-30）。
// ページ（`app/(shell)/p/[projectId]/page.tsx`）はサーバーで問い合わせ部分を読まないので、取りに行く意味が無い。
//
// Next は `window.history.pushState`／`replaceState` を自分のルーターに繋いでいて、`useSearchParams`・
// `usePathname` はそのまま追いかける（https://nextjs.org/docs/app/getting-started/linking-and-navigating
// 「Native History API」）。パスが同じならこちらを使い、パスが変わるときだけ今までどおりルーターで移る。

interface Router {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
}

export function navigateUrl(router: Router, href: string, options: { replace?: boolean } = {}): void {
  const url = new URL(href, window.location.href);
  if (url.origin === window.location.origin && url.pathname === window.location.pathname) {
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (options.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
    return;
  }
  if (options.replace) router.replace(href, { scroll: false });
  else router.push(href, { scroll: false });
}
