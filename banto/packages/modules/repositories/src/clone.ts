// URL から clone・新しいリポジトリ（docs/specs/v4-modules.md §2.4「始める3つの手」、段階3）。
//
// 判断はここで決め、画面は言い方だけを持つ（モックの `parseCloneSource`・`inspectCloneSource`・`inspectTargetFolder`・
// `freeFolderName` の1箇所ずつと同じ分け方）。
//
// - **clone の元**：`owner/repo`・`https://…`・`git@host:path`・`ssh://…`。GitHub の外も受ける。手元のパス・`file://`・
//   `git://`（暗号化されない）・`ext::`・URL に資格情報を書いたもの（clone 先の `.git/config` に残る）は断る
// - **もう手元にあるなら clone しない**。台帳が覚えているのにフォルダが見つからない行なら、**その場所に clone し直す**
// - **置く場所**は既定の置き場の下 `<置き場>/<名前>`。ぶつかれば `<名前>-2` を先に入れておき、人が変えられる
// - **資格情報**：GitHub のアカウントで clone するときは、そのアカウントの使えるトークン（`tokenFor`）を一度きりの窓口
//   （`credential-server.ts`）から git に渡す。SSH 鍵を選んだアカウントは Vault の ssh-agent の窓口で。GitHub の外は
//   このマシンの git の設定で（`writeEnv` の `machine`）。登録したアカウントの無い GitHub は資格情報を使わない
// - **clone は背景の仕事**（大きいものは何分もかかる）。画面は進み具合を聞きに来る（`status`）。Vault の口は押した
//   呼び出しの中で使い終える——背景の仕事は Vault を呼ばない（人の画面の外の呼び出しにしない、段階2と同じ理由）

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { GithubAccounts } from "./accounts.js";
import { openCredentialWindow, type CredentialWindow } from "./credential-server.js";
import { configuredDefaultBranch, gitClone, gitInit, readFolder, sshCommandFor, type CloneProgress, type GitCredential } from "./git.js";
import type { GithubApi, GithubEndpoints } from "./github.js";
import { DEFAULT_REPO_HOME, syncWithOrigin, type LedgerEntry, type LedgerStore } from "./ledger.js";
import { displayPath, resolveUserPath } from "./paths.js";
import { assignAccount, newEntry, type ProjectsLookup } from "./repositories.js";
import type { VaultAccess } from "./vault.js";

// ── clone の元 ────────────────────────────────────────────────────────────

export type CloneSource =
  | { kind: "github"; owner: string; name: string }
  | { kind: "elsewhere"; url: string; host: string; name: string };

const NAME = /^[A-Za-z0-9._-]+$/;

/** フォルダ名（＝リポジトリ名）に使えるか。英数字と - _ .、ドットだけは不可 */
export function isValidFolderName(name: string): boolean {
  return NAME.test(name) && !/^\.+$/.test(name);
}

const stripGit = (s: string) => s.replace(/\.git$/, "");

/** GitHub と見なす host（本物と、行き先を替えたときの偽物） */
function githubHosts(github: GithubEndpoints): Set<string> {
  const hosts = new Set(["github.com", "www.github.com"]);
  try {
    hosts.add(new URL(github.web).host.toLowerCase());
  } catch {
    // 行き先が URL でない——本物の名前だけで見る
  }
  if (github.ssh) hosts.add(github.ssh.toLowerCase());
  return hosts;
}

/** 行き先を替えた GitHub（`endpoints.web`）そのものか——http はこれだけ受ける */
function isConfiguredWeb(github: GithubEndpoints, u: URL): boolean {
  try {
    const web = new URL(github.web);
    return web.protocol === u.protocol && web.host.toLowerCase() === u.host.toLowerCase();
  } catch {
    return false;
  }
}

function ownerName(path: string): { owner: string; name: string } | undefined {
  const m = path.replace(/^\/+/, "").replace(/\/+$/, "").match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m) return undefined;
  const name = stripGit(m[2]!);
  return isValidFolderName(name) ? { owner: m[1]!, name } : undefined;
}

/**
 * clone の元を読む。読めなければ理由を返す（打っている途中は画面が例を出すだけで、押したときに断る）
 */
