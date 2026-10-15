"use client";

// AI がきっかけを作るときの確認（決定・2026-10-15、`lib/mock/triggers.ts`）。人が見ていない間に AI が動き続ける
// もとになるので、AI がきっかけを作る・変えるときは会話のカードで人が許す（黙って作らせない）。
//
// 汎用の承認カード（引数の JSON）ではなく、人が決めるのに要るものを文で出す：何が起きたら・何を・どう起こすか・
// 承認の要る操作に当たったらどうなるか。機構は承認ゲートと同じ（result が付くまで作られていない）
import { Ban, Check, Zap } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { getApprovalResult } from "@/lib/mock/adapter";
import { describeSource, type TriggerSource } from "@/lib/mock/triggers";

interface CreateTriggerArgs {
  name: string;
  instruction: string;
  source: TriggerSource;
  target: { kind: "dedicated"; mode: "fresh" | "continue" } | { kind: "thread"; threadTitle: string };
}

export const TriggerProposalCard: ToolCallMessagePartComponent = (props) => {
  const args = props.args as unknown as CreateTriggerArgs;
  const isPending = props.result === undefined;
  const isDeclined =
    !isPending && typeof props.result === "object" && props.result !== null && "error" in props.result;
  const how =
    args.target.kind === "thread"
      ? `「${args.target.threadTitle}」に届けて`
      : args.target.mode === "fresh"
        ? "毎回まっさらな会話で"
        : "前の回の会話を引き継いで";

  return (
    <div className="my-1.5 flex flex-col gap-2.5 rounded-lg border border-warn/30 bg-warn-soft/50 p-3" data-testid="trigger-proposal">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
        <Zap className="size-3.5" />
        自動で動かしてよいですか
      </p>

      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-foreground">{args.name}</p>
        <p className="text-xs text-ink-2">
          {describeSource(args.source)}に、{how}動きます
        </p>
      </div>

      <blockquote className="rounded-md bg-surface px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-2">
        {args.instruction}
      </blockquote>

      <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-ink-3">
        {args.target.kind === "dedicated" ? (
          <li>専用の Fork「{args.name}」を立て、そこで AI が動きます。</li>
        ) : null}
        <li>確認が要る操作に当たったら、あなたの答えを待って止まります。</li>
        <li>あとで Project の設定の「自動で動かす」から止めたり消したりできます。</li>
      </ul>

      {isPending ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => props.addResult?.({ error: "ユーザーが拒否しました" })}>
            作らない
          </Button>
          <Button size="sm" onClick={() => props.addResult?.(getApprovalResult(props.toolCallId))}>
            作る
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
              作りました
            </>
          )}
        </p>
      )}
    </div>
  );
};
