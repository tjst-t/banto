"use client";

// サイドバーの「チャット」（モック・2026-10-21、Fork「Project 作成前の検討」）。
//
// Claude のチャットのように、「＋」で新しいチャットの画面が開く（この時点では Project を作らない。
// 最初の書き込みで作り、AI が書き込みから題を付ける）。中身は普通の Project。
// 見た目は下の「Project」の一覧に合わせる：見出しの右に「畳む・開く」と「＋」、一番下に「閉じたチャット」
// （押すと「履歴」と同じ形の小窓が開き、そこから開き直す）。
// 並ぶのは最近のものだけ（5件まで。残りは「ほかに N 件」）。
// 行の右の小さな印でコンテナの様子が分かる：
//   印なし=話すだけ（コンテナを作っていない）／緑の点=試作のコンテナが動いている／月=眠っている
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { closeDraft, getClosedDrafts, getDrafts, type DraftMachine } from "@/lib/mock/drafts";
import { cn } from "@/lib/utils";
import { PromoteDialog } from "@/components/banto/project/promote-dialog";
import { ClosedChatsDialog } from "./closed-chats-dialog";

const SHOWN = 5;

export function MachineMark({ machine }: { machine: DraftMachine }) {
  if (machine === "none") return null;
  const label = machine === "running" ? "試作のコンテナが動いています" : "試作のコンテナは眠っています";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-4 shrink-0 items-center justify-center" role="img" aria-label={label}>
          {machine === "running" ? (
            <span className="size-1.5 rounded-full bg-chart-3" />
          ) : (
            <Moon className="size-3 text-ink-3" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

const ICON_BUTTON = "flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground";

export function DraftList({ activeProjectId, onNavigate }: { activeProjectId: string | null; onNavigate?: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const drafts = getDrafts();
  const closed = getClosedDrafts();
  const [open, setOpen] = useState(true);
  const [closedOpen, setClosedOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const shown = showAll ? drafts : drafts.slice(0, SHOWN);
  const running = drafts.filter((d) => d.info.machine === "running").length;

  return (
    <SidebarGroup>
      {/* 見出し：「Project」の見出しと同じ形 */}
      <div className="group/heading flex h-8 shrink-0 items-center gap-0.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70">
        <span className="flex-1">
          チャット
          {!open && drafts.length > 0 ? (
            <span className="ml-1.5 font-normal text-ink-3">
              {drafts.length}
              {running > 0 ? `（試作中 ${running}）` : ""}
            </span>
          ) : null}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={open ? "チャットの一覧を畳む" : "チャットの一覧を開く"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={ICON_BUTTON}
            >
              {open ? <ChevronsDownUp className="size-4" /> : <ChevronsUpDown className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{open ? "畳む" : "開く"}</TooltipContent>
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
              className={ICON_BUTTON}
            >
              <Plus className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">新しいチャット</TooltipContent>
        </Tooltip>
      </div>
      {open ? (
        <SidebarGroupContent>
          <SidebarMenu>
            {shown.map(({ project, info }) => (
              <SidebarMenuItem key={project.id} className="group/draft">
                <SidebarMenuButton asChild isActive={project.id === activeProjectId} className="pr-7">
                  <Link href={`/p/${project.id}`} onClick={onNavigate}>
                    {info.titling ? (
                      <span className="min-w-0 flex-1 animate-pulse truncate text-ink-3">題を考えています…</span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    )}
                    <MachineMark machine={info.machine} />
                  </Link>
                </SidebarMenuButton>
                <DraftMenu
                  name={project.name}
                  onPromote={() => setPromoteId(project.id)}
                  onClose={() => closeDraft(project.id)}
                />
              </SidebarMenuItem>
            ))}
            {drafts.length > SHOWN ? (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setShowAll((v) => !v)} className="text-ink-3">
                  <ChevronRight className={cn("transition-transform", showAll && "rotate-90")} />
                  <span>{showAll ? "最近のものだけ" : `ほかに ${drafts.length - SHOWN} 件`}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            {closed.length > 0 ? (
              /* 一番下の「閉じたチャット」：押すと「履歴」と同じ形の小窓 */
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setClosedOpen(true)} className="text-ink-3">
                  <Archive />
                  <span className="flex-1 truncate">閉じたチャット</span>
                  <span className="text-xs tabular-nums">{closed.length}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
      <ClosedChatsDialog open={closedOpen} onOpenChange={setClosedOpen} onNavigate={onNavigate} />
      {promoteId ? (
        <PromoteDialog projectId={promoteId} open onOpenChange={(o) => !o && setPromoteId(null)} />
      ) : null}
    </SidebarGroup>
  );
}

/** 行の「…」：Project にする・閉じる */
function DraftMenu({ name, onPromote, onClose }: { name: string; onPromote: () => void; onClose: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`「${name}」の操作`}
          className="absolute top-1.5 right-1 flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-accent hover:text-foreground data-[state=open]:opacity-100 md:opacity-0 md:group-hover/draft:opacity-100"
        >
          <MoreHorizontal className="size-4" />
        </button>
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
