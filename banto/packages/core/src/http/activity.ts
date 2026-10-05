// **いま banto の中で動いているもの**（決定・2026-09-28、ユーザー「再起動の頃合いを計れるように」）。
//
// host を再起動すると切れてしまうものを数える。数えるのは、どれも host がメモリ（と札の置き場）に持っているものを
// 読むだけ——新しく覚えるものは無い（規則3）：
//
// - **走っているターン**（`ThreadTurns`）——人が送ったもの・届いたもので起きたもの。承認や質問の返事を
//   待って止まっているものは `waitingOnHuman` を立てる（受信箱に答えていない判断待ちがある）。
// - **返事待ちの札**（Thread の `awaitingReplies`）——待たない形で頼んだ仕事（`runInBackground` の
//   サブエージェントなど）。Module が中継で頼んだ仕事の札（Module 宛て、`module-replies.ts`）も同じに数える。
// - **Module の呼び出し**（`ModuleCallTracker`）——ターンの中の tool 呼び出しと、人が画面で押したもの。
//
// **数えないもの**：Service で動かしているもの（コンテナの中の systemd で動き、host を再起動しても切れない）・
// 届いてまだ積んでいないもの（Event Store に残っていて、起動し直したら起こす）。
//
// **起こし直しで待つものと待たないもの**（決定・2026-10-05、アーキ仕様 §2.5「画面から banto を更新する」の待つ段）。
// 起こし直しをまたいで続けられるもの（§2.5「起こし直しをまたいで続ける」）は待たない。待つのは、切れると結果が
// 分からなくなるものだけ（`blocking`）：
//   - 待つ：実行中の Module の呼び出し（ターンの中の tool・人が画面で押したもの・Module 間の中継）／「続けられる」と
//     名乗らない Module の返事待ちの札（Thread 宛て・Module 宛て）——起き直すと「途中で終わりました」になる
//   - 待たない（`continuesAfterRestart`）：走っているターン（tool を呼んでいない間——文を書いている・考えている。
//     起き直したら続く）／名乗った Module の札（起き直したら続けるかを問う）／人の答えを待っている判断待ちと、
//     それで止まっている呼び出し（起き直したら無効になり、続きの AI がもう一度呼べばカードが出直す。待つと人が答える
//     までどこまでも待つ）
// 名乗っているかは札の判定（`delivery/restart-recovery.ts`）と同じ口で見る。閉じた Thread・Project の札は、名乗っていても
// 起き直したら「途中で終わりました」になるので待つ。

import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { ModuleAwaitingReply } from "../delivery/module-replies.js";
import type { ModuleCallTracker } from "../relay/module-calls.js";

export interface ActivityThreadRef {
  projectId?: string;
  projectName?: string;
  threadId: string;
  threadTitle?: string;
}

type Turn = ActivityThreadRef & {
  startedAt: string;
  /** 届いたもので起きたターンは 1 以上、人が送ったものは 0 */
  hop: number;
  /** 同じ Thread で順番を待っている人の発言 */
  queued: number;
  /** 答えていない判断待ちがある（承認・質問） */
  waitingOnHuman: boolean;
};
type AwaitingReply = ActivityThreadRef & { module: string; since: string };
/** Module が中継で頼んだ仕事の返事待ち（`module` が頼んだ先、`caller` が頼んだ Module） */
type ModuleReply = { projectId?: string; projectName?: string; module: string; caller: string; since: string };
type ModuleCall = Partial<ActivityThreadRef> & { connName: string; origin: string };

/** 起こし直しで待つもの・待たないものの1件。どの Project のどの会話の何か */
export type ActivityItem =
  | ({ kind: "turn" } & Turn)
  | ({ kind: "reply" } & AwaitingReply)
  | ({ kind: "moduleReply" } & ModuleReply)
  | ({ kind: "call"; waitingOnHuman: boolean } & ModuleCall);

export interface ActivityReport {
  /** 何も動いていない——いま再起動しても切れるものが無い */
  idle: boolean;
  /** 動いているのが「人の返事を待って止まっているターン」だけ（それとその中の呼び出し） */
  onlyWaitingOnHuman: boolean;
  /**
   * **いま起こし直してよい**（追加・2026-10-05）——切れると結果が分からなくなるもの（`blocking`）が無い。動いている
   * ものがあっても、起き直したあと続く（`continuesAfterRestart`）
   */
  restartable: boolean;
  /** 待つもの：切れると結果が分からなくなる（実行中の呼び出し・名乗らない Module の札） */
  blocking: Array<Extract<ActivityItem, { kind: "call" | "reply" | "moduleReply" }>>;
  /** 待たないもの：起き直したら続く（ターン・名乗った Module の札）か、人の答えを待っていて待つと終わらないもの */
  continuesAfterRestart: ActivityItem[];
  turns: Turn[];
  awaitingReplies: AwaitingReply[];
  /** Module 宛ての返事待ち（追加・2026-10-05。`idle` もこれを数える） */
  moduleReplies: ModuleReply[];
  moduleCalls: ModuleCall[];
  now: string;
}

