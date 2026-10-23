import type { MockMetaProjectSettings, ProjectId } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { getAllProjects } from "./projects";

// メタ Project（v4-architecture.md §4.6）の設定のモックデータ。UI を固める
// ことが目的——バックエンドとは繋がっていない（`mock/README.md`）。

let mockMetaProjectSettings: MockMetaProjectSettings[] = [
  {
    projectId: "orchestrator",
    managedProjectIds: ["banto", "home", "hermes"],
    backlogBackend: "gist",
    // 既定は「任せる」（決定・2026-10-23）——このサンプルは既定のまま
    releasePolicy: "delegate",
  },
];

export function getMetaProjectSettings(projectId: ProjectId): MockMetaProjectSettings {
  return (
    mockMetaProjectSettings.find((s) => s.projectId === projectId) ?? {
      projectId,
      managedProjectIds: [],
      backlogBackend: "gist",
      releasePolicy: "delegate",
    }
  );
}

export function setMetaProjectSettings(settings: MockMetaProjectSettings): void {
  const exists = mockMetaProjectSettings.some((s) => s.projectId === settings.projectId);
  mockMetaProjectSettings = exists
    ? mockMetaProjectSettings.map((s) => (s.projectId === settings.projectId ? settings : s))
    : [...mockMetaProjectSettings, settings];
  notifyMockStoreChange();
}

/**
 * このメタ Project が管理対象として選べる Project——自分自身と、他のメタ
 * Project は候補に出さない（メタ Project を入れ子にする話はまだ無い）
 */
export function getManageableProjects(metaProjectId: ProjectId) {
  return getAllProjects().filter((p) => p.id !== metaProjectId && p.kind !== "meta");
}
