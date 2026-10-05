// docs/specs/v4-frontend.md「Module 間中継の承認（入れ子の承認）」の host 側。
//
// **新しい機構は作らない**（同節）——判断待ち（§2.4）・hold-the-line（§6.0）・
// 会話中のカードという既にあるものを組み合わせるだけ。ここがやるのは、
// 「初回だけ人に聞き、許可されたら Event Store に残して以降は自動で通す」
// （アーキ仕様 §2.5）という判断そのもの。
//
// **permissionMode は見ない**（決定・2026-09-03、docs/specs/v4-frontend.md）
// ——`bypassPermissions` が緩めるのは AI への信用であって、Project の内部配線
// （どの Module が、どの Module の内部 tool に触れてよいか）への信用ではない。
//
// **例外は Project の「承認をすべて自動で許可する」だけ**（改訂・2026-10-05、ユーザー。docs/specs/v4-frontend.md §6.4）。
// permissionMode の軸を混ぜたのではない——あちらは AI への信用、こちらは「この Project では人が承認の役を降りる」という
// 別のスイッチで、中継の承認も含めて全部を通す（コンテナからの `scope` 付きの呼び出し＝秘密を返す `resolveAlias` も、案A）。
// **通しても覚えない**（grant を残さない）——スイッチを切れば、また聞く

import type { InboxStore } from "../inbox/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { RelayCallDescriptor, RelayGrantStore } from "./grants.js";
import { grantKey } from "./grants-fold.js";
import type { ModuleCallTracker } from "./module-calls.js";
import { AUTO_APPROVED_ANSWER_TEXT, AUTO_APPROVED_REASON, raiseAutoApprovedJudgment } from "../inbox/auto-approve.js";

export interface RelayApprovalRequest extends RelayCallDescriptor {
  /** 呼び出し元の**プロセス**の名前（`<Module 名>-<projectId>`）。 */
  callerConnName: string;
  /**
   * 呼び出し元が中継に返した**呼び出しの印**（追加・2026-09-28、`CALL_ID_META_KEY`）。あればその1件の会話で聞く
   * ——同じ Module を2つのターンが同時に使っていても、どちらの会話か決まる
   */
  callerCallId?: string;
}

export interface RelayApprovalDecision {
  allowed: boolean;
  reason: string;
}

export interface RelayApprovalGate {
  requestApproval(req: RelayApprovalRequest): Promise<RelayApprovalDecision>;
}

export interface RelayApprovalGateDeps {
  grants: RelayGrantStore;
  inbox: InboxStore;
  pendingApprovals: PendingApprovalRegistry;
  moduleCalls: ModuleCallTracker;
  /** 走行中のターンの画面へ、判断待ちが出たことを流す（会話の中のカード）。 */
  onJudgmentRaised?(
    threadId: string,
    judgment: { id: string; message: string; serverName: string; toolInput: unknown },
  ): void;
  /**
   * 判断待ちを host の側で畳んだ（聞いた呼び出しが終わった）ことを、その会話の画面へ流す——カードを回答済みにする
   * （追加・2026-10-04）
   */
  onJudgmentSettled?(threadId: string, settled: { id: string; answer: string }): void;
  /**
   * **その Project で「承認をすべて自動で許可する」がオンか**（追加・2026-10-05）。聞くたびに引く——保存した時点で
   * 次の承認から効く。渡されなければ今までどおり聞く
   */
  autoApproveAll?(projectId: string): boolean;
}

/** 聞いた呼び出しが、答えを待たずに終わったとき（AI のターンが終わった・止まった・外側が切れた）の理由。 */
export const RELAY_CALL_ENDED_REASON =
  "承認を聞いた呼び出しが、人が答える前に終わりました（もう一度呼べば、また聞きます）";

/** 1回聞いた結果。`askerEnded`——人が答える前に、聞いた呼び出しが終わって畳んだ */
interface AskOutcome {
  decision: RelayApprovalDecision;
  askerEnded: boolean;
}

