"use client";

// Project の整理（モック・2026-10-16、Fork「Project の整理（サイドバー）」）。
//
// - **グループ**：人が作る見出し。Project は 0 か 1 つのグループに入る（入っていなければ一覧の一番上に見出し無しで並ぶ）。
//   色は5つの決まった色から選ぶ（chart-1〜5）。グループごとに畳める
// - **スリープ**：消さずに脇へ寄せる。一覧の一番下の「スリープ中」に薄く並ぶ。開けば起きる
// - 並び順は手で決める（ドラッグかメニュー）。グループの中も、グループどうしも
//
// 真実はこのファイルの配列1か所。変わったら notifyMockStoreChange で再描画させる。
import { notifyMockStoreChange } from "./store-events";
import { getActiveProjects } from "./projects";

export type GroupColor = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

export const GROUP_COLORS: { id: GroupColor; label: string }[] = [
  { id: "chart-1", label: "青" },
  { id: "chart-3", label: "緑" },
  { id: "chart-4", label: "黄" },
  { id: "chart-2", label: "橙" },
  { id: "chart-5", label: "桃" },
];

/** Tailwind はクラス名を文字列のまま探すので、組み立てずに書き並べる */
export const GROUP_DOT_CLASS: Record<GroupColor, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export interface ProjectGroup {
  id: string;
  name: string;
  color: GroupColor;
  collapsed: boolean;
}

interface OrgState {
  groups: ProjectGroup[];
  /** Project id → グループ id（無ければグループなし） */
  groupOf: Record<string, string>;
  /** 一覧の並び（グループの中もこの順で並ぶ）。載っていない Project は後ろ */
  order: string[];
  /** スリープ中の Project id → いつ眠らせたか（表示用の文字） */
  sleeping: Record<string, string>;
  /** 最後に使ってからの日数（モックの固定値。自動スリープの提案に使う） */
  idleDays: Record<string, number>;
  /** 自動でスリープにする設定 */
  autoSleep: "suggest" | "auto" | "off";
  /** 提案を「今はしない」で消したもの */
  dismissedSuggestions: string[];
  /** 起こしている途中の Project（モックでは数秒で起きる） */
  waking: Record<string, true>;
}

let state: OrgState = {
  groups: [
    { id: "g-dev", name: "開発", color: "chart-1", collapsed: false },
    { id: "g-lab", name: "検証", color: "chart-3", collapsed: false },
    { id: "g-life", name: "くらし", color: "chart-4", collapsed: false },
  ],
  groupOf: {
    banto: "g-dev",
    "qemu-bmc": "g-dev",
    site: "g-dev",
    hermes: "g-lab",
    kaggle: "g-lab",
    "proxmox-lab": "g-lab",
    home: "g-life",
    kakeibo: "g-life",
    trip: "g-life",
    recipe: "g-life",
  },
  order: ["banto", "qemu-bmc", "site", "hermes", "kaggle", "proxmox-lab", "home", "kakeibo", "trip", "recipe", "papers"],
  sleeping: { recipe: "9月20日", "proxmox-lab": "10月2日" },
  idleDays: { banto: 0, "qemu-bmc": 1, site: 0, hermes: 3, kaggle: 16, "proxmox-lab": 30, home: 2, kakeibo: 21, trip: 5, recipe: 40, papers: 0 },
  autoSleep: "suggest",
  dismissedSuggestions: [],
  waking: {},
};

/** 自動スリープを提案するまでの日数（モックの仮の値） */
export const IDLE_DAYS_FOR_SUGGESTION = 14;

function set(next: Partial<OrgState>): void {
  state = { ...state, ...next };
  notifyMockStoreChange();
}

export function getGroups(): readonly ProjectGroup[] {
  return state.groups;
}

export function groupOf(projectId: string): ProjectGroup | undefined {
  const id = state.groupOf[projectId];
  return id ? state.groups.find((g) => g.id === id) : undefined;
}

export function isSleeping(projectId: string): boolean {
  return projectId in state.sleeping;
}

export function sleptAt(projectId: string): string | undefined {
  return state.sleeping[projectId];
}

export function isWaking(projectId: string): boolean {
  return projectId in state.waking;
}

export function idleDays(projectId: string): number {
  return state.idleDays[projectId] ?? 0;
}

export function getAutoSleep(): OrgState["autoSleep"] {
  return state.autoSleep;
}

export function setAutoSleep(mode: OrgState["autoSleep"]): void {
  set({ autoSleep: mode });
}

function sorted<T extends { id: string }>(items: readonly T[]): T[] {
  const index = (id: string) => {
    const i = state.order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...items].sort((a, b) => index(a.id) - index(b.id));
}

/** サイドバーの並び：グループなし → グループ（作った順・並べ替えた順）→ スリープ中 */
export function getSidebarSections() {
  const awake = sorted(getActiveProjects().filter((p) => !isSleeping(p.id)));
  const ungrouped = awake.filter((p) => !groupOf(p.id));
  const groups = state.groups.map((g) => ({ group: g, projects: awake.filter((p) => state.groupOf[p.id] === g.id) }));
  const sleeping = sorted(getActiveProjects().filter((p) => isSleeping(p.id)));
  return { ungrouped, groups, sleeping };
}

