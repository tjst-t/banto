// このマシンから削除（docs/specs/v4-modules.md §2.4、段階4）。「一覧から外す」（台帳からだけ）とは別の手。
//
// - **まず失われるものを調べる**（`readLosses`）：push していないコミット（全ブランチ・detached）・コミットしていない
//   変更・追跡していないもの・stash・リモートに無いブランチ・使えなくなる worktree・使っている Project
// - 何も無ければ1回確かめて消す。あれば何がいくつかを出し、**リポジトリ名を打たせて**消す（確かめを1段増やす）
// - **確かめは Module が決める**——画面が「確かめた」と言っても、消す直前にもう一度調べ、要る確かめが揃っていなければ
//   断る（調べたあとに増えていたら、もう一度確かめさせる）
// - **消すのはそのフォルダだけ**。危ない場所（シンボリックリンク・台帳の場所が realpath と違う・置き場の外・置き場
//   そのもの・ホーム・`/`・中にマウントがある）は断る。消すときもリンクを辿らず、別の dev に入らない。worktree なら
//   worktree だけを消して本体のその記録だけを片づける（本体は消さない）。本体が先に消えた worktree は、数えられないと
//   言って名前を打たせて消せる。消したら台帳から外す。GitHub のリモートには触らない
// - Project は触らない——使っている Project を閉じるのは core の確認画面（`dev.banto/close-projects`）で人が押したとき

import { lstat, readdir, readFile, realpath, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { lossCount, readFolder, readLosses, removeWorktreeRecord, type LossReport } from "./git.js";
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
  /** `worktree`：worktree だけを消す（本体は `main`）。`orphan-worktree`：本体が消えた worktree（数えられない） */
  kind?: "repo" | "worktree" | "orphan-worktree";
  /** worktree の本体（見せる形と、実際の場所） */
  main?: string;
  mainPath?: string;
  losses?: LossReport;
  /** 失われるものの数（数えきれなかったものは含まない） */
  lossCount?: number;
  /** 本体を消すと使えなくなる worktree */
  worktrees?: string[];
  /** そのフォルダ（かその worktree）か、その下のフォルダを根にしている Project。引けなければ無く、`projectsError` に理由 */
  projects?: Array<{ id: string; name: string; closed: boolean }>;
  projectsError?: string;
  /** リポジトリ名を打たせるか（失われるもの・数えきれないもの・壊れる worktree・使っている Project があるとき） */
  needsTypedName?: boolean;
}

const isInside = (child: string, parent: string) => child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** **試験で差し替える穴**——マウントの一覧の場所と、歩くときの lstat（試験では本物のマウントを作れない） */
export const DELETE_HOOKS = { mountinfo: "/proc/self/mountinfo", lstat };

/**
 * そのフォルダか、その中にマウントされているもの（bind mount・FUSE 等）。`fs.rm` はマウントを越えて消すので、あれば
 * 断る。マウントの一覧が無い（Linux でない）なら空——消すときに歩きながら dev を見る（`removeTree`）
 */
export async function mountsAt(path: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(DELETE_HOOKS.mountinfo, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // 5つ目がマウントした場所（空白などは \040 のように8進で書かれる）
  const unescape = (v: string) => v.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)));
  return text
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter((m): m is string => !!m)
    .map(unescape)
    .filter((m) => m === path || isInside(m, path));
}

/**
 * フォルダを消す。**リンクは辿らず**（リンクそのものを消す）、**別の dev（マウント）に入る手前で止まる**——
 * `fs.rm` はマウントを越えて消す。止まったら、そこまでに消したものは戻らないので、マウントは調べるとき（`mountsAt`）に断る
 */
async function removeTree(root: string): Promise<void> {
  const top = await DELETE_HOOKS.lstat(root);
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const info = await DELETE_HOOKS.lstat(p);
      if (info.isDirectory()) {
        if (info.dev !== top.dev) throw new Error(`${p} は別のファイルシステム（マウント）なので、その先は消していません`);
        await walk(p);
        await rmdir(p);
      } else {
        await unlink(p);
      }
    }
  };
  await walk(root);
  await rmdir(root);
}

/**
 * 本体の無い worktree か：一番上の `.git` が「gitdir: <場所>」のファイルで、その場所が無い。本体を先に消すと、
 * worktree は git から見て「git でないフォルダ」になる（実測）
 */
async function orphanWorktreeOf(path: string): Promise<string | undefined> {
  const dotGit = join(path, ".git");
  try {
    if (!(await lstat(dotGit)).isFile()) return undefined;
    const m = /^gitdir: (.+)$/m.exec((await readFile(dotGit, "utf8")).slice(0, 4096));
    if (!m) return undefined;
    const target = resolve(path, m[1]!.trim());
    try {
      await lstat(target);
      return undefined;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? target : undefined;
    }
  } catch {
    return undefined;
  }
}

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
  let mounts;
  try {
    mounts = await mountsAt(path);
  } catch (err) {
    return { ...base, refusal: `マウントの一覧を読めません（${(err as Error).message}）——中に別のファイルシステムが無いか確かめられないので消しません` };
  }
  if (mounts.length > 0) {
    return {
      ...base,
      refusal: `中に別のファイルシステムがマウントされています（${mounts.map((m) => displayPath(m, home)).join("・")}）——消すとマウント先の中身まで消えるので消しません。外してから、もう一度`,
    };
  }
  let facts;
  try {
    facts = await readFolder(path);
  } catch (err) {
    return { ...base, refusal: `読めません（${(err as Error).message}）` };
  }
  let kind: "repo" | "worktree" | "orphan-worktree";
  let losses: LossReport;
  let gone: string | undefined;
  if (facts.kind === "repo" || facts.kind === "worktree") {
    kind = facts.kind;
    losses = await readLosses(path);
  } else if (facts.kind === "not-git" && (gone = await orphanWorktreeOf(path))) {
    // 本体が先に消えた worktree——git が読めないので数えられない。数えられないと言って、名前を打たせて消せる
    kind = "orphan-worktree";
    losses = {
      unpushed: [], unpushedTotal: 0, detached: 0, localOnlyBranches: [], localOnlyTags: [], changed: 0, untracked: 0, stashes: 0,
      problems: [`本体の無い worktree です（記録の場所 ${displayPath(gone, home)} がありません）——git で読めないので、変更・追跡していないものを数えられません`],
    };
  } else {
    return { ...base, refusal: "リポジトリでないフォルダは消しません（中身が分からないので、失われるものを数えられない）" };
  }
  const worktrees = facts.kind === "repo" ? facts.worktrees : [];
  const roots = [path, ...worktrees];
  // その場所か、その下のフォルダ（monorepo の packages/app 等）を根にした Project
  const projects = lookup?.ok
    ? lookup.projects
        .filter((p) => roots.some((r) => p.root === r || isInside(p.root, r)))
        .map((p) => ({ id: p.id, name: p.name, closed: p.status === "closed" }))
    : undefined;
  const count = lossCount(losses);
  return {
    ...base,
    kind,
    ...(facts.kind === "worktree" ? { main: displayPath(facts.main, home), mainPath: facts.main } : {}),
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
  await removeTree(input.path);
  if (now.kind === "worktree" && now.mainPath) {
    // 本体の側の、この worktree の記録（.git/worktrees/<名前>）だけを片づける。本体は消さない
    await removeWorktreeRecord(now.mainPath, input.path).catch((err: Error) => {
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
