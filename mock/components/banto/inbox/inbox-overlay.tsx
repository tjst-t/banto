"use client";

// 受信箱（§2.4）。判断待ち・レビュー待ちの2種類を1つの入れ物にまとめ、
// 判断待ちを先に出す——「止まっているものが先」。
// Project 単位の MCP 接続の外側にある入れ物なので、どの Project を見ていても開ける
// （overlay は searchParams 駆動、usePanelStack 参照）。
import { useState } from "react";
import Link from "next/link";
import { CircleCheck, FolderGit2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getProject } from "@/lib/mock/projects";
import { mockInboxItems } from "@/lib/mock/inbox";
import type { MockInboxItem } from "@/lib/mock/types";
import { cn } from "@/lib/utils";
import { ElicitationFormView } from "./elicitation-form";

export function InboxOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 回答した判断待ちは一覧からその場で取り除く——Event Store の射影として、
  // 「解決済み」は状態として表示せず消える（§2.4.1、2026-08-31）
  const [answeredIds, setAnsweredIds] = useState<ReadonlySet<string>>(new Set());

  const items = [
    ...mockInboxItems.filter((i) => i.kind === "judgment" && !answeredIds.has(i.id)),
    ...mockInboxItems.filter((i) => i.kind === "review"),
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border">
          <SheetTitle>受信箱</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
          {items.map((item) => {
            const project = getProject(item.projectId);
            const expanded = expandedId === item.id;
            return (
              <div key={item.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : item.id)}
                  className="flex w-full items-start gap-2.5 py-3 text-left"
                >
                  {item.kind === "judgment" ? (
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full",
                        item.source === "elicitation" && item.status === "timedOut"
                          ? "bg-muted text-ink-3"
                          : "bg-turn-soft text-turn",
                      )}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                    </span>
                  ) : (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-xs text-ink-3">
                      <FolderGit2 className="size-3" />
                      {project.name}
                      <span aria-hidden>·</span>
                      {item.source === "thread" ? item.threadTitle : item.serverName}
                      <span aria-hidden>·</span>
                      {item.age}
                      {item.kind === "judgment" && item.source === "elicitation" ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className={item.status === "live" ? "text-turn" : undefined}>
                            {item.status === "live" ? "まだ有効" : "期限切れ"}
                          </span>
                        </>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-sm text-foreground">{item.message}</span>
                  </span>
                </button>
                {expanded ? (
                  <div className="pb-3 pl-6.5">
                    <InboxItemDetail
                      item={item}
                      onAnswered={() =>
                        setAnsweredIds((prev) => new Set(prev).add(item.id))
                      }
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InboxItemDetail({
  item,
  onAnswered,
}: {
  item: MockInboxItem;
  onAnswered: () => void;
}) {
  if (item.source === "module") {
    return (
      <Link
        href={`/p/${item.projectId}?canvas=${item.moduleId}:${item.viewId}`}
        className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink-2 hover:bg-accent"
      >
        Canvas を開く
      </Link>
    );
  }

  if (item.source === "thread") {
    const href = item.threadKind === "fork" ? `/p/${item.projectId}?fork=${item.threadId}` : `/p/${item.projectId}`;
    return (
      <Link
        href={href}
        className="inline-flex items-center rounded-md border border-border bg-surface px-2.5 py-1.5 text-sm text-ink-2 hover:bg-accent"
      >
        {item.kind === "judgment" ? "Thread を開いて返信する" : "Thread を開く"}
      </Link>
    );
  }

  return (
    <ElicitationFormView
      elicitation={item.elicitation}
      onAnswered={onAnswered}
      timedOut={item.status === "timedOut"}
    />
  );
}