export function collectActivity(deps: {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  threadTurns?: ThreadTurns;
  moduleCalls?: ModuleCallTracker;
  /** Module 宛ての返事待ち。無ければ無い */
  moduleReplies?: { awaiting(): readonly ModuleAwaitingReply[] };
  /** その Module が「起こし直しても続けられる」と名乗っているか（札の判定と同じ口）。無ければ、どれも名乗っていない */
  resumesAfterRestart?: (target: { moduleName: string; projectId?: string }) => boolean;
}): ActivityReport {
  const projectName = (projectId: string | undefined) =>
    projectId !== undefined ? deps.projectThread.getProject(projectId)?.name : undefined;
  const ref = (threadId: string): ActivityThreadRef => {
    const thread = deps.projectThread.getThread(threadId);
    const name = thread ? projectName(thread.projectId) : undefined;
    return {
      threadId,
      ...(thread ? { projectId: thread.projectId, threadTitle: thread.title } : {}),
      ...(name !== undefined ? { projectName: name } : {}),
    };
  };
  const resumes = (target: { moduleName: string; projectId?: string }) => deps.resumesAfterRestart?.(target) === true;

  const humanWaits = new Set(
    deps.inbox
      .listOpen()
      .filter((i): i is JudgmentItem => i.kind === "judgment" && i.liveness === "live")
      .map((j) => j.threadId),
  );

  const turns = (deps.threadTurns?.list() ?? []).map((t) => ({
    ...ref(t.threadId),
    startedAt: new Date(t.startedAt).toISOString(),
    hop: t.hop,
    queued: t.queued,
    waitingOnHuman: humanWaits.has(t.threadId),
  }));

  const blocking: ActivityReport["blocking"] = [];
  const continuesAfterRestart: ActivityItem[] = turns.map((t) => ({ kind: "turn" as const, ...t }));

  const awaitingReplies: AwaitingReply[] = [];
  for (const p of deps.projectThread.listProjects()) {
    for (const t of deps.projectThread.listThreadsForProject(p.id)) {
      for (const r of t.awaitingReplies ?? []) {
        const reply = { ...ref(t.id), module: r.moduleName, since: r.since };
        awaitingReplies.push(reply);
        // 閉じた Thread・Project の札は、名乗っていても起き直したら「途中で終わりました」（restart-recovery.ts と同じ）
        const open = p.status !== "closed" && t.status !== "closed";
        (open && resumes({ moduleName: r.moduleName, projectId: p.id }) ? continuesAfterRestart : blocking).push({
          kind: "reply",
          ...reply,
        });
      }
    }
  }

  const moduleReplies = (deps.moduleReplies?.awaiting() ?? []).map((a) => {
    const name = projectName(a.projectId);
    return {
      ...(a.projectId ? { projectId: a.projectId } : {}),
      ...(name !== undefined ? { projectName: name } : {}),
      module: a.fromModule,
      caller: a.toModule,
      since: a.since,
    };
  });
  for (const r of moduleReplies) {
    (resumes({ moduleName: r.module, ...(r.projectId ? { projectId: r.projectId } : {}) }) ? continuesAfterRestart : blocking).push({
      kind: "moduleReply",
      ...r,
    });
  }

  const calls = (deps.moduleCalls?.list() ?? []).map((c): ModuleCall & { waitingOnHuman: boolean } => ({
    ...(c.threadId ? ref(c.threadId) : c.projectId ? { projectId: c.projectId } : {}),
    connName: c.connName,
    origin: c.origin,
    waitingOnHuman: c.waitingOnHuman,
  }));
  const turnThreads = new Set(turns.map((t) => t.threadId));
  for (const c of calls) {
    if (!c.waitingOnHuman) blocking.push({ kind: "call", ...c });
    // 人を待っている呼び出しは、ターンの中ならそのターン（の行）と一緒に続く。ターンの外（人が画面で押したもの）だけ足す
    else if (!(c.threadId !== undefined && turnThreads.has(c.threadId))) continuesAfterRestart.push({ kind: "call", ...c });
  }
  const moduleCalls = calls.map(({ waitingOnHuman: _w, ...c }) => c);

  const idle = turns.length === 0 && awaitingReplies.length === 0 && moduleReplies.length === 0 && moduleCalls.length === 0;
  // 止まっているターンの中の呼び出し（承認を待っている Module 間の中継など）は、そのターンと一緒に扱う
  const waitingThreads = new Set(turns.filter((t) => t.waitingOnHuman).map((t) => t.threadId));
  const onlyWaitingOnHuman =
    !idle &&
    turns.every((t) => t.waitingOnHuman) &&
    awaitingReplies.length === 0 &&
    moduleReplies.length === 0 &&
    moduleCalls.every((c) => "threadId" in c && c.threadId !== undefined && waitingThreads.has(c.threadId));

  return {
    idle,
    onlyWaitingOnHuman,
    restartable: blocking.length === 0,
    blocking,
    continuesAfterRestart,
    turns,
    awaitingReplies,
    moduleReplies,
    moduleCalls,
    now: new Date().toISOString(),
  };
}
