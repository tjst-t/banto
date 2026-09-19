import type { ReactNode } from "react";
import { AppShell } from "@/components/banto/shell/app-shell";
import { ConnectGate } from "@/components/banto/shell/connect-gate";

/**
 * **外枠は1つ**（`app-shell-shared-layout`、決定・2026-09-10）。
 *
 * 以前は `/`・`/p/[id]`・`/settings` がそれぞれ AppShell を持っていたので、
 * 面をまたぐたびにレール・トップバーが**作り直されていた**——実測（2026-09-10、
 * `banto/e2e/specs/app-shell-persist.spec.ts`）：レールの DOM の節が入れ替わり、
 * その中で開いていた「新しい Project」は**入力ごと消えた**。ホームの自動
 * リダイレクトが入力の途中で走ると、人はこれを踏む（実測・2026-09-06）。
 *
 * ルートグループ（URL には出ない）でこの3つを束ね、外枠を1回だけ張る。
 * **Canvas の別タブ（`/canvas-window`）はこの外にある**——あちらは banto の
 * クロムを一切持たない面なので、束ねてはいけない。
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  // **繋がっていないなら、外枠より先にそう言う**（追加・2026-09-18）。
  // 中に入れてしまうと「Project が無い」「読み込み中…」のまま止まって見える
  // ——聞いてもいないのに「無い」と言い切ることになる（規則2・規則13）
  return (
    <ConnectGate>
      <AppShell>{children}</AppShell>
    </ConnectGate>
  );
}
