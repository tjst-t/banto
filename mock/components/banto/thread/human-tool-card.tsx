"use client";

// 会話の中で人に聞く tool 呼び出し（Elicitation）のライブ表示。
// 受信箱の判断待ちと見た目の材料は同じ（ElicitationFormView を共有）だが、
// ここは「その場の tool 呼び出しの生存期間の中」でしか意味を持たない
// ——accept/decline/cancel（ここでは addResult 経由の回答）がそのまま
// tool の結果になり、会話が続く。タイムアウトしたらこのカードは消え、
// 記録だけが受信箱に残る（§2.4.1、item13の決定）。
import { useState, type PropsWithChildren } from "react";
import { useAuiState, type ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ToolFallback } from "@/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/components/assistant-ui/elements/tool-group.aui";
import type { ThreadGroupPart } from "@/components/assistant-ui/elements/thread.aui";
import { ApprovalToolCard } from "@/components/banto/thread/approval-tool-card";
import { ElicitationFormView } from "@/components/banto/inbox/elicitation-form";
import { InlineModuleView } from "@/components/banto/thread/inline-module-view";
import { APPROVAL_TOOL_NAME, HUMAN_TOOL_NAME, getInlineView } from "@/lib/mock/adapter";
import type { MockElicitationForm, MockElicitationUrl } from "@/lib/mock/types";

interface HumanToolArgs {
  serverName: string;
  message: string;
  elicitation: MockElicitationForm | MockElicitationUrl;
}

export const HumanToolCard: ToolCallMessagePartComponent = (props) => {
  if (props.toolName === APPROVAL_TOOL_NAME) {
    return <ApprovalToolCard {...props} />;
  }
  if (props.toolName !== HUMAN_TOOL_NAME) {
    // MCP Apps の display mode "inline"（§6.2）——結果が揃ってから、
    // Module の Canvas コンテンツを会話のカードに埋め込んで見せる
    if (props.result !== undefined) {
      const inlineView = getInlineView(props.toolCallId);
      if (inlineView) {
        return <InlineModuleView moduleId={inlineView.moduleId} viewId={inlineView.viewId} props={props} />;
      }
    }
    return <ToolFallback {...props} />;
  }

  const args = props.args as unknown as HumanToolArgs;
  const isPending = props.status?.type === "requires-action";

  return (
    <div className="my-1.5 flex flex-col gap-2 rounded-lg border border-turn/30 bg-turn-soft/50 p-3">
      <p className="text-xs font-semibold text-turn">
        {args.serverName} があなたの判断を待っています
      </p>
      <p className="text-sm text-foreground">{args.message}</p>
      {isPending ? (
        <ElicitationFormView
          elicitation={args.elicitation}
          onAnswered={(answer) => props.addResult?.(answer)}
        />
      ) : (
        <p className="text-xs text-ink-3">
          {typeof props.result === "string" ? `回答：${props.result}` : "回答済みです"}
        </p>
      )}
    </div>
  );
};

// tool-group.aui.tsx の既定（defaultOpen: false）だと、判断待ちの human tool や
// inline 表示の Module Canvas が「N tool call(s)」トグルの中に畳まれて見えなく
// なる——判断待ちは「止まっているものが先」（§2.4.1）で最優先に見えるべきもの、
// inline はその場に埋め込んで見せることが目的（§6.2）なので、どちらも自動で開く。
// ロジックは tool-fallback.aui.tsx の isRequiresAction 自動展開パターンを踏襲。
export function HumanAwareToolGroup({
  group,
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const isRequiresAction = group.status.type === "requires-action";
  const hasInlineView = useAuiState((s) =>
    group.indices.some((i) => {
      const part = s.message.parts[i];
      return part?.type === "tool-call" && getInlineView(part.toolCallId) !== undefined;
    }),
  );
  const shouldAutoOpen = isRequiresAction || hasInlineView;
  const [open, setOpen] = useState(shouldAutoOpen);
  const [prevShouldAutoOpen, setPrevShouldAutoOpen] = useState(shouldAutoOpen);
  if (shouldAutoOpen !== prevShouldAutoOpen) {
    setPrevShouldAutoOpen(shouldAutoOpen);
    if (shouldAutoOpen) setOpen(true);
  }

  return (
    <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
      <ToolGroupTrigger
        count={group.indices.length}
        active={group.status.type === "running"}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
}
