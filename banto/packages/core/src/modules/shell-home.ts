// **Shell 専用のホーム**（決定・2026-09-23、ユーザー）。
//
// Shell のコマンドは閉じ込め（Landlock）の中で走り、人のホームは読めない。以前は
// host の `HOME` をそのまま継いでいたので、git は `~/.gitconfig` を、npm は `~/.npm` を
// 触ろうとして**致命的に落ちていた**（実測：Project の根がホームでない限り、ローカルの
// `git commit` すら通らなかった）。人のホームを見せるのは閉じ込めの意味を消す
// ——`~/.ssh`・`~/.config/gh`・banto 自身の合言葉が、外へ繋がるコマンドから読める。
//
// **Dev Containers と同じ形にする**（規則12）：
//   - Project ごとに**書けるホーム**を用意する（Shell の Module の置き場の中）
//   - 人が選んだ設定ファイルだけを**写す**（既定は git の設定）
//   - **資格情報は写さない**。git の `credential.*`（取り出し役）と、写していない
//     ファイルを指す `include` は外す——資格情報は Vault から渡す（`sshIdentity`・`envSecrets`）
//
// 写すのは host（閉じ込めの外）。Module は自分の置き場の中にある写しを見るだけ。

import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, sep } from "node:path";
import type { RuntimeConfigStore } from "../config/runtime.js";

/** 写すものの一覧の鍵（banto 全体の設定）。中身は人のホームからの相対パス。 */
export const SHELL_HOME_FILES_KEY = "shellHomeFiles";

/** 既定で写すもの（決定・2026-09-23、ユーザー）。git の名前・メール・無視の設定が引き継がれる。 */
export const DEFAULT_SHELL_HOME_FILES = [".gitconfig", ".config/git"];

/**
 * **写せないもの**。中身が資格情報そのもの（か、それを取り出す鍵）なので、人が選んでも
 * 断る——写すと、外へ繋がる AI のコマンドから読める。資格情報は Vault から渡す。
 */
const NEVER_COPY = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".claude",
  ".claude.json",
  ".config/gh",
  ".config/gcloud",
  ".config/banto",
  ".local/share/banto",
];

/** 写しの記録（次に写すとき、一覧から外れたものを消すため）。 */
const MANIFEST = ".banto-shell-home.json";

export interface ShellHomeSync {
  /** 写したもの（人のホームからの相対パス）。 */
  copied: string[];
  /** 一覧にあるが、人のホームに無かったもの。 */
  missing: string[];
  /** 写したあとで外した git の設定（資格情報の取り出し役・写していないファイルの include）。 */
  removedGitKeys: string[];
  /** 人のホームを指していたので、Shell のホームへ向け直した git の設定。 */
  rewrittenGitKeys: string[];
}

/** 一覧の1件が写してよい形か。**だめなら理由を返す。** */
export function shellHomeEntryProblem(entry: string): string | undefined {
  const rel = entry.trim().replace(/^~\//, "");
  if (rel === "" || rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === ".")) {
    return `ホームの中の相対パスで書いてください（例：.gitconfig、.config/git）: ${entry}`;
  }
  const hit = NEVER_COPY.find((deny) => rel === deny || rel.startsWith(`${deny}/`) || deny.startsWith(`${rel}/`));
  if (hit) return `${rel} は写せません（資格情報が入る場所 ${hit} を含む）——資格情報は Vault から渡します`;
  return undefined;
}

/** 写すものの一覧（書かれていなければ既定）。 */
export function shellHomeFiles(config: Pick<RuntimeConfigStore, "layerValue"> | undefined): string[] {
  const raw = config?.layerValue(SHELL_HOME_FILES_KEY) as unknown;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [...DEFAULT_SHELL_HOME_FILES];
}

/**
 * Shell のホームを整える。**一覧から外れたものは消し、一覧のものは写し直す**
 * （人のホームで変えた設定が、次に写したときに届く）。それ以外（キャッシュ等、
 * Shell の中で作られたもの）には触らない。
 */
