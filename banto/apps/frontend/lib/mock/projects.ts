import type { MockProject, MockProjectOverrides } from "./types";
import { notifyMockStoreChange } from "./store-events";
import { getThread, registerRealFork, registerRealThread } from "./threads";
import { seedThreadPermissionMode } from "./permission-mode";
import { seedThreadModel } from "../backend/thread-model";
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
  assignRealProjectGroup,
  updateRealProjectSettings,
  prepareRealProjectModules,
} from "../backend/client";
import { refreshRealInbox } from "../backend/real-inbox";

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
 * **host から根と実行場所を読み直す**（別の実行場所へ移したあと。Backlog `runtime-move-ui`）。手元で移す先を
 * 書き込まない——移したかどうか・正規化した根は host が知っている（規則3）。返すのは読み直した Project
 */
export async function refreshRealProjectLocation(id: string): Promise<MockProject | undefined> {
  const real = (await listRealProjects()).find((p) => p.id === id);
  if (!real) throw new Error("host にこの Project がありません");
  projects = projects.map((p) => {
    if (p.id !== id) return p;
    const next: MockProject = { ...p, basePath: real.root };
    // この機械のコンテナへ戻したら、印を消す（無いのがこの機械のコンテナ）
    if (real.runtime) next.runtime = real.runtime;
    else delete next.runtime;
    return next;
  });
  notifyMockStoreChange();
  return projects.find((p) => p.id === id);
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

/**
 * **Project を置く**（追加・2026-10-16、v4-frontend.md §6.43）。ドラッグで落とした先・行の「…」の「グループへ移す」・
 * 「上へ／下へ」がここを通る（規則3）。`beforeId` があればその Project の前（そのグループに入る）、無ければ
 * `groupId` のグループの最後（`null` ならグループに入っていない Project の最後）。
 *
 * 並びは host に1つ（Project 全部、閉じたものも）——グループの中の順はその並びを絞ったもの（アーキ §2.2）。
 * だから動かすのはいつも全体の並び。グループが変わるなら入れ先と位置を**1つの出来事**で書く（`order` を添える）。
 * 先に画面を動かし、書けなかったら戻す（`reorderProjects` と同じ、規則2）
 */
export async function placeProject(
  projectId: string,
  target: { groupId: string | null; beforeId?: string },
): Promise<void> {
  const moving = projects.find((p) => p.id === projectId);
  if (!moving || target.beforeId === projectId) return;
  const before = projects;
  const rest = projects.filter((p) => p.id !== projectId);
  let at = target.beforeId ? rest.findIndex((p) => p.id === target.beforeId) : -1;
  if (at < 0) {
    // そのグループ（開いている Project）の最後の後ろ。まだ誰もいなければ、グループの外なら先頭・グループなら末尾
    const last = rest.findLastIndex((p) => p.status === "active" && (p.groupId ?? null) === target.groupId);
    at = last >= 0 ? last + 1 : target.groupId === null ? 0 : rest.length;
  }
  const placed: MockProject = { ...moving };
  if (target.groupId) placed.groupId = target.groupId;
  else delete placed.groupId;
  const next = [...rest.slice(0, at), placed, ...rest.slice(at)];
  const groupChanged = (moving.groupId ?? null) !== target.groupId;
  if (!groupChanged && next.every((p, i) => p.id === before[i]!.id)) return;
  projects = next;
  notifyMockStoreChange();
  const order = next.map((p) => p.id);
  try {
    if (groupChanged) await assignRealProjectGroup(projectId, target.groupId, order);
    else await setRealProjectOrder(order);
  } catch (err) {
    projects = before;
    notifyMockStoreChange();
    throw err;
  }
}

/**
 * **host の一覧に合わせ直す**（追加・2026-10-16、`projects.changed`・繋ぎ直したとき）。並び・名前・状態・グループを
 * host のとおりにする——別の画面（携帯）で動かしたものがこの画面にも出る。知らない Project は `hydrateRealProjects` が足す
 */
export async function syncRealProjects(): Promise<void> {
  if (!getBackendConfig()) return;
  const real = await listRealProjects();
  const byId = new Map(real.map((rp, i) => [rp.id, { rp, i }]));
  const updated = projects.map((p) => {
    const hit = byId.get(p.id);
    if (!hit) return p;
    const { rp } = hit;
    const next: MockProject = { ...p, name: rp.name, initial: rp.name.slice(0, 1), status: rp.status };
    if (rp.groupId) next.groupId = rp.groupId;
    else delete next.groupId;
    return next;
  });
  // host に無いもの（ありえないが）は元の場所の順で後ろへ
  const rank = (p: MockProject) => byId.get(p.id)?.i ?? Number.MAX_SAFE_INTEGER;
  projects = updated.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(({ p }) => p);
  notifyMockStoreChange();
  if (real.some((rp) => !projects.some((p) => p.id === rp.id))) await hydrateRealProjects();
}

export interface NewProjectInput {
  name: string;
  basePath: string;
  /** 実行場所（`remote:<名前>`）。無ければこの機械のコンテナ */
  runtime?: string;
  /** Advanced で選んだ Configuration の上書き（§2.2「設定のカスケード」） */
  overrides?: Omit<MockProjectOverrides, "projectId" | "securityRoot">;
}

/**
 * **その Project の Module を用意する**（決定・2026-09-07、ユーザー）。用意できなければ
 * 受信箱にお知らせが出るので、終わったら受信箱を取り直す。
 *
 * **同じ Project を同時に2回頼まない**（追加・2026-09-26）——作った直後に頼み（画面が
 * 切り替わるのを待たない）、開いた Project の画面も同じものを頼む。host の側でも束ねられるが、
 * 往復を1回減らせる。
 */
const modulePreparations = new Map<string, Promise<void>>();
export function prepareProjectModules(projectId: string): Promise<void> {
  let pending = modulePreparations.get(projectId);
  if (!pending) {
    pending = prepareRealProjectModules(projectId)
      .then(() => refreshRealInbox())
      .finally(() => modulePreparations.delete(projectId));
    modulePreparations.set(projectId, pending);
  }
  return pending;
}

/**
 * 実bantoホストにProjectとBase Threadを作る（決定・2026-09-03）。
 */
export async function createRealProject(input: NewProjectInput): Promise<MockProject> {
  const realProject = await createRealProjectOnHost(input.name, input.basePath, input.runtime);
  const realThread = await createRealBaseThread(realProject.id);
  const project: MockProject = {
    id: realProject.id,
    name: realProject.name,
    initial: realProject.name.slice(0, 1),
    baseThreadId: realThread.id,
    basePath: realProject.root,
    status: realProject.status,
    real: true,
    ...(realProject.runtime ? { runtime: realProject.runtime } : {}),
  };
  // 作った知らせ（projects.changed）で一覧を読み直した側が、先に足していることがある——二重にしない
  projects = [...projects.filter((p) => p.id !== project.id), project];
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
  // **作った時点で Module の用意を始める**（追加・2026-09-26、実測）。新しい Project は
  // コンテナを作るところから始まるので 1.5 秒ほどかかる——画面が切り替わって Project の
  // 画面が頼むまで待たない。失敗は開いた画面が頼み直したときに出る（受信箱にも出る）
  prepareProjectModules(project.id).catch(() => undefined);
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
      ...(rp.runtime ? { runtime: rp.runtime } : {}),
      ...(rp.groupId ? { groupId: rp.groupId } : {}),
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
    // 人が選んだモデルと effort も host が持っている（決定・2026-09-23）
    seedThreadModel(base.id, base.model, base.effort);
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
        { by: fork.closedBy, reason: fork.closedReason },
      );
      seedThreadPermissionMode(fork.id, fork.permissionMode);
      seedThreadModel(fork.id, fork.model, fork.effort);
    }
    changed = true;
  }
  if (changed) notifyMockStoreChange();
}

