"use client";

// モバイルの「どこへ行くか」（決定・2026-09-09、ユーザー指摘「モバイルも使いにくい」）。
//
// **段を1つに減らす**のが要点だった。従来は上部バー（Project の頭文字＋アイコン9個）と
// 各パネルのヘッダの2段が常に積まれ、履歴・設定は両方の段にあり、しかも
// **Fork Thread へ行く口がモバイルには無かった**（Command Palette で探すしかなかった）。
//
// 代わりに、ナビはパネルのヘッダ左端の1つのボタンに集約し、押すと左から Drawer が出る。
// **中身はデスクトップのサイドバーと同じ `NavPanel`**（規則3）——Project 名も、
// その下の Base/Fork の目次も、モバイルで同じように読める。
//
// Drawer（vaul）は右スワイプで閉じられる——タッチでの「戻る」が自然に手に入る（規則12）。
import { useState } from "react";
import { Menu } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { usePanelStack } from "./use-panel-stack";
import { NavPanel } from "./nav-panel";

/**
 * ナビの入口（≡）と Drawer 本体。パネルのヘッダに1つ置くだけで使える
 * ——受信箱・検索・履歴・新規 Project を開く経路は自分の中に持つ（`usePanelStack`）
 */
export function MobileNavDrawer({ projectId }: { projectId: string | null }) {
  const stack = usePanelStack(projectId ?? "");
  useMockStoreVersion();
  const [open, setOpen] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Project と Thread の一覧を開く"
        className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
      >
        <Menu className="size-4" />
      </button>

      <Drawer open={open} onOpenChange={setOpen} direction="left">
        <DrawerContent className="w-[86%] max-w-xs">
          {/* Drawer は Dialog なので、読み上げ用の題と説明が要る（無いと警告が出る）。
              画面には banto 自身の見出し（NavPanel の title）が出るのでこちらは隠す */}
          <DrawerTitle className="sr-only">Project と Thread の一覧</DrawerTitle>
          <DrawerDescription className="sr-only">
            Project を切り替える、開いている Thread を選ぶ、受信箱・検索・履歴・設定を開く
          </DrawerDescription>
          <div className="flex min-h-0 flex-1 flex-col bg-sidebar text-sidebar-foreground">
            <NavPanel
              activeProjectId={projectId}
              activeForkThreadId={stack.forkThreadId}
              onOpenInbox={() => stack.open({ overlay: "inbox" })}
              onOpenPalette={() => stack.open({ overlay: "palette" })}
              onOpenArchive={() => stack.open({ overlay: "archive" })}
              onNewProject={() => setShowNewProject(true)}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </DrawerContent>
      </Drawer>
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </>
  );
}
