// **設定から抜けたら、どこへ戻るか**（決定・2026-09-28、ユーザー要望「設定画面で Escape を
// 押したら一発で設定から抜けてほしい」）。
//
// 以前の Escape は「ブラウザの戻る」だった。設定の中で節を移ると履歴に積まれるので、Escape は
// **1つ前の節**に戻るだけで、抜けるまで何度も押す必要があった。
//
// 抜ける先は「設定に入る前に居た画面」。外枠（AppShell）はページを移っても作り直されないので、
// そこで**設定の外に居るあいだの URL を覚え続け**、設定の側はそれを読むだけにする。
// 覚えが無いとき（設定を直接開いた・読み込み直した）は、見ていた Project の会話へ、それも無ければホームへ。

let lastOutsideSettings: string | null = null;

/** 設定の外に居るあいだ、その URL を覚える（AppShell が URL の変わるたびに呼ぶ） */
export function rememberOutsideSettings(pathname: string, search: string): void {
  if (pathname === "/settings") return;
  lastOutsideSettings = search ? `${pathname}?${search}` : pathname;
}

/** 設定から抜ける先。`projectId` は設定がいま見せている Project の層（`?project=`） */
export function settingsExitHref(projectId: string | null): string {
  if (lastOutsideSettings) return lastOutsideSettings;
  return projectId ? `/p/${projectId}` : "/";
}
