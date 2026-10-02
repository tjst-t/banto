// Repositories の判断（docs/specs/v4-modules.md §2.4）。画面は言い方だけを持ち、**何が起きるかはここで決める**
// （規則3——モックの `inspectImport`・`syncWithFolders`・一覧の並べ方の1箇所ずつと同じ分け方）。
//
// - 一覧：台帳から作る。フォルダの事実（git）と、どの Project が根にしているか（core の Project の一覧）を合わせる。
//   答えるたびに origin と突き合わせて台帳を直す
// - Import：人が選んだフォルダ1つを、その場所のまま台帳に足す。断るときは理由と次の手を言えるだけの値を返す
// - 外す／元に戻す：台帳からだけ外す。フォルダには触らない
// - 扱うアカウント：origin の持ち主と登録したアカウントの login が一致したら台帳に覚える（覚えていなければ）。
//   一致しなければ「読むだけ」

import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { nearestExistingFolder, readFolder, type FolderFacts } from "./git.js";
import {
  DEFAULT_REPO_HOME,
  parseLedgerEntry,
  syncWithOrigin,
  type GithubAccount,
  type LedgerEntry,
  type LedgerStore,
} from "./ledger.js";
import { displayPath, resolveUserPath } from "./paths.js";
import { remoteHost, type GithubLocation, type RemoteLocation } from "./remote.js";

/** core の Project の姿（中継の `relayListProjects` が返すもの） */
export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  status: "active" | "closed";
}

/** どの Project が使っているかを引けたか。**引けなかったことを「使っていない」と言わない**（規則2） */
export type ProjectsLookup = { ok: true; projects: ProjectSummary[] } | { ok: false; error: string };

export type RemoteView =
  | ({ kind: "github" } & GithubLocation)
  | { kind: "elsewhere"; url: string; host: string }
  | { kind: "none" };

export interface ProjectUse {
  id: string;
  name: string;
  closed: boolean;
  /** その Project の根はこのリポジトリの worktree（フォルダそのものではない） */
  viaWorktree: boolean;
}

export interface RepoRow {
  path: string;
  displayPath: string;
  /** フォルダ名 */
  name: string;
  /**
   * - `ok`：フォルダがあり、git のリポジトリ
   * - `missing`：フォルダが見つからない（手がかりは台帳の値だけ）
   * - `not-repo`：フォルダはあるが、リポジトリの一番上ではなくなっている（.git を消した等）
   * - `unreadable`：読めなかった（権限・git が断った等）。理由は `problem`
   */
  state: "ok" | "missing" | "not-repo" | "unreadable";
  problem?: string;
  /** `ok` はフォルダの origin。`missing` 等は台帳が覚えている場所（`remembered`） */
  remote?: RemoteView;
  remembered?: boolean;
  branch?: string;
  commits?: number;
  /** コミット数を数えられなかった理由（行は読めている） */
  commitsProblem?: string;
  correctedFrom?: GithubLocation;
  /**
   * 扱うアカウント（GitHub のリポジトリだけ）。`registered` が false なら、覚えている login が今は登録されていない
   * ——読むだけ。無ければ、扱うアカウントが無い（読むだけ）
   */
  account?: { login: string; registered: boolean };
  /** 引けなかったら無い（`section` も `unknown`） */
  projects?: ProjectUse[];
  section: "used" | "unused" | "unknown";
}

export interface RepoListing {
  rows: RepoRow[];
  /** どの Project が使っているかを引けなかった理由（あれば、区切りは作れない） */
  projectsError?: string;
}

function remoteView(remote: RemoteLocation): RemoteView {
  return remote.kind === "elsewhere" ? { ...remote, host: remoteHost(remote.url) } : remote;
}

function rememberedRemote(entry: LedgerEntry): RemoteView | undefined {
  if (entry.github) return { kind: "github", ...entry.github };
  if (entry.elsewhere) return { kind: "elsewhere", url: entry.elsewhere, host: remoteHost(entry.elsewhere) };
  return undefined;
}