export function parseCloneSource(text: string, github: GithubEndpoints): CloneSource | { kind: "invalid"; reason: string } {
  const t = text.trim().replace(/\/+$/, "");
  const invalid = (reason: string) => ({ kind: "invalid" as const, reason });
  if (t === "") return invalid("URL を入れてください");
  if (t.startsWith("-")) return invalid("URL として読めません");
  const hosts = githubHosts(github);
  const short = ownerName(t.replace(/^(?:www\.)?github\.com\//i, ""));
  if (short && !t.includes(":")) return { kind: "github", ...short };
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme !== "https" && scheme !== "http" && scheme !== "ssh") {
      return invalid(scheme === "git" ? "git:// は暗号化されないので受けません（https か ssh の URL にしてください）" : `${scheme}:// の URL は受けません（https か ssh の URL にしてください）`);
    }
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      return invalid("URL として読めません");
    }
    // https://user:token@host/… は clone 先の .git/config に残る（そこから AI が読める）
    if (u.password || (scheme !== "ssh" && u.username)) return invalid("URL に資格情報を書かないでください（アカウントは下で選びます）");
    const host = u.host.toLowerCase();
    // http は暗号化されない（git:// を断るのと同じ理由）。受けるのは行き先を替えた GitHub（試験の偽物）だけ
    if (scheme === "http" && !isConfiguredWeb(github, u)) {
      return invalid("http:// は暗号化されないので受けません（https か ssh の URL にしてください）");
    }
    if (hosts.has(host) || hosts.has(u.hostname.toLowerCase())) {
      const loc = ownerName(u.pathname);
      if (!loc) return invalid("GitHub の URL は github.com/owner/repo の形で入れてください");
      return { kind: "github", ...loc };
    }
    const name = stripGit(basename(u.pathname));
    if (!name || u.pathname.replace(/\/+/g, "/") === "/") return invalid("リポジトリの場所（パス）がありません");
    if (!isValidFolderName(name)) return invalid(`リポジトリ名「${name}」はフォルダ名に使えません`);
    return { kind: "elsewhere", url: t, host, name };
  }
  // scp の形（`git@host:path`）
  const scp = t.match(/^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost):(?!\/\/)(.+)$/);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    if (hosts.has(host)) {
      const loc = ownerName(scp[2]!);
      if (!loc) return invalid("GitHub の URL は git@github.com:owner/repo.git の形で入れてください");
      return { kind: "github", ...loc };
    }
    const name = stripGit(basename(scp[2]!));
    if (!isValidFolderName(name)) return invalid(`リポジトリ名「${name}」はフォルダ名に使えません`);
    return { kind: "elsewhere", url: t, host, name };
  }
  if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".")) {
    return invalid("手元のフォルダは clone しません（そのまま使うなら「フォルダを Import」を使ってください）");
  }
  return invalid("URL として読めません");
}

/** 同じリポジトリかを比べる鍵（`git@gitlab.com:a/b.git` と `https://gitlab.com/a/b` は同じ） */
export function remoteKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .toLowerCase();
}

export function sourceLabel(source: CloneSource): string {
  return source.kind === "github" ? `${source.owner}/${source.name}` : `${source.host}/${source.name}`;
}

// ── 置く場所 ───────────────────────────────────────────────────────────────

export type TargetState =
  /** 何も無い——ここに clone する／作る */
  | { kind: "free" }
  /** 台帳にあるリポジトリがある */
  | { kind: "taken-repo"; name: string; suggestion: string }
  /** 台帳にあるリポジトリの場所だが、フォルダが見つからない（clone し直す先として空けておく） */
  | { kind: "taken-missing"; name: string; suggestion: string }
  /** 台帳に無い git のリポジトリがある */
  | { kind: "taken-unknown-repo"; suggestion: string }
  /** git でないフォルダ・ファイルがある */
  | { kind: "taken-folder"; entries: number; suggestion: string }
  /** いま別の clone がここに置こうとしている */
  | { kind: "taken-cloning"; suggestion: string };

/** 既定の置き場（見せる形と、実際の場所——在れば realpath。台帳は realpath で覚えるので、突き合わせに要る） */
export async function repoHomeOf(store: LedgerStore, home = homedir()): Promise<{ display: string; path: string }> {
  const display = (await store.settings()).repoHome ?? DEFAULT_REPO_HOME;
  const resolved = resolveUserPath(display, home);
  return { display, path: await realpath(resolved).catch(() => resolved) };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** そのパスが使われているか——フォルダ（かファイル）がある・台帳にある・clone の最中 */
async function taken(path: string, ledger: Set<string>, reserved: Set<string>): Promise<boolean> {
  return ledger.has(path) || reserved.has(path) || (await exists(path));
}

/** 置き場の中で空いている名前——`<名前>`、ぶつかったら `<名前>-2`、`-3`… */
export async function freeFolderName(home: string, name: string, ledger: Set<string>, reserved: Set<string>): Promise<string> {
  if (!(await taken(join(home, name), ledger, reserved))) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!(await taken(join(home, candidate), ledger, reserved))) return candidate;
  }
}

