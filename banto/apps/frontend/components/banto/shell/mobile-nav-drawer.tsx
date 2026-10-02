"use client";

// モバイルの「どこへ行くか」（決定・2026-09-09、mock/ で形を決めてから持ってきた）。
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
//
// **Drawer 本体は外枠（AppShell）に1つだけ置く**（改訂・2026-10-02、ユーザー要望）。
// 以前は各パネルのヘッダが自分の Drawer を持っていたので、別 Project へ移ると画面ごと
// 作り直され、Drawer も閉じた——別 Project の Fork へ行くには「開く→Project→また開く→Fork」
// の4手が要った。いまは Project を移っても Drawer は残り、その Project の目次を開いて待つ
// （`NavPanel` の `onNavigate`）。ヘッダに置くのは入口のボタン（`MobileNavButton`）だけで、
// Base・Fork・Canvas・設定・ホームのどの面からも同じ Drawer を開く。
import { createContext, useContext, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { usePanelStack } from "./use-panel-stack";
import { NavPanel } from "./nav-panel";

const OpenMobileNavContext = createContext<(() => void) | null>(null);

/**
 * Drawer 本体と、それを開く口。外枠（AppShell）が1つだけ張る——
 * 中の面（Base・Fork・Canvas・設定・ホーム）は `MobileNavButton` を置くだけ
 */
export function MobileNavProvider({
  projectId,
  children,
}: {
  projectId: string | null;
  children: ReactNode;
}) {
  const stack = usePanelStack(projectId ?? "");
  useMockStoreVersion();
  const [open, setOpen] = useState(false);
  const [showNewProject, setShowNewProject] = useState(false);

  return (
    <OpenMobileNavContext.Provider value={() => setOpen(true)}>
      {children}
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
              keepOpenOnProjectSwitch
            />
          </div>
        </DrawerContent>
      </Drawer>
      <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
    </OpenMobileNavContext.Provider>
  );
}

/** ナビの入口（≡）。パネルのヘッダの左端に置く。押すと外枠の Drawer が開く */
export function MobileNavButton() {
  const openNav = useContext(OpenMobileNavContext);
  return (
    <button
      type="button"
      onClick={() => openNav?.()}
      aria-label="Project と Thread の一覧を開く"
      className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-accent"
    >
      <Menu className="size-4" />
    </button>
  );
}
