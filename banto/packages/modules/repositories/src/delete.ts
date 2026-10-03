// このマシンから削除（docs/specs/v4-modules.md §2.4、段階4）。「一覧から外す」（台帳からだけ）とは別の手。
//
// - **まず失われるものを調べる**（`readLosses`）：push していないコミット（全ブランチ・detached）・コミットしていない
//   変更・追跡していないもの・stash・リモートに無いブランチ・使えなくなる worktree・使っている Project
// - 何も無ければ1回確かめて消す。あれば何がいくつかを出し、**リポジトリ名を打たせて**消す（確かめを1段増やす）
// - **確かめは Module が決める**——画面が「確かめた」と言っても、消す直前にもう一度調べ、要る確かめが揃っていなければ
//   断る（調べたあとに増えていたら、もう一度確かめさせる）
// - **消すのはそのフォルダだけ**。危ない場所（シンボリックリンク・台帳の場所が realpath と違う・置き場の外・置き場
//   そのもの・ホーム・`/`）は断る。worktree なら worktree だけを消して本体の記録を片づける（本体は消さない）。
//   消したら台帳から外す。GitHub のリモートには触らない
// - Project は触らない——使っている Project を閉じるのは core の確認画面（`dev.banto/close-projects`）で人が押したとき

import { lstat, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import { lossCount, pruneWorktrees, readFolder, readLosses, type LossReport } from "./git.js";
import type { LedgerEntry, LedgerStore } from "./ledger.js";
import { displayPath } from "./paths.js";
import { repoHomeOf } from "./clone.js";
import type { ProjectsLookup } from "./repositories.js";

export interface DeleteInspection {
  path: string;
  displayPath: string;
  name: string;
  /** 断る理由（あれば消せない） */
  refusal?: string;
  /** `worktree`：worktree だけを消す（本体は `main`） */
  kind?: "repo" | "worktree";
  /** worktree の本体（見せる形と、実際の場所） */
  main?: string;
  mainPath?: string;
  losses?: LossReport;
  /** 失われるものの数（数えきれなかったものは含まない） */
  lossCount?: number;
  /** 本体を消すと使えなくなる worktree */
  worktrees?: string[];
  /** そのフォルダ（かその worktree）を根にしている Project。引けなければ無く、`projectsError` に理由 */
  projects?: Array<{ id: string; name: string; closed: boolean }>;
  projectsError?: string;
  /** リポジトリ名を打たせるか（失われるもの・数えきれないもの・壊れる worktree・使っている Project があるとき） */
  needsTypedName?: boolean;
}

const isInside = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * そこを消してよい場所か。**だめなら理由**。見るのは台帳の場所そのもの（画面の字ではない）
 */
export async function deletionRefusal(path: string, repoHome: string, home: string, repoHomeDisplay = repoHome): Promise<string | undefined> {
  if (!path.startsWith("/")) return "絶対パスでない場所は消しません";
  if (path === "/" || path === home || isInside(home, path)) return "ホームや / を消すことはできません";
  let info;
  try {
    info = await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "フォルダが見つかりません（一覧から外してください）";
    return `読めません（${(err as Error).message}）`;
  }
  if (info.isSymbolicLink()) return "シンボリックリンクは消しません（リンクの先を消すことになる）";
  if (!info.isDirectory()) return "フォルダではありません";
  let real: string;
  try {
    real = await realpath(path);
  } catch (err) {
    return `読めません（${(err as Error).message}）`;
  }
  if (real !== path) return `一覧の場所（${path}）と実際の場所（${real}）が違います（途中にシンボリックリンクがあります）`;
  let homeReal = repoHome;
  try {
    homeReal = await realpath(repoHome);
  } catch {
    // 置き場がまだ無い——置き場の中のものは在りえない（下で断る）
  }
  if (path === homeReal) return "置き場そのものは消しません";
  if (!isInside(path, homeReal)) {
    return `置き場（${repoHomeDisplay}）の外のフォルダは、このマシンから削除できません——一覧から外して、ほかの道具で消してください`;
  }
  return undefined;
}

export async function inspectDelete(store: LedgerStore, path: string, lookup: ProjectsLookup | undefined, home = homedir()): Promise<DeleteInspection> {
  const entry = (await store.entries()).find((e) => e.path === path);
  const base = { path, displayPath: displayPath(path, home), name: basename(path) };
  if (!entry) return { ...base, refusal: "一覧に無いフォルダは消しません" };
  const repoHome = await repoHomeOf(store, home);
  const refusal = await deletionRefusal(path, repoHome.path, home, repoHome.display);
  if (refusal) return { ...base, refusal };
  let facts;
  try {
    facts = await readFolder(path);
  } catch (err) {
    return { ...base, refusal: `読めません（${(err as Error).message}）` };
  }
  if (facts.kind !== "repo" && facts.kind !== "worktree") {
    return { ...base, refusal: "リポジトリでないフォルダは消しません（中身が分からないので、失われるものを数えられない）" };
  }
  const kind = facts.kind;
  const losses = await readLosses(path);
  const worktrees = kind === "repo" ? facts.worktrees : [];
  const roots = [path, ...worktrees];
  const projects = lookup?.ok
    ? lookup.projects.filter((p) => roots.includes(p.root)).map((p) => ({ id: p.id, name: p.name, closed: p.status === "closed" }))
    : undefined;
  const count = lossCount(losses);
  return {
    ...base,
    kind,
    ...(kind === "worktree" ? { main: displayPath(facts.main, home), mainPath: facts.main } : {}),
    losses,
    lossCount: count,
    worktrees: worktrees.map((w) => displayPath(w, home)),
    ...(projects ? { projects } : {}),
    ...(lookup && !lookup.ok ? { projectsError: lookup.error } : {}),
    // 何かを失う・数えきれない・ほかが壊れる・Project が使っている（・使っているかが分からない）なら、名前を打たせる
    needsTypedName:
      count > 0 || losses.problems.length > 0 || worktrees.length > 0 || (projects?.length ?? 0) > 0 || !lookup?.ok,
  };
}

/**
 * 消す。**消す直前にもう一度調べる**——画面が見た結果を信じない。要る確かめ（`confirmed`、要るなら `typedName`）が
 * 揃っていなければ断る。消したら台帳から外し、外した行と、使っていた Project（閉じる確認に使う）を返す
 */
export async function deleteRepository(
  store: LedgerStore,
  input: { path: string; confirmed: boolean; typedName?: string },
  lookup: ProjectsLookup | undefined,
  home = homedir(),
): Promise<{ removed: LedgerEntry; displayPath: string; projects: Array<{ id: string; name: string; closed: boolean }> }> {
  const now = await inspectDelete(store, input.path, lookup, home);
  if (now.refusal) throw new Error(`${now.displayPath} は消せません：${now.refusal}`);
  if (!input.confirmed) throw new Error("消す前に確かめてください");
  if (now.needsTypedName && input.typedName !== now.name) {
    throw new Error(
      input.typedName === undefined
        ? `失われるものがあります（調べたあとに増えたかもしれません）。もう一度確かめて、リポジトリ名「${now.name}」を打ってください`
        : `リポジトリ名が違います（「${now.name}」を打ってください）`,
    );
  }
  await rm(input.path, { recursive: true, force: false });
  if (now.kind === "worktree" && now.mainPath) {
    // 本体の側の記録（.git/worktrees/<名前>）を片づける。本体は消さない
    await pruneWorktrees(now.mainPath).catch((err: Error) => {
      throw new Error(`worktree のフォルダは消しました。${err.message}`);
    });
  }
  const removed = await store.update((entries) => {
    const entry = entries.find((e) => e.path === input.path);
    if (!entry) throw new Error(`${now.displayPath} は消しましたが、一覧からはもう外れていました`);
    return { entries: entries.filter((e) => e !== entry), result: entry };
  });
  return { removed, displayPath: now.displayPath, projects: now.projects ?? [] };
}
