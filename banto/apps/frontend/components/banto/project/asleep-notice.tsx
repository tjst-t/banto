"use client";

// **眠っている Project の設定・入口・Module の画面**（追加・2026-10-16、v4-frontend.md §6.43「スリープ」）。
//
// 眠っている Project の画面を開いても Module は起こさない（アーキ §2.2「それ以外の道では起こさない」）——host は
// 409 `asleep` を返す（`ProjectAsleepError`）。画面は「眠っています。起こすと見られます」と「起こす」を出し、押すと
// `modules/prepare`（起こす専用の口は無い）。起きたら `onWoke` で読み直す。
import { useState } from "react";
import { LoaderCircle, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wakeProject } from "@/lib/mock/projects";
import { reportFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";

export function AsleepNotice({
  projectId,
  onWoke,
  className,
}: {
  projectId: string;
  onWoke?: () => void;
  className?: string;
}) {
  const [waking, setWaking] = useState(false);
  async function wake() {
    setWaking(true);
    try {
      await wakeProject(projectId);
      onWoke?.();
    } catch (err) {
      reportFailure("この Project を起こせませんでした", err);
    } finally {
      setWaking(false);
    }
  }
  return (
    <div
      role="status"
      data-testid="project-asleep-notice"
      className={cn("flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-2", className)}
    >
      <Moon className="size-4 shrink-0 text-ink-3" aria-hidden />
      <span className="min-w-0 flex-1">眠っています。起こすと見られます</span>
      <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={waking} onClick={() => void wake()}>
        {waking ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
        {waking ? "起こしています" : "起こす"}
      </Button>
    </div>
  );
}