/** 置く先に、もう何があるか（判断はここ1箇所。画面は言い方だけ） */
export async function inspectTarget(
  home: string,
  folder: string,
  entries: LedgerEntry[],
  reserved: Set<string>,
): Promise<TargetState> {
  const path = join(home, folder);
  const ledger = new Set(entries.map((e) => e.path));
  if (!(await taken(path, ledger, reserved))) return { kind: "free" };
  const suggestion = await freeFolderName(home, folder, ledger, reserved);
  if (reserved.has(path)) return { kind: "taken-cloning", suggestion };
  if (ledger.has(path)) {
    const there = await exists(path);
    return there ? { kind: "taken-repo", name: folder, suggestion } : { kind: "taken-missing", name: folder, suggestion };
  }
  const facts = await readFolder(path).catch(() => undefined);
  if (facts?.kind === "repo") return { kind: "taken-unknown-repo", suggestion };
  const count = await readdir(path).then((l) => l.length, () => 0);
  return { kind: "taken-folder", entries: count, suggestion };
}

// ── clone の判断 ────────────────────────────────────────────────────────────

export interface CloneInspection {
  source?: CloneSource & { label: string };
  invalid?: string;
  /** もう手元にある——clone しない */
  have?: { path: string; displayPath: string; name: string; projects?: string[] };
  /** 台帳にあるのにフォルダが見つからない——その場所に clone し直す */
  reclone?: { path: string; displayPath: string; name: string };
  /**
   * 台帳はこのリポジトリを覚えているが、その場所にあるものが違う（リポジトリでない・読めない）——clone し直さない
   * （上書き・消すことになる）。別の名前で置き場の下に clone するか、一覧から外す
   */
  misplaced?: { path: string; displayPath: string; name: string; problem: string };
  /** 置き場の下に clone する */
  target?: {
    home: string;
    folder: string;
    path: string;
    displayPath: string;
    /** 元の名前がぶつかったので `-2` 等にしたとき、元の名前 */
    renamedFrom?: string;
    folderInvalid?: boolean;
    state: TargetState;
  };
  /** GitHub のとき、使えるアカウント（login）と先に選んでおくもの（URL の持ち主と同じ login か、1つならそれ） */
  accounts?: { logins: string[]; preselected?: string };
}

export interface CloneJobView {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  path: string;
  displayPath: string;
  label: string;
  recloned: boolean;
  /** Project 名の既定（リポジトリ名） */
  suggestedName: string;
  account?: string;
  progress?: CloneProgress;
  /** 失敗の理由と、次の手の手がかり */
  error?: { message: string; hint: "not-found" | "auth" | "ssh" | "host-key" | "network" | "timeout" | "other" };
}

interface CloneJob extends CloneJobView {
  abort: AbortController;
  finishedAt?: number;
}

export interface ClonerDeps {
  store: LedgerStore;
  /** この Module のデータ置き場（GitHub の SSH の host 鍵を置く） */
  dataDir: string;
  accounts: GithubAccounts;
  vault: VaultAccess;
  github: GithubApi;
  endpoints: GithubEndpoints;
  home?: string;
}

/** git の失敗の文言から、次の手の手がかりを読む */
/** 失敗の分類——**相手の言葉（`remote:` の行）は見ない**（呼ぶ側が除いて渡す） */
function classify(message: string): NonNullable<CloneJobView["error"]>["hint"] {
  if (/Repository not found|repository '.*' not found|not found/i.test(message)) return "not-found";
  if (/could not read Username|Authentication failed|Invalid username or token|terminal prompts disabled|401/i.test(message)) return "auth";
  if (/Permission denied \(publickey/i.test(message)) return "ssh";
  if (/Host key verification failed/i.test(message)) return "host-key";
  if (/Could not resolve host|Connection refused|Connection timed out|unable to access|Network is unreachable/i.test(message)) return "network";
  return "other";
}

const EXPLAIN: Record<NonNullable<CloneJobView["error"]>["hint"], string> = {
  "not-found": "見つかりません（非公開なら、このアカウントからは読めません）",
  auth: "資格情報が通りませんでした（非公開なら、読めるアカウントが要ります）",
  ssh: "SSH 鍵が受け付けられませんでした（その鍵を GitHub 等に登録してあるか確かめてください）",
  "host-key": "相手の SSH の鍵を確かめられませんでした（known_hosts と食い違っています）",
  network: "相手に繋がりませんでした",
  timeout: "",
  other: "",
};

/** GitHub の SSH の host 鍵（`githubKnownHosts` の説明を見る。確認日 2026-10-02） */
export const GITHUB_SSH_HOST_KEYS: readonly string[] = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
];