/** 判断待ちに出す文と中身。`auto`——「承認をすべて自動で許可する」で聞かずに通したもの（注記だけが違う） */
function describe(req: RelayApprovalRequest, auto: boolean): { message: string; toolInput: Record<string, unknown> } {
  // **何を指しているか**（コンテナからの呼び出しは、それごとに聞く）。名前だけで、値は入らない
  const scopeText =
    req.scope && Object.keys(req.scope).length > 0
      ? `（${Object.entries(req.scope).map(([k, v]) => `${k}: ${v}`).join("、")}）`
      : "";
  const message =
    `Module 間の呼び出しの確認：${req.callerModule} が ${req.targetModule} の ` +
    `${req.name}${scopeText || " "}を呼ぼうとしています`;
  // **記録に残るのは宛名だけ**（アーキ仕様 §2.5）——引数は載せない。
  // 判断待ちは Event Store に積まれるので、秘密の値が混ざる余地を作らない。
  const toolInput = {
    呼び出し元: req.callerModule,
    宛先: req.targetModule,
    種別: req.kind,
    名前: req.name,
    ...(req.scope && Object.keys(req.scope).length > 0 ? { 対象: req.scope } : {}),
    注記: auto
      ? "この Project は「承認をすべて自動で許可する」がオンなので、聞かずに通しました（許可は覚えません。オフにすれば、また聞きます）"
      : req.scope
        ? "許可すると、この Project では同じ組み合わせ・同じ対象を次から自動で通します（対象が違えば、また聞きます）"
        : "許可すると、この Project では同じ組み合わせを次から自動で通します",
  };
  return { message, toolInput };
}

