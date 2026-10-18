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
  /**
   * **まとめて呼ぶ口**（追加・2026-10-18、`docs/specs/v4-modules.md`「秘密をまとめて引く」）。このとき `name` は
   * `batchOf.tool`（1件ずつの口、`resolveAlias`）で、鍵はそれで作る——今までに1件ずつ許したものがそのまま効く。
   * `name`（ここ）は実際に呼んだ口（`resolveAliases`、カードに出す）。`scopes` はコンテナからの呼び出しの要素ごとの識別子
   * ——1件ごとに鍵を作り、まだ許していないものだけを1枚のカードで聞き、許可は1件ずつ覚える。無ければ鍵は1つ（`scope` を見る）
   */
  batch?: { name: string; size: number; scopes?: Record<string, string>[] };
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
  autoApproveAll?(projectId: string, threadId?: string): boolean;
}

/** 聞いた呼び出しが、答えを待たずに終わったとき（AI のターンが終わった・止まった・外側が切れた）の理由。 */
export const RELAY_CALL_ENDED_REASON =
  "承認を聞いた呼び出しが、人が答える前に終わりました（もう一度呼べば、また聞きます）";

/** 1回聞いた結果。`askerEnded`——人が答える前に、聞いた呼び出しが終わって畳んだ */
interface AskOutcome {
  decision: RelayApprovalDecision;
  askerEnded: boolean;
}

/**
 * その呼び出しで照らす承認の鍵（宛名）。まとめて呼ぶ口のコンテナからの呼び出しは要素ごと（同じものは1つに）、
 * ほかは1つ。**残すのは宛名だけ**——プロセスの名前（`shell-<projectId>`）は起動のたびに変わりうるので入れない
 */
function descriptorsOf(req: RelayApprovalRequest): RelayCallDescriptor[] {
  const base: RelayCallDescriptor = {
    projectId: req.projectId,
    callerModule: req.callerModule,
    targetModule: req.targetModule,
    kind: req.kind,
    name: req.name,
  };
  if (req.projectId === undefined) delete base.projectId;
  const scopes = req.batch?.scopes;
  if (!scopes) return [{ ...base, ...(req.scope ? { scope: req.scope } : {}) }];
  const byKey = new Map<string, RelayCallDescriptor>();
  for (const scope of scopes) {
    const d = { ...base, scope };
    byKey.set(grantKey(d), d);
  }
  return [...byKey.values()];
}

/**
 * 判断待ちに出す文と中身。`auto`——「承認をすべて自動で許可する」で聞かずに通したもの（注記だけが違う）。
 * `pending`——まだ許していない鍵（まとめて呼ぶ口は、これだけを並べる）
 */
