// **いま、上に何か開いているか**（`frontend-interaction-hardening`、2026-09-10）。
//
// Escape を聞く場所が2つある（`shell/panel-stack.tsx` の重なった層と、
// `hooks/use-escape-leave-settings.ts` の設定の面）。どちらも「Dialog が開いて
// いるならそちらが先」を守る必要があるので、判断はここ1箇所に持つ（規則3）
// ——片方だけが検査していたために、Palette を開いたまま Escape を押すと
// **背面の Fork が閉じる**という壊れ方をしていた（実測・2026-09-10）。
//
// Radix（Dialog / AlertDialog / Sheet / Drawer / cmdk の CommandDialog）は
// 開いている間だけ `[data-state="open"]` を付ける。**設定の面**（会話の上に重ねる、2026-09-28）も
// 同じ印を付けている（`data-banto-settings`）——設定の上で押した Escape は、下の Fork や Canvas を閉じない。
// 設定の面自身が「ほかに何か開いているか」を聞くときは、自分を数えない（`exceptSettings`）。
const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

export function isOverlayOpen(options: { exceptSettings?: boolean } = {}): boolean {
  for (const el of document.querySelectorAll(OPEN_DIALOG)) {
    if (options.exceptSettings && el.hasAttribute("data-banto-settings")) continue;
    return true;
  }
  return false;
}
