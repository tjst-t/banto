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
  renameRealProject,
  setRealProjectOrder,
  updateRealProjectSettings,
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

/**
 * **名前を変える**（決定・2026-09-11、ユーザー要望）。作るときに付けた名前を
 * 後から直せなかった。**先に host へ書いてから**手元を直す——逆にすると、
 * 書けなかったときに画面だけ新しい名前になる（規則2・規則3）。
 */
export async function renameProject(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("名前を空にはできません");
  await renameRealProject(id, trimmed);
  projects = projects.map((p) =>
    p.id === id ? { ...p, name: trimmed, initial: trimmed.slice(0, 1) } : p,
  );
  notifyMockStoreChange();
}

/**
 * **名前と根を直す**（決定・2026-09-11、ユーザー要望）。**先に host へ書いてから**
 * 手元を直す——逆にすると、書けなかったときに画面だけ新しくなる（規則2・規則3）。
 */
export async function updateRealProject(
  id: string,
  patch: { name?: string; root?: string },
): Promise<void> {
  const updated = await updateRealProjectSettings(id, patch);
  projects = projects.map((p) =>
    p.id === id
      ? { ...p, name: updated.name, initial: updated.name.slice(0, 1), basePath: updated.root }
      : p,
  );
  notifyMockStoreChange();
}

/**
 * **並べ替える**（決定・2026-09-11、ユーザー要望）。受け取るのは画面に出ている
 * （畳んでいない）Project の並び。host へ送るのは**一覧全体の並び**
 * ——1件ずつ番号を振ると、途中で失敗したときに順番が飛ぶ。
 *
 * **見えていないものは動かさない**（実測・2026-09-11）。畳んだ Project を
 * 並びに入れずに送ると、host 側で「並びに無いもの」として末尾へ回り、
 * **開き直したときに知らないところへ移動している**。畳んだものが居た場所は
 * そのままにして、見えているものだけを入れ替える。
 */
export async function reorderProjects(visibleOrderedIds: string[]): Promise<void> {
  const before = projects;
  const rank = new Map(visibleOrderedIds.map((id, i) => [id, i]));
  const slots: number[] = [];
  const moving: MockProject[] = [];
  projects.forEach((p, i) => {
    if (rank.has(p.id)) {
      slots.push(i);
      moving.push(p);
    }
  });
  moving.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  const next = [...projects];
  slots.forEach((slot, i) => {
    next[slot] = moving[i]!;
  });
  projects = next;
  notifyMockStoreChange();
  try {
    await setRealProjectOrder(projects.map((p) => p.id));
  } catch (err) {
    // **書けなかったら戻す**——画面だけ並び替わった状態にしない（規則2）
    projects = before;
    notifyMockStoreChange();
    throw err;
  }
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
        // **入口は「分けた場所」に置く**（決定・2026-09-11）——過去のメッセージ
        // から分けた Fork は、いまの続きではなくその位置に出る
        fork.forkedFromSeq ?? fork.createdSeq,
        overviewOf(fork),
        fork.title,
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
