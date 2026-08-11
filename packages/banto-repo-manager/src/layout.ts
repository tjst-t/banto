/**
 * リポジトリとワークツリーの**置き場の決め方**（PO裁定 2026-08-11）。
 *
 * もとは `ghq` と `gwq` に決めさせていた。やめた理由は1つ：**`gwq` はリモートが無いと
 * ワークツリーを作れない**——置き場を `git remote get-url origin` から組み立てるので、
 * まだ push していないリポジトリでは `failed to generate worktree path` で落ちる。
 * 実際にひらがなの task-0001 / task-0002 がここで止まり、Kobo は1本も回せなかった。
 *
 * **並びは今までのものをそのまま引き継ぐ**（`ghq`/`gwq` で作った手元の資産を捨てない）：
 *
 * ```
 *   <リポジトリの根>/<host>/<owner>/<repo>              例: ~/ghq/github.com/tjst-t/banto
 *   <ワークツリーの根>/<host>/<owner>/<repo>/<ブランチ>   例: ~/worktrees/github.com/tjst-t/banto/task-task-0090
 * ```
 *
 * 違うのは**何から導くか**だけ。リモートではなく「リポジトリが根のどこに在るか」から
 * 導く——だからリモートの無いリポジトリでも、置き場は一意に決まる。
 *
 * D3: 台帳を持たない。並びとファイルシステムから導出する。
 * D6: node:fs / node:os / node:path のみ。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** リポジトリの根（既定）。`ghq` が使っていた場所と同じ——手元の資産をそのまま読む。 */
const DEFAULT_REPO_ROOT = path.join(os.homedir(), "ghq");

/** ワークツリーの根（既定）。`gwq` の `worktree.basedir` と同じ。 */
const DEFAULT_WORKTREE_BASE = path.join(os.homedir(), "worktrees");

/**
 * リポジトリを探しに行く深さ。`<host>/<owner>/<repo>` で 3 段。
 *
 * **無制限に潜らない。** 根の下にはリポジトリ本体（`node_modules` を含む）が並ぶので、
 * 深さを切らないと数万のディレクトリを舐める。`.git` を見つけた時点でその枝は止める。
 */
const MAX_DEPTH = 4;

/** 設定から根を読む。**複数指定できる**（`:` 区切り）。 */
export function repoRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["BANTO_REPO_ROOTS"]?.trim();
  const roots = raw
    ? raw.split(path.delimiter).map((r) => r.trim()).filter((r) => r.length > 0)
    : [DEFAULT_REPO_ROOT];
  return roots.map((r) => path.resolve(expandHome(r)));
}

/** ワークツリーの根。 */
export function worktreeBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["BANTO_WORKTREE_BASE"]?.trim();
  return path.resolve(expandHome(raw && raw.length > 0 ? raw : DEFAULT_WORKTREE_BASE));
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** 見つかったリポジトリ1つ。 */
export interface FoundRepository {
  /** 根からの相対パス（`github.com/tjst-t/banto`）。根の外なら絶対パス。 */
  id: string;
  /** 実体の場所。 */
  path: string;
}

/**
 * 根の下にあるリポジトリを列挙する。
 *
 * **`.git` が在るところがリポジトリ**（ディレクトリでもファイルでもよい——後者は
 * ワークツリーやサブモジュール）。見つけたらその下は見ない：リポジトリの中に
 * `node_modules/**\/.git` があっても別のリポジトリとして数えない。
 *
 * I2: 読めない根は黙って飛ばさずログに出す。根ごと消えていたら場所が全部消えるので、
 *     気づけないのが一番困る。
 */
export function listRepositories(
  roots: readonly string[] = repoRoots(),
  log: (message: string) => void = (m) => console.error(m)
): FoundRepository[] {
  const found: FoundRepository[] = [];
  for (const root of roots) {
    if (!existsDir(root)) continue; // 根がまだ無いのは異常ではない（何も clone していない）
    walk(root, root, 0, found, log);
  }
  // 並びを安定させる（呼び出し側が毎回同じ順で見られるように）
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function walk(
  root: string,
  dir: string,
  depth: number,
  out: FoundRepository[],
  log: (message: string) => void
): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    log(`[banto] リポジトリを探せませんでした（${dir}）: ${String(err)}`);
    return;
  }
  // ここ自体がリポジトリなら、それを1件として下は見ない
  if (entries.some((e) => e.name === ".git")) {
    if (dir !== root) out.push({ id: relativeId(dir, root), path: dir });
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    walk(root, path.join(dir, entry.name), depth + 1, out, log);
  }
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 根からの相対パスを id にする（区切りは常に `/`）。 */
function relativeId(absolute: string, root: string): string {
  const rel = path.relative(root, absolute);
  return rel.length > 0 ? rel.split(path.sep).join("/") : absolute;
}