/** GitHub の host 鍵だけを置いた known_hosts を、この Module のデータ置き場に書く（clone・push で同じもの） */
export async function writeGithubKnownHosts(dataDir: string, endpoints: GithubEndpoints): Promise<string> {
  const path = join(dataDir, "github_known_hosts");
  const host = endpoints.ssh ?? "github.com";
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, GITHUB_SSH_HOST_KEYS.map((k) => `${host} ${k}`).join("\n") + "\n", { mode: 0o644 });
  return path;
}

/** 終わった仕事を覚えておく長さ（画面が結果を取りに来るまで） */
const KEEP_FINISHED_MS = 10 * 60_000;

export class Cloner {
  private readonly jobs = new Map<string, CloneJob>();
  /** clone の最中の置き場所（同じ場所に2つ置かない） */
  private readonly reserved = new Set<string>();

  constructor(private readonly deps: ClonerDeps) {}

  private get home() {
    return this.deps.home ?? homedir();
  }

  /**
   * そのリポジトリを、もう台帳が知っているか。その場所に**リポジトリがある**（手元にある）・**何も無い**（clone し直す）・
   * **違うものがある／読めない**（clone し直さない——読めないのを「無い」にすると、既にあるフォルダに clone し直して
   * 失敗の片づけで消しうる）
   */
  private async findKnown(
    source: CloneSource,
  ): Promise<{ entry: LedgerEntry; state: "repo" | "missing" | "other"; problem?: string } | undefined> {
    const entries = await this.deps.store.entries();
    const match = entries.find((e) =>
      source.kind === "github"
        ? !!e.github && e.github.owner.toLowerCase() === source.owner.toLowerCase() && e.github.name.toLowerCase() === source.name.toLowerCase()
        : !!e.elsewhere && remoteKey(e.elsewhere) === remoteKey(source.url),
    );
    if (!match) return undefined;
    let facts;
    try {
      facts = await readFolder(match.path);
    } catch (err) {
      return { entry: match, state: "other", problem: `読めません（${(err as Error).message}）` };
    }
    if (facts.kind === "repo") return { entry: match, state: "repo" };
    if (facts.kind === "missing") return { entry: match, state: "missing" };
    const what = { "not-git": "git のリポジトリでないフォルダ", bare: "作業ツリーの無い（bare）リポジトリ", "git-dir": "git の管理用のフォルダ", inside: "別のリポジトリの中のフォルダ", worktree: "別のリポジトリの worktree" }[facts.kind];
    return { entry: match, state: "other", problem: `${what}があります` };
  }

  async inspect(input: { source: string; folder?: string }, lookup?: ProjectsLookup): Promise<CloneInspection> {
    const parsed = parseCloneSource(input.source, this.deps.endpoints);
    if (parsed.kind === "invalid") return { invalid: parsed.reason };
    const source = { ...parsed, label: sourceLabel(parsed) };
    const known = await this.findKnown(parsed);
    if (known?.state === "repo") {
      const projects = lookup?.ok ? lookup.projects.filter((p) => p.root === known.entry.path).map((p) => p.name) : undefined;
      return {
        source,
        have: { path: known.entry.path, displayPath: displayPath(known.entry.path, this.home), name: basename(known.entry.path), ...(projects ? { projects } : {}) },
      };
    }
    // clone し直すなら、その行が覚えているアカウントを先に選ぶ
    const accounts = parsed.kind === "github" ? await this.accountChoice(known?.entry.account ?? parsed.owner) : undefined;
    const misplaced =
      known?.state === "other"
        ? { misplaced: { path: known.entry.path, displayPath: displayPath(known.entry.path, this.home), name: basename(known.entry.path), problem: known.problem ?? "" } }
        : {};
    if (known?.state === "missing") {
      return {
        source,
        reclone: { path: known.entry.path, displayPath: displayPath(known.entry.path, this.home), name: basename(known.entry.path) },
        ...(accounts ? { accounts } : {}),
      };
    }
    const home = await repoHomeOf(this.deps.store, this.home);
    const entries = await this.deps.store.entries();
    const auto = await freeFolderName(home.path, parsed.name, new Set(entries.map((e) => e.path)), this.reserved);
    const folder = input.folder?.trim() || auto;
    const folderInvalid = !isValidFolderName(folder);
    const path = join(home.path, folder);
    return {
      source,
      ...misplaced,
      target: {
        home: home.display,
        folder,
        path,
        displayPath: displayPath(path, this.home),
        ...(!input.folder?.trim() && auto !== parsed.name ? { renamedFrom: parsed.name } : {}),
        ...(folderInvalid ? { folderInvalid: true } : {}),
        state: folderInvalid ? { kind: "free" } : await inspectTarget(home.path, folder, entries, this.reserved),
      },
      ...(accounts ? { accounts } : {}),
    };
  }