export function createRelayApprovalGate(deps: RelayApprovalGateDeps): RelayApprovalGate {
  /**
   * **聞かずに通す**（追加・2026-10-05、「承認をすべて自動で許可する」）。どの会話の呼び出しか分かれば、そこに答え済みの
   * カードを出す（何を自動で通したかを残す）。分からなくても通す——人はこの Project で承認の役を降りている。
   * **grant は残さない**（覚えると、スイッチを切っても通り続ける）
   */
  async function autoApprove(req: RelayApprovalRequest): Promise<RelayApprovalDecision> {
    const where = deps.moduleCalls.threadFor(req.callerConnName, req.callerCallId);
    if (where.kind === "thread") {
      const { message, toolInput } = describe(req, true);
      const judgment = await raiseAutoApprovedJudgment(deps.inbox, {
        threadId: where.threadId,
        source: "relay",
        message,
        serverName: req.callerModule,
        toolInput,
      });
      deps.onJudgmentRaised?.(where.threadId, { id: judgment.id, message, serverName: req.callerModule, toolInput });
      deps.onJudgmentSettled?.(where.threadId, { id: judgment.id, answer: AUTO_APPROVED_ANSWER_TEXT });
    }
    return { allowed: true, reason: AUTO_APPROVED_REASON };
  }

  /** 同じ組み合わせの2本目以降は、1本目の答えに相乗りする——カードを増やさない。 */
  const inFlight = new Map<string, Promise<AskOutcome>>();

  async function ask(req: RelayApprovalRequest): Promise<AskOutcome> {
    // **聞いた呼び出しが終わったら畳む**（追加・2026-10-04、ユーザー報告「publishService が承認待ちで止まる」）。
    // 答える口（会話のカード）は、その呼び出しのターンの中にしか出ない（受信箱は Thread を開くだけ）。以前は
    // 呼び出しが終わっても待ち続け、カードの無い判断待ちが残り、次の呼び出しはそこに相乗りして**カードが二度と
    // 出なかった**。畳めば、次の呼び出しでまた聞く（いまのターンにカードが出る）
    let ended = false;
    /** 畳んだのはこちら（人の拒否ではない） */
    let expired = false;
    let judgmentId: string | undefined;
    let threadId: string | undefined;
    const stopWatching = deps.moduleCalls.whenEnded(req.callerConnName, req.callerCallId, () => {
      ended = true;
      if (judgmentId === undefined) return;
      const denied = { behavior: "deny" as const, message: RELAY_CALL_ENDED_REASON };
      if (deps.pendingApprovals.resolve(judgmentId, denied)) {
        expired = true;
        const id = judgmentId;
        void deps.inbox.answerJudgment(id, denied).then(
          () => deps.onJudgmentSettled?.(threadId!, { id, answer: RELAY_CALL_ENDED_REASON }),
          () => undefined,
        );
      }
    });
    try {
      const decision = await askWhileCalling(req, {
        isEnded: () => ended,
        markExpired: () => {
          expired = true;
        },
        isExpired: () => expired,
        raised: (id, thread) => {
          judgmentId = id;
          threadId = thread;
        },
      });
      return { decision, askerEnded: expired };
    } finally {
      stopWatching();
    }
  }

  async function askWhileCalling(
    req: RelayApprovalRequest,
    watch: { isEnded(): boolean; markExpired(): void; isExpired(): boolean; raised(judgmentId: string, threadId: string): void },
  ): Promise<RelayApprovalDecision> {
    const where = deps.moduleCalls.threadFor(req.callerConnName, req.callerCallId);
    if (where.kind !== "thread") {
      // **決められないなら通さない**（規則2）。どの会話で聞けばよいか分からない
      // まま許可すると、人が見ていないところで内部配線が開くことになる。
      return {
        allowed: false,
        reason:
          where.kind === "none"
            ? "どのターンからの呼び出しか特定できません（走行中の tool 呼び出しがありません）"
            : "同じ Module を複数のターンが同時に使っているため、どの会話で確認すべきか決められません",
      };
    }

    const { message, toolInput } = describe(req, false);
    // **その中継が属する AI の tool 呼び出し**（追加・2026-10-05）——起き直したあと、承認を待ったまま無効になった呼び出しを
    // 続きの文に書くため（`turn-continuation.ts`）。決まらなければ付けない
    const withinToolCallId = deps.moduleCalls.toolUseIdFor(req.callerConnName, req.callerCallId);
    const judgment = await deps.inbox.raiseJudgment({
      threadId: where.threadId,
      source: "relay",
      message,
      serverName: req.callerModule,
      toolInput,
      ...(withinToolCallId ? { withinToolCallId } : {}),
    });
    watch.raised(judgment.id, where.threadId);
    deps.onJudgmentRaised?.(where.threadId, {
      id: judgment.id,
      message,
      serverName: req.callerModule,
      toolInput,
    });

    // **答えを待つ。聞いた呼び出しが続く間は待つのをやめない**——外側の呼び出しは、人の答えを待つ間は
    // 上限（60秒）を数えない（`agent-proxy.ts`、改訂・2026-10-04）。呼び出しが終わったら畳む（上の `ask`）
    const answer = await new Promise<{ behavior: string }>((resolve) => {
      deps.pendingApprovals.register(judgment.id, (result) => resolve(result as { behavior: string }));
      // 出している間に呼び出しが終わっていた——待つ相手がいない
      if (watch.isEnded()) {
        const denied = { behavior: "deny" as const, message: RELAY_CALL_ENDED_REASON };
        if (deps.pendingApprovals.resolve(judgment.id, denied)) {
          watch.markExpired();
          void deps.inbox.answerJudgment(judgment.id, denied).then(
            () => deps.onJudgmentSettled?.(where.threadId, { id: judgment.id, answer: RELAY_CALL_ENDED_REASON }),
            () => undefined,
          );
        }
      }
    });

    if (answer.behavior !== "allow") {
      if (watch.isExpired()) return { allowed: false, reason: RELAY_CALL_ENDED_REASON };
      // 拒否は覚えない——覚えると、気が変わったときに戻す口が要る。
      // 次に同じ呼び出しが来たら、もう一度聞く（fail closed のまま）。
      return { allowed: false, reason: "人が拒否しました" };
    }
    // 残すのは**宛名だけ**——プロセスの名前（`shell-<projectId>`）は起動のたびに
    // 変わりうるので、許可の記録には入れない
    await deps.grants.grant({
      projectId: req.projectId,
      callerModule: req.callerModule,
      targetModule: req.targetModule,
      kind: req.kind,
      name: req.name,
      ...(req.scope ? { scope: req.scope } : {}),
    });
    return { allowed: true, reason: "人が許可しました（初回）" };
  }

  return {
    async requestApproval(req) {
      if (deps.grants.isGranted(req)) return { allowed: true, reason: "この Project で承認済み" };
      // Project のための呼び出しだけ（banto 全体の呼び出しは、どの Project のスイッチも効かせない）
      if (req.projectId !== undefined && deps.autoApproveAll?.(req.projectId) === true) return autoApprove(req);

      // **人の答えを待っている間は、外側の呼び出しの上限を数えない**（追加・2026-10-04）——相乗りした呼び出しも
      const release = deps.moduleCalls.holdForHuman(req.callerConnName, req.callerCallId);
      try {
        const key = grantKey(req);
        for (;;) {
          const running = inFlight.get(key);
          if (!running) {
            const pending = ask(req).finally(() => inFlight.delete(key));
            inFlight.set(key, pending);
            return (await pending).decision;
          }
          const joined = await running;
          // **相乗りした先が、聞いた呼び出しの終わりで畳まれた**（追加・2026-10-05、
          // docs/notes/2026-10-05-relay-stale-card.md）。人は何も答えていない——こちらの呼び出しがまだ続いていれば、
          // こちらの会話で聞き直す（以前は畳まれた理由をそのまま受け取り、こちらのターンには一度もカードが出なかった）
          if (joined.askerEnded && deps.moduleCalls.isRunning(req.callerConnName, req.callerCallId)) {
            if (deps.grants.isGranted(req)) return { allowed: true, reason: "この Project で承認済み" };
            continue;
          }
          return joined.decision;
        }
      } finally {
        release();
      }
    },
  };
}
