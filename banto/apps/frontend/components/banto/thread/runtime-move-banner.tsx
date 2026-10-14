"use client";

// **移している Project の会話の面の帯**（追加・2026-10-12、ユーザー要望。Backlog #270 runtime-move-visible）。
// 別の実行場所へ移している間、その Project の会話（Base・Fork とも）の上に出す。進み具合は移す本体の知らせ
// （`runtime-moves.ts`）。移せなかったら理由（受信箱の知らせと同じ文）に替わり、人が閉じるまで残る。
// 移し終えたら「移しました：root は…、元は…に残っています」に替わり、人が閉じるまで残る（追加・2026-10-14、Backlog #293
// ——移す小窓は押したら閉じるので、終わりの結果を出すのはここと設定の欄）
import { ArrowRightLeft, CircleCheck, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MOVE_PHASE_LABEL,
  dismissRuntimeMoveDone,
  dismissRuntimeMoveFailure,
  formatMoveSize,
  useRuntimeMove,
  useRuntimeMoveDone,
  useRuntimeMoveFailure,
} from "@/lib/backend/runtime-moves";

/** 入力欄を止めている理由（移している間） */
export const RUNTIME_MOVE_COMPOSER_REASON = "別の実行場所へ移している間は送れません。終わると送れるようになります";

export function RuntimeMoveBanner({ projectId }: { projectId: string }) {
  const move = useRuntimeMove(projectId);
  const failure = useRuntimeMoveFailure(projectId);
  const done = useRuntimeMoveDone(projectId);

  if (move) {
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
          <span data-testid="runtime-move-banner-size">{formatMoveSize(move)}</span>
          {move.phase ? <span data-testid="runtime-move-banner-phase">——{MOVE_PHASE_LABEL[move.phase]}</span> : null}
          。終わるまで会話は止まっています。届いたものは終わってから届きます
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

  if (done) {
    return (
      <div
        role="status"
        data-testid="runtime-move-banner"
        data-state="done"
        className="flex shrink-0 items-start gap-2 border-b border-border bg-surface-2 px-3 py-2 text-sm text-ink-2"
      >
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
        <span className="min-w-0 flex-1 break-words">
          <MoveDoneText done={done} testIdPrefix="runtime-move-banner" />
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0"
          aria-label="この知らせを閉じる"
          onClick={() => dismissRuntimeMoveDone(projectId)}
        >
          <X className="size-3.5" />
        </Button>
      </div>
    );
  }

  return null;
}

/** 移し終えたときの文（帯と設定の欄で同じ） */
export function MoveDoneText({
  done,
  testIdPrefix,
}: {
  done: { from: { root: string; label: string }; to: { root: string; label: string } };
  testIdPrefix: string;
}) {
  return (
    <>
      {done.to.label} へ移しました。root は{" "}
      <span className="font-mono text-xs" data-testid={`${testIdPrefix}-root`}>
        {done.to.root}
      </span>{" "}
      です。元は {done.from.label} の{" "}
      <span className="font-mono text-xs" data-testid={`${testIdPrefix}-previous`}>
        {done.from.root}
      </span>{" "}
      に残っています。要らなくなったら消してください。
    </>
  );
}
