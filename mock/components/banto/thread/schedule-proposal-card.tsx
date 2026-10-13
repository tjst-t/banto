"use client";

// AI が予定を作るときの確認（決定・2026-10-13、`lib/mock/schedules.ts`）。人が見ていない間に AI が動き続ける
// もとになるので、AI が予定を作る・変えるときは会話のカードで人が許す（黙って作らせない）。
//
// 汎用の承認カード（引数の JSON）ではなく、人が決めるのに要るものを文で出す：いつ・何を・どう起こすか・
// 承認の要る操作に当たったらどうなるか。機構は承認ゲートと同じ（result が付くまで作られていない）
import { Ban, CalendarClock, Check } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { getApprovalResult } from "@/lib/mock/adapter";
import { describeRepeat, timeZoneLabel, type ScheduleRepeat } from "@/lib/mock/schedules";

interface CreateScheduleArgs {
  name: string;
  instruction: string;
  repeat: ScheduleRepeat;
  timeZone: string;
  mode: "fresh" | "continue";
}

export const ScheduleProposalCard: ToolCallMessagePartComponent = (props) => {
  const args = props.args as unknown as CreateScheduleArgs;
  const isPending = props.result === undefined;
  const isDeclined =
    !isPending && typeof props.result === "object" && props.result !== null && "error" in props.result;

  return (
    <div
      className="my-1.5 flex flex-col gap-2.5 rounded-lg border border-warn/30 bg-warn-soft/50 p-3"
      data-testid="schedule-proposal"
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
        <CalendarClock className="size-3.5" />
        予定を作ってよいですか
      </p>

      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">{args.name}</p>
        <p className="text-xs text-ink-2">
          {describeRepeat(args.repeat)}（{timeZoneLabel(args.timeZone)}）に、
          {args.mode === "fresh" ? "毎回まっさらな会話で" : "前の回の会話を引き継いで"}動きます
        </p>
      </div>

      <blockquote className="rounded-md bg-surface px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-2">
        {args.instruction}
      </blockquote>

      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-ink-3">
        <li>専用の Fork「{args.name}」を立て、時刻が来たらそこで AI が動きます。</li>
        <li>確認が要る操作に当たったら、あなたの答えを待って止まります。</li>
        <li>あとで Project の設定の「予定」から止めたり消したりできます。</li>
      </ul>

      {isPending ? (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.addResult?.({ error: "ユーザーが拒否しました" })}
          >
            作らない
          </Button>
          <Button size="sm" onClick={() => props.addResult?.(getApprovalResult(props.toolCallId))}>
            予定を作る
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          {isDeclined ? (
            <>
              <Ban className="size-3.5" />
              作りませんでした
            </>
          ) : (
            <>
              <Check className="size-3.5 text-ok" />
              予定を作りました。最初は {args.repeat.kind === "weekly" ? "次の週の" : "次の"}時刻に動きます
            </>
          )}
        </p>
      )}
    </div>
  );
};
