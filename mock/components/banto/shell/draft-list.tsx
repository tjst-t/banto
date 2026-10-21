"use client";

// サイドバーの「チャット」（モック・2026-10-21、Fork「Project 作成前の検討」）。
//
// Claude のチャットのように、押せばすぐ始まる。名前もフォルダも聞かない。中身は普通の Project。
// 見出しを押すと畳める（Project の一覧を広く使いたいとき）。畳んでいても「＋」で始められる。
// 並ぶのは最近のものだけ（5件まで。残りは「ほかに N 件」）。閉じたチャットは「履歴」に出る。
// 行の右の小さな印でコンテナの様子が分かる：
//   印なし=話すだけ（コンテナを作っていない）／緑の点=試作のコンテナが動いている／月=眠っている
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, MessageSquarePlus, Moon, MoreHorizontal, Plus, Rocket, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { closeDraft, createDraft, getDrafts, type DraftMachine } from "@/lib/mock/drafts";
import { cn } from "@/lib/utils";
import { PromoteDialog } from "@/components/banto/project/promote-dialog";

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

export function DraftList({ activeProjectId, onNavigate }: { activeProjectId: string | null; onNavigate?: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const drafts = getDrafts();
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [promoteId, setPromoteId] = useState<string | null>(null);
  const shown = showAll ? drafts : drafts.slice(0, SHOWN);
  const running = drafts.filter((d) => d.info.machine === "running").length;

  function startNew() {
    const p = createDraft();
    setOpen(true);
    onNavigate?.();
    router.push(`/p/${p.id}`);
  }

  return (
    <SidebarGroup>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent"
      >
        <span>チャット</span>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        {!open && drafts.length > 0 ? (
          <span className="ml-1 font-normal text-ink-3">
            {drafts.length}
            {running > 0 ? `（試作中 ${running}）` : ""}
          </span>
        ) : null}
      </button>
      <SidebarGroupAction onClick={startNew} aria-label="新しいチャット" title="新しいチャット">
        <Plus />
      </SidebarGroupAction>
      {open ? (
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={startNew} className="text-foreground">
                <MessageSquarePlus />
                <span className="truncate">新しいチャット</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {shown.map(({ project, info }) => (
              <SidebarMenuItem key={project.id} className="group/draft">
                <SidebarMenuButton asChild isActive={project.id === activeProjectId} className="pr-7">
                  <Link href={`/p/${project.id}`} onClick={onNavigate}>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
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
          </SidebarMenu>
        </SidebarGroupContent>
      ) : null}
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
