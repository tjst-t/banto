import {
  FolderGit2,
  GitFork,
  Inbox,
  MessageSquare,
  Rocket,
  Search,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getActiveProjects, getProject } from "./projects";
import { getThreadsForProject } from "./threads";
import { getInboxItemHref, getInboxItems } from "./inbox";
import { getLaunchersForProject } from "./settings";

// Command Palette（§6.3）。「自分の索引を持たない」——出るものは全部、
// すでにあるところ（Project/Thread・受信箱・Module集合）から導出する。
// モックなので導出元はすべて静的な配列だが、構造は本実装と同じにする：
// パレット専用のデータストアを新しく作らない。

export type PaletteGroupKind = "project" | "thread" | "inbox" | "launcher" | "resource" | "operation";

export interface PaletteItem {
  id: string;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  /** 選んだときの遷移先。router.push に渡す */
  href?: string;
  /** href では表現できない操作（overlay を開く等）。呼び出し側が実行する */
  kind: PaletteGroupKind;
  actionId?: string;
}

export interface PaletteGroup {
  kind: PaletteGroupKind;
  label: string;
  items: readonly PaletteItem[];
}

// 数えきれない資源の例（§6.3「深い検索は completion API に乗せる」）。
// 本実装は resources/templates/list + completion/complete だが、モックでは
// 固定の候補から前方一致で絞り込むだけに簡略化する——**クエリが空のときは
// 一切出さない**（「数えきれない」ものを既定で全部出さない、という性質だけ再現する）
const MOCK_FILES: Readonly<Record<string, readonly string[]>> = {
  banto: [
    "lib/mock/thread-panel.tsx",
    "lib/mock/adapter.ts",
    "app/settings/page.tsx",
    "docs/README.md",
    "docs/spec.pdf",
    "public/index.html",
    "public/logo.png",
  ],
  home: ["config/mqtt.yaml", "scripts/backup.sh"],
  hermes: ["docs/notes/2026-08-30-poc.md", "poc/01-item4-event-store-read-model/run.mjs"],
};

const OPERATIONS: readonly { id: string; title: string; subtitle: string; icon: LucideIcon }[] = [
  { id: "open-fork", title: "Fork Thread を開く", subtitle: "この Project で新しい枝を立てる", icon: GitFork },
  { id: "open-canvas", title: "Canvas を開く", subtitle: "Repo Module の差分ビュー", icon: Rocket },
  { id: "open-inbox", title: "受信箱を開く", subtitle: "判断待ち・レビュー待ち", icon: Inbox },
  { id: "open-project-settings", title: "この Project の設定を開く", subtitle: "階層2", icon: SlidersHorizontal },
  { id: "open-instance-settings", title: "instance 設定を開く", subtitle: "/settings・階層1", icon: Settings },
];

export function getOperations(): typeof OPERATIONS {
  return OPERATIONS;
}

export function buildPaletteGroups(currentProjectId: string | null, query: string): PaletteGroup[] {
  const q = query.trim().toLowerCase();
  const groups: PaletteGroup[] = [];

  // Project / Thread ——banto 全体（Project を切り替える手段なので、§6.3）
  const projectItems: PaletteItem[] = getActiveProjects()
    .filter((p) => q === "" || p.name.toLowerCase().includes(q))
    .map((p) => ({
      id: `project:${p.id}`,
      title: p.name,
      subtitle: "Project",
      icon: FolderGit2,
      href: `/p/${p.id}`,
      kind: "project",
    }));
  if (projectItems.length > 0) groups.push({ kind: "project", label: "Project", items: projectItems });

  const threadItems: PaletteItem[] = getActiveProjects()
    .flatMap((p) => getThreadsForProject(p.id).map((t) => ({ thread: t, project: p })))
    .filter(({ thread }) => q === "" || thread.title.toLowerCase().includes(q))
    .map(({ thread, project }) => ({
      id: `thread:${thread.id}`,
      title: thread.title,
      subtitle: `${project.name} · ${thread.kind === "fork" ? "Fork Thread" : "Base Thread"}`,
      icon: MessageSquare,
      href: thread.kind === "fork" ? `/p/${project.id}?fork=${thread.id}` : `/p/${project.id}`,
      kind: "thread",
    }));
  if (threadItems.length > 0) groups.push({ kind: "thread", label: "Thread", items: threadItems });

  // 受信箱——banto 全体（Project の外にある、§2.4）
  const inboxItems: PaletteItem[] = getInboxItems()
    .filter((i) => q === "" || i.message.toLowerCase().includes(q))
    .map((i) => {
      const project = getProject(i.projectId);
      return {
        id: `inbox:${i.id}`,
        title: i.message,
        subtitle: `${project.name} · ${i.kind === "judgment" ? "判断待ち" : "レビュー待ち"}`,
        icon: Inbox,
        href: getInboxItemHref(i),
        kind: "inbox" as const,
      };
    });
  if (inboxItems.length > 0) groups.push({ kind: "inbox", label: "受信箱", items: inboxItems });

  // Module の入口・資源——いまの Project の Module 集合に限る（§6.3）
  if (currentProjectId) {
    const launcherItems: PaletteItem[] = getLaunchersForProject(currentProjectId)
      .filter((l) => q === "" || l.label.toLowerCase().includes(q))
      .map((l) => ({
        id: `launcher:${l.implementationId}:${l.id}`,
        title: l.label,
        subtitle: l.implementationName,
        icon: Rocket,
        href: `/p/${currentProjectId}?canvas=${l.implementationId}:${l.viewId}&fullscreen=1`,
        kind: "launcher" as const,
      }));
    if (launcherItems.length > 0) groups.push({ kind: "launcher", label: "Module の入口", items: launcherItems });

    if (q !== "") {
      const resourceItems: PaletteItem[] = (MOCK_FILES[currentProjectId] ?? [])
        .filter((path) => path.toLowerCase().includes(q))
        .map((path) => ({
          id: `resource:${path}`,
          title: path,
          subtitle: "banto.fs の資源（completion 相当）",
          icon: Search,
          // フォルダツリーは畳んだ状態で開く（file-explorer-view.tsx）——
          // 開いた後の遷移は fsFile/fsDir をブラウザ履歴に積む形に切り替わる
          href: `/p/${currentProjectId}?canvas=banto.fs:browser&fsFile=${path}&fsCollapsed=1&fullscreen=1`,
          kind: "resource" as const,
        }));
      if (resourceItems.length > 0) groups.push({ kind: "resource", label: "資源", items: resourceItems });
    }
  }

  // core の操作。Project に紐づく操作は、いまその Project を見ているときだけ出す
  const PROJECT_SCOPED_OPS = new Set(["open-fork", "open-canvas", "open-project-settings"]);
  const opItems: PaletteItem[] = OPERATIONS.filter((o) => currentProjectId || !PROJECT_SCOPED_OPS.has(o.id))
    .filter((o) => q === "" || o.title.toLowerCase().includes(q))
    .map((o) => ({
    id: `operation:${o.id}`,
    title: o.title,
    subtitle: o.subtitle,
    icon: o.icon,
    kind: "operation" as const,
    actionId: o.id,
  }));
  if (opItems.length > 0) groups.push({ kind: "operation", label: "操作", items: opItems });

  return groups;
}
