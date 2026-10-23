// **管理対象 Project のターンが終わったら、メタ Project の専用 Fork に知らせる**（追加・2026-10-23、Backlog #534。アーキ仕様 §4.6
// 「通知——ターンが終わるたびに届いてよい」）。
//
// - 配線は既存の「Thread に届ける」（`ThreadDeliveries.deliver`）に乗せる——届いたら起こす・残してから起こす・ループ防止がそのまま効く。
//   出来事（§4.3 段2）にはしない：届け先は Thread の `managedProjectId` から一意に決まり、人が作る自動化の台帳を介す理由が無い
// - **「本当に人の返事を待っているターンか」は判定しない**——毎回知らせる（通知ストームは許容する、§4.6）。起きた AI が `read_thread`
//   で様子を確かめ、何もしなくてよければ何もしない
// - **まだ渡していない知らせが同じ Thread について残っていれば積み増さない**——AI は読む口で最新を見るので、1件で足りる。
//   積み増すと速度の上限で留めたときに受信箱が埋まる
// - ホップは終わったターンのホップ＋1（§4.3「AI のターンの中から生じたものは、そのターンのホップ＋1」と同じ）——専用 Fork と
//   管理対象の Thread の往復が止まらないとき、連鎖の上限で止まる
// - 送り元（`sender`）は付けない——付けると「返事は承認なし」（§4.2）の対象になる。書くのは `send_message` の承認どおり
// - 冷める前の要約のターンは人のターンではないので知らせない（§3.1）。閉じた専用 Fork・閉じたメタ Project には届けない

import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ThreadState } from "../project-thread/types.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";
import type { ThreadTurns } from "./thread-turns.js";

/** 届けものの送り手の名前（`DeliverInput.from`）——同じ Thread の知らせが残っているかもこれで見る */
export const MANAGED_TURN_FROM = "banto.managed-turn";

export interface ManagedTurnNoticesDeps {
  projectThread: ProjectThreadStore;
  turns: ThreadTurns;
  deliveries: Pick<ThreadDeliveries, "deliver">;
}

export class ManagedTurnNotices {
  constructor(private readonly deps: ManagedTurnNoticesDeps) {
    deps.turns.onChange((change) => {
      if (change.type !== "ended" || change.idleCompaction) return;
      void this.turnEnded(change.threadId, change.hop).catch((err: unknown) =>
        console.warn(`[host] ${change.threadId} のターンの終わりをメタ Project に知らせられませんでした:`, err),
      );
    });
  }

  /** そのターンの Thread の Project を管理対象にしている、開いたメタ Project の専用 Fork に1件ずつ届ける */
  async turnEnded(threadId: string, hop: number): Promise<void> {
    const { projectThread } = this.deps;
    const thread = projectThread.getThread(threadId);
    if (!thread) return;
    const project = projectThread.getProject(thread.projectId);
    if (!project) return;
    for (const fork of this.dedicatedForksFor(thread.projectId)) {
      if (alreadyNotified(fork, threadId)) continue;
      const threadLabel = thread.title ?? (thread.kind === "base" ? "Base Thread" : "Fork Thread");
      const outcome = thread.lastTurn?.outcome;
      await this.deps.deliveries.deliver({
        threadId: fork.id,
        from: MANAGED_TURN_FROM,
        kind: "banto",
        title: `「${project.name}」の ${threadLabel} でターンが終わりました`,
        text: [
          `管理対象の Project「${project.name}」の ${threadLabel} で、AI のターンが終わりました（終わり方：${outcomeLabel(outcome)}）。`,
          `project-id: ${project.id}`,
          `thread-id: ${thread.id}`,
          "人の返事を待っているターンとは限りません。read_thread でこの Thread の様子を確かめ、何もしなくてよければ何もせずに終えてください。",
        ].join("\n"),
        hop: hop + 1,
      });
    }
  }

  /** 管理対象にしている開いたメタ Project の、その Project 用の開いた専用 Fork（どの Fork がどの Project 用かは Thread から引く） */
  private dedicatedForksFor(projectId: string): ThreadState[] {
    const { projectThread } = this.deps;
    return projectThread
      .listProjects()
      .filter((p) => p.kind === "meta" && p.status === "active" && (p.managedProjectIds ?? []).includes(projectId))
      .flatMap((meta) =>
        projectThread
          .listThreadsForProject(meta.id)
          .filter((t) => t.kind === "fork" && t.status === "active" && t.managedProjectId === projectId),
      );
  }
}

/**
 * **その Thread が受け持つ管理対象 Project**（`read_thread` の `readableProjectOf`、アーキ仕様 §4.6「読む」）。開いたメタ Project の
 * 開いた専用 Fork で、その Project がいまも管理対象に選ばれているときだけ。知らせを届ける先（`dedicatedForksFor`）と同じ条件
 */
export function managedProjectOf(projectThread: ProjectThreadStore, threadId: string): string | undefined {
  const thread = projectThread.getThread(threadId);
  if (!thread?.managedProjectId || thread.kind !== "fork" || thread.status !== "active") return undefined;
  const meta = projectThread.getProject(thread.projectId);
  if (meta?.kind !== "meta" || meta.status !== "active") return undefined;
  return (meta.managedProjectIds ?? []).includes(thread.managedProjectId) ? thread.managedProjectId : undefined;
}

function alreadyNotified(fork: ThreadState, threadId: string): boolean {
  return (fork.deliveries ?? []).some((d) => d.from === MANAGED_TURN_FROM && d.text.includes(`thread-id: ${threadId}\n`));
}

function outcomeLabel(outcome: string | undefined): string {
  if (outcome === "completed") return "最後まで";
  if (outcome === "stopped") return "止められた";
  if (outcome === "failed") return "失敗";
  return "不明";
}