/**
 * **この画面の外で作られた Fork を一覧に足す**（決定・2026-09-27、アーキ仕様 §2.2「AI が Fork を立てる」）。
 * AI が立てた Fork は host が作るので、開いている画面は知らない——host から「その Thread のターンが始まった」が
 * 届いたときに、知らない Thread なら呼ぶ。既に知っているものは触らない（`registerRealFork` が既存を返す）
 */
export async function registerNewRealForks(projectId: string): Promise<void> {
  if (!getBackendConfig()) return;
  const project = projects.find((p) => p.id === projectId);
  if (!project?.real) return;
  const realThreads = await listRealThreads(projectId);
  for (const fork of realThreads.filter((t) => t.kind === "fork")) {
    if (getThread(fork.id)) continue;
    registerRealFork(
      fork.id,
      projectId,
      fork.parentThreadId ?? project.baseThreadId,
      undefined,
      undefined,
      fork.status === "closed" ? "closed" : "open",
      undefined,
      fork.forkedFromSeq ?? fork.createdSeq,
      { messageCount: fork.messageCount, firstMessage: fork.firstMessage, lastMessage: fork.lastMessage },
      fork.title,
      { by: fork.closedBy, reason: fork.closedReason },
    );
    seedThreadPermissionMode(fork.id, fork.permissionMode);
    seedThreadModel(fork.id, fork.model, fork.effort);
  }
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