/** フォルダを読む。**読めなかったことは値にする**——1行が読めないだけで一覧ごと出なくしない */
async function readFacts(path: string): Promise<FolderFacts | { kind: "error"; message: string }> {
  try {
    return await readFolder(path);
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

/** 次の手が要る順：見つからない・読めない → このマシンにだけ → あとは名前順（§2.4。並べ替えは無い） */
function rank(row: RepoRow): number {
  if (row.state !== "ok") return 0;
  return row.remote?.kind === "none" ? 1 : 2;
}

export function sortRows(rows: RepoRow[]): RepoRow[] {
  const order = { used: 0, unknown: 0, unused: 1 } as const;
  return [...rows].sort(
    (a, b) =>
      order[a.section] - order[b.section] ||
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, "ja") ||
      a.path.localeCompare(b.path),
  );
}

function projectsUsing(path: string, worktrees: string[], lookup: ProjectsLookup): ProjectUse[] | undefined {
  if (!lookup.ok) return undefined;
  return lookup.projects
    .filter((p) => p.root === path || worktrees.includes(p.root))
    .map((p) => ({ id: p.id, name: p.name, closed: p.status === "closed", viaWorktree: p.root !== path }));
}

/**
 * 扱うアカウントを決める。**覚えていればそれ**（登録を外していても変えない）。覚えていなくて、GitHub の持ち主と同じ
 * login のアカウントが登録されていれば、それを覚える（書き戻すかは呼ぶ側）
 */
export function assignAccount(entry: LedgerEntry, accounts: GithubAccount[]): LedgerEntry {
  if (entry.account || !entry.github) return entry;
  const owner = entry.github.owner.toLowerCase();
  const match = accounts.find((a) => a.login.toLowerCase() === owner);
  return match ? { ...entry, account: match.login } : entry;
}

function accountView(entry: LedgerEntry, accounts: GithubAccount[]): RepoRow["account"] {
  if (!entry.account) return undefined;
  const login = entry.account.toLowerCase();
  const found = accounts.find((a) => a.login.toLowerCase() === login);
  return { login: found?.login ?? entry.account, registered: found !== undefined };
}

/**
 * 一覧を作る。**答えるたびに origin と突き合わせ、食い違っていれば台帳を直す**（§2.4）。扱うアカウントが決まって
 * いなければ、ここで登録したアカウントと突き合わせる。
 * Project の一覧は呼ぶ側が引いて渡す（中継の口は人の画面からの呼び出しの中でだけ答える）
 */
export async function listRepositories(
  store: LedgerStore,
  lookup: ProjectsLookup,
  home = homedir(),
  read: (path: string) => Promise<Facts> = readFacts,
): Promise<RepoListing> {
  const accounts = await store.accounts();
  // **git は台帳の書き込みの列の外で読む**——応答しないマウントが1つあるだけで、Import・外す等の全部の書き込みが
  // 止まらないように。列の中でするのは、読めた事実との突き合わせと書き戻しだけ
  const facts = new Map<string, Facts>();
  await Promise.all((await store.entries()).map(async (e) => void facts.set(e.path, await read(e.path))));
  const entries = await store.update((before) => {
    let changed = false;
    const next = before.map((e) => {
      const f = facts.get(e.path);
      // 読んでいる間に足された行は、まだ突き合わせない（次の一覧で）
      const synced = !f || f.kind === "error" ? e : syncWithOrigin(e, f).entry;
      const assigned = assignAccount(synced, accounts);
      if (assigned !== e) changed = true;
      return assigned;
    });
    return { entries: changed ? next : before, result: next };
  });
  for (const e of entries) if (!facts.has(e.path)) facts.set(e.path, await read(e.path));
  const rows = entries.map((entry) => toRow(entry, facts.get(entry.path)!, lookup, home, accounts));
  return { rows: sortRows(rows), ...(lookup.ok ? {} : { projectsError: lookup.error }) };
}

type Facts = FolderFacts | { kind: "error"; message: string };

function toRow(
  entry: LedgerEntry,
  facts: FolderFacts | { kind: "error"; message: string },
  lookup: ProjectsLookup,
  home: string,
  accounts: GithubAccount[],
): RepoRow {
  const account = accountView(entry, accounts);
  const base = {
    path: entry.path,
    displayPath: displayPath(entry.path, home),
    name: basename(entry.path),
    ...(account ? { account } : {}),
  };
  const remembered = rememberedRemote(entry);
  const withProjects = (row: Omit<RepoRow, "section" | "projects">, worktrees: string[]): RepoRow => {
    const projects = projectsUsing(entry.path, worktrees, lookup);
    return {
      ...row,
      ...(projects ? { projects } : {}),
      section: projects === undefined ? "unknown" : projects.length > 0 ? "used" : "unused",
    };
  };
  switch (facts.kind) {
    case "repo":
      return withProjects(
        {
          ...base,
          state: "ok",
          remote: remoteView(facts.remote),
          ...(facts.branch ? { branch: facts.branch } : {}),
          ...commitsOf(facts),
          ...(entry.correctedFrom ? { correctedFrom: entry.correctedFrom } : {}),
        },
        facts.worktrees,
      );
    case "missing":
      return withProjects({ ...base, state: "missing", ...(remembered ? { remote: remembered, remembered: true } : {}) }, []);
    case "error":
      return withProjects(
        { ...base, state: "unreadable", problem: facts.message, ...(remembered ? { remote: remembered, remembered: true } : {}) },
        [],
      );
    default:
      return withProjects(
        {
          ...base,
          state: "not-repo",
          problem:
            facts.kind === "not-git"
              ? "フォルダはありますが、git のリポジトリではなくなっています"
              : `フォルダはありますが、${describeRefusal(facts, home)}`,
          ...(remembered ? { remote: remembered, remembered: true } : {}),
        },
        [],
      );
  }
}

// ── Import ────────────────────────────────────────────────────────────────

interface Place {
  path: string;
  displayPath: string;
  name: string;
}

export type ImportCheck =
  /** git のリポジトリで、まだ台帳に無い——Import できる。`account` は扱うことになるアカウント（無ければ読むだけ） */
  | { kind: "ready"; remote: RemoteView; branch?: string; commits?: number; commitsProblem?: string; account?: string }
  /** もう台帳にある */
  | { kind: "known" }
  /** worktree——本体が台帳にあれば `mainKnown` */
  | { kind: "worktree"; main: Place; mainKnown: boolean }
  /** リポジトリの中のフォルダ——一番上を選ぶ */
  | { kind: "inside"; top: Place }
  /** git でないフォルダ */
  | { kind: "not-git" }
  /** 作業ツリーの無い（bare）リポジトリ・どの作業ツリーのものか決められない git の管理用のフォルダ——Import できない */
  | { kind: "bare" }
  | { kind: "git-dir" }
  /** 無いパス——いちばん近くにある上のフォルダへ */
  | { kind: "missing"; nearest: Place };

export interface ImportInspection extends Place {
  check: ImportCheck;
}

function place(path: string, home: string): Place {
  return { path, displayPath: displayPath(path, home), name: path === "/" ? "/" : basename(path) };
}

/** そのフォルダを Import すると何が起きるか。**読めなかったら投げる**——「git でない」と取り違えない（規則2） */
export async function inspectImport(store: LedgerStore, input: string, home = homedir()): Promise<ImportInspection> {
  const resolved = resolveUserPath(input, home);
  const facts = await readFolder(resolved);
  const entries = await store.entries();
  const accounts = await store.accounts();
  const known = (p: string) => entries.some((e) => e.path === p);
  switch (facts.kind) {
    case "missing":
      return { ...place(resolved, home), check: { kind: "missing", nearest: place(await nearestExistingFolder(resolved), home) } };
    case "not-git":
    case "bare":
    case "git-dir":
      return { ...place(resolved, home), check: { kind: facts.kind } };
    case "inside":
      return { ...place(resolved, home), check: { kind: "inside", top: place(facts.top, home) } };
    case "worktree":
      return {
        ...place(resolved, home),
        check: { kind: "worktree", main: place(facts.main, home), mainKnown: known(facts.main) },
      };
    case "repo":
      if (known(facts.path)) return { ...place(facts.path, home), check: { kind: "known" } };
      {
        const account = assignAccount(newEntry(facts), accounts).account;
        return {
          ...place(facts.path, home),
          check: {
            kind: "ready",
            remote: remoteView(facts.remote),
            ...(facts.branch ? { branch: facts.branch } : {}),
            ...commitsOf(facts),
            ...(account ? { account } : {}),
          },
        };
      }
  }
}

function commitsOf(facts: Extract<FolderFacts, { kind: "repo" }>): { commits?: number; commitsProblem?: string } {
  return {
    ...(facts.commits !== undefined ? { commits: facts.commits } : {}),
    ...(facts.commitsProblem ? { commitsProblem: facts.commitsProblem } : {}),
  };
}

function newEntry(facts: Extract<FolderFacts, { kind: "repo" }>): LedgerEntry {
  return {
    path: facts.path,
    ...(facts.remote.kind === "github" ? { github: { owner: facts.remote.owner, name: facts.remote.name } } : {}),
    ...(facts.remote.kind === "elsewhere" ? { elsewhere: facts.remote.url } : {}),
  };
}

/** Import する。**画面の判断を信じず、ここで読み直す**——Import できるときだけ足す */
export async function importRepository(store: LedgerStore, input: string, home = homedir()): Promise<Place> {
  const resolved = resolveUserPath(input, home);
  const accounts = await store.accounts();
  // 読み直すのは列の外で（git が止まっても、ほかの書き込みを止めない）。足す直前のぶつかりは列の中で見る
  const facts = await readFolder(resolved);
  return store.update((entries) => {
    if (facts.kind !== "repo") throw new Error(`${displayPath(resolved, home)} は Import できません（${describeRefusal(facts, home)}）`);
    if (entries.some((e) => e.path === facts.path)) {
      throw new Error(`${displayPath(facts.path, home)} は、もう一覧にあります`);
    }
    const entry = assignAccount(newEntry(facts), accounts);
    return { entries: [...entries, entry], result: place(facts.path, home) };
  });
}

function describeRefusal(facts: Exclude<FolderFacts, { kind: "repo" }>, home: string): string {
  switch (facts.kind) {
    case "missing":
      return "このフォルダはありません";
    case "not-git":
      return "git のリポジトリではありません";
    case "bare":
      return "作業ツリーの無い（bare）リポジトリです。clone した作業ツリーを選んでください";
    case "git-dir":
      return "git の管理用のフォルダです（作業ツリーではありません）";
    case "inside":
      return `${displayPath(facts.top, home)} のリポジトリの中のフォルダです`;
    case "worktree":
      return `${displayPath(facts.main, home)} の worktree です`;
  }
}

// ── 外す・元に戻す・お知らせを消す ───────────────────────────────────────────

/** 一覧から外す——**台帳の行だけ**。フォルダには触らない。戻すときのために外した行を返す */
export function removeRepository(store: LedgerStore, path: string): Promise<LedgerEntry> {
  return store.update((entries) => {
    const entry = entries.find((e) => e.path === path);
    if (!entry) throw new Error(`${path} は一覧にありません`);
    return { entries: entries.filter((e) => e !== entry), result: entry };
  });
}

/**
 * 「元に戻す」——外した行を戻し、フォルダがあれば origin に合わせる。**置き場所は画面が持ってきた字を信じない**
 * ——リポジトリならその一番上（realpath）、フォルダがあればその realpath に寄せる（台帳は realpath で覚える決まり）
 */
export async function restoreRepository(store: LedgerStore, raw: unknown): Promise<LedgerEntry> {
  const given = parseLedgerEntry(raw, "戻す行");
  const facts = await readFacts(given.path);
  const path = facts.kind === "repo" ? facts.path : await realpath(given.path).catch(() => given.path);
  const entry = { ...given, path };
  const synced = facts.kind === "error" ? entry : syncWithOrigin(entry, facts).entry;
  return store.update((entries) => {
    if (entries.some((e) => e.path === path)) throw new Error(`${path} は、もう一覧にあります`);
    return { entries: [...entries, synced], result: synced };
  });
}

/** 台帳を直したお知らせを見た——一度見たら消す（覚えていた古い場所も一緒に忘れる） */
export function dismissCorrection(store: LedgerStore, path: string): Promise<void> {
  return store.update((entries) => {
    if (!entries.some((e) => e.path === path && e.correctedFrom)) return { entries, result: undefined };
    return {
      entries: entries.map((e) => {
        if (e.path !== path) return e;
        const { correctedFrom: _seen, ...rest } = e;
        return rest;
      }),
      result: undefined,
    };
  });
}

// ── フォルダをたどる（Import のダイアログ・置き場を選ぶ） ──────────────────────

export interface FolderListing extends Place {
  parent?: Place;
  /** 中のフォルダ。**名前だけ**——中身も git の状態も読まない。台帳にあるかだけは台帳から言える */
  entries: Array<Place & { known: boolean }>;
}

/**
 * そのフォルダの中のフォルダ（名前だけ）。core の `/api/fs/directories` と同じ窓——**ファイル名も中身も返さない**。
 * 開こうとした場所そのものが読めないときは投げる（規則2）
 */
export async function listFolders(store: LedgerStore, input: string | undefined, home = homedir()): Promise<FolderListing> {
  const path = resolveUserPath(input, home);
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 打たれたパスが無い・フォルダでないは、そう言う（node の文言をそのまま見せない）
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error(`${displayPath(path, home)} というフォルダはありません`);
    if (code === "EACCES") throw new Error(`${displayPath(path, home)} は読む権限がありません`);
    throw err;
  }
  const ledger = new Set((await store.entries()).map((e) => e.path));
  const entries: FolderListing["entries"] = [];
  for (const d of dirents) {
    // git の管理用のフォルダは、選ぶものではない
    if (d.name === ".git") continue;
    const full = join(path, d.name);
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = (await stat(full)).isDirectory();
      } catch {
        // 切れたリンク——出さない
      }
    }
    if (isDir) entries.push({ ...place(full, home), known: ledger.has(full) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const up = dirname(path);
  return { ...place(path, home), ...(up !== path ? { parent: place(up, home) } : {}), entries };
}

// ── 置き場の設定 ────────────────────────────────────────────────────────────

export interface RepoHomeView {
  repoHome: string;
  isDefault: boolean;
  defaultRepoHome: string;
  /** いまそのフォルダがあるか（無ければ「最初に使うときに作ります」と言う） */
  exists: boolean;
}

/** 置き場として受ける形にそろえる。ホームや `/` そのものは断る（その下のフォルダを選ばせる） */
export function normalizeRepoHome(input: string, home = homedir()): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "~" || trimmed === "/" || resolveUserPath(trimmed, home) === home) {
    throw new Error("ホームや / をそのまま置き場にはできません。その下のフォルダを選んでください");
  }
  if (!trimmed.startsWith("~/") && !trimmed.startsWith("/")) {
    throw new Error("置き場は ~/ か / から始まるパスで書いてください");
  }
  // 人が打った形（~/…）で覚える。home の下を選んだら ~/… に直す（home が変わっても同じ意味のまま）
  return displayPath(resolveUserPath(trimmed, home), home);
}

export async function repoHomeView(store: LedgerStore, home = homedir()): Promise<RepoHomeView> {
  const { repoHome } = await store.settings();
  const value = repoHome ?? DEFAULT_REPO_HOME;
  let exists = false;
  try {
    exists = (await stat(resolveUserPath(value, home))).isDirectory();
  } catch {
    exists = false;
  }
  return { repoHome: value, isDefault: repoHome === undefined, defaultRepoHome: DEFAULT_REPO_HOME, exists };
}

/** 置き場を変える。`null` で既定に戻す。**今あるフォルダは動かさない**（台帳はパスで覚えている） */
export async function setRepoHome(store: LedgerStore, input: string | null, home = homedir()): Promise<RepoHomeView> {
  if (input === null) await store.updateSettings({ repoHome: undefined });
  else {
    const value = normalizeRepoHome(input, home);
    await store.updateSettings({ repoHome: value === DEFAULT_REPO_HOME ? undefined : value });
  }
  return repoHomeView(store, home);
}
