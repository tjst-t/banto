// **いま、上に何か開いているか**（`frontend-interaction-hardening`、2026-09-10）。
//
// Escape を聞く場所が2つある（`shell/panel-stack.tsx` の重なった層と、
// `hooks/use-escape-navigate-back.ts` の設定画面）。どちらも「Dialog が開いて
// いるならそちらが先」を守る必要があるので、判断はここ1箇所に持つ（規則3）
// ——片方だけが検査していたために、Palette を開いたまま Escape を押すと
// **背面の Fork が閉じる**という壊れ方をしていた（実測・2026-09-10）。
//
// Radix（Dialog / AlertDialog / Sheet / Drawer / cmdk の CommandDialog）は
// 開いている間だけ `[data-state="open"]` を付ける。
export function isOverlayOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  );
}
