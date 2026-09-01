"use client";

// 閉じた（畳んだ）Fork Thread の一覧（§2.2「会話を畳む」）。削除ではない——
// 会話ログを読み返し、再度開ける。検索は今はタイトルの前方一致だけ
// （本文の全文検索をやるなら索引が要る——HermesAgent のような形。§10 に
// 未決として残す価値がある、モック段では手を出さない）。
import { useState } from "react";
import { Clock, RotateCcw, Search } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { getClosedForksForProject, getThreadOverview, reopenThread } from "@/lib/mock/threads";
import type { MockThread } from "@/lib/mock/types";
import { useMockStoreVersion } from "@/lib/mock/store-events";

function ThreadOverview({ thread }: { thread: MockThread }) {
  const overview = getThreadOverview(thread);
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2.5 text-xs text-ink-2">
      <p className="text-ink-3">{overview.messageCount}件のやり取り</p>
      {overview.firstMessage ? (
        <p>
          <span className="text-ink-3">最初：</span>
          {overview.firstMessage}
        </p>
      ) : null}
      {overview.lastMessage ? (
        <p>
          <span className="text-ink-3">最後：</span>
          {overview.lastMessage}
        </p>
      ) : null}
    </div>
  );
}

export function ClosedForksPanel({
  projectId,
  open,
  onOpenChange,
  onReopen,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 再度開いたら、その Fork Thread を実際に表示する（呼び出し側が stack.open する） */
  onReopen: (threadId: string) => void;
}) {
  useMockStoreVersion();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const closedForks = getClosedForksForProject(projectId).filter((t) =>
    t.title.toLowerCase().includes(query.trim().toLowerCase()),
  );

  function handleReopen(threadId: string) {
    reopenThread(threadId);
    onOpenChange(false);
    onReopen(threadId);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle>閉じた Fork Thread</SheetTitle>
        </SheetHeader>
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="タイトルで検索"
              className="h-8 pl-8"
            />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
          {closedForks.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-ink-3">見つからない</p>
          ) : (
            closedForks.map((thread) => {
              const expanded = expandedId === thread.id;
              return (
                <div key={thread.id} className="border-b border-border last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : thread.id)}
                    className="flex w-full items-start gap-2.5 py-3 text-left"
                  >
                    <Clock className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-foreground">{thread.title}</span>
                      <span className="text-xs text-ink-3">畳んだ日：{thread.closedAt}</span>
                    </span>
                  </button>
                  {expanded ? (
                    <div className="mb-3 flex flex-col gap-2 pb-1 pl-6.5">
                      <ThreadOverview thread={thread} />
                      <button
                        type="button"
                        onClick={() => handleReopen(thread.id)}
                        className="flex items-center justify-center gap-1.5 self-start rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink-2 hover:bg-accent"
                      >
                        <RotateCcw className="size-3.5" /> 再度開く
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
