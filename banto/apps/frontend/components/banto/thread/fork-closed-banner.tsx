"use client";

// **閉じた Fork を開いているときの帯**（決定・2026-10-08、v4-frontend.md §6「Fork を閉じるときの警告」、アーキ仕様 §2.2
// 「AI が自分の Fork を閉じる」）。AI が閉じた・別の画面で閉じた Fork を開いている画面は Base へ飛ばさず、会話の上に
// これを出す。入力欄は開き直すまで使えない（`ThreadPanel` の `closed`）。人がこの画面で閉じたときは今までどおり Base へ戻る
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MockThread } from "@/lib/mock/types";

export function ForkClosedBanner({ thread, onReopen }: { thread: MockThread; onReopen: () => void }) {
  return (
    <div
      role="status"
      data-testid="fork-closed-banner"
      data-closed-by={thread.closedBy}
      className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
    >
      <span className="min-w-0 flex-1">
        この Fork は閉じました{thread.closedReason ? `（${thread.closedReason}）` : ""}
      </span>
      <Button size="sm" variant="outline" onClick={onReopen}>
        <RotateCcw className="size-3.5" />
        開き直す
      </Button>
    </div>
  );
}
