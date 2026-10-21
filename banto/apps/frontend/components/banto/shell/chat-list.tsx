"use client";

// **サイドバーの「チャット」**（追加・2026-10-21、v4-frontend.md §6.53。見本はモック `fork/draft-projects` の
// `mock/components/banto/shell/draft-list.tsx`）。
//
// Project の一覧の上に置く。中身は普通の Project（`kind: "chat"`）で、画面だけ別に扱う：
// - 見出しは「Project」の見出しと同じ形で、右に「畳む・開く」と「＋」（新しいチャットの画面 `/chat/new` を開くだけ——
//   何も作らない）。畳んだかはこの端末に覚える（Project のグループの開閉と同じ）。畳んでいる間は見出しに件数（試作中の数）
// - 行はチャットの題だけ。新しいものから5件、残りは「ほかに N 件」。題を付けている間は「題を考えています…」
// - 行の右の小さな印でコンテナの様子：印なし＝話すだけ（コンテナを作っていない）／緑の点＝試作のコンテナが動いている／
//   月＝眠っている。押すと開く（眠っていれば開いた画面が起こす——Project と同じ）
// - 行の「…」：「Project にする…」「閉じる」
// - 一番下に「閉じたチャット N」。押すと「履歴」と同じ形の小窓（`closed-chats-dialog.tsx`）
import { useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ChevronRight, ChevronsDownUp, ChevronsUpDown, Moon, MoreHorizontal, Plus, Rocket, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UrlLink as Link } from "@/components/banto/url-link";
import { PromoteDialog } from "@/components/banto/project/promote-dialog";
import { closeProject, getChatProjects, getClosedChats, isChatTitling } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { describeFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";
import type { MockProject } from "@/lib/mock/types";
import { ClosedChatsDialog } from "./closed-chats-dialog";

/** 見せる件数（残りは「ほかに N 件」） */
const SHOWN = 5;

const HEADER_BUTTON =
  "flex size-5 items-center justify-center rounded-md text-ink-3 outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring";

/** コンテナの様子。none＝話すだけ（作っていない）／running＝試作のコンテナが動いている／asleep＝眠っている */
type ChatMachine = "none" | "running" | "asleep";

function machineOf(chat: MockProject): ChatMachine {
  if (chat.sleep) return "asleep";
  return chat.prototyping ? "running" : "none";
}

// **畳んだかはこの端末の localStorage**（`banto.sidebarChats.v1`）——host には持たない（Project のグループの開閉と同じ、
// `lib/backend/project-groups.ts`）。開いているのが既定なので、覚えるのは畳んだことだけ
const COLLAPSE_KEY = "banto.sidebarChats.v1";
const collapseListeners = new Set<() => void>();

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(COLLAPSE_KEY, "collapsed");
    else window.localStorage.removeItem(COLLAPSE_KEY);
  } catch {
    // 書けなくても、この画面の中では畳んだまま（次に読み込み直すまで）
  }
  for (const l of collapseListeners) l();
}

