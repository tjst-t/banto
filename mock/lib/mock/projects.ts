import type { MockProject, MockProjectOverrides } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { createBaseThreadForProject } from "./threads";
import { setProjectOverrides } from "./settings";

let projects: MockProject[] = [
  {
    id: "banto",
    name: "banto",
    initial: "b",
    baseThreadId: "banto-base",
    basePath: "~/worktrees/banto-v4",
    status: "active",
  },
  {
    id: "home",
    name: "自宅サーバ",
    initial: "自",
    baseThreadId: "home-base",
    basePath: "~/banto/home-automation",
    status: "active",
  },
  {
    id: "hermes",
    name: "記憶の検証",
    initial: "記",
    baseThreadId: "hermes-base",
    basePath: "~/banto/hermes",
    status: "active",
  },
  // ── Project の整理のモック（2026-10-16）：グループ・スリープを見せるための Project ──
  {
    id: "qemu-bmc",
    name: "qemu-bmc",
    initial: "q",
    baseThreadId: "qemu-bmc-base",
    basePath: "~/banto/qemu-bmc",
    status: "active",
  },
  {
    id: "site",
    name: "公開サイト",
    initial: "公",
    baseThreadId: "site-base",
    basePath: "~/banto/banto-site",
    status: "active",
  },
  {
    id: "kaggle",
    name: "Kaggle の練習",
    initial: "K",
    baseThreadId: "kaggle-base",
    basePath: "~/banto/kaggle",
    status: "active",
  },
  {
    id: "kakeibo",
    name: "家計簿の整理",
    initial: "家",
    baseThreadId: "kakeibo-base",
    basePath: "~/banto/kakeibo",
    status: "active",
  },
  {
    id: "trip",
    name: "旅行の計画",
    initial: "旅",
    baseThreadId: "trip-base",
    basePath: "~/banto/trip-2026",
    status: "active",
  },
  {
    id: "papers",
    name: "論文メモ",
    initial: "論",
    baseThreadId: "papers-base",
    basePath: "~/banto/papers",
    status: "active",
  },
  {
    id: "proxmox-lab",
    name: "Proxmox の検証",
    initial: "P",
    baseThreadId: "proxmox-lab-base",
    basePath: "~/banto/proxmox-lab",
    status: "active",
  },
  {
    id: "recipe",
    name: "レシピ集",
    initial: "レ",
    baseThreadId: "recipe-base",
    basePath: "~/banto/recipe",
    status: "active",
  },
  {
    id: "old-migration",
    name: "旧DBの移行検証",
    initial: "旧",
    baseThreadId: "old-migration-base",
    basePath: "~/banto/db-migration",
    status: "closed",
    closedAt: "2026-08-15",
  },
];

// 整理のモックで足した Project には Base Thread だけ用意する（中身はダミー）
for (const p of projects) {
  if (["qemu-bmc", "site", "kaggle", "kakeibo", "trip", "papers", "proxmox-lab", "recipe"].includes(p.id)) {
    createBaseThreadForProject(p.id, p.baseThreadId, p.name);
  }
}

export function getAllProjects(): readonly MockProject[] {
  return projects;
}

/** 普通の Project の一覧に並ぶもの（チャットは除く——サイドバーの「チャット」に別に並ぶ） */
export function getActiveProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "active" && !p.draft);
}

/** チャット（下書きの Project）も含めた、開いているもの */
export function getActiveProjectsWithDrafts(): readonly MockProject[] {
  return projects.filter((p) => p.status === "active");
}

/** チャットのモック（drafts.ts）が Project を足す・書き換える口 */
export function addProjectRecord(project: MockProject): void {
  projects = [...projects, project];
}

export function updateProjectRecord(id: string, patch: Partial<MockProject>): void {
  projects = projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

export function getClosedProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "closed" && !p.draft);
}

export function getProject(id: string): MockProject {
  return projects.find((p) => p.id === id) ?? projects[0];
}

export interface NewProjectInput {
  name: string;
  basePath: string;
  /** Advanced で選んだ Configuration の上書き（§2.2「設定のカスケード」） */
  overrides?: Omit<MockProjectOverrides, "projectId" | "securityRoot">;
}

/**
 * 新規 Project を作る（§2.2）。モックなので Module 集合の実配線は行わない——
 * 名前・根・Base Thread が揃った最小の入れ物だけを作る。Advanced で選んだ
 * runtime config の上書きは、そのまま Project 設定画面（§2.10）に反映する
 */
export function createProject(input: NewProjectInput): MockProject {
  const id = `p-${Math.random().toString(36).slice(2, 8)}`;
  const project: MockProject = {
    id,
    name: input.name,
    initial: input.name.slice(0, 1),
    baseThreadId: `${id}-base`,
    basePath: input.basePath,
    status: "active",
  };
  projects = [...projects, project];
  createBaseThreadForProject(project.id, project.baseThreadId, project.name);
  setProjectOverrides({ projectId: id, securityRoot: input.basePath, ...input.overrides });
  notifyMockStoreChange();
  return project;
}

/** Project を終了する（削除ではない——閉じたProjectの一覧から読み返し、再開できる） */
export function closeProject(id: string): void {
  projects = projects.map((p) => (p.id === id ? { ...p, status: "closed", closedAt: "たった今" } : p));
  notifyMockStoreChange();
}

export function reopenProject(id: string): void {
  projects = projects.map((p) => (p.id === id ? { ...p, status: "active", closedAt: undefined } : p));
  notifyMockStoreChange();
}
