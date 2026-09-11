"use client";

// **面の題を右クリックすると、名前を変えられる**（決定・2026-09-11、ユーザー要望）。
//
// サイドバーの行と同じことを、いま見ている面の題でもできるようにする
// ——直したいものが目の前にあるのに、サイドバーまで戻る理由が無い。
//
// **出すのは「名前を変える…」だけ。** 並べ替え（上へ／下へ）はサイドバーの
// 一覧の話で、ここには居場所が無い。Close はヘッダにボタンがある。
import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { RenameDialog } from "@/components/banto/shell/rename-dialog";

export interface RenameTarget {
  /** 何の名前か（「Project」「Fork Thread」）。ダイアログの題に出る */
  what: string;
  name: string;
  onRename: (name: string) => Promise<void>;
}

export function RenameOnRightClick({
  target,
  children,
}: {
  /** 無ければ、ただ中身を出すだけ（名前を変えられない面） */
  target?: RenameTarget;
  children: ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);
  if (!target) return <>{children}</>;
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            <Pencil />
            名前を変える…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        what={target.what}
        currentName={target.name}
        onSubmit={target.onRename}
      />
    </>
  );
}
