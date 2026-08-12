/**
 * リポジトリとワークツリーの一覧（ADR-0010 決定36b・task-0039）。
 *
 * **独自の台帳を作らない。** 手元の並び（`layout.ts`）と `git worktree list` から導出する
 * （D3：導出できる値は保存しない）。Worker Pool が `SpawnLedger` を持つのとは対照的——
 * あちらは「起こしたプロセス」という導出できない事実が要るが、こちらは要らない。
 *
 * **`ghq` / `gwq` は使わない**（PO裁定 2026-08-11）。`gwq` はリモートが無いとワークツリーの
 * 置き場を決められず、実際に Kobo が1本も回せなくなった。並びは引き継いだので、
 * それらで作った手元の資産はそのまま読める。
 *
 * **導出の結果は短い間だけ手元に置く**（`RepoDiscovery`）。一覧は1回 400ms 以上かかり、
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

import * as path from "node:path";
import type { Place } from "@banto/core";
import { runCommand, type CommandRunner } from "./command.js";
import { listRepositories, repoRoots, worktreeBase } from "./layout.js";
import { listWorktrees } from "./git-worktrees.js";

/** ワークツリーとして見つかった場所（ブランチ名を添える）。 */
export interface WorktreePlace extends Place {
  /** そのワークツリーが指しているブランチ。 */
  branch: string;
}

/**
 * 手元のリポジトリを場所として返す（PO裁定 2026-08-11 で `ghq list` から自前に）。
 *
 * id は根からの相対パス（`github.com/tjst-t/banto`）。**他のリポジトリが増えても
 * 変わらず、構造上必ず一意**——短い名前を付けると、同名リポジトリが1つ増えただけで
 * 過去の id の意味が変わる（番頭が覚えた id が別の場所を指しかねない）。
 */
export function listLocalRepositories(roots: readonly string[] = repoRoots()): Place[] {
  return listRepositories(roots).map(({ id, path: full }) => ({
    id,
    label: shortLabel(id),
    path: full,
  }));
}

/**
 * ワークツリーを場所として返す（`gwq list` の置き換え）。
 *
 * **git に聞く。** リポジトリ1つずつ `git worktree list` を読み、本体は落とす
 * ——本体は上のリポジトリ一覧と同じ場所なので、混ぜると二重に出る。
 *
 * id は**置き場の根からの相対パス**（`github.com/tjst-t/banto/task-task-0090`）。
 * 根の外に作られたワークツリー（人が手で作ったもの）は絶対パスのまま出す
 * ——読みにくいが、一意であることは保たれる。
 */
export async function listGitWorktrees(
  run: CommandRunner,
  repositories: readonly Place[],
  base: string = worktreeBase()
): Promise<WorktreePlace[]> {
  const places: WorktreePlace[] = [];
  for (const repo of repositories) {
    let found;
    try {
      found = await listWorktrees(run, repo.path);
    } catch (err) {
      // I2: 1つのリポジトリが読めなくても他は返す。ただし黙らせない
      console.error(`[banto] ${repo.id} のワークツリーを読めませんでした: ${String(err)}`);
      continue;
    }
    for (const worktree of found) {
      if (worktree.main) continue; // 本体はリポジトリとして既に出ている
      const id = relativeToAnyRoot(worktree.path, [base]);
      places.push({
        id,
        label: `${shortLabel(id)}（ワークツリー: ${worktree.branch}）`,
        path: worktree.path,
        branch: worktree.branch,
      });
    }
  }
  return places;
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
  /** 手元にあるリポジトリ。 */
  repositories(): Promise<Place[]>;
  /** その git ワークツリー。 */
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
            //（捨てると、git が一時的に失敗しただけで場所が全部消える）
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
  const repositories = memo(async () => listLocalRepositories(), "リポジトリの一覧");
  /**
   * ワークツリーは**リポジトリの一覧から導く**（1つずつ git に聞く）。
   * 写しを共有しているので、リポジトリを取り直したときは自然にこちらも新しくなる。
   */
  const worktrees = memo(
    async () => listGitWorktrees(run, await repositories.get()),
    "ワークツリーの一覧"
  );
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
 * **既定の実行口（本物の `git`）を使うときだけプロセス内で1つを共有する**——
 * 場所の提供元（`place.list`）と `repo.list` は同じものを見ているので、別々に導出する
 * 理由がない。テストが `run` を差し替えたときはその場限りの写しを作る：共有すると
 * テスト同士が互いの写しを見てしまう（偽の実行口の結果が別のテストに漏れる）。
 */
let sharedDiscovery: RepoDiscovery | undefined;

export function repoDiscoveryFor(run: CommandRunner): RepoDiscovery {
  if (run !== runCommand) return createRepoDiscovery(run);
  return (sharedDiscovery ??= createRepoDiscovery(run));
}

/**
 * 共有の写しを捨てる。
 *
 * **根が変わったとき用**——並びは環境変数（`BANTO_REPO_ROOTS` / `BANTO_WORKTREE_BASE`）で
 * 決まるので、走っている間にそこが変わると写しが別の場所を指したままになる。実運用では
 * 起動時に決まって動かないが、試験は1本ごとに一時ディレクトリへ差し替える。
 */
export function resetRepoDiscovery(): void {
  sharedDiscovery = undefined;
}

// ── 小道具 ──────────────────────────────────────────────────────────────────

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
