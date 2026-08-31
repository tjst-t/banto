import type { MockProject } from "./types";

export const mockProjects: readonly MockProject[] = [
  { id: "banto", name: "banto", initial: "b", baseThreadId: "banto-base" },
  { id: "home", name: "自宅サーバ", initial: "自", baseThreadId: "home-base" },
  { id: "hermes", name: "記憶の検証", initial: "記", baseThreadId: "hermes-base" },
];

export function getProject(id: string): MockProject {
  return mockProjects.find((p) => p.id === id) ?? mockProjects[0];
}