/** しばらく使っていない、起きている Project（自動スリープの提案） */
export function getSleepSuggestions() {
  if (state.autoSleep !== "suggest") return [];
  return sorted(
    getActiveProjects().filter(
      (p) => !isSleeping(p.id) && idleDays(p.id) >= IDLE_DAYS_FOR_SUGGESTION && !state.dismissedSuggestions.includes(p.id),
    ),
  );
}

export function dismissSleepSuggestions(ids: readonly string[]): void {
  set({ dismissedSuggestions: [...state.dismissedSuggestions, ...ids] });
}

export function sleepProject(projectId: string): void {
  const { [projectId]: _w, ...waking } = state.waking;
  void _w;
  set({ sleeping: { ...state.sleeping, [projectId]: "たった今" }, waking });
}

export function sleepProjects(ids: readonly string[]): void {
  const sleeping = { ...state.sleeping };
  for (const id of ids) sleeping[id] = "たった今";
  set({ sleeping });
}

/** 起こす。モックでは「起こしています」を少し見せてから起きた形にする */
export function wakeProject(projectId: string): void {
  if (!isSleeping(projectId)) return;
  const { [projectId]: _s, ...sleeping } = state.sleeping;
  void _s;
  set({ sleeping, waking: { ...state.waking, [projectId]: true }, idleDays: { ...state.idleDays, [projectId]: 0 } });
  setTimeout(() => {
    const { [projectId]: _x, ...waking } = state.waking;
    void _x;
    set({ waking });
  }, 2500);
}

export function moveToGroup(projectId: string, groupId: string | null): void {
  const groupOfNext = { ...state.groupOf };
  if (groupId) groupOfNext[projectId] = groupId;
  else delete groupOfNext[projectId];
  set({ groupOf: groupOfNext });
}

/** ドラッグで落とした位置へ。before があればその前、無ければ落とした先のグループの最後 */
export function placeProject(projectId: string, target: { groupId: string | null; beforeId?: string }): void {
  const order = state.order.filter((id) => id !== projectId);
  if (target.beforeId) {
    const i = order.indexOf(target.beforeId);
    order.splice(i === -1 ? order.length : i, 0, projectId);
  } else {
    // そのグループの最後の Project の後ろ
    const members = order.filter((id) => (state.groupOf[id] ?? null) === target.groupId);
    const last = members.at(-1);
    const i = last ? order.indexOf(last) + 1 : order.length;
    order.splice(i, 0, projectId);
  }
  const groupOfNext = { ...state.groupOf };
  if (target.groupId) groupOfNext[projectId] = target.groupId;
  else delete groupOfNext[projectId];
  // スリープ中の行をグループへ落としたら、起こす（置き場所を選び直したということ）
  set({ order, groupOf: groupOfNext });
  if (isSleeping(projectId)) wakeProject(projectId);
}

/** グループの中で1つ上・下へ */
export function nudgeProject(projectId: string, dir: -1 | 1): void {
  const gid = state.groupOf[projectId] ?? null;
  const awake = sorted(getActiveProjects().filter((p) => !isSleeping(p.id) && (state.groupOf[p.id] ?? null) === gid));
  const i = awake.findIndex((p) => p.id === projectId);
  const neighbor = awake[i + dir];
  if (!neighbor) return;
  const order = [...state.order];
  const a = order.indexOf(projectId);
  const b = order.indexOf(neighbor.id);
  if (a === -1 || b === -1) return;
  [order[a], order[b]] = [order[b], order[a]];
  set({ order });
}

export function createGroup(name: string, color?: GroupColor): ProjectGroup {
  const used = new Set(state.groups.map((g) => g.color));
  const pick = color ?? GROUP_COLORS.find((c) => !used.has(c.id))?.id ?? "chart-1";
  const group: ProjectGroup = { id: `g-${Math.random().toString(36).slice(2, 8)}`, name, color: pick, collapsed: false };
  set({ groups: [...state.groups, group] });
  return group;
}

export function renameGroup(groupId: string, name: string): void {
  set({ groups: state.groups.map((g) => (g.id === groupId ? { ...g, name } : g)) });
}

export function recolorGroup(groupId: string, color: GroupColor): void {
  set({ groups: state.groups.map((g) => (g.id === groupId ? { ...g, color } : g)) });
}

export function toggleGroupCollapsed(groupId: string): void {
  set({ groups: state.groups.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g)) });
}

/** 全部畳む（VS Code のファイルブラウザの「すべて折りたたむ」と同じ）／全部開く */
export function setAllGroupsCollapsed(collapsed: boolean): void {
  set({ groups: state.groups.map((g) => ({ ...g, collapsed })) });
}

export function moveGroup(groupId: string, dir: -1 | 1): void {
  const i = state.groups.findIndex((g) => g.id === groupId);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= state.groups.length) return;
  const groups = [...state.groups];
  [groups[i], groups[j]] = [groups[j], groups[i]];
  set({ groups });
}

/** グループを外す。中の Project は消えず「グループなし」へ */
export function removeGroup(groupId: string): void {
  const groupOfNext = Object.fromEntries(Object.entries(state.groupOf).filter(([, g]) => g !== groupId));
  set({ groups: state.groups.filter((g) => g.id !== groupId), groupOf: groupOfNext });
}
