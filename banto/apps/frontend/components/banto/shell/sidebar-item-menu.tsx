"use client";

// **その項目への操作**（決定・2026-09-11、ユーザー要望）。Project と Fork で
// 同じものを使う（規則3）。出し方は2つ、中身は1つ：
//
//  - **右クリック**（タッチは長押し）——その場で出る
//  - **「…」ボタン**（改訂・2026-09-11、ユーザー要望）——行にマウスを乗せると出る。
//    右クリックを知らなくても辿り着ける口（狭い画面ではいつも出しておく）
//
// **項目の並びはここに1つだけ持つ**——2つのメニューに同じ内容を書き写さない。
//
// 「上へ／下へ」も置く理由：並べ替えは掴んで動かすのが主だが、**掴めない人・
// 掴めない場面**（キーボード、細いレール、タッチ）でも並べ替えられるようにする。
// 出ている操作が、その場の入力手段で必ず効く（規則13）。
import { Fragment, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil } from "lucide-react";
import { CloseIcon, type IconComponent } from "@/components/banto/thread/thread-icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { RenameDialog } from "./rename-dialog";

interface MenuEntry {
  label: string;
  icon: IconComponent;
  onSelect?: () => void;
  /** この項目の前に区切りを引く */
  separatorBefore?: boolean;
}

export function SidebarItemMenu({
  what,
  name,
  onRename,
  onMoveUp,
  onMoveDown,
  onClose,
  moreClassName,
  children,
}: {
  /** 何の名前か（「Project」「Fork Thread」）。ダイアログの題に出る */
  what: string;
  name: string;
  onRename: (name: string) => Promise<void>;
  /** 並びの端なら undefined——押せない項目として出す（隠さない。端に居ることが分かる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Close（Fork だけ）。削除ではなく整理——閉じた Fork は履歴から開き直せる */
  onClose?: () => void;
  /** 「…」ボタンの位置合わせ（既定は行の右端） */
  moreClassName?: string;
  /** 行そのもの。引数の「…」ボタンを行の中の好きな場所に置く */
  children: (more: ReactNode) => ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);

  const entries: MenuEntry[] = [
    { label: "名前を変える…", icon: Pencil, onSelect: () => setRenaming(true) },
    { label: "上へ移動", icon: ArrowUp, onSelect: onMoveUp, separatorBefore: true },
    { label: "下へ移動", icon: ArrowDown, onSelect: onMoveDown },
    ...(onClose ? [{ label: "Close", icon: CloseIcon, onSelect: onClose, separatorBefore: true }] : []),
  ];

  const more = (
    <DropdownMenuTrigger asChild>
      <SidebarMenuAction
        showOnHover
        data-testid="sidebar-item-more"
        aria-label={`「${name}」の操作`}
        className={cn("text-ink-3", moreClassName)}
      >
        <MoreHorizontal />
      </SidebarMenuAction>
    </DropdownMenuTrigger>
  );

  return (
    <>
      {/* Dropdown が外側——「…」は行（ContextMenu の対象）の中に置くので、
          Root はその外に無いと Trigger が自分の Root を見つけられない */}
      <DropdownMenu>
        <ContextMenu>
          <ContextMenuTrigger asChild>{children(more)}</ContextMenuTrigger>
          <ContextMenuContent>
            {entries.map((entry) => (
              <Fragment key={entry.label}>
                {entry.separatorBefore ? <ContextMenuSeparator /> : null}
                <ContextMenuItem disabled={!entry.onSelect} onSelect={() => entry.onSelect?.()}>
                  <entry.icon />
                  {entry.label}
                </ContextMenuItem>
              </Fragment>
            ))}
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenuContent align="start" className="min-w-40">
          {entries.map((entry) => (
            <Fragment key={entry.label}>
              {entry.separatorBefore ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem disabled={!entry.onSelect} onSelect={() => entry.onSelect?.()}>
                <entry.icon />
                {entry.label}
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
