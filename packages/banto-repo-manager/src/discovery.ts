/**
 * リポジトリとワークツリーの一覧（ADR-0010 決定36b・task-0039）。
 *
 * **独自の台帳を作らない。** `ghq` の配置と `gwq list` から導出する（D3：導出できる値は
 * 保存しない）。Worker Pool が `SpawnLedger` を持つのとは対照的——あちらは「起こしたプロセス」
 * という導出できない事実が要るが、こちらは要らない。
 *
 * **未導入なら何も返さない**（決定36b）。`ghq` / `gwq` の導入を強制せず、静的な場所だけで動く。
 *
 * **導出の結果は短い間だけ手元に置く**（`RepoDiscovery`）。`gwq list` は1回 400ms 以上かかり、
 * `place.*` / `file.*` / `git.*` はどれも呼び出しのたびに場所を解決するので、GUIを1つ開くだけで
 * これが4回積み上がっていた（実測：ファイルの中身が出るまで1.4秒のうち1.35秒がこれ）。
 * 台帳ではない——**いつでも捨てられる写し**であり、次の3つで正しさを保つ：
 *   - 一定時間で裏から取り直す（返すのは手元の写し。待たせない）
 *   - ワークツリーを作った・消した直後は自分で捨てる（`invalidate`）
 *   - 探している場所が写しに無ければ、呼び手が取り直せる（`PlaceProvider.refresh`）
 *
 * D6: node:os / node:path のみ（外部コマンドは command.ts 経由）。
 * I2: コマンドがあるのに失敗したら例外。未導入（`notFound`）とは分ける。
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Place } from "@banto/core";
import { output, runCommand, type CommandRunner } from "./command.js";

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
 * ワークツリーが1つも無いときの `gwq` の返事かどうか。
 *
 * **`--json` を付けても JSON を返さない**——`No worktrees found in <置き場>` という人向けの
 * 1行を標準出力に出し、終了コードは 0 になる（gwq 実測 2026-08-05）。これを「解釈できない」
 * として扱うと、ワークツリーを1つも作っていない環境で**場所を引くたびに例外が上がる**
 * （実際、新しい環境で `place.list` のたびに提供元の失敗が記録されていた）。
 *
 * **0件は正常なので0件として返す。** それ以外の非JSONは、下の I2 のとおり例外のままにする
 * ——文言が変わればここが外れて例外に戻る。**黙って消えるより、うるさい方に倒す。**
 */
function looksLikeNoWorktrees(text: string): boolean {
  return /^no worktrees?\b/i.test(text);
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
  if (looksLikeNoWorktrees(trimmed)) return []; // 0件（JSON では返ってこない）

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

// ── 導出の写し ──────────────────────────────────────────────────────────────

/**
 * これを過ぎたら、次に聞かれたときに裏で取り直す。
 *
 * リポジトリやワークツリーが増減するのは PO か番頭が明示的に何かしたときで、
 * 秒単位で勝手に変わるものではない。**待たせないことを優先し**、変化には
 * `invalidate` と `refresh` で追いつく。
 */
const REVALIDATE_AFTER_MS = 10_000;

/** 導出した一覧の手元の写し。 */
export interface RepoDiscovery {
  /** `ghq` が知っているリポジトリ。 */
  repositories(): Promise<Place[]>;
  /** `gwq` が知っているワークツリー。 */
  worktrees(): Promise<WorktreePlace[]>;
  /** 次に聞かれたら取り直す（ワークツリーを作った・消した直後に呼ぶ）。 */
  invalidate(): void;
}

/** 1種類の導出を「待たせずに、古くなったら取り直す」形で包む。 */
function memo<T>(derive: () => Promise<T>, label: string): { get(): Promise<T>; clear(): void } {
  let value: T | undefined;
  let at = 0;
  let inFlight: Promise<T> | undefined;

  // 同時に何本来ても導出は1回。GUI は place.list と file.list をほぼ同時に投げる
  const run = (): Promise<T> => {
    inFlight ??= derive().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async get(): Promise<T> {
      if (value === undefined) {
        // 初回は待つ。失敗は呼び手へそのまま伝える（I2：空を返して「無い」と偽らない）
        value = await run();
        at = Date.now();
        return value;
      }
      if (Date.now() - at > REVALIDATE_AFTER_MS) {
        // 古くなっていたら裏で取り直す。**返すのは手元の写し**——待たせない
        at = Date.now();
        void run().then(
          (fresh) => {
            value = fresh;
          },
          (err: unknown) => {
            // I2: 黙って古い写しを使い続けない。ただし直前まで動いていたものは捨てない
            //（捨てると、gwq が一時的に失敗しただけで場所が全部消える）
            console.error(`[banto] ${label} の取り直しに失敗しました: ${String(err)}`);
          }
        );
      }
      return value;
    },
    clear(): void {
      value = undefined;
      at = 0;
    },
  };
}

/** 実行口を1つ与えて、リポジトリ／ワークツリーの導出をまとめて包む。 */
export function createRepoDiscovery(run: CommandRunner): RepoDiscovery {
  const repositories = memo(() => listGhqRepositories(run), "リポジトリの一覧（ghq）");
  const worktrees = memo(() => listGwqWorktrees(run), "ワークツリーの一覧（gwq）");
  return {
    // 写しを配る。呼び手が並べ替えても互いに影響しないように
    repositories: async () => [...(await repositories.get())],
    worktrees: async () => [...(await worktrees.get())],
    invalidate(): void {
      repositories.clear();
      worktrees.clear();
    },
  };
}

/**
 * 実行口ごとの写し。
 *
 * **既定の実行口（本物の `ghq`/`gwq`）を使うときだけプロセス内で1つを共有する**——
 * 場所の提供元（`place.list`）と `repo.list` は同じものを見ているので、別々に導出する
 * 理由がない。テストが `run` を差し替えたときはその場限りの写しを作る：共有すると
 * テスト同士が互いの写しを見てしまう（偽の実行口の結果が別のテストに漏れる）。
 */
let sharedDiscovery: RepoDiscovery | undefined;

export function repoDiscoveryFor(run: CommandRunner): RepoDiscovery {
  if (run !== runCommand) return createRepoDiscovery(run);
  return (sharedDiscovery ??= createRepoDiscovery(run));
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