  /** 使えるアカウントと、先に選ぶもの（持ち主——か覚えている login——と同じ login か、1つならそれ） */
  private async accountChoice(owner: string): Promise<{ logins: string[]; preselected?: string }> {
    const { accounts } = await this.deps.accounts.list();
    const logins = accounts.map((a) => a.login);
    const same = logins.find((l) => l.toLowerCase() === owner.toLowerCase());
    const preselected = same ?? (logins.length === 1 ? logins[0] : undefined);
    return { logins, ...(preselected ? { preselected } : {}) };
  }

  /**
   * clone を始める。**押した呼び出しの中で、判断を読み直し・資格情報を用意し**、git は背景で走らせる。
   * `account` は GitHub のときの login（null で「アカウントを使わない」）。省けば先に選んだもの
   */
  async start(input: { source: string; folder?: string; account?: string | null }, callId?: string): Promise<CloneJobView> {
    const inspection = await this.inspect(input);
    // **判断の直後、await を挟まずに場所を取る**——同じ場所への2本目は、1本目の判断と await の間に「空き」と見てしまう
    const reservedPath = (inspection.reclone ?? inspection.target)?.path;
    if (reservedPath !== undefined) {
      if (this.reserved.has(reservedPath)) throw new Error(`${displayPath(reservedPath, this.home)} には、いま別の clone が置こうとしています`);
      this.reserved.add(reservedPath);
    }
    let handed = false;
    try {
      const job = await this.prepare(input, inspection, callId);
      handed = true;
      return job;
    } finally {
      // 仕事に渡せなかった（断った・資格情報を用意できなかった）なら、取った場所を返す
      if (!handed && reservedPath !== undefined) this.reserved.delete(reservedPath);
    }
  }

  private async prepare(
    input: { source: string; folder?: string; account?: string | null },
    inspection: CloneInspection,
    callId?: string,
  ): Promise<CloneJobView> {
    if (inspection.invalid || !inspection.source) throw new Error(inspection.invalid ?? "URL として読めません");
    if (inspection.have) throw new Error(`もう手元にあります（${inspection.have.displayPath}）。新しくは clone しません`);
    const target = inspection.reclone ?? inspection.target;
    if (!target) throw new Error("置く場所が決まりません");
    if (inspection.target?.folderInvalid) throw new Error("フォルダ名に使えるのは英数字と - _ . だけです");
    if (inspection.target && inspection.target.state.kind !== "free") {
      throw new Error(`${inspection.target.displayPath} には、もう何かがあります（上書きしません）`);
    }
    const source = inspection.source;
    const login = source.kind === "github" ? (input.account === undefined ? inspection.accounts?.preselected : input.account ?? undefined) : undefined;
    if (login && !inspection.accounts?.logins.some((l) => l.toLowerCase() === login.toLowerCase())) {
      throw new Error(`@${login} は登録されていません`);
    }

    // 資格情報を用意する（Vault・GitHub の口はここで使い終える）
    let url: string;
    let credential: GitCredential;
    let window: CredentialWindow | undefined;
    if (source.kind === "elsewhere") {
      url = source.url;
      credential = { kind: "machine" };
    } else if (!login) {
      url = `${this.deps.endpoints.web.replace(/\/+$/, "")}/${source.owner}/${source.name}.git`;
      credential = { kind: "none" };
    } else {
      const account = (await this.deps.accounts.list()).accounts.find((a) => a.login.toLowerCase() === login.toLowerCase())!;
      if (account.ssh) {
        const sshHost = this.deps.endpoints.ssh ?? new URL(this.deps.endpoints.web).hostname;
        url = `git@${sshHost}:${source.owner}/${source.name}.git`;
        const socket = (await this.deps.vault.startSshAgent(account.ssh, callId)).socketPath;
        const knownHosts = await this.githubKnownHosts();
        // 窓口の場所を ssh のコマンドに埋められるかを、仕事を始める前に確かめる（だめなら押した画面に理由を返す）
        sshCommandFor(socket, knownHosts);
        credential = { kind: "ssh-agent", socket, knownHosts };
      } else {
        url = `${this.deps.endpoints.web.replace(/\/+$/, "")}/${source.owner}/${source.name}.git`;
        const token = await this.deps.accounts.tokenFor(account.login, callId);
        const web = new URL(url);
        window = await openCredentialWindow({ protocol: web.protocol.replace(/:$/, ""), host: web.host, username: account.login, password: token });
        credential = { kind: "helper", command: window.helperCommand };
      }
    }

    const id = randomUUID();
    const job: CloneJob = {
      id,
      state: "running",
      path: target.path,
      displayPath: target.displayPath,
      label: source.label,
      recloned: !!inspection.reclone,
      suggestedName: source.name,
      ...(login ? { account: login } : {}),
      abort: new AbortController(),
    };
    this.jobs.set(id, job);
    void this.run(job, url, credential, window);
    return this.view(job);
  }

