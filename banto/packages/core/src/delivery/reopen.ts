// **開き直したら、閉じている間に溜まった届いたもので AI を起こす**（決定・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を
// 閉じる」）。閉じた Thread・Project への届いたものは `ThreadDeliveries` が留めておく（holdReason）。開き直す口（HTTP・
// この先の別の口）は記録を変えたあと、ここを通って起こす——起こし方を口ごとに書かない。速度・連鎖の上限は `kick` の中で今までどおり効く

import type { ProjectThreadStore } from "../project-thread/store.js";
import type { ProjectId, ThreadId } from "../project-thread/types.js";
import { remoteNameOf, type RemoteRuntimes } from "../runtime/remote-runtimes.js";
import type { ThreadDeliveries } from "./thread-deliveries.js";

export interface ReopenDeps {
  projectThread: ProjectThreadStore;
  /** 別のサーバの Project を再開するとき、その実行場所が空いているかを確かめる（無ければ確かめない——試験の最小構成） */
  remoteRuntimes?: RemoteRuntimes;
  /** 無ければ起こさない（届ける仕組みを繋いでいない host・試験） */
  deliveries?: ThreadDeliveries;
}

export async function reopenThread(deps: ReopenDeps, id: ThreadId): Promise<void> {
  await deps.projectThread.reopenThread(id);
  if ((deps.projectThread.getThread(id)?.deliveries?.length ?? 0) > 0) deps.deliveries?.kick(id);
}

/**
 * Project を開き直したら、その中の開いている Thread を起こす（閉じた Thread は閉じたまま留まる——`kick` が断る）。
 * **別のサーバの Project は、閉じている間にその実行場所を別の Project が使い始めていたら断る**（`RemoteRuntimeError` 409・
 * `code: "runtime-taken"`。v4-security.md §1「閉じた Project は数えない」）。作成・移すと同じ鍵で押さえる
 */
export async function reopenProject(deps: ReopenDeps, id: ProjectId): Promise<void> {
  const remote = remoteNameOf(deps.projectThread.getProject(id)?.runtime);
  if (remote && deps.remoteRuntimes) await deps.remoteRuntimes.reopenProjectOn(remote, id, () => deps.projectThread.reopenProject(id));
  else await deps.projectThread.reopenProject(id);
  for (const t of deps.projectThread.listThreadsForProject(id)) {
    if (t.status !== "closed" && (t.deliveries?.length ?? 0) > 0) deps.deliveries?.kick(t.id);
  }
}
