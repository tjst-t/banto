"use client";

// Module 間中継の承認（入れ子の承認、v4-frontend.md「Module 間中継の承認」）。
// 外側の tool 呼び出し（Shell の runCommand）は既に承認ゲートを通っていて、
// この確認は**そのハンドラが動いている内側**で新たに発生する——見せ方は
// 既存の承認ゲート（ApprovalToolCard）と同じ枠・同じ機構
// （unstable_humanToolNames + addResult）を使い回す。新しい機構は作らない。
//
// **permissionMode の値は見ない。** bypassPermissions が素通りさせるのは
// `canUseTool`（AI への信用）だけで、こちらは Project の内部配線への信用という
// 別の軸なので、常に初回の確認を行う。
import { Ban, ShieldAlert, ShieldCheck } from "lucide-react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRelayRequest, relayInboxItemId } from "@/lib/mock/adapter";
import { removeInboxItem } from "@/lib/mock/inbox";
import { approveRelay } from "@/lib/mock/relay-approval";
import { cn } from "@/lib/utils";

export const RelayApprovalCard: ToolCallMessagePartComponent = (props) => {
  const req = getRelayRequest(props.toolCallId);
  const isPending = props.result === undefined;
  const isDeclined =
    !isPending && typeof props.result === "object" && props.result !== null && "error" in props.result;
  const isAuto =
    !isPending &&
    typeof props.result === "object" &&
    props.result !== null &&
    (props.result as { decision?: unknown }).decision === "auto-approved";

  if (!req) return null;

  return (
    <div
      className={cn(
        "my-1.5 flex flex-col gap-2 rounded-lg border p-3",
        isPending ? "border-warn/30 bg-warn-soft/50" : "border-border bg-surface-2",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs font-semibold",
          isPending ? "text-warn" : "text-ink-3",
        )}
      >
        {isPending ? <ShieldAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
        Module 間の呼び出しの確認
      </p>
      <p className="text-sm text-foreground">
        {req.caller} が {req.target} の {req.tool} を呼び出そうとしています
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono text-xs">
          呼び出し元: {req.caller}
        </Badge>
        <Badge variant="outline" className="font-mono text-xs">
          宛先: {req.target}
        </Badge>
        <Badge variant="outline" className="font-mono text-xs">
          tool: {req.tool}
        </Badge>
      </div>
      <p className="text-xs text-ink-3">{req.reason}</p>
      {isPending ? (
        <>
          <p className="text-xs text-ink-3">
            許可すると、この Project では同じ組み合わせ（呼び出し元・宛先・tool）を次から自動で通します。
            この確認は permissionMode の設定に関わらず、初回は必ず行います。
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                approveRelay(req.cacheKey);
                removeInboxItem(relayInboxItemId(props.toolCallId));
                props.addResult?.({ decision: "approved" });
              }}
            >
              許可する
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                removeInboxItem(relayInboxItemId(props.toolCallId));
                props.addResult?.({ error: "ユーザーが中継を拒否しました" });
              }}
            >
              拒否する
            </Button>
          </div>
        </>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          {isDeclined ? (
            <>
              <Ban className="size-3.5" />
              拒否しました——中継していません
            </>
          ) : isAuto ? (
            "自動承認——この組み合わせは、この Project で承認済みです"
          ) : (
            "許可され、中継しました"
          )}
        </p>
      )}
    </div>
  );
};
