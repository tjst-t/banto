import type { MockMetaProjectSettings, MockProject, ProjectId } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { getSidebarSections } from "./project-org";

// メタ Project（v4-architecture.md §4.6）の設定のモックデータ。UI を固める
// ことが目的——バックエンドとは繋がっていない（`mock/README.md`）。
// Backlog のバックエンドはここに持たない——Backlog Module 自身の設定面
// （project-modules、`lib/mock/backlog.ts` の getBacklogBackend/
// setBacklogBackend）から選ぶ、通常の Module 設定の範囲（レビュー指摘・2026-10-23）

let mockMetaProjectSettings: MockMetaProjectSettings[] = [
  {
    projectId: "orchestrator",
    managedProjectIds: ["banto", "home", "hermes"],
    // 既定は「任せる」（決定・2026-10-23)——このサンプルは既定のまま
    releasePolicy: "delegate",
  },
];

export function getMetaProjectSettings(projectId: ProjectId): MockMetaProjectSettings {
  return (
    mockMetaProjectSettings.find((s) => s.projectId === projectId) ?? {
      projectId,
      managedProjectIds: [],
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
 * 管理対象の候補を、**サイドバーと同じ順序・グループ構造**で返す（決定・2026-10-23、
 * レビュー指摘）——「どこにあるか」を探す手間を減らすため、一覧の真実は project-org.ts
 * の1か所にする（規則３）。スリープ中も含む——管理対象にするかは起きているかで増らすべきではない
 */
export function getManageableProjectSections(metaProjectId: ProjectId) {
  const isCandidate = (p: MockProject) => p.id !== metaProjectId && p.kind !== "meta";
  const sections = getSidebarSections();
  return {
    ungrouped: sections.ungrouped.filter(isCandidate),
    groups: sections.groups
      .map((g) => ({ group: g.group, projects: g.projects.filter(isCandidate) }))
      .filter((g) => g.projects.length > 0),
    sleeping: sections.sleeping.filter(isCandidate),
  };
}