export async function syncShellHome(
  shellHome: string,
  files: readonly string[],
  opts: { sourceHome?: string } = {},
): Promise<ShellHomeSync> {
  const source = opts.sourceHome ?? homedir();
  await mkdir(shellHome, { recursive: true, mode: 0o700 });
  const previous = await readManifest(shellHome);
  const wanted = files.map((f) => f.trim().replace(/^~\//, ""));
  for (const rel of previous) {
    if (!wanted.includes(rel)) await rm(inside(shellHome, rel), { recursive: true, force: true });
  }

  const copied: string[] = [];
  const missing: string[] = [];
  for (const rel of wanted) {
    const problem = shellHomeEntryProblem(rel);
    if (problem) throw new Error(problem);
    const from = join(source, rel);
    if (!(await exists(from))) {
      missing.push(rel);
      await rm(inside(shellHome, rel), { recursive: true, force: true });
      continue;
    }
    const to = inside(shellHome, rel);
    await rm(to, { recursive: true, force: true });
    await cp(from, to, { recursive: true, dereference: true, force: true });
    copied.push(rel);
  }
  await writeFile(join(shellHome, MANIFEST), JSON.stringify({ copied }));

  const removedGitKeys: string[] = [];
  const rewrittenGitKeys: string[] = [];
  for (const rel of [".gitconfig", ".config/git/config"]) {
    const file = join(shellHome, rel);
    if (!(await exists(file))) continue;
    const r = sanitizeGitConfig(file, source, shellHome);
    removedGitKeys.push(...r.removed);
    rewrittenGitKeys.push(...r.rewritten);
  }
  return { copied, missing, removedGitKeys, rewrittenGitKeys };
}

/**
 * git の設定の写しから、**資格情報の取り出し役と include を外し、人のホームを指す値を
 * Shell のホームへ向け直す**。書式は git 自身に読ませる（規則12——INI もどきを自分で解かない）。
 *
 * - `credential.*`：取り出し役（`gh auth git-credential` 等）は、閉じ込めの中では
 *   トークンの置き場を読めずに失敗する。資格情報は Vault から渡す
 * - `include.*`・`includeIf.*`：写していないファイルを指す——閉じ込めの中で読めず、
 *   git が致命的に落ちる
 * - 値が人のホームの絶対パス（`core.excludesFile=/home/…/x` 等）：同じく読めずに落ちる
 */
function sanitizeGitConfig(file: string, sourceHome: string, shellHome: string): { removed: string[]; rewritten: string[] } {
  const git = (args: string[]) => spawnSync("git", ["config", "--file", file, ...args], { encoding: "utf8" });
  const listed = git(["--list", "-z"]);
  if (listed.error) {
    // git が無ければ、git の設定も使われない——黙って落ちるのではなく、そう残す
    throw new Error(`git の設定を整えられませんでした（git を起動できません: ${listed.error.message}）`);
  }
  const removed: string[] = [];
  const rewritten: string[] = [];
  const entries = listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const nl = e.indexOf("\n");
      return nl === -1 ? { key: e, value: "" } : { key: e.slice(0, nl), value: e.slice(nl + 1) };
    });
  for (const key of new Set(entries.map((e) => e.key))) {
    if (/^(credential\.|include\.|includeif\.)/i.test(key)) {
      git(["--unset-all", key]);
      removed.push(key);
    }
  }
  const prefix = sourceHome.endsWith(sep) ? sourceHome : `${sourceHome}${sep}`;
  for (const { key, value } of entries) {
    if (removed.includes(key) || !value.startsWith(prefix)) continue;
    const next = join(shellHome, value.slice(prefix.length));
    git(["--replace-all", key, next, `^${escapeRegex(value)}$`]);
    rewritten.push(key);
  }
  return { removed, rewritten };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Shell のホームの中を指すパス。**外へ出る相対パスは作らない**。 */
function inside(shellHome: string, rel: string): string {
  const full = normalize(join(shellHome, rel));
  if (!full.startsWith(shellHome + sep)) throw new Error(`Shell のホームの外を指しています: ${rel}`);
  return full;
}

async function readManifest(shellHome: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(shellHome, MANIFEST), "utf8")) as { copied?: unknown };
    return Array.isArray(parsed.copied) ? parsed.copied.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
