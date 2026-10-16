"use client";

// **Project のグループの写し**（追加・2026-10-16、v4-frontend.md §6.43、アーキ仕様 §2.2「Project のグループとスリープ」）。
//
// 記録は host にあり、画面は写しを持つだけ（規則3）。どの Project がどのグループに入っているかは Project の側
// （`MockProject.groupId`、`lib/mock/projects.ts`）——ここに写さない。取り直すのは出来事の流れで：
//   projects.changed（作る・名前・並び・閉じる・開き直す・グループ）→ グループと Project の一覧を取り直す
//   hello（繋ぎ直した）→ 同じ（切れていた間の変化を取りこぼさない）
// ポーリングはしない（app-events.ts と同じ理由）。
//
// **畳んだ・開いたはこの端末の localStorage**（`banto.sidebarGroups.v1`）——host には持たない（アーキ §2.2）。
// 携帯で畳んだものがパソコンの見え方を変えない。

import { useEffect, useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import {
  REAL_PROJECT_GROUP_COLORS,
  createRealProjectGroup,
  getBackendConfig,
  listRealProjectGroups,
  removeRealProjectGroup,
  setRealProjectGroupOrder,
  updateRealProjectGroup,
  type RealProjectGroup,
  type RealProjectGroupColor,
} from "./client";
import { syncRealProjects } from "@/lib/mock/projects";
import { reportFailure } from "@/lib/report-failure";

export type ProjectGroup = RealProjectGroup;
export type ProjectGroupColor = RealProjectGroupColor;

/** 色の選び口の並びと呼び名。値は host の名前、描くのは画面の段の色（chart-1〜5） */
export const PROJECT_GROUP_COLORS: ReadonlyArray<{ id: ProjectGroupColor; label: string }> = [
  { id: "blue", label: "青" },
  { id: "green", label: "緑" },
  { id: "yellow", label: "黄" },
  { id: "orange", label: "橙" },
  { id: "pink", label: "桃" },
];
// 呼び名の抜けを型で拾えないので、数だけ突き合わせる（host の色を足したらここも足す）
if (PROJECT_GROUP_COLORS.length !== REAL_PROJECT_GROUP_COLORS.length) {
  throw new Error("グループの色の呼び名が host の色と数が合いません");
}

/** Tailwind はクラス名を文字列のまま探すので、組み立てずに書き並べる */
export const GROUP_DOT_CLASS: Record<ProjectGroupColor, string> = {
  blue: "bg-chart-1",
  green: "bg-chart-3",
  yellow: "bg-chart-4",
  orange: "bg-chart-2",
  pink: "bg-chart-5",
};

let groups: readonly ProjectGroup[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
let wired = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function setGroups(next: readonly ProjectGroup[]): void {
  groups = next;
  loaded = true;
  notify();
}

function wire(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "projects.changed" || event.type === "hello") {
      void refreshProjectGroups().catch(() => undefined);
      void syncRealProjects().catch((err: unknown) => reportFailure("Project の一覧を読み直せませんでした", err));
    }
  });
  startRealAppEvents();
}

