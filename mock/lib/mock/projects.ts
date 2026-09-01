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
    basePath: "~/srv/home-automation",
    status: "active",
  },
  {
    id: "hermes",
    name: "記憶の検証",
    initial: "記",
    baseThreadId: "hermes-base",
    basePath: "~/worktrees/hermes",
    status: "active",
  },
  {
    id: "old-migration",
    name: "旧DBの移行検証",
    initial: "旧",
    baseThreadId: "old-migration-base",
    basePath: "~/worktrees/old-migration",
    status: "closed",
    closedAt: "2026-08-15",
  },
];

export function getAllProjects(): readonly MockProject[] {
  return projects;
}

export function getActiveProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "active");
}

export function getClosedProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "closed");
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