function subscribeCollapsed(listener: () => void): () => void {
  collapseListeners.add(listener);
  // ほかのタブで畳んだものも拾う
  function onStorage(e: StorageEvent) {
    if (e.key === COLLAPSE_KEY) listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    collapseListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function MachineMark({ machine }: { machine: ChatMachine }) {
  if (machine === "none") return null;
  const label = machine === "running" ? "試作のコンテナが動いています" : "試作のコンテナは眠っています";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex size-4 shrink-0 items-center justify-center"
          role="img"
          aria-label={label}
          data-testid="sidebar-chat-machine"
          data-machine={machine}
        >
          {machine === "running" ? <span className="size-1.5 rounded-full bg-chart-3" /> : <Moon className="size-3 text-ink-3" />}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function ChatList({ activeProjectId, onNavigate }: { activeProjectId: string | null; onNavigate?: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const pathname = usePathname();
  const chats = getChatProjects();
  const closed = getClosedChats();
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  const [showAll, setShowAll] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const shown = showAll ? chats : chats.slice(0, SHOWN);
  const running = chats.filter((c) => machineOf(c) === "running").length;
  const toggleLabel = collapsed ? "チャットの一覧を開く" : "チャットの一覧を畳む";

  async function close(chat: MockProject) {
    try {
      await closeProject(chat.id);
      // いま開いているチャットを閉じたら、そこに居続けない
      if (pathname.startsWith(`/p/${chat.id}`)) router.push("/");
    } catch (err) {
      toast.error(`「${chat.name}」を閉じられませんでした`, { description: describeFailure(err) });
    }
  }

  return (
    <SidebarGroup data-testid="sidebar-chats">
      {/* 見出し：「Project」の見出しと同じ形 */}
      <div
        className="flex h-8 shrink-0 items-center gap-0.5 rounded-md pr-1 pl-2 text-xs font-medium text-sidebar-foreground/70"
        data-testid="sidebar-chats-heading"
      >
        <span className="flex-1">
          チャット
          {collapsed && chats.length > 0 ? (
            <span className="ml-1.5 font-normal text-ink-3" data-testid="sidebar-chats-count">
              {chats.length}
              {running > 0 ? `（試作中 ${running}）` : ""}
            </span>
          ) : null}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={toggleLabel}
              aria-expanded={!collapsed}
              onClick={() => writeCollapsed(!collapsed)}
              className={HEADER_BUTTON}
            >
              {collapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{collapsed ? "開く" : "畳む"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="新しいチャット"
              onClick={() => {
                onNavigate?.();
                router.push("/chat/new");
              }}
              className={HEADER_BUTTON}
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新しいチャット</TooltipContent>
        </Tooltip>
      </div>
      {collapsed ? null : (
        <SidebarGroupContent>
          <SidebarMenu data-testid="sidebar-chat-list">
            {shown.map((chat) => (
              <SidebarMenuItem key={chat.id} data-testid="sidebar-chat" data-project-id={chat.id}>
                <SidebarMenuButton asChild isActive={chat.id === activeProjectId} className="pr-7">
                  <Link href={`/p/${chat.id}`} onClick={onNavigate}>
                    {isChatTitling(chat) ? (
                      <span className="min-w-0 flex-1 animate-pulse truncate text-ink-3" data-testid="sidebar-chat-name">
                        題を考えています…
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate" data-testid="sidebar-chat-name">
                        {chat.name}
                      </span>
                    )}
                    <MachineMark machine={machineOf(chat)} />
                  </Link>
                </SidebarMenuButton>
                <ChatRowMenu
                  name={isChatTitling(chat) ? "新しいチャット" : chat.name}
                  onPromote={() => setPromoteId(chat.id)}
                  onClose={() => void close(chat)}
                />
              </SidebarMenuItem>
            ))}
            {chats.length > SHOWN ? (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setShowAll((v) => !v)} className="text-ink-3" data-testid="sidebar-chats-more">
                  <ChevronRight className={cn("transition-transform", showAll && "rotate-90")} />
                  <span>{showAll ? "最近のものだけ" : `ほかに ${chats.length - SHOWN} 件`}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            {closed.length > 0 ? (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setClosedOpen(true)} className="text-ink-3" data-testid="sidebar-closed-chats">
                  <Archive />
                  <span className="flex-1 truncate">閉じたチャット</span>
                  <span className="text-xs tabular-nums" data-testid="sidebar-closed-chats-count">
                    {closed.length}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      )}
      <ClosedChatsDialog open={closedOpen} onOpenChange={setClosedOpen} onNavigate={onNavigate} />
      {promoteId ? <PromoteDialog projectId={promoteId} open onOpenChange={(o) => !o && setPromoteId(null)} /> : null}
    </SidebarGroup>
  );
}

/** 行の「…」：Project にする・閉じる */
function ChatRowMenu({ name, onPromote, onClose }: { name: string; onPromote: () => void; onClose: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuAction showOnHover aria-label={`「${name}」の操作`}>
          <MoreHorizontal />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-56">
        <DropdownMenuItem onSelect={onPromote}>
          <Rocket />
          Project にする…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClose}>
          <X />
          閉じる
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