  private async run(job: CloneJob, url: string, credential: GitCredential, window: CredentialWindow | undefined): Promise<void> {
    // **自分が作ったフォルダだけを消す**——始める前に、置く場所そのものを（recursive 無しで）作る。もう在れば作れず、
    // その場合は何も消さずに断る（ほかの誰かのフォルダ）
    let created = false;
    try {
      await mkdir(dirname(job.path), { recursive: true });
      try {
        await mkdir(job.path);
        created = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${job.displayPath} には、もう何かがあります（上書きしません）`);
        throw err;
      }
      const result = await gitClone({
        url,
        dest: job.path,
        credential,
        signal: job.abort.signal,
        onProgress: (p) => (job.progress = p),
      });
      if (!result.ok) {
        // 途中まで作ったフォルダは消す（この仕事が作ったもの）
        if (created) await rm(job.path, { recursive: true, force: true });
        job.state = result.kind === "cancelled" ? "cancelled" : "failed";
        if (result.kind !== "cancelled") {
          const hint = result.kind === "timeout" ? "timeout" : classify(result.own ?? "");
          const why = EXPLAIN[hint];
          job.error = { message: why ? `${why}——${result.message}` : result.message, hint };
        }
        return;
      }
      const facts = await readFolder(job.path);
      if (facts.kind !== "repo") throw new Error(`clone したフォルダが読めません（${facts.kind}）`);
      const accounts = (await this.deps.store.accounts());
      await this.deps.store.update((entries) => {
        const at = entries.findIndex((e) => e.path === job.path);
        const base: LedgerEntry = at >= 0 ? syncWithOrigin(entries[at]!, facts).entry : newEntry(facts);
        // 使ったアカウントを覚える（選んだもの）。選ばなかったなら持ち主と同じ login のものを
        const withAccount = job.account ? { ...base, account: job.account } : assignAccount(base, accounts);
        const next = at >= 0 ? entries.map((e, i) => (i === at ? withAccount : e)) : [...entries, withAccount];
        return { entries: next, result: undefined };
      });
      job.state = "done";
    } catch (err) {
      job.state = "failed";
      job.error = { message: (err as Error).message, hint: "other" };
    } finally {
      await window?.close().catch(() => undefined);
      this.reserved.delete(job.path);
      job.finishedAt = Date.now();
      for (const [id, j] of this.jobs) if (j.finishedAt && Date.now() - j.finishedAt > KEEP_FINISHED_MS) this.jobs.delete(id);
    }
  }

  private view(job: CloneJob): CloneJobView {
    const { abort: _a, finishedAt: _f, ...rest } = job;
    return { ...rest, ...(job.progress ? { progress: { ...job.progress } } : {}) };
  }

  /**
   * GitHub の SSH の host 鍵を置いた known_hosts（この Module のデータ置き場）。**GitHub が公開している値だけを信じる**——
   * 人の `~/.ssh/known_hosts` に初めての相手を覚えさせない（accept-new はやめた）。値は GitHub の文書
   * 「GitHub's SSH key fingerprints」と `GET https://api.github.com/meta` の `ssh_keys`（2026-10-02 に両方を突き合わせた。
   * 指紋 Ed25519 +DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU・ECDSA p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM・
   * RSA uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s）。GitHub が鍵を替えたら、ここを替える
   */
  private githubKnownHosts(): Promise<string> {
    return writeGithubKnownHosts(this.deps.dataDir, this.deps.endpoints);
  }

  status(id: string): CloneJobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error("この clone はもう覚えていません。一覧を読み直してください");
    return this.view(job);
  }

  cancel(id: string): CloneJobView {
    const job = this.jobs.get(id);
    if (!job) throw new Error("この clone はもう覚えていません");
    if (job.state === "running") job.abort.abort();
    return this.view(job);
  }

  // ── 新しいリポジトリ ─────────────────────────────────────────────────────

  /**
   * 新しいリポジトリを作ると何が起きるか。登録したアカウントの GitHub に同じ名前があれば、その login を言う
   * （作るのは止めない——GitHub に上げるのは公開のとき）。確かめられなかったら、そう言う
   */
  async inspectNew(input: { name: string; checkGithub?: boolean }, callId?: string): Promise<{
    home: string;
    folder: string;
    path: string;
    displayPath: string;
    folderInvalid?: boolean;
    state: TargetState;
    takenOnGithub?: string;
    githubCheckError?: string;
  }> {
    const folder = input.name.trim();
    const home = await repoHomeOf(this.deps.store, this.home);
    const path = join(home.path, folder);
    const base = { home: home.display, folder, path, displayPath: displayPath(path, this.home) };
    if (folder === "") return { ...base, state: { kind: "free" } };
    if (!isValidFolderName(folder)) return { ...base, folderInvalid: true, state: { kind: "free" } };
    const state = await inspectTarget(home.path, folder, await this.deps.store.entries(), this.reserved);
    if (state.kind !== "free") return { ...base, state };
    // GitHub に同じ名前があるかは、名前を決めたとき（入力の確定・作る直前）にだけ聞く——打つたびに全部のアカウントで
    // トークンを引いて GitHub を叩かない
    if (!input.checkGithub) return { ...base, state };
    const { accounts } = await this.deps.accounts.list();
    const problems: string[] = [];
    for (const a of accounts) {
      try {
        const token = await this.deps.accounts.tokenFor(a.login, callId);
        if (await this.deps.github.repoExists(token, a.login, folder)) return { ...base, state, takenOnGithub: a.login };
      } catch (err) {
        problems.push(`@${a.login}：${(err as Error).message}`);
      }
    }
    return { ...base, state, ...(problems.length ? { githubCheckError: problems.join("・") } : {}) };
  }

  /**
   * 置き場に空のリポジトリを作る（git init）。ブランチ名は**このマシンの git の設定（`init.defaultBranch`）に従い、
   * 無ければ main**——人が決めた名前を上書きしない。決めていなければ GitHub の既定に合わせる（公開のときに食い違わない）
   */
  async create(input: { name: string }): Promise<{ path: string; displayPath: string; name: string; branch: string }> {
    const folder = input.name.trim();
    if (!isValidFolderName(folder)) throw new Error("名前に使えるのは英数字と - _ . だけです");
    const home = await repoHomeOf(this.deps.store, this.home);
    const path = join(home.path, folder);
    const state = await inspectTarget(home.path, folder, await this.deps.store.entries(), this.reserved);
    if (state.kind !== "free") throw new Error(`${displayPath(path, this.home)} には、もう何かがあります（上書きしません）。${state.suggestion} ならあいています`);
    this.reserved.add(path);
    try {
      await mkdir(home.path, { recursive: true });
      const branch = (await configuredDefaultBranch(home.path)) ?? "main";
      await gitInit(path, branch);
      const facts = await readFolder(path);
      if (facts.kind !== "repo") throw new Error(`作ったフォルダが読めません（${facts.kind}）`);
      await this.deps.store.update((entries) => ({ entries: [...entries, newEntry(facts)], result: undefined }));
      return { path: facts.path, displayPath: displayPath(facts.path, this.home), name: folder, branch };
    } finally {
      this.reserved.delete(path);
    }
  }
}
