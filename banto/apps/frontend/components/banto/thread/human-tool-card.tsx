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
import { InlineModuleView, RealInlineModuleView } from "@/components/banto/thread/inline-module-view";
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
import { getRealInlineView, sendRealAnswer } from "@/lib/backend/adapter";
import type { MockElicitationForm, MockElicitationUrl } from "@/lib/mock/types";

interface HumanToolArgs {
  serverName: string;
  message: string;
  /** 承認する tool の引数（§6.0「サーバを呼ぶ前に人に見せる」・決定・2026-09-06）。 */
  toolInput?: unknown;
  /** false＝答えても元の呼び出しには届かない（Elicitation由来、§2.4.1）。 */
  answerable?: boolean;
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
    // **inline の Canvas はここには出さない**（決定・2026-09-07、ユーザー指摘）。
    // tool コールの折りたたみの中に入れると、人が畳んだ瞬間に画面が消える
    // ——出すのは HumanAwareToolGroup の**外側**（§6.2）
    return <ToolFallback {...props} />;
  }

  return <HumanJudgmentCard {...props} />;
};

/** 判断待ちの本体。hooksを使うのでカードを分けている
 *  （HumanToolCard は tool の種類ごとに早期returnするため、上では呼べない）。 */
const HumanJudgmentCard: ToolCallMessagePartComponent = (props) => {
  const args = props.args as unknown as HumanToolArgs;
  // 実Threadでは、答えてもhostから次の何かが届くまでpartsが更新されない
  // （更新はlib/backend/adapter.tsのyield経由）。その隙にフォームが出たままだと
  // 二重に答えられてしまうので、送った時点でこちら側でも畳む。
  const [answeredHere, setAnsweredHere] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // 答えても元の呼び出しに届かないものには、答える口を出さない
  // （規則13——押せるのに繋がっていない状態を残さない。決定・2026-09-06）
  const answerable = args.answerable !== false;
  const isPending = props.status?.type === "requires-action" && answeredHere === null && answerable;
  const answer = typeof props.result === "string" ? props.result : answeredHere;

  return (
    <div
      data-role="judgment-card"
      className="my-1.5 flex flex-col gap-2 rounded-lg border border-turn/30 bg-turn-soft/50 p-3"
    >
      <p className="text-xs font-semibold text-turn">
        {args.serverName} があなたの判断を待っています
      </p>
      <p className="text-sm text-foreground">{args.message}</p>
      {args.toolInput !== undefined ? (
        // **何を承認するのか**をそのまま出す（§6.0）。これが無いと
        // runCommand を中身を見ないまま許可することになる
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 p-2 text-xs text-ink-2">
          {JSON.stringify(args.toolInput, null, 2)}
        </pre>
      ) : null}
      {sendError ? <p className="text-xs text-destructive">{sendError}</p> : null}
      {!answerable ? (
        <p className="text-xs text-ink-3">
          この問いはまだ banto に繋がっていません——ここで答えても元の処理には届かず、
          呼び出し側のタイムアウトを待つことになります。
        </p>
      ) : null}
      {isPending ? (
        <ElicitationFormView
          elicitation={args.elicitation}
          onAnswered={async (value) => {
            // 実banto hostのThreadなら、答えを/api/inbox/:id/answer経由で送る
            // ——これが実際にcanUseToolのPromiseを解決する（lib/backend/adapter.ts）。
            let sentToHost: boolean;
            try {
              sentToHost = await sendRealAnswer(props.toolCallId, value);
            } catch (err) {
              // 押したのに何も起きない、を作らない（規則2）
              setSendError(
                `答えを送れませんでした：${err instanceof Error ? err.message : String(err)}`,
              );
              return;
            }
            setAnsweredHere(value);
            // **実Threadでは addResult を呼ばない**——待っているのはhost側であって
            // ランタイムではない。ここで結果を入れるとランタイムがrunを起こし直し、
            // 既存contentと再yield分が連結されてtoolCallIdが重複する
            // （`Duplicate key toolCallId-…`——実測・2026-09-06）。
            // 台本のThreadは従来どおりaddResultだけで完結する。
            if (!sentToHost) props.addResult?.(value);
          }}
        />
      ) : (
        <p className="text-xs text-ink-3">{answer !== null ? `回答：${answer}` : "回答済みです"}</p>
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
 * **inline の Canvas は、tool コールの折りたたみの外に並べる**
 * （決定・2026-09-07、ユーザー指摘）。きっかけは tool 呼び出しでも、これは
 * 人が見て操作する面であって AI の作業ログではない。畳める領域に入れると、
 * 人が畳んだ瞬間に「出したはずの画面」が消える。
 *
 * **部品ごとに読む**——`useAuiState` の selector が毎回新しい配列を返すと
 * 再描画が止まらなくなり、画面ごと落ちる（実測・2026-09-07）。
 */
function InlineViewForPart({ index }: { index: number }) {
  const part = useAuiState((s) => s.message.parts[index]);
  if (!part || part.type !== "tool-call" || part.result === undefined) return null;

  const real = getRealInlineView(part.toolCallId);
  if (real) {
    return (
      <RealInlineModuleView
        view={real}
        toolCallId={part.toolCallId}
        toolName={part.toolName}
        result={part.result}
      />
    );
  }
  const mock = getInlineView(part.toolCallId);
  if (mock) {
    return <InlineModuleView moduleId={mock.moduleId} viewId={mock.viewId} toolName={part.toolName} />;
  }
  return null;
}

export function HumanAwareToolGroup({
  group,
  children,
}: PropsWithChildren<{ group: ThreadGroupPart }>) {
  const isRequiresAction = group.status.type === "requires-action";
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
