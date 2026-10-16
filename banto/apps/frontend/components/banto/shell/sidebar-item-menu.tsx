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
import { ArrowDown, ArrowUp, Check, FolderInput, FolderPlus, MoreHorizontal, Pencil } from "lucide-react";
import { CloseIcon, ForkIcon, type IconComponent } from "@/components/banto/thread/thread-icons";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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

/** 「グループへ移す」（追加・2026-10-16、v4-frontend.md §6.43）。Project の行だけ */
export interface GroupMenu {
  groups: ReadonlyArray<{ id: string; name: string; dotClass: string }>;
  /** いま入っているグループ（無ければ null） */
  current: string | null;
  /** null＝グループに入れない */
  onPick: (groupId: string | null) => void;
  /** 新しいグループを作って入れる */
  onNew: () => void;
}

export function SidebarItemMenu({
  what,
  name,
  onRename,
  onMoveUp,
  onMoveDown,
  onClose,
  onFork,
  groupMenu,
  moreClassName,
  children,
}: {
  /** 何の名前か（「Project」「Fork Thread」）。ダイアログの題に出る */
  what: string;
  name: string;
  /** 名前を変える。無ければ項目を出さない（Base Thread の行——名前は固定） */
  onRename?: (name: string) => Promise<void>;
  /** 並びの端なら undefined——押せない項目として出す（隠さない。端に居ることが分かる） */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Close（Fork だけ）。削除ではなく整理——閉じた Fork は履歴から開き直せる */
  onClose?: () => void;
  /** 「ここから Fork…」（Thread の行。Base でも Fork でも、2026-10-11） */
  onFork?: () => void;
  /** 「グループへ移す」の中身。無ければ項目を出さない */
  groupMenu?: GroupMenu;
  /** 「…」ボタンの位置合わせ（既定は行の右端） */
  moreClassName?: string;
  /** 行そのもの。引数の「…」ボタンを行の中の好きな場所に置く */
  children: (more: ReactNode) => ReactNode;
}) {
  const [renaming, setRenaming] = useState(false);

  const entries: MenuEntry[] = [
    ...(onFork ? [{ label: "ここから Fork…", icon: ForkIcon, onSelect: onFork }] : []),
    ...(onRename ? [{ label: "名前を変える…", icon: Pencil, onSelect: () => setRenaming(true) }] : []),
    // 並べ替えられない行（Base Thread）には出さない
    ...(onMoveUp !== undefined || onMoveDown !== undefined || onRename
      ? [
          { label: "上へ移動", icon: ArrowUp, onSelect: onMoveUp, separatorBefore: true },
          { label: "下へ移動", icon: ArrowDown, onSelect: onMoveDown },
        ]
      : []),
    ...(onClose ? [{ label: "Close", icon: CloseIcon, onSelect: onClose, separatorBefore: true }] : []),
  ];
  // 先頭に区切りを引かない（「グループへ移す」が先頭にあるときは引く）
  if (entries[0]) entries[0] = { ...entries[0], separatorBefore: groupMenu !== undefined };

  // 「グループへ移す」の中の項目。右クリックと「…」で部品の名前だけが違うので、部品を受け取って組む
  function groupItems(Item: typeof DropdownMenuItem | typeof ContextMenuItem, Separator: typeof DropdownMenuSeparator) {
    if (!groupMenu) return null;
    return (
      <>
        {groupMenu.groups.map((g) => (
          <Item key={g.id} onSelect={() => groupMenu.onPick(g.id)}>
            <span className={cn("size-2 shrink-0 rounded-full", g.dotClass)} />
            <span className="flex-1 truncate">{g.name}</span>
            {groupMenu.current === g.id ? <Check className="text-ink-3" aria-label="いま入っている" /> : null}
          </Item>
        ))}
        <Item onSelect={() => groupMenu.onPick(null)}>
          <span className="size-2 shrink-0 rounded-full border border-ink-3" />
          <span className="flex-1">グループに入れない</span>
          {groupMenu.current === null ? <Check className="text-ink-3" aria-label="いま入っている" /> : null}
        </Item>
        <Separator />
        <Item onSelect={groupMenu.onNew}>
          <FolderPlus />
          新しいグループを作って入れる…
        </Item>
      </>
    );
  }

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
            {groupMenu ? (
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <FolderInput />
                  グループへ移す
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-56">{groupItems(ContextMenuItem, ContextMenuSeparator)}</ContextMenuSubContent>
              </ContextMenuSub>
            ) : null}
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
          {groupMenu ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput />
                グループへ移す
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-56">{groupItems(DropdownMenuItem, DropdownMenuSeparator)}</DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
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
      {onRename ? (
        <RenameDialog
          open={renaming}
          onOpenChange={setRenaming}
          what={what}
          currentName={name}
          onSubmit={onRename}
        />
      ) : null}
    </>
  );
}
