"use client";

// 受信箱の見直し（決定・2026-10-15、ユーザー）。左から出る Sheet をやめ、会話と同じく
// **前面に全面の一覧だけ**を出す。行を押したらその会話へ移る（2つに分けて右に会話を出す形は採らない）。
//
// 並び：あなたの判断を待っています → 決めることがあります → 返ってきた会話 → 直してほしいこと。
// 中は新しい順。会話を開いた（押した）ものは一覧から外れる。判断待ちは答えるまで残る。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitFork,
  Hand,
  MessageSquareReply,
  Wrench,
  X,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileNavDrawer } from "@/components/banto/shell/mobile-nav-drawer";
import { getProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  dismissAllReturned,
  dismissFeedItem,
  feedHref,
  getFeedItems,
  sectionOf,
  type FeedItem,
  type FeedSection,
} from "@/lib/mock/inbox-feed";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";

const SECTIONS: { key: FeedSection; label: string; hint: string }[] = [
  { key: "judgment", label: "あなたの判断を待っています", hint: "AI が止まっています" },
  { key: "decide", label: "決めることがあります", hint: "まとめに問いが付いています" },
  { key: "returned", label: "返ってきた会話", hint: "AI の番が終わりました" },
  { key: "fix", label: "直してほしいこと", hint: "banto の仕組みで、あなたの手が要るもの" },
];

export function InboxPage({ projectId, onClose }: { projectId: string | null; onClose: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const isMobile = useIsMobile();
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();
  const items = [...getFeedItems()].sort((a, b) => a.ageMin - b.ageMin);
  const returnedCount = items.filter((i) => sectionOf(i) === "returned").length;

  // Escape で前の画面へ（会話の上の Canvas を閉じるのと同じ感覚）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function open(item: FeedItem) {
    if (item.kind !== "judgment") dismissFeedItem(item.id);
    router.push(feedHref(item));
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="inbox-page">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-2 md:h-11 md:px-3">
        {isMobile ? <MobileNavDrawer projectId={projectId} /> : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">受信箱</p>
        {returnedCount > 0 ? (
          <button
            type="button"
            onClick={dismissAllReturned}
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 hover:bg-accent"
          >
            <CheckCheck className="size-3.5" />
            <span className="hidden sm:inline">返ってきた会話をすべて見たにする</span>
            <span className="sm:hidden">すべて見た</span>
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="受信箱を閉じる"
          className="flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:size-8"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div ref={containerRef} onKeyDown={onKeyDown} className="mx-auto w-full max-w-3xl px-3 pb-16 pt-4 md:px-6 md:pt-6">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-24 text-center">
              <CircleCheck className="size-8 text-ok" />
              <p className="text-sm text-foreground">あなたの番のものはありません</p>
              <p className="text-xs text-ink-3">AI が返してきたら、ここに出ます</p>
            </div>
          ) : (
            SECTIONS.map((section) => {
              const rows = items.filter((i) => sectionOf(i) === section.key);
              if (rows.length === 0) return null;
              return (
                <section key={section.key} className="mb-7">
                  <h2 className="mb-1 flex items-baseline gap-2 px-2">
                    <span
                      className={cn(
                        "text-[13px] font-semibold",
                        section.key === "judgment" || section.key === "decide" ? "text-turn" : "text-foreground",
                      )}
                    >
                      {section.label}
                    </span>
                    <span className="text-xs tabular-nums text-ink-3">{rows.length}</span>
                    <span className="ml-auto hidden text-xs text-ink-3 sm:inline">{section.hint}</span>
                  </h2>
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    {rows.map((item) => (
                      <FeedRow key={item.id} item={item} onOpen={() => open(item)} />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function FeedRow({ item, onOpen }: { item: FeedItem; onOpen: () => void }) {
  const section = sectionOf(item);
  const project = item.projectId ? getProject(item.projectId) : undefined;
  const thread = item.threadId ? getThread(item.threadId) : undefined;
  const where = project ? project.name : "banto 全体";
  const threadName = thread ? (thread.kind === "base" ? "Base Thread" : thread.title) : null;

  return (
    <button
      type="button"
      data-roving-item
      onClick={onOpen}
      className="group flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none md:px-4"
    >
      <RowMark item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <span className="truncate">{where}</span>
          {threadName ? (
            <>
              <span aria-hidden>·</span>
              {thread?.kind === "fork" ? <GitFork className="size-3 shrink-0" /> : null}
              <span className="truncate">{threadName}</span>
            </>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 tabular-nums">{item.age}</span>
        </div>
        <RowBody item={item} />
      </div>
      <span className="mt-6 hidden shrink-0 text-xs text-ink-3 group-hover:inline md:mt-5">
        {section === "fix" && item.kind === "fix" ? item.actionLabel : "会話を開く"} →
      </span>
    </button>
  );
}

function RowMark({ item }: { item: FeedItem }) {
  const base = "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full";
  if (item.kind === "judgment") {
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <Hand className="size-3.5" />
      </span>
    );
  }
  if (item.kind === "fix") {
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <Wrench className="size-3.5" />
      </span>
    );
  }
  if ((item.summary?.decisions.length ?? 0) > 0) {
    return (
      <span className={cn(base, "bg-turn-soft text-turn")}>
        <MessageSquareReply className="size-3.5" />
      </span>
    );
  }
  if (item.interrupted || item.summary?.status === "failed") {
    return (
      <span className={cn(base, "bg-warn-soft text-warn")}>
        <CircleX className="size-3.5" />
      </span>
    );
  }
  if (item.summary?.status === "partial") {
    return (
      <span className={cn(base, "bg-surface-2 text-ink-2")}>
        <CircleDashed className="size-3.5" />
      </span>
    );
  }
  return (
    <span className={cn(base, "bg-ok-soft text-ok")}>
      <CircleCheck className="size-3.5" />
    </span>
  );
}

const STATUS_LABEL = { done: "終わった", partial: "途中まで", failed: "できなかった" } as const;

function RowBody({ item }: { item: FeedItem }) {
  if (item.kind === "judgment") {
    return (
      <>
        <p className="mt-0.5 text-sm text-foreground">{item.message}</p>
        <p className="mt-1 text-xs text-turn">{item.from}——会話で答えてください</p>
      </>
    );
  }
  if (item.kind === "fix") {
    return (
      <>
        <p className="mt-0.5 text-sm font-medium text-foreground">{item.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{item.detail}</p>
      </>
    );
  }
  const decisions = item.summary?.decisions ?? [];
  return (
    <>
      <p className="mt-0.5 line-clamp-2 text-sm text-foreground">
        {item.summary?.headline ?? item.lastReply}
      </p>
      {decisions.length > 0 ? (
        <div className="mt-1.5 rounded-md border-l-2 border-turn bg-turn-soft/60 px-2.5 py-1.5">
          <p className="text-xs font-medium text-foreground">{decisions[0]!.question}</p>
          <p className="mt-0.5 text-xs text-ink-2">
            {decisions[0]!.options.join(" ／ ")}
            {decisions.length > 1 ? <span className="ml-2 text-turn">ほかに {decisions.length - 1} 件</span> : null}
          </p>
        </div>
      ) : item.interrupted ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-warn">
          <AlertTriangle className="size-3" />
          {item.interrupted}
        </p>
      ) : item.summary ? (
        <p className="mt-1 text-xs text-ink-3">結果：{STATUS_LABEL[item.summary.status]}</p>
      ) : (
        <p className="mt-1 text-xs text-ink-3">最後の返事</p>
      )}
    </>
  );
}