/**
 * そのリポジトリの id（`github.com/tjst-t/banto`）。
 *
 * **根の下に在ることから導く。** どの根にも入っていないリポジトリ（試験用の一時ディレクトリ、
 * PO が手で置いたもの）は**ディレクトリ名**を id にする——絶対パスを id にすると、
 * ワークツリーの置き場が `~/worktrees/home/ubuntu/...` のように根から生えてしまう。
 */
export function repositoryId(repoPath: string, roots: readonly string[] = repoRoots()): string {
  const absolute = path.resolve(repoPath);
  for (const root of roots) {
    if (absolute === root || absolute.startsWith(root + path.sep)) {
      const rel = path.relative(root, absolute);
      if (rel.length > 0 && !rel.startsWith("..")) return rel.split(path.sep).join("/");
    }
  }
  return path.basename(absolute);
}

/**
 * ブランチ名をディレクトリ名にする。
 *
 * `/` を `-` に畳む（`task/task-0090` → `task-task-0090`）。**`gwq` と同じ形**なので、
 * 移行しても手元のワークツリーは同じ場所を指す。パスとして危ういもの（`..`・先頭の `.`）は
 * 落とす——ブランチ名は外から来る（タスク id を含む）ので、置き場の外へ出させない。
 */
export function branchDirName(branch: string): string {
  const flattened = branch.replace(/[/\\]+/gu, "-").replace(/\s+/gu, "-");
  const safe = flattened.replace(/[^\w.@+-]/gu, "-").replace(/^[.-]+/u, "");
  // I2: 空になるブランチ名は置き場を決められない。黙って既定名に落とさない
  if (safe.length === 0) throw new Error(`ブランチ名から置き場を決められません: "${branch}"`);
  return safe;
}

/**
 * そのリポジトリの、そのブランチのワークツリーの置き場。
 *
 * **リモートを見ない**のが要点（`gwq` との違い）。まだ push していないリポジトリでも
 * 決まるので、Kobo は remote の有無に関わらずタスクを回せる。
 */
export function worktreePathFor(options: {
  repoPath: string;
  branch: string;
  roots?: readonly string[];
  base?: string;
}): string {
  const roots = options.roots ?? repoRoots();
  const base = options.base ?? worktreeBase();
  return path.join(base, repositoryId(options.repoPath, roots), branchDirName(options.branch));
}

/**
 * clone / init でリポジトリを置く場所を、URL や `<owner>/<repo>` から決める。
 *
 * 受けるのは `ghq get` と同じ形：
 *   - `https://github.com/tjst-t/banto(.git)` / `git@github.com:tjst-t/banto.git`
 *   - `tjst-t/banto`（host は既定の `github.com`）
 *
 * I2: 解釈できないものは黙って適当な場所に置かない。理由を添えて投げる。
 */
export function repositoryPathFor(
  target: string,
  options: { root?: string; defaultHost?: string } = {}
): { path: string; id: string } {
  const root = options.root ?? repoRoots()[0]!;
  const host = options.defaultHost ?? "github.com";
  const trimmed = target.trim();
  if (trimmed.length === 0) throw new Error("空の指定からはリポジトリの置き場を決められません");

  const slug = parseTarget(trimmed, host);
  return { path: path.join(root, ...slug.split("/")), id: slug };
}

function parseTarget(target: string, defaultHost: string): string {
  // git@host:owner/repo(.git)
  const scp = /^[^@/]+@([^:]+):(.+)$/u.exec(target);
  if (scp) return normalizeSlug(`${scp[1]}/${scp[2]}`);
  // scheme://host/owner/repo(.git)
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch (err) {
      throw new Error(`リポジトリの指定を解釈できません（${target}）: ${String(err)}`);
    }
    return normalizeSlug(`${url.host}${url.pathname}`);
  }
  // owner/repo（host は既定）
  const segments = target.replace(/^\/+/u, "").split("/").filter((s) => s.length > 0);
  if (segments.length === 2) return normalizeSlug(`${defaultHost}/${segments.join("/")}`);
  if (segments.length >= 3) return normalizeSlug(segments.join("/"));
  throw new Error(
    `リポジトリの指定を解釈できません（${target}）。` +
      "URL か <owner>/<repo> の形で渡してください"
  );
}

function normalizeSlug(raw: string): string {
  const segments = raw
    .replace(/\.git$/u, "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments.length < 2) throw new Error(`リポジトリの指定を解釈できません（${raw}）`);
  return segments.join("/");
}
