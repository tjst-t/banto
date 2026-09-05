// Thread 単位の permissionMode（v4-frontend.md §6.4「permissionMode は Thread 単位で
// 選べる」）。**保存するのは「その Thread で人が明示的に切り替えた値」だけ**——
// 切り替えていない Thread は Configuration のカスケード（Project 上書き →
// instance 既定）から毎回導出する（規則3：導出できる値を保存しない）。
// 切り替えはセッション内にだけ効き、他の Thread・新しい会話には影響しない。
import { getProjectOverrides, mockRuntimeDefaults } from "./settings";
import { notifyMockStoreChange } from "./store-events";
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

export function setThreadPermissionMode(threadId: ThreadId, mode: MockPermissionMode): void {
  threadOverrides.set(threadId, mode);
  notifyMockStoreChange();
}
