"use client";

// prototype の `.shell`（.rail + .rooms）に対応する外枠。
// ≥md: ProjectRail（サイドバー。展開 16rem ⇄ 畳んで 58px）+ PanelStack
// <md: PanelStack だけ（ナビは各パネルのヘッダの ≡ → MobileNavDrawer）
import { Suspense, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ArchiveDialog } from "@/components/banto/archive/archive-dialog";
import { InboxOverlay } from "@/components/banto/inbox/inbox-overlay";
import { CommandPalette } from "@/components/banto/palette/command-palette";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import { usePanelStack } from "./use-panel-stack";
import { ProjectRail } from "./project-rail";
import {
  getServerSidebarPreference,
  getSidebarPreference,
  setSidebarOpen,
  setSidebarWidth,
  subscribeSidebarPreference,
} from "./sidebar-preference";

const SHOW_ARCHIVE = CONNECTED_FEATURES.threadCloseReopen || CONNECTED_FEATURES.projectCloseReopen;

// usePanelStack が useSearchParams を使う（searchParams 駆動、§3.1）ので、
// AppShell 自身の中に Suspense 境界を持つ——呼び出し側（各 layout.tsx）に
// 「Suspense で包む」を覚えさせない。これが無いと `/settings` のような
// 静的にプリレンダーされるルートで build が失敗する
// （"useSearchParams() should be wrapped in a suspense boundary"、実測で踏んだ）
export function AppShell(props: {
  /** null＝Project の外（instance 設定 `/settings` 等）。ProjectRail のアクティブ表示だけに使う */
  projectId: string | null;
  children: ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <AppShellInner {...props} />
    </Suspense>
  );
}

function AppShellInner({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  // 受信箱は Project 単位の MCP 接続の外側にある入れ物（§2.4.1）——
  // どの Project を見ていても、同じ overlay 状態（searchParams）で開ける
  const stack = usePanelStack(projectId ?? "");
  // サイドバーの幅・畳んだかどうかは React の外（sidebar-preference.ts）に持つ
  // ——Project を移ると各 layout の AppShell は作り直されるので、ここに state で
  // 持つと**既定で1回描いてから直す**ことになり、幅が一瞬跳ねる（ユーザー報告）
  const sidebar = useSyncExternalStore(
    subscribeSidebarPreference,
    getSidebarPreference,
    getServerSidebarPreference,
  );

  // Ctrl-K / Cmd-K でどこからでも開く（§6.3「探すときの入口も1つ」）。
  // ブラウザ既定のショートカット（住所バーへのフォーカス等）を上書きする
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        stack.open({ overlay: "palette" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [stack]);

  return (
    <SidebarProvider
      open={sidebar.open}
      onOpenChange={setSidebarOpen}
      style={
        {
          "--sidebar-width": `${sidebar.width}px`,
          "--sidebar-width-icon": "58px",
        } as React.CSSProperties
      }
      // **画面の高さそのもの**（改訂・2026-09-07、ユーザー報告）。`svh` は
      // 「URL バーが出ている状態の高さ」に固定されるので、URL バーが隠れると
      // 下に何も無い帯ができる。`dvh` は URL バーにもキーボードにも追従する
      // （キーボードで縮むのは上の `interactiveWidget: "resizes-content"` があってこそ）
      className="h-dvh flex-col overflow-hidden md:flex-row"
    >
      <ProjectRail
        activeProjectId={projectId}
        activeForkThreadId={stack.forkThreadId}
        width={sidebar.width}
        // ドラッグ中は覚えない（描画だけ）。手を離した1回だけ覚える
        onResize={(next) => setSidebarWidth(next, { persist: false })}
        onResizeEnd={(next) => setSidebarWidth(next)}
        onOpenInbox={() => stack.open({ overlay: "inbox" })}
        onOpenPalette={() => stack.open({ overlay: "palette" })}
        onOpenArchive={() => stack.open({ overlay: "archive" })}
      />
      {/* モバイルは専用の上部バーを持たない（決定・2026-09-09）——ナビは各パネルの
          ヘッダ左端の ≡（MobileNavDrawer）に寄せ、常時2段だったヘッダを1段にした */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      {CONNECTED_FEATURES.inbox ? (
        <InboxOverlay
          open={stack.overlay === "inbox"}
          onOpenChange={(open) => (open ? stack.open({ overlay: "inbox" }) : stack.close("overlay"))}
        />
      ) : null}
      <CommandPalette
        projectId={projectId}
        stack={stack}
        open={stack.overlay === "palette"}
        onOpenChange={(open) => (open ? stack.open({ overlay: "palette" }) : stack.close("overlay"))}
      />
      {SHOW_ARCHIVE ? (
        <ArchiveDialog
          projectId={projectId}
          open={stack.overlay === "archive"}
          onOpenChange={(open) => (open ? stack.open({ overlay: "archive" }) : stack.close("overlay"))}
          onReopenFork={(threadId) => stack.open({ fork: threadId, overlay: null })}
        />
      ) : null}
    </SidebarProvider>
  );
}
