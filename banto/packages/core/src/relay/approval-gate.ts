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

import type { InboxStore } from "../inbox/store.js";
import type { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import type { RelayCallDescriptor, RelayGrantStore } from "./grants.js";
import { grantKey } from "./grants-fold.js";
import type { ModuleCallTracker } from "./module-calls.js";

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
}

export function createRelayApprovalGate(deps: RelayApprovalGateDeps): RelayApprovalGate {
  /** 同じ組み合わせの2本目以降は、1本目の答えに相乗りする——カードを増やさない。 */
  const inFlight = new Map<string, Promise<RelayApprovalDecision>>();

  async function ask(req: RelayApprovalRequest): Promise<RelayApprovalDecision> {
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
      注記: req.scope
        ? "許可すると、この Project では同じ組み合わせ・同じ対象を次から自動で通します（対象が違えば、また聞きます）"
        : "許可すると、この Project では同じ組み合わせを次から自動で通します",
    };
    const judgment = await deps.inbox.raiseJudgment({
      threadId: where.threadId,
      source: "relay",
      message,
      serverName: req.callerModule,
      toolInput,
    });
    deps.onJudgmentRaised?.(where.threadId, {
      id: judgment.id,
      message,
      serverName: req.callerModule,
      toolInput,
    });

    // **答えを待つ。待つのをやめない**——外側の tool 呼び出しが MCP の既定
    // タイムアウト（60秒）で先に諦めても、人が後から許可したことは記録に残す。
    // そうしないと「許可したのに次も聞かれる」になり、いつまでも収束しない
    // （§2.4.1「後で答える」と同じ考え方）。
    const answer = await new Promise<{ behavior: string }>((resolve) => {
      deps.pendingApprovals.register(judgment.id, (result) => resolve(result as { behavior: string }));
    });

    if (answer.behavior !== "allow") {
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

      const key = grantKey(req);
      const running = inFlight.get(key);
      if (running) return running;

      const pending = ask(req).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}
