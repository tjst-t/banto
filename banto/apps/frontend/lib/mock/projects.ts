import type { MockProject, MockProjectOverrides } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { registerRealFork, registerRealThread } from "./threads";
import { seedThreadPermissionMode } from "./permission-mode";
import { setProjectOverrides } from "./settings";
import {
  createRealProject as createRealProjectOnHost,
  createRealBaseThread,
  listRealProjects,
  listRealThreads,
  getBackendConfig,
  closeRealProject,
  reopenRealProject,
} from "../backend/client";

// デモ用の初期Projectは持たない（決定・2026-09-03、実機投入に伴いデモデータを撤去）。
// 実Projectはアプリ起動時にhydrateRealProjects()（real-projects-bootstrap.tsx）が
// banto hostから読み込んでここへ登録する
let projects: MockProject[] = [];

export function getAllProjects(): readonly MockProject[] {
  return projects;
}

export function getActiveProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "active");
}

export function getClosedProjects(): readonly MockProject[] {
  return projects.filter((p) => p.status === "closed");
}

/** 見つからない場合、デモの先頭Projectへの暗黙フォールバックはしない
 *  （デモデータ撤去に伴う決定・2026-09-03）——呼び出し側が必ず何らかの
 *  MockProjectを受け取れるよう、素性の分かるプレースホルダーを返す */
export function getProject(id: string): MockProject {
  return (
    projects.find((p) => p.id === id) ?? {
      id,
      name: "(不明な Project)",
      initial: "?",
      baseThreadId: `${id}-base`,
      basePath: "",
      status: "active",
    }
  );
}

export interface NewProjectInput {
  name: string;
  basePath: string;
  /** Advanced で選んだ Configuration の上書き（§2.2「設定のカスケード」） */
  overrides?: Omit<MockProjectOverrides, "projectId" | "securityRoot">;
}

/**
 * 実bantoホストにProjectとBase Threadを作る（決定・2026-09-03）。
 */
export async function createRealProject(input: NewProjectInput): Promise<MockProject> {
  const realProject = await createRealProjectOnHost(input.name, input.basePath);
  const realThread = await createRealBaseThread(realProject.id);
  const project: MockProject = {
    id: realProject.id,
    name: realProject.name,
    initial: realProject.name.slice(0, 1),
    baseThreadId: realThread.id,
    basePath: realProject.root,
    status: realProject.status,
    real: true,
  };
  projects = [...projects, project];
  registerRealThread(
    realThread.id,
    realProject.id,
    realProject.name,
    realThread.messages,
    realThread.markers,
    realThread.usage,
  );
  setProjectOverrides({ projectId: project.id, securityRoot: input.basePath, ...input.overrides });
  notifyMockStoreChange();
  return project;
}

/**
 * 実bantoホストから既存の実Project一覧を読み込み、ローカルのモジュール状態
 * （`projects`）へ登録する（決定・2026-09-03）。`projects`はページの
 * フルロードのたびに初期値へ戻る、純粋にクライアント側だけのメモリ状態
 * ——直接そのProjectのURLへ来た（一覧画面を経由していない）ときでも
 * 実データを引けるよう、アプリ起動時にこれを1回呼ぶ
 * （components/banto/real-projects-bootstrap.tsx）。
 */
// React 19 StrictMode は開発時にeffectを2回呼ぶ——同時に2回
// hydrateRealProjects()が走ると、awaitの間に両方とも同じProjectを
// 「まだ無い」と読んでしまい重複登録する（実測で踏んだ）。進行中の
// Promiseを使い回すことで、同時呼び出しを1回分に潰す。
let hydrationInFlight: Promise<void> | null = null;

export function hydrateRealProjects(): Promise<void> {
  if (!hydrationInFlight) {
    hydrationInFlight = hydrateRealProjectsUncached().finally(() => {
      hydrationInFlight = null;
    });
  }
  return hydrationInFlight;
}

async function hydrateRealProjectsUncached(): Promise<void> {
  if (!getBackendConfig()) return;
  const realProjects = await listRealProjects();
  // **Project ごとの Thread 一覧は同時に取る**（改訂・2026-09-07、実測）。
  // 1本ずつ待っていたので、Project の数だけ往復が積み上がっていた
  // ——起動時に一度だけとはいえ、最初の画面が出るまでの時間に直に乗る。
  // （なお「開いていない Project の分まで取っている」ほうは別の話で、
  //   直すと Fork 件数バッジの見え方が変わる。`perf-bootstrap-overfetch` に分けた）
  const pending = realProjects.filter((rp) => !projects.some((p) => p.id === rp.id));
  const fetched = await Promise.all(
    pending.map(async (rp) => ({ rp, realThreads: await listRealThreads(rp.id) })),
  );
  let changed = false;
  for (const { rp, realThreads } of fetched) {
    if (projects.some((p) => p.id === rp.id)) continue;
    const base = realThreads.find((t) => t.kind === "base");
    if (!base) continue;
    const project: MockProject = {
      id: rp.id,
      name: rp.name,
      initial: rp.name.slice(0, 1),
      baseThreadId: base.id,
      basePath: rp.root,
      status: rp.status,
      real: true,
    };
    projects = [...projects, project];
    // **中身は持たずに登録する**（改訂・2026-09-07、実測）——一覧は要約だけ。
    // 開いた Project の中身は project-panels.tsx が取りに行く
    const overviewOf = (t: (typeof realThreads)[number]) => ({
      messageCount: t.messageCount,
      firstMessage: t.firstMessage,
      lastMessage: t.lastMessage,
    });
    registerRealThread(
      base.id,
      rp.id,
      rp.name,
      undefined,
      undefined,
      // 文脈使用量は開いたときに入る（一覧は目次に徹する）
      undefined,
      overviewOf(base),
    );
    // 人が選んだpermissionModeはhostが持っている（決定・2026-09-06）——
    // リロード後もそのモードで会話を続けられるよう、ここで写す
    seedThreadPermissionMode(base.id, base.permissionMode);
    // Fork Threadはhydrateの度に消えて見えなくなっていた——base同様、host側の
    // 一覧をそのまま復元する（決定・2026-09-04、サイドバーに出ない不具合の修正）。
    for (const fork of realThreads.filter((t) => t.kind === "fork")) {
      registerRealFork(
        fork.id,
        rp.id,
        fork.parentThreadId ?? base.id,
        undefined,
        undefined,
        fork.status === "closed" ? "closed" : "open",
        undefined,
        fork.createdSeq,
        overviewOf(fork),
      );
      seedThreadPermissionMode(fork.id, fork.permissionMode);
    }
    changed = true;
  }
  if (changed) notifyMockStoreChange();
}

/** Project を終了する（削除ではない——閉じたProjectの一覧から読み返し、再開できる）。
 *  実Projectはhostへも反映する（Clearのhandle Clearと同じ形、規則3）。 */
export async function closeProject(id: string): Promise<void> {
  const project = getProject(id);
  if (project.real) await closeRealProject(id);
  projects = projects.map((p) => (p.id === id ? { ...p, status: "closed", closedAt: "たった今" } : p));
  notifyMockStoreChange();
}

export async function reopenProject(id: string): Promise<void> {
  const project = getProject(id);
  if (project.real) await reopenRealProject(id);
  projects = projects.map((p) => (p.id === id ? { ...p, status: "active", closedAt: undefined } : p));
  notifyMockStoreChange();
}
