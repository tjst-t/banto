/**
 * リポジトリとワークツリーの一覧（ADR-0010 決定36b・task-0039）。
 *
 * **独自の台帳を作らない。** `ghq` の配置と `gwq list` から毎回導出する（D3：導出できる値は
 * 保存しない）。Worker Pool が `SpawnLedger` を持つのとは対照的——あちらは「起こしたプロセス」
 * という導出できない事実が要るが、こちらは要らない。
 *
 * **未導入なら何も返さない**（決定36b）。`ghq` / `gwq` の導入を強制せず、静的な場所だけで動く。
 *
 * D6: node:os / node:path のみ（外部コマンドは command.ts 経由）。
 * I2: コマンドがあるのに失敗したら例外。未導入（`notFound`）とは分ける。
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Place } from "@banto/core";
import { output, type CommandRunner } from "./command.js";

/** ワークツリーとして見つかった場所（ブランチ名を添える）。 */
export interface WorktreePlace extends Place {
  /** そのワークツリーが指しているブランチ。 */
  branch: string;
}

/** `gwq list --json` が返す1件。使うのは path / branch / is_main だけ。 */
interface GwqEntry {
  path?: unknown;
  branch?: unknown;
  is_main?: unknown;
}

/**
 * `ghq` が知っているリポジトリを場所として返す。
 *
 * id は ghq のルートからの相対パス（`github.com/tjst-t/banto`）。**他のリポジトリが増えても
 * 変わらず、構造上必ず一意**——短い名前を付けると、同名リポジトリが1つ増えただけで
 * 過去の id の意味が変わる（番頭が覚えた id が別の場所を指しかねない）。
 */
export async function listGhqRepositories(run: CommandRunner): Promise<Place[]> {
  const rootsRaw = await output(run, "ghq", ["root", "--all"]);
  if (rootsRaw === undefined) return []; // 未導入
  const listRaw = await output(run, "ghq", ["list", "--full-path"]);
  if (listRaw === undefined) return [];

  const roots = lines(rootsRaw).map((r) => path.resolve(r));
  return lines(listRaw).map((full) => {
    const absolute = path.resolve(full);
    const id = relativeToAnyRoot(absolute, roots);
    return { id, label: shortLabel(id), path: absolute };
  });
}

/**
 * `gwq` が知っているワークツリーを場所として返す。
 *
 * `-g` を付けて**置き場のワークツリーだけ**を見る。付けないとリポジトリ本体（`is_main`）も
 * 混じり、`ghq` が返すものと同じ場所が二重に出る。
 */
export async function listGwqWorktrees(run: CommandRunner): Promise<WorktreePlace[]> {
  const raw = await output(run, "gwq", ["list", "-g", "--json"]);
  if (raw === undefined) return []; // 未導入
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // I2: 形が変わったなら黙って空を返さない。気づけないまま場所が消えるのが一番困る
    throw new Error(`gwq list --json の出力を解釈できません: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) return [];

  const base = await worktreeBaseDir(run);
  const places: WorktreePlace[] = [];
  for (const entry of parsed as GwqEntry[]) {
    if (typeof entry?.path !== "string" || entry.path.length === 0) continue;
    // -g を付けても本体が混じる場合に備える（gwq の版で変わりうる。二重登録は避ける）
    if (entry.is_main === true) continue;
    const absolute = path.resolve(entry.path);
    const branch = typeof entry.branch === "string" ? entry.branch : "(detached)";
    const id = base ? relativeToAnyRoot(absolute, [base]) : absolute;
    places.push({ id, label: `${shortLabel(id)}（ワークツリー: ${branch}）`, path: absolute, branch });
  }
  return places;
}

/**
 * ワークツリーの置き場。`gwq` の設定をそのまま使う（自分で決めない）。
 *
 * 取れなければ `undefined`。その場合 id は絶対パスになる——読みにくいが、
 * **一意であることは保たれる**（推測で短くして取り違えるより良い）。
 */
export async function worktreeBaseDir(run: CommandRunner): Promise<string | undefined> {
  let raw: string | undefined;
  try {
    raw = await output(run, "gwq", ["config", "get", "worktree.basedir"]);
  } catch {
    // 設定が無いのは異常ではない。id が絶対パスになるだけで動く
    return undefined;
  }
  const value = raw?.trim();
  if (!value) return undefined;
  // gwq は表示上 `~` に畳む（ui.tilde_home）。そのままではパスとして使えない
  return path.resolve(value.startsWith("~") ? path.join(os.homedir(), value.slice(1)) : value);
}

// ── 小道具 ──────────────────────────────────────────────────────────────────

function lines(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** どれかのルート配下ならそこからの相対パス。どれにも入っていなければ絶対パスのまま。 */
function relativeToAnyRoot(absolute: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (absolute === root || absolute.startsWith(root + path.sep)) {
      const rel = path.relative(root, absolute);
      if (rel.length > 0) return rel.split(path.sep).join("/");
    }
  }
  return absolute;
}

/** 表示用の短い名前。ホスト名の段は落とす（`github.com/tjst-t/banto` → `tjst-t/banto`）。 */
function shortLabel(id: string): string {
  const segments = id.split("/");
  return segments.length >= 3 ? segments.slice(1).join("/") : id;
}
