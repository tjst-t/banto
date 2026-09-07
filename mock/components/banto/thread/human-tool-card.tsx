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
import { RelayApprovalCard } from "@/components/banto/thread/relay-approval-card";
import { ShellCommandCard } from "@/components/banto/thread/shell-command-card";
import {
  HUMAN_TOOL_NAME,
  MODULE_RELAY_TOOL_NAME,
  SHELL_RUN_COMMAND_TOOL_NAME,
  getInlineView,
  isApprovalGated,
  wasApprovalBypassed,
} from "@/lib/mock/adapter";
import type { MockElicitationForm, MockElicitationUrl } from "@/lib/mock/types";

interface HumanToolArgs {
  serverName: string;
  message: string;
  elicitation: MockElicitationForm | MockElicitationUrl;
}

export const HumanToolCard: ToolCallMessagePartComponent = (props) => {
  // Shell は承認待ち・実行後の両方を1つの専用カードで出す（承認用の別 tool は
  // 作らない、v4-modules.md §2.3「tool は runCommand 1本だけ」）
  if (props.toolName === SHELL_RUN_COMMAND_TOOL_NAME) {
    return <ShellCommandCard {...props} />;
  }
  // host 中継の承認（入れ子の承認）——外側の tool のハンドラの内側で起きる
  if (props.toolName === MODULE_RELAY_TOOL_NAME) {
    return <RelayApprovalCard {...props} />;
  }
  // 専用カードを持たない tool が承認ゲートに掛かったときの一般表示
  if (isApprovalGated(props.toolCallId)) {
    return <ApprovalToolCard {...props} />;
  }
  if (props.toolName !== HUMAN_TOOL_NAME) {
    // MCP Apps の display mode "inline"（§6.2）——結果が揃ってから、
    // Module の Canvas コンテンツを会話のカードに埋め込んで見せる
    // **inline の Canvas はここには出さない**（決定・2026-09-07）
    // ——出すのは HumanAwareToolGroup の外側（§6.2）
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
/**
 * 折りたたみの外に並べる inline の面。**部品ごとに読む**——`useAuiState` の
 * selector が毎回新しい配列を返すと再描画が止まらず、画面ごと落ちる
 * （実測・2026-09-07）。
 */
function InlineViewForPart({ index }: { index: number }) {
  const part = useAuiState((s) => s.message.parts[index]);
  if (!part || part.type !== "tool-call" || part.result === undefined) return null;
  const inlineView = getInlineView(part.toolCallId);
  if (!inlineView) return null;
  return (
    <InlineModuleView
      moduleId={inlineView.moduleId}
      viewId={inlineView.viewId}
      toolName={part.toolName}
    />
  );
}

export function HumanAwareToolGroup({
  group,
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const isRequiresAction = group.status.type === "requires-action";
  // **inline の Canvas は、この折りたたみの外に並べる**（決定・2026-09-07）
  // ——中に入れると、人が畳んだ瞬間に「出したはずの画面」が消える
  // permissionMode が bypassPermissions のため確認を飛ばした呼び出しも自動で開く
  // ——本来なら承認カードとして目に入っていたものが、畳まれて見えなくなるのは
  // 「何が黙って実行されたか分からない」という一番避けたい状態になる
  const hasBypassedApproval = useAuiState((s) =>
    group.indices.some((i) => {
      const part = s.message.parts[i];
      return part?.type === "tool-call" && wasApprovalBypassed(part.toolCallId);
    }),
  );
  const shouldAutoOpen = isRequiresAction || hasBypassedApproval;
  const [open, setOpen] = useState(shouldAutoOpen);
  const [prevShouldAutoOpen, setPrevShouldAutoOpen] = useState(shouldAutoOpen);
  if (shouldAutoOpen !== prevShouldAutoOpen) {
    setPrevShouldAutoOpen(shouldAutoOpen);
    if (shouldAutoOpen) setOpen(true);
  }

  return (
    <>
      <ToolGroupRoot variant="ghost" open={open} onOpenChange={setOpen}>
        <ToolGroupTrigger
          count={group.indices.length}
          active={group.status.type === "running"}
        />
        <ToolGroupContent>{children}</ToolGroupContent>
      </ToolGroupRoot>
      {group.indices.map((index) => (
        <InlineViewForPart key={index} index={index} />
      ))}
    </>
  );
}
