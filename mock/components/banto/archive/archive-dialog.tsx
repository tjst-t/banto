"use client";

// 履歴（決定・2026-09-02、§10 item14 派生）。閉じた Fork Thread と終了した
// Project はスコープが違う（Fork＝この Project の中、Project＝banto 全体）
// ——ここは Command Palette と同じ非対称（Module の入口はいまの Project に
// 限る、§6.3）で自然に扱える。だが「削除ではなく終わっただけ、読み返して
// 再度開ける」という性質は同じなので、1つのモーダルにセクション分けして
// まとめる——Chrome の「最近閉じたタブ」がタブとウィンドウを1つのリストに
// 混在させ、アイコンで区別しているのと同じ発想（規則12）。
// 入口は Base Thread ヘッダー・サイドバー下部の両方から、同じダイアログを
// 開く（use-panel-stack.ts の "archive"）。
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Clock, FolderGit2, GitFork, RotateCcw, Search, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getClosedProjects, reopenProject } from "@/lib/mock/projects";
import { getAllThreadsForProject, getClosedForksForProject, getThreadOverview, reopenThread } from "@/lib/mock/threads";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";
import type { MockProject, MockThread } from "@/lib/mock/types";

function ArchiveRow({
  icon: Icon,
  title,
  subtitle,
  expanded,
  onToggle,
  onReopen,
  children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  onReopen: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        data-roving-item
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 py-2.5 text-left focus-visible:bg-accent focus-visible:outline-none"
      >
        <ChevronRight
          className={cn("mt-0.5 size-3.5 shrink-0 text-ink-3 transition-transform", expanded && "rotate-90")}
        />
        <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{title}</span>
          <span className="text-xs text-ink-3">{subtitle}</span>
        </span>
      </button>
      {expanded ? (
        <div className="mb-3 flex flex-col gap-2 pb-1 pl-10.5">
          {children}
          <button
            type="button"
            onClick={onReopen}
            className="flex items-center justify-center gap-1.5 self-start rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink-2 hover:bg-accent"
          >
            <RotateCcw className="size-3.5" /> 再度開く
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ThreadOverviewContent({ thread }: { thread: MockThread }) {
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

function ProjectOverviewContent({ project }: { project: MockProject }) {
  const threadCount = getAllThreadsForProject(project.id).length;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-surface-2 p-2.5 text-xs text-ink-3">
      <div className="flex items-center justify-between gap-2">
        <span>Base パス</span>
        <span className="truncate font-mono text-ink-2">{project.basePath}</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span>Thread</span>
        <span className="text-ink-2">{threadCount}件</span>
      </div>
    </div>
  );
}

export function ArchiveDialog({
  projectId,
  open,
  onOpenChange,
  onReopenFork,
}: {
  /** null＝いま Project の外（/settings 等）——Fork のセクションは出さない */
  projectId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 再度開いたら、その Fork Thread を実際に表示する（呼び出し側が stack.open する） */
  onReopenFork: (threadId: string) => void;
}) {
  useMockStoreVersion();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();

  const q = query.trim().toLowerCase();
  const closedForks = projectId
    ? getClosedForksForProject(projectId).filter((t) => t.title.toLowerCase().includes(q))
    : [];
  const closedProjects = getClosedProjects().filter((p) => p.name.toLowerCase().includes(q));
  const isEmpty = closedForks.length === 0 && closedProjects.length === 0;

  function toggle(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  // 注意：onOpenChange(false) と、遷移（onReopenFork／router.push）を同じ
  // ハンドラで両方呼ばない——usePanelStack.open() は「そのレンダーの
  // searchParams」から新しい URL を組み立てるので、同じイベントハンドラ内で
  // 2回続けて呼ぶと2回目が1回目の変更をまだ知らず踏みつぶす
  // （Command Palette で踏んだのと同じ罠）。fork の再オープンは呼び出し側が
  // overlay を一緒にクリアする1回の呼び出しにまとめてもらう。Project の
  // 再オープンは新しい URL 全体への遷移なので、それだけで overlay も消える
  function handleReopenFork(threadId: string) {
    reopenThread(threadId);
    setQuery("");
    onReopenFork(threadId);
  }

  function handleReopenProject(id: string) {
    reopenProject(id);
    setQuery("");
    router.push(`/p/${id}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-4 text-ink-3" />
            履歴
          </DialogTitle>
        </DialogHeader>
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名前で検索"
              className="h-8 pl-8"
              autoFocus
            />
          </div>
        </div>
        <div
          ref={containerRef}
          onKeyDown={onKeyDown}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
        >
          {isEmpty ? <p className="px-2 py-6 text-center text-xs text-ink-3">見つからない</p> : null}

          {closedForks.length > 0 ? (
            <div className="mb-3">
              <p className="mb-1 px-1 text-xs font-medium text-ink-3">この Project の閉じた Fork Thread</p>
              {closedForks.map((thread) => (
                <ArchiveRow
                  key={thread.id}
                  icon={GitFork}
                  title={thread.title}
                  subtitle={`畳んだ日：${thread.closedAt}`}
                  expanded={expandedId === thread.id}
                  onToggle={() => toggle(thread.id)}
                  onReopen={() => handleReopenFork(thread.id)}
                >
                  <ThreadOverviewContent thread={thread} />
                </ArchiveRow>
              ))}
            </div>
          ) : null}

          {closedProjects.length > 0 ? (
            <div>
              <p className="mb-1 px-1 text-xs font-medium text-ink-3">終了した Project</p>
              {closedProjects.map((project) => (
                <ArchiveRow
                  key={project.id}
                  icon={FolderGit2}
                  title={project.name}
                  subtitle={`終了日：${project.closedAt}`}
                  expanded={expandedId === project.id}
                  onToggle={() => toggle(project.id)}
                  onReopen={() => handleReopenProject(project.id)}
                >
                  <ProjectOverviewContent project={project} />
                </ArchiveRow>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
