"use client";

// **新しい Project の始め方の帯**（追加・2026-10-20、`docs/specs/v4-frontend.md` §6.49 の 5.）。別のサーバに「clone」「新しい
// リポジトリ」で作った Project の会話の上に出す：Module を起こしています（初めてなら数分）→ clone しています（経過 m 分）→
// 終われば閉じる。失敗したら理由と「もう一度」「AI に頼む」（入力欄に頼みを置く）。banto を起こし直して止まったものも同じ。
// 状態は host の記録（`project-starts.ts`）
import { useEffect, useState } from "react";
import { CloudDownload, FolderPlus, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryRealProjectStart, type RealProjectStart } from "@/lib/backend/client";
import { useProjectStart } from "@/lib/backend/project-starts";
import { placeComposerText } from "@/lib/composer-drafts";

/** 経過（分）。1分ごとに描き直す */
function useElapsedMinutes(since: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)) : 0;
}

/** 「AI に頼む」で入力欄に置く頼み */
function askText(start: RealProjectStart, root: string): string {
  return start.kind === "clone"
    ? `${start.url ?? ""} を、この Project の Root（${root}）にそのまま clone してください（Root の直下に中身が来るように）。`
    : `この Project の Root（${root}）で git init してください。`;
}

export function ProjectStartBanner({ projectId, threadId, root }: { projectId: string; threadId: string; root: string }) {
  const start = useProjectStart(projectId);
  const minutes = useElapsedMinutes(start && (start.status === "waking" || start.status === "running") ? start.startedAt : undefined);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (!start) return null;
  const what = start.kind === "clone" ? "clone" : "git init";
  const Icon = start.kind === "clone" ? CloudDownload : FolderPlus;

  if (start.status === "waking" || start.status === "running") {
    return (
      <div
        role="status"
        data-testid="project-start-banner"
        data-state={start.status}
        className="flex shrink-0 items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-turn" />
        <span className="min-w-0 flex-1 break-words" data-testid="project-start-banner-text">
          {start.status === "waking"
            ? `${what} の前に、この Project の Module を起こしています（初めてなら数分かかります）`
            : start.kind === "clone"
              ? `${start.url ?? ""} を clone しています（経過 ${minutes} 分）`
              : "git init しています"}
        </span>
      </div>
    );
  }

  // failed・interrupted
  return (
    <div
      role="alert"
      data-testid="project-start-banner"
      data-state={start.status}
      className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-warn-soft px-3 py-2 text-sm text-warn"
    >
      <span className="flex min-w-0 items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">
          {start.status === "interrupted" ? `${what} は途中で止まりました` : `${what} できませんでした`}
          {start.error ? (
            <>
              ：<span data-testid="project-start-banner-reason">{start.error}</span>
            </>
          ) : null}
          。Project とフォルダはそのまま残っています
        </span>
      </span>
      {retryError ? (
        <span className="pl-6 text-xs break-words" data-testid="project-start-banner-retry-error">
          {retryError}
        </span>
      ) : null}
      <span className="flex gap-2 pl-6">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          data-testid="project-start-retry"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            setRetryError(null);
            retryRealProjectStart(projectId)
              .catch((err: unknown) => setRetryError(err instanceof Error ? err.message : String(err)))
              .finally(() => setRetrying(false));
          }}
        >
          もう一度
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          data-testid="project-start-ask-ai"
          onClick={() => placeComposerText(threadId, askText(start, root))}
        >
          AI に頼む
        </Button>
      </span>
    </div>
  );
}
