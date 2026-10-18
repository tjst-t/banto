// **会話のカードで人に聞いて、答えを待つ**——core 自身の tool が承認モードに依らず人に聞くときの共通の形
// （自動化を作る・変える・再開する・消す §4.3——自動許可にも依らず必ず聞く、Memory を取り消す・改める §2.2——自動許可が
// オンなら `autoApprove` で聞かずに通す）。判断待ちを出し、走っているターンの画面へ
// カードを流し、答えか止められるまで待つ。止められたら判断待ちを断りで畳む。
import type { InboxStore } from "./store.js";
import type { JudgmentSource } from "./types.js";
import type { PendingApprovalRegistry } from "./pending-approvals.js";
import { AUTO_APPROVED_ANSWER, AUTO_APPROVED_ANSWER_TEXT } from "./auto-approve.js";

export interface AskInThreadDeps {
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  /** 走っているターンの画面へ、判断待ちが出たことを流す（会話の中の確認のカード） */
  publishJudgment?(
    threadId: string,
    judgment: { id: string; message: string; serverName: string; toolInput: unknown; choices: string[] },
  ): void;
  /** 走っているターンの画面へ、判断待ちに答えが出たことを流す（自動で許可したとき、カードを答え済みにする） */
  publishAnswered?(threadId: string, answered: { id: string; answer: string }): void;
}

export interface AskInThreadInput {
  threadId: string;
  source: JudgmentSource;
  message: string;
  toolInput: Record<string, unknown>;
  choices: readonly string[];
  signal: AbortSignal | undefined;
  /** 止めたターンの判断待ちを畳めなかったときのログの頭 */
  logTag: string;
  /**
   * **聞かずに許可する**（「承認をすべて自動で許可する」がオン。追加・2026-10-18、v4-frontend.md §6.4）。判断待ちは出して
   * すぐ host が答える——会話には「自動で許可しました」のカードが残る。渡すかは呼び元が決める（自動化は渡さない）
   */
  autoApprove?: boolean;
}

export async function askInThread(deps: AskInThreadDeps, input: AskInThreadInput): Promise<{ allowed: boolean; note: string }> {
  const { threadId, message, toolInput, signal } = input;
  if (signal?.aborted) return { allowed: false, note: "（ターンが止まりました）" };
  const choices = [...input.choices];
  const judgment = await deps.inbox.raiseJudgment({
    threadId,
    source: input.source,
    message,
    serverName: "banto",
    toolInput,
    choices,
  });
  deps.publishJudgment?.(threadId, { id: judgment.id, message, serverName: "banto", toolInput, choices });
  if (input.autoApprove === true) {
    await deps.inbox.answerJudgment(judgment.id, AUTO_APPROVED_ANSWER);
    deps.publishAnswered?.(threadId, { id: judgment.id, answer: AUTO_APPROVED_ANSWER_TEXT });
    return { allowed: true, note: "" };
  }

  let folding: Promise<unknown> | undefined;
  const answer = await new Promise<{ behavior: string; message?: unknown }>((resolve) => {
    deps.pendingApprovals.register(judgment.id, (result) => resolve(result as { behavior: string }));
    const fold = (): void => {
      const denied = { behavior: "deny" as const, message: "ターンが止まりました" };
      if (deps.pendingApprovals.resolve(judgment.id, denied)) {
        folding = deps.inbox.answerJudgment(judgment.id, denied).catch((err: unknown) => {
          console.warn(`[${input.logTag}] 止めたターンの判断待ち ${judgment.id} を畳めませんでした: ${String(err)}`);
        });
      }
    };
    // 判断待ちを出している間に止められていたら、聞き手を付けてももう鳴らない——ここで畳む
    if (signal?.aborted) fold();
    else signal?.addEventListener("abort", fold, { once: true });
  });
  if (folding) await folding;
  // 許されたあとでも、その間に止められていたらやらない
  if (signal?.aborted) return { allowed: false, note: "（ターンが止まりました）" };
  if (answer.behavior === "allow") return { allowed: true, note: "" };
  return { allowed: false, note: typeof answer.message === "string" && answer.message !== "" ? `（答え：${answer.message}）` : "" };
}
