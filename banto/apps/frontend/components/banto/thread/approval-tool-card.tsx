"use client";

// 承認ゲート（§6.0・§6.4）——呼ぶ前に人に見せて拒否できる機構。Elicitation
// （HumanToolCard）とは別物：tool はまだ呼ばれておらず、承認して初めて実行される。
// 機構は human tool とまったく同じにする（unstable_humanToolNames + addResult）
// ——assistant-ui 独自の `approval`/`respondToApproval` は、承認直後に result が
// 無くても shouldContinue の内部 do-while が回り続ける前提で作られており、
// こちらの「後から addResult する」設計と噛み合わせるとスタックする事故を
// 実測で踏んだ（規則1）。一度動作確認できた経路（human tool）だけを使う
// （規則12）。
import { Ban, ShieldAlert } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { getApprovalResult } from "@/lib/mock/adapter";

export const ApprovalToolCard: ToolCallMessagePartComponent = (props) => {
  const isPending = props.result === undefined;
  const isDeclined =
    !isPending &&
    typeof props.result === "object" &&
    props.result !== null &&
    "error" in props.result;

  return (
    <div className="my-1.5 flex flex-col gap-2 rounded-lg border border-warn/30 bg-warn-soft/50 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
        <ShieldAlert className="size-3.5" />
        実行前の確認——{props.toolName}
      </p>
      <pre className="overflow-auto rounded-md bg-surface p-2 font-mono text-xs text-ink-2">
        {JSON.stringify(props.args, null, 2)}
      </pre>
      {isPending ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => props.addResult?.(getApprovalResult(props.toolCallId))}>
            許可する
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => props.addResult?.({ error: "ユーザーが拒否しました" })}
          >
            拒否する
          </Button>
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          {isDeclined ? (
            <>
              <Ban className="size-3.5" />
              拒否しました
            </>
          ) : (
            "許可され、実行しました"
          )}
        </p>
      )}
    </div>
  );
};
