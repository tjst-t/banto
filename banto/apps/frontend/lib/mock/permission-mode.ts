// Thread 単位の permissionMode（v4-frontend.md §6.4「permissionMode は Thread 単位で
// 選べる」）。**保存するのは「その Thread で人が明示的に切り替えた値」だけ**——
// 切り替えていない Thread は Configuration のカスケード（Project 上書き →
// instance 既定）から毎回導出する（規則3：導出できる値を保存しない）。
//
// **実Threadでは、選んだ値は host が持つ**（決定・2026-09-06、ユーザー報告起点）。
// ここのMapは host の値の写しで、起動時のhydrateで seed する——UI側だけに置くと
// リロードで消え、「いまどのモードで会話しているか」を見失う。§6.4 が
// インジケータを常時表示すると決めた狙い（選んだ後に忘れて事故る、を避ける）が
// リロード1回で崩れていた。
import { getProjectOverrides, mockRuntimeDefaults } from "./settings";
import { notifyMockStoreChange } from "./store-events";
import { getThread } from "./threads";
import { setRealThreadPermissionMode } from "../backend/client";
import type { MockPermissionMode, ProjectId, ThreadId } from "./types";

const threadOverrides = new Map<ThreadId, MockPermissionMode>();

/** Configuration 側の既定（Project 上書きがあればそれ、無ければ instance 既定） */
export function getConfiguredPermissionMode(projectId: ProjectId): MockPermissionMode {
  return getProjectOverrides(projectId).defaultPermissionMode ?? mockRuntimeDefaults.defaultPermissionMode;
}

/** いまその Thread で実際に効いている値 */
export function getThreadPermissionMode(threadId: ThreadId, projectId: ProjectId): MockPermissionMode {
  return threadOverrides.get(threadId) ?? getConfiguredPermissionMode(projectId);
}

/** host が持っている値をこちらへ写す（hydrateRealProjects から呼ぶ）。
 *  **無ければ消す**——「選んでいない」はカスケードから導出する状態であって、
 *  古い写しを残す状態ではない（規則3）。 */
export function seedThreadPermissionMode(threadId: ThreadId, mode: MockPermissionMode | undefined): void {
  if (mode) threadOverrides.set(threadId, mode);
  else threadOverrides.delete(threadId);
}

export function setThreadPermissionMode(threadId: ThreadId, mode: MockPermissionMode): void {
  threadOverrides.set(threadId, mode);
  notifyMockStoreChange();
  // 実Threadなら host にも残す。**失敗を握りつぶさない**（規則2）——
  // 残らなかったのに残ったように見せると、次に開いたとき別のモードで
  // 会話することになる
  if (getThread(threadId)?.real) {
    void setRealThreadPermissionMode(threadId, mode).catch((err: unknown) => {
      console.error("[banto] permissionMode を host に保存できなかった", err);
    });
  }
}
