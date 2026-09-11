"use client";

// **右クリック（タッチは長押し）で出る、その項目への操作**
// （決定・2026-09-11、ユーザー要望）。Project と Fork で同じものを使う（規則3）。
//
// 「上へ／下へ」も置く理由：並べ替えは掴んで動かすのが主だが、**掴めない人・
// 掴めない場面**（キーボード、細いレール、タッチ）でも並べ替えられるようにする。
// 出ている操作が、その場の入力手段で必ず効く（規則13）。
import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RenameDialog } from "./rename-dialog";

export function SidebarItemMenu({
  what,
  name,
  onRename,
  onMoveUp,
  onMoveDown,
  children,
}: {
  /** 何の名前か（「Project」「Fork Thread」）。ダイアログの題に出る */
  what: string;
  name: string;
  onRename: (name: string) => Promise<void>;
  /** 並びの端なら undefined——押せない項目として出す（隠さない。端に居ることが分かる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            名前を変える…
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!onMoveUp} onSelect={() => onMoveUp?.()}>
            <ArrowUp />
            上へ移動
          </ContextMenuItem>
          <ContextMenuItem disabled={!onMoveDown} onSelect={() => onMoveDown?.()}>
            <ArrowDown />
            下へ移動
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        what={what}
        currentName={name}
        onSubmit={onRename}
      />
    </>
  );
}