function describe(
  req: RelayApprovalRequest,
  pending: RelayCallDescriptor[],
  auto: boolean,
): { message: string; toolInput: Record<string, unknown> } {
  if (req.batch) {
    const scoped = req.batch.scopes !== undefined;
    const countText = scoped
      ? `（まとめて ${req.batch.size} 件のうち、まだ許していない ${pending.length} 件）`
      : `（まとめて ${req.batch.size} 件）`;
    const message =
      `Module 間の呼び出しの確認：${req.callerModule} が ${req.targetModule} の ` + `${req.batch.name}${countText}を呼ぼうとしています`;
    const toolInput = {
      呼び出し元: req.callerModule,
      宛先: req.targetModule,
      種別: req.kind,
      名前: req.batch.name,
      // 要素ごとの識別子（名前だけで、値は入らない）。画面は1行1件の表で出す
      ...(scoped ? { 対象: pending.map((d) => d.scope ?? {}) } : {}),
      注記: auto
        ? "この Project は「承認をすべて自動で許可する」がオンなので、聞かずに通しました（許可は覚えません。オフにすれば、また聞きます）"
        : scoped
          ? `許可すると、この Project では並べた対象を1件ずつ覚え、次から ${req.name} でもまとめた呼び出しでも自動で通します（対象が違えば、また聞きます）`
          : "許可すると、この Project では同じ組み合わせを次から自動で通します",
    };
    return { message, toolInput };
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
  async function autoApprove(req: RelayApprovalRequest, pending: RelayCallDescriptor[]): Promise<RelayApprovalDecision> {
    const where = deps.moduleCalls.threadFor(req.callerConnName, req.callerCallId);
    if (where.kind === "thread") {
      // まとめて呼ぶ口も1枚（中に対象の一覧）
      const { message, toolInput } = describe(req, pending, true);
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

  /**
   * 同じ組み合わせの2本目以降は、1本目の答えに相乗りする——カードを増やさない。まとめた問いは、聞いている鍵すべてで載せる
   * （重なる2つのまとめた呼び出しで、同じ alias のカードを2枚出さない）
   */
  const inFlight = new Map<string, Promise<AskOutcome>>();

  async function ask(req: RelayApprovalRequest, pending: RelayCallDescriptor[]): Promise<AskOutcome> {
    // **聞いた呼び出しが終わったら畳む**（追加・2026-10-04、ユーザー報告「publishService が承認待ちで止まる」）。
    // 答える口（会話のカード）は、その呼び出しのターンの中にしか出ない（受信箱は Thread を開くだけ）。以前は
    // 呼び出しが終わっても待ち続け、カードの無い判断待ちが残り、次の呼び出しはそこに相乗りして**カードが二度と
    // 出なかった**。畳めば、次の呼び出しでまた聞く（いまのターンにカードが出る）
    let ended = false;
    /** 畳んだのはこちら（人の拒否ではない） */
    let expired = false;
    let judgmentId: string | undefined;
    let threadId: string | undefined;
    /**
     * 畳むときの受信箱への書き込み。**書き終えてから返す**（追加・2026-10-06、Backlog #216 と同じ形。Fable のレビュー）
     * ——返った時点で判断待ちが live のままだと、相乗りの列（inFlight）が先に空き、次の同じ組み合わせが新しい判断待ちを
     * 出して一瞬 live が2つになる。試験も負荷のもとで古い判断待ちを live と見る
     */
    let folding: Promise<unknown> | undefined;
    const fold = (id: string, thread: string, denied: { behavior: "deny"; message: string }): void => {
      folding = deps.inbox.answerJudgment(id, denied).then(
        () => deps.onJudgmentSettled?.(thread, { id, answer: RELAY_CALL_ENDED_REASON }),
        (err: unknown) => console.warn(`[relay] 終わった呼び出しの判断待ち ${id} を畳めませんでした: ${String(err)}`),
      );
    };
    const stopWatching = deps.moduleCalls.whenEnded(req.callerConnName, req.callerCallId, () => {
      ended = true;
      if (judgmentId === undefined) return;
      const denied = { behavior: "deny" as const, message: RELAY_CALL_ENDED_REASON };
      if (deps.pendingApprovals.resolve(judgmentId, denied)) {
        expired = true;
        fold(judgmentId, threadId!, denied);
      }
    });
    try {
      const decision = await askWhileCalling(req, pending, {
        isEnded: () => ended,
        markExpired: () => {
          expired = true;
        },
        isExpired: () => expired,
        raised: (id, thread) => {
          judgmentId = id;
          threadId = thread;
        },
        fold,
      });
      return { decision, askerEnded: expired };
    } finally {
      stopWatching();
      if (folding) await folding;
    }
  }

  async function askWhileCalling(
    req: RelayApprovalRequest,
    pending: RelayCallDescriptor[],
    watch: {
      isEnded(): boolean;
      markExpired(): void;
      isExpired(): boolean;
      raised(judgmentId: string, threadId: string): void;
      fold(judgmentId: string, threadId: string, denied: { behavior: "deny"; message: string }): void;
    },
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

    const { message, toolInput } = describe(req, pending, false);
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
          watch.fold(judgment.id, where.threadId, denied);
        }
      }
    });

    if (answer.behavior !== "allow") {
      if (watch.isExpired()) return { allowed: false, reason: RELAY_CALL_ENDED_REASON };
      // 拒否は覚えない——覚えると、気が変わったときに戻す口が要る。
      // 次に同じ呼び出しが来たら、もう一度聞く（fail closed のまま）。
      return { allowed: false, reason: "人が拒否しました" };
    }
    // 残すのは**宛名だけ**（`descriptorsOf`）。まとめて呼ぶ口は、並べた鍵を1件ずつ
    for (const d of pending) await deps.grants.grant(d);
    return { allowed: true, reason: "人が許可しました（初回）" };
  }

  /** 呼び出しの会話が決まらない（候補が複数）なら、どれもが自動で許可してよいときだけ */
  function mayAutoApprove(projectId: string, req: RelayApprovalRequest): boolean {
    const allowed = deps.autoApproveAll;
    if (!allowed) return false;
    const where = deps.moduleCalls.threadFor(req.callerConnName, req.callerCallId);
    const threads = where.kind === "thread" ? [where.threadId] : where.kind === "ambiguous" ? where.threadIds : [undefined];
    return threads.every((t) => allowed(projectId, t));
  }

  return {
    async requestApproval(req) {
      const all = descriptorsOf(req);
      const ungranted = () => all.filter((d) => !deps.grants.isGranted(d));
      if (ungranted().length === 0) return { allowed: true, reason: "この Project で承認済み" };
      // Project のための呼び出しだけ（banto 全体の呼び出しは、どの Project のスイッチも効かせない）
      // 呼び出しの会話も渡す——判断役の会話には効かせない（§4.3）
      if (req.projectId !== undefined && mayAutoApprove(req.projectId, req)) return autoApprove(req, ungranted());

      // **人の答えを待っている間は、外側の呼び出しの上限を数えない**（追加・2026-10-04）——相乗りした呼び出しも
      const release = deps.moduleCalls.holdForHuman(req.callerConnName, req.callerCallId);
      try {
        for (;;) {
          // 鍵ごとに引き直す——相乗りした先の許可で埋まったものは、もう聞かない
          const pending = ungranted();
          if (pending.length === 0) return { allowed: true, reason: "この Project で承認済み" };
          const running = pending.map((d) => inFlight.get(grantKey(d))).find((p) => p !== undefined);
          if (!running) {
            // どこにも載っていない未許可だけを、新しく1枚で聞く
            const keys = pending.map(grantKey);
            const asking: Promise<AskOutcome> = ask(req, pending).finally(() => {
              for (const k of keys) if (inFlight.get(k) === asking) inFlight.delete(k);
            });
            for (const k of keys) inFlight.set(k, asking);
            return (await asking).decision;
          }
          const joined = await running;
          // **相乗りした先が、聞いた呼び出しの終わりで畳まれた**（追加・2026-10-05、
          // docs/notes/2026-10-05-relay-stale-card.md）。人は何も答えていない——こちらの呼び出しがまだ続いていれば、
          // こちらの会話で聞き直す（以前は畳まれた理由をそのまま受け取り、こちらのターンには一度もカードが出なかった）
          if (joined.askerEnded && deps.moduleCalls.isRunning(req.callerConnName, req.callerCallId)) continue;
          // 相乗りした先の答えが拒否なら、こちらも断る
          if (!joined.decision.allowed) return joined.decision;
          // 許可でも、こちらの未許可がまだ残っていれば（別の問いに載っている・どこにも載っていない）続ける
          if (ungranted().length === 0) return joined.decision;
        }
      } finally {
        release();
      }
    },
  };
}