/** グループを取り直す。失敗は呼んだ側に返し、ここでも知らせる（黙らない、規則2） */
export function refreshProjectGroups(): Promise<void> {
  wire();
  if (!getBackendConfig()) return Promise.resolve();
  if (loading) return loading;
  loading = listRealProjectGroups()
    .then(setGroups)
    .catch((err: unknown) => {
      reportFailure("Project のグループを読み込めませんでした", err);
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EMPTY: readonly ProjectGroup[] = [];

/** **グループ**（host の並び）。まだ取っていなければ取りに行き、取れるまでは空 */
export function useProjectGroups(): readonly ProjectGroup[] {
  const list = useSyncExternalStore(subscribe, () => groups, () => EMPTY);
  useEffect(() => {
    if (!loaded) void refreshProjectGroups().catch(() => undefined);
    else wire();
  }, []);
  return list;
}

/** 名前を聞いて作る。色は host がまだ使っていない色から選ぶ（あとで変えられる） */
export async function createProjectGroup(name: string): Promise<ProjectGroup> {
  const created = await createRealProjectGroup(name);
  if (!groups.some((g) => g.id === created.id)) setGroups([...groups, created]);
  return created;
}

export async function updateProjectGroup(id: string, patch: { name?: string; color?: ProjectGroupColor }): Promise<void> {
  const updated = await updateRealProjectGroup(id, patch);
  setGroups(groups.map((g) => (g.id === id ? updated : g)));
}

/** なくす。中の Project は消えずグループの外へ出る——Project の側は host の一覧を読み直して合わせる */
export async function removeProjectGroup(id: string): Promise<void> {
  await removeRealProjectGroup(id);
  setGroups(groups.filter((g) => g.id !== id));
  await syncRealProjects();
}

/** グループを1つ上・下へ。端では何もしない（メニューは押せなくしてある） */
export async function moveProjectGroup(id: string, delta: -1 | 1): Promise<void> {
  const i = groups.findIndex((g) => g.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= groups.length) return;
  const before = groups;
  const next = [...groups];
  [next[i], next[j]] = [next[j]!, next[i]!];
  setGroups(next);
  try {
    await setRealProjectGroupOrder(next.map((g) => g.id));
  } catch (err) {
    setGroups(before);
    throw err;
  }
}

// ---- 畳んだ・開いた（この端末だけ） ---------------------------------------------------------------

const COLLAPSE_KEY = "banto.sidebarGroups.v1";

/**
 * 畳んでいるグループの id。**開いているのが既定**——覚えるのは畳んだものだけ（導出できる既定値を保存しない、規則3）。
 * 「スリープ中」は逆に**畳んであるのが既定**——開いたときだけ `sleepOpen`
 */
interface CollapseStore {
  collapsed: string[];
  sleepOpen?: true;
}

const collapseListeners = new Set<() => void>();
let collapseCache: CollapseStore | null = null;
const EMPTY_COLLAPSE: CollapseStore = { collapsed: [] };

function readCollapse(): CollapseStore {
  if (collapseCache) return collapseCache;
  if (typeof window === "undefined") return EMPTY_COLLAPSE;
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    const record = parsed && typeof parsed === "object" ? (parsed as { collapsed?: unknown; sleepOpen?: unknown }) : undefined;
    const list = record?.collapsed;
    collapseCache = {
      collapsed: Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [],
      ...(record?.sleepOpen === true ? { sleepOpen: true as const } : {}),
    };
  } catch {
    collapseCache = EMPTY_COLLAPSE;
  }
  return collapseCache;
}

function writeCollapse(next: CollapseStore): void {
  collapseCache = next;
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
  } catch {
    // 書けなくても画面の中では覚えている（次に読み込み直すまで）
  }
  for (const l of collapseListeners) l();
}

/** グループを畳む・開く */
export function setGroupCollapsed(id: string, collapsed: boolean): void {
  const current = new Set(readCollapse().collapsed);
  if (current.has(id) === collapsed) return;
  if (collapsed) current.add(id);
  else current.delete(id);
  writeCollapse({ ...readCollapse(), collapsed: [...current] });
}

/** 渡したグループを全部畳む／全部開く（「すべて畳む」「すべて開く」）。すべて畳むは「スリープ中」も畳む */
export function setGroupsCollapsed(ids: readonly string[], collapsed: boolean): void {
  if (collapsed) writeCollapse({ collapsed: [...ids] });
  else writeCollapse({ ...readCollapse(), collapsed: [] });
}

/** 「スリープ中」を開く・畳む */
export function setSleepOpen(open: boolean): void {
  const current = readCollapse();
  if ((current.sleepOpen === true) === open) return;
  writeCollapse({ collapsed: current.collapsed, ...(open ? { sleepOpen: true as const } : {}) });
}

function subscribeCollapse(listener: () => void): () => void {
  collapseListeners.add(listener);
  // ほかのタブで畳んだものも拾う
  function onStorage(e: StorageEvent) {
    if (e.key !== COLLAPSE_KEY) return;
    collapseCache = null;
    listener();
  }
  window.addEventListener("storage", onStorage);
  return () => {
    collapseListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** 「スリープ中」を開いているか（既定は畳んである） */
export function useSleepOpen(): boolean {
  return useSyncExternalStore(subscribeCollapse, readCollapse, () => EMPTY_COLLAPSE).sleepOpen === true;
}

/** 畳んでいるグループの id（変われば描き直す）。サーバでは空 */
export function useCollapsedGroups(): ReadonlySet<string> {
  const store = useSyncExternalStore(subscribeCollapse, readCollapse, () => EMPTY_COLLAPSE);
  return collapsedSetOf(store);
}

const setCache = new WeakMap<CollapseStore, ReadonlySet<string>>();
function collapsedSetOf(store: CollapseStore): ReadonlySet<string> {
  let set = setCache.get(store);
  if (!set) {
    set = new Set(store.collapsed);
    setCache.set(store, set);
  }
  return set;
}

// ---- サイドバーの並び ---------------------------------------------------------------------------

export interface ProjectSection<P> {
  /** null＝グループに入っていない Project（見出し無し） */
  group: ProjectGroup | null;
  projects: P[];
}

/**
 * **サイドバーの並び**（v4-frontend.md §6.43）：グループに入っていない Project → グループ（host の並び）ごとにその中の
 * Project。どれも Project の並び（host の1つの並び）を絞ったもの。知らないグループに入っている Project（グループを
 * なくした直後で、まだ読み直していない）はグループの外に出す——一覧から消さない（fail open）
 */
export function projectSections<P extends { groupId?: string }>(
  projects: readonly P[],
  list: readonly ProjectGroup[],
): ProjectSection<P>[] {
  const known = new Set(list.map((g) => g.id));
  const groupOf = (p: P) => (p.groupId && known.has(p.groupId) ? p.groupId : null);
  return [
    { group: null, projects: projects.filter((p) => groupOf(p) === null) },
    ...list.map((group) => ({ group, projects: projects.filter((p) => groupOf(p) === group.id) })),
  ];
}
