// **いま banto の中で動いているもの**（決定・2026-09-28、ユーザー「再起動の頃合いを計れるように」）。
//
// host を再起動すると切れてしまうものだけを数える。数えるのは3つで、どれも host がメモリに持っているものを
// 読むだけ——新しく覚えるものは無い（規則3）：
//
// - **走っているターン**（`ThreadTurns`）——人が送ったもの・届いたもので起きたもの。承認や質問の返事を
//   待って止まっているものは `waitingOnHuman` を立てる（受信箱に答えていない判断待ちがある）。
// - **返事待ちの札**（Thread の `awaitingReplies`）——待たない形で頼んだ仕事（`runInBackground` の
//   サブエージェントなど）。再起動すると host が「途中で終わりました」を届ける対象そのもの。
// - **Module の呼び出し**（`ModuleCallTracker`）——ターンの中の tool 呼び出しと、人が画面で押したもの。
//
// **数えないもの**：Service で動かしているもの（コンテナの中の systemd で動き、host を再起動しても切れない）・
// 届いてまだ積んでいないもの（Event Store に残っていて、起動し直したら起こす）。

import type { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadTurns } from "../delivery/thread-turns.js";
import type { ModuleCallTracker } from "../relay/module-calls.js";

export interface ActivityThreadRef {
  projectId?: string;
  projectName?: string;
  threadId: string;
  threadTitle?: string;
}

export interface ActivityReport {
  /** 何も動いていない——いま再起動しても切れるものが無い */
  idle: boolean;
  /** 動いているのが「人の返事を待って止まっているターン」だけ（それとその中の呼び出し） */
  onlyWaitingOnHuman: boolean;
  turns: Array<
    ActivityThreadRef & {
      startedAt: string;
      /** 届いたもので起きたターンは 1 以上、人が送ったものは 0 */
      hop: number;
      /** 同じ Thread で順番を待っている人の発言 */
      queued: number;
      /** 答えていない判断待ちがある（承認・質問） */
      waitingOnHuman: boolean;
    }
  >;
  awaitingReplies: Array<ActivityThreadRef & { module: string; since: string }>;
  moduleCalls: Array<Partial<ActivityThreadRef> & { connName: string; origin: string }>;
  now: string;
}

export function collectActivity(deps: {
  projectThread: ProjectThreadStore;
  inbox: InboxStore;
  threadTurns?: ThreadTurns;
  moduleCalls?: ModuleCallTracker;
}): ActivityReport {
  const ref = (threadId: string): ActivityThreadRef => {
    const thread = deps.projectThread.getThread(threadId);
    const project = thread ? deps.projectThread.getProject(thread.projectId) : undefined;
    return {
      threadId,
      ...(thread ? { projectId: thread.projectId, threadTitle: thread.title } : {}),
      ...(project ? { projectName: project.name } : {}),
    };
  };

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

  const awaitingReplies = deps.projectThread.listProjects().flatMap((p) =>
    deps.projectThread.listThreadsForProject(p.id).flatMap((t) =>
      (t.awaitingReplies ?? []).map((r) => ({ ...ref(t.id), module: r.moduleName, since: r.since })),
    ),
  );

  const moduleCalls = (deps.moduleCalls?.list() ?? []).map((c) => ({
    ...(c.threadId ? ref(c.threadId) : c.projectId ? { projectId: c.projectId } : {}),
    connName: c.connName,
    origin: c.origin,
  }));

  const idle = turns.length === 0 && awaitingReplies.length === 0 && moduleCalls.length === 0;
  // 止まっているターンの中の呼び出し（承認を待っている Module 間の中継など）は、そのターンと一緒に扱う
  const waitingThreads = new Set(turns.filter((t) => t.waitingOnHuman).map((t) => t.threadId));
  const onlyWaitingOnHuman =
    !idle &&
    turns.every((t) => t.waitingOnHuman) &&
    awaitingReplies.length === 0 &&
    moduleCalls.every((c) => "threadId" in c && c.threadId !== undefined && waitingThreads.has(c.threadId));

  return { idle, onlyWaitingOnHuman, turns, awaitingReplies, moduleCalls, now: new Date().toISOString() };
}
