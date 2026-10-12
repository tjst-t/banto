"use client";

// **移している Project の会話の面の帯**（追加・2026-10-12、ユーザー要望。Backlog #270 runtime-move-visible）。
// 別の実行場所へ移している間、その Project の会話（Base・Fork とも）の上に出す。進み具合は移す本体の知らせ
// （`runtime-moves.ts`）。移せなかったら理由（受信箱の知らせと同じ文）に替わり、人が閉じるまで残る。
// 終わったら消える——各 Thread への知らせ（会話の中）が残る
import { ArrowRightLeft, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dismissRuntimeMoveFailure,
  formatMoveBytes,
  useRuntimeMove,
  useRuntimeMoveFailure,
} from "@/lib/backend/runtime-moves";

/** 入力欄を止めている理由（移している間） */
export const RUNTIME_MOVE_COMPOSER_REASON = "別の実行場所へ移している間は送れません。終わると送れるようになります";

export function RuntimeMoveBanner({ projectId }: { projectId: string }) {
  const move = useRuntimeMove(projectId);
  const failure = useRuntimeMoveFailure(projectId);

  if (move) {
    const size =
      move.totalBytes !== undefined && move.totalBytes > 0
        ? `（${formatMoveBytes(Math.min(move.copiedBytes ?? 0, move.totalBytes))} / ${formatMoveBytes(move.totalBytes)}）`
        : "";
    return (
      <div
        role="status"
        data-testid="runtime-move-banner"
        data-state="moving"
        className="flex shrink-0 items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
      >
        <ArrowRightLeft className="mt-0.5 size-4 shrink-0 text-turn" />
        <span className="min-w-0 flex-1">
          <span data-testid="runtime-move-banner-route">
            この Project を {move.from.label} から {move.to.label} へ移しています
          </span>
          <span data-testid="runtime-move-banner-size">{size}</span>。終わるまで会話は止まっています。届いたものは終わってから届きます
        </span>
      </div>
    );
  }

  if (failure) {
    return (
      <div
        role="alert"
        data-testid="runtime-move-banner"
        data-state="failed"
        className="flex shrink-0 items-start gap-2 border-b border-border bg-warn-soft px-3 py-2 text-sm text-warn"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 break-words">
          移せませんでした：<span data-testid="runtime-move-banner-reason">{failure.reason}</span>
          元の {failure.from.label}（{failure.from.root}）のまま動いています
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          aria-label="この知らせを閉じる"
          onClick={() => dismissRuntimeMoveFailure(projectId)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return null;
}
