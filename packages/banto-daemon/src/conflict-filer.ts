/**
 * ConflictFiler: generates conflict-resolution task definition files on rebase failure.
 *
 * ## Design
 *
 * When a merge-queue rebase fails (conflict), the daemon calls `fileConflictTask()` to:
 *   1. Scan work/tasks/ for the highest existing task-NNNN number to assign the next ID (D6: fs stdlib).
 *   2. Write a new task definition markdown file with:
 *      - kind: conflict (spec-schemas §1: "解消タスク")
 *      - status: queued (watcher ingests it via the normal path, D4)
 *      - refs[0] = origin task ID (discovered-from convention, spec-schemas §1)
 *      - scope.paths = conflicted file paths (from git status post-rebase-abort)
 *      - body: both branches' provenance and conflict situation (D8: resolution session must
 *        be able to judge standalone)
 *
 * ## Idempotency guard (D3)
 *
 * A conflict task is only filed ONCE per (originTaskId, projectTag) conflict occurrence.
 * The guard is derived from the event log and task store state — not a separate file.
 * Caller checks before calling: if origin task is already paused, skip filing.
 *
 * ## No daemon internals bypass (D4)
 *
 * The file goes through the REAL watcher path (work/tasks/ → watcher → task_created +
 * draft→queued). No direct daemon.createTask() call here (that would bypass the
 * watcher route that is the spec-sanctioned communication route).
 *
 * D3: no mapping file persisted — origin↔resolution correspondence is derived from
 *     refs[0] in the conflict task's event log entries (discovered-from convention).
 * D6: fs stdlib only; no new npm dependencies.
 * I2: throws clearly if the tasks directory does not exist (caller handles).
 * P1: only reads/writes work/tasks/ within the registered project repoPath.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { loadProjectConfig } from "./review-policy.js";

// ── Task number assignment ────────────────────────────────────────────────────

/**
 * Return the next task-NNNN number by scanning work/tasks/ for the highest existing one.
 *
 * Scans all *.md filenames in the directory, extracts the NNNN portion from
 * "task-NNNN-<slug>.md" or "task-NNNN.md", and returns max+1 (zero-padded to 4 digits).
 * Falls back to "0004" if no tasks exist (0001..0003 reserved for known tasks).
 *
 * I2: if tasksDir does not exist, throws (caller should pre-check).
 * D6: fs stdlib only.
 */
export function nextTaskNumber(tasksDir: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch (err) {
    throw new Error(`nextTaskNumber: cannot read tasks dir ${tasksDir}: ${String(err)}`);
  }

  let maxNum = 0;
  const pattern = /^task-(\d{4,})/;
  for (const name of entries) {
    const m = pattern.exec(name);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }

  // Next number, zero-padded to at least 4 digits
  const next = maxNum + 1;
  return String(next).padStart(4, "0");
}

// ── Conflict task file generation ─────────────────────────────────────────────

export interface ConflictTaskSpec {
  /** The project tag (for context in the body). */
  projectTag: string;
  /** The origin task ID that had the rebase conflict (e.g. "task-A"). */
  originTaskId: string;
  /** Title of the origin task (for body context). */
  originTaskTitle: string;
  /** Task branch of the origin task (e.g. "task/task-A"). */
  originTaskBranch: string;
  /** Mainline branch name (e.g. "main"). */
  mainline: string;
  /** Files that had rebase conflicts (from git status after rebase abort). */
  conflictedFiles: string[];
  /**
   * Raw error message from the rebase failure (for body context).
   * Contains the git rebase output or at least the error summary.
   */
  rebaseErrorMessage: string;
  /**
   * Absolute path to the project's repo (to write work/tasks/ into).
   */
  repoPath: string;
}

export interface FiledConflictTask {
  /** The newly-assigned conflict task ID (e.g. "task-0004"). */
  taskId: string;
  /** The absolute path to the written task definition file. */
  filePath: string;
}

/**
 * Generate and write a conflict-resolution task definition file to work/tasks/.
 *
 * The file is written with `status: queued` so the watcher picks it up immediately
 * via the normal ingestion path (D4).
 *
 * Returns { taskId, filePath } of the newly written file.
 *
 * I2: throws on write failure.
 * D3: does not write any mapping or state file — only the task definition.
 * D4: goes through work/tasks/ so the watcher (not daemon internals) ingests it.
 */
export function fileConflictTask(spec: ConflictTaskSpec): FiledConflictTask {
  const {
    projectTag,
    originTaskId,
    originTaskTitle,
    originTaskBranch,
    mainline,
    conflictedFiles,
    rebaseErrorMessage,
    repoPath,
  } = spec;

  const tasksDir = path.join(repoPath, "work", "tasks");

  // Ensure the directory exists (projects must have work/tasks/ per spec-document-system)
  if (!fs.existsSync(tasksDir)) {
    fs.mkdirSync(tasksDir, { recursive: true });
  }

  const num = nextTaskNumber(tasksDir);
  const taskId = `task-${num}`;
  const slug = `conflict-resolution-for-${originTaskId}`;
  const fileName = `${taskId}-${slug}.md`;
  const filePath = path.join(tasksDir, fileName);

  // scope.paths: the conflicted files (or a catch-all if none detected)
  const scopePaths =
    conflictedFiles.length > 0
      ? conflictedFiles
      : ["**"]; // fallback when git status could not determine specific files

  // Format scope.paths as YAML inline array
  const scopePathsYaml = `[${scopePaths.map((p) => `"${p}"`).join(", ")}]`;

  // Title
  const title = `コンフリクト解消: ${originTaskId} vs ${mainline}`;

  // Refs: discovered-from convention — originTaskId is refs[0] (spec-schemas §1).
  // Quoted defensively: task IDs may start with digits or contain special chars
  // that YAML would misparse without quotes (e.g. "0004" as integer, "a:b" as map).
  const refsYaml = `["${originTaskId}"]`;

  /**
   * **解消タスクに持たせる検査**（realign 第3便・段3）。
   *
   * 層Bから取る（`verify.conflict_command`）。コードに直書きしないのは、プロジェクト
   * ごとにテストの打ち方が違うから——banto の `npm test` を埋め込むと他のプロジェクトで
   * 破綻する。書かれていなければ**持たせない**（今までどおり）。
   */
  const conflictVerify = loadProjectConfig(repoPath).verify.conflictCommand;

  /**
   * **名乗りと実態をずらさない**（realign 第3便・段3）。
   *
   * 既定の反転（→ `spec-daemon-core` §2.5）以降、`auto` を名乗っても**検査が1本も
   * 無い契約は必ず人の承認を通る**。検査を持たせられないときに `auto` と書くと、
   * 帳簿には「auto」と残るのに一度も自動着地しない——読む側が判断できない嘘になる。
   *
   * だから名乗りは検査の有無に従わせる。`kind: conflict` を判定の例外にはしない
   * （番頭裁定 2026-08-14：例外を作ると「証拠のあるものだけ機械に通す」に穴が開く）。
   */
  const reviewPolicy = conflictVerify ? "auto" : "banto";

  /**
   * 受け入れ条件の inline map に書ける形へ包む。
   *
   * 層Bの YAML パーサはエスケープを扱わないので、**含まれていない方の引用符で囲む**。
   * 両方含むものは `loadProjectConfig` が既に断っている（ここへは来ない）。
   */
  const verifyField = conflictVerify
    ? `, verify: ${conflictVerify.includes('"') ? `'${conflictVerify}'` : `"${conflictVerify}"`}`
    : "";

  // Build the task body (D8: resolution session must be able to judge standalone)
  const conflictedFilesSection =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f) => `- \`${f}\``).join("\n")
      : "- (詳細は git status を参照)";

  const body = [
    `## 背景`,
    ``,
    `プロジェクト \`${projectTag}\` でタスク \`${originTaskId}\`（${originTaskTitle}）を`,
    `メインライン \`${mainline}\` へ rebase しようとしたところ、コンフリクトが発生しました。`,
    ``,
    `元タスクはコンフリクト解消まで一時停止（paused）されます。`,
    `このタスク（${taskId}）が merged になると、元タスクが再開されます。`,
    `このタスクが failed になると、元タスクも failed になります（I2: 連鎖失敗）。`,
    ``,
    `## コンフリクト情報`,
    ``,
    `**元タスク**: \`${originTaskId}\` — ${originTaskTitle}`,
    `**ブランチ**: \`${originTaskBranch}\`（元タスク）vs \`${mainline}\`（メインライン）`,
    ``,
    `**コンフリクトしたファイル**:`,
    ``,
    conflictedFilesSection,
    ``,
    `**rebase エラー（抜粋）**:`,
    ``,
    "```",
    rebaseErrorMessage.slice(0, 2000), // truncate to keep the file reasonable
    "```",
    ``,
    `## 解消方針`,
    ``,
    `1. \`${mainline}\` の最新コミットを確認し、変更意図を把握してください`,
    `2. \`${originTaskBranch}\` の変更意図を確認してください`,
    `3. 両ブランチの変更を統合したコンフリクト解消コミットを \`${originTaskBranch}\` に作成してください`,
    `4. \`acceptance\` を確認し、解消後に全ての受け入れ基準が成立することを確認してください`,
    ``,
    `## スコープ外`,
    ``,
    `- 元タスク（\`${originTaskId}\`）の機能追加や変更 — コンフリクト箇所の統合のみ`,
    `- \`${mainline}\` への直接 push — このタスク完了後にマージキューが処理します`,
  ].join("\n");

  // Build the acceptance criteria: one entry per conflicted file (or a generic one)
  const acceptanceItems =
    conflictedFiles.length > 0
      ? conflictedFiles.map((f, i) => {
          const id = `a${i + 1}`;
          const text = `\`${f}\` のコンフリクトが解消されており、両ブランチの意図が統合されている`;
          return `  - { id: ${id}, text: "${text}"${verifyField} }`;
        })
      : [
          `  - { id: a1, text: "コンフリクトが解消されており、${originTaskId} の意図が mainline と統合されている"${verifyField} }`,
        ];

  const frontmatter = [
    `---`,
    `id: ${taskId}`,
    `type: task`,
    `kind: conflict`,
    `title: "${title}"`,
    `status: queued`,
    `refs: ${refsYaml}`,
    `scope:`,
    `  paths: ${scopePathsYaml}`,
    `acceptance:`,
    ...acceptanceItems,
    `review:`,
    `  policy: ${reviewPolicy}`,
    `---`,
    ``,
  ].join("\n");

  const content = frontmatter + body + "\n";

  fs.writeFileSync(filePath, content, "utf-8");

  return { taskId, filePath };
}

// ── Derive origin↔resolution correspondences from event log ──────────────────

/**
 * Derive active (paused-origin → resolution-task) pairs from the current task set.
 *
 * D3: no mapping file. Correspondence is derived from:
 *   - The resolution task has kind="conflict" and refs[0] = originTaskId
 *   - The origin task is in status "paused" with suspendedFrom="merging"
 *   - The resolution task has NOT yet reached a terminal state (merged/closed/failed)
 *
 * Returns an array of { originTaskId, originProjectTag, resolutionTaskId } pairs.
 * Called by the daemon on each tick to check for resolution tasks that just changed state.
 */
export interface OriginResolutionPair {
  /** The paused origin task ID */
  originTaskId: string;
  /** The origin task's project tag */
  originProjectTag: string;
  /** The conflict-resolution task ID */
  resolutionTaskId: string;
  /** The resolution task's project tag (same as origin's in single-project setup) */
  resolutionProjectTag: string;
}

/**
 * 解消タスクが「役目を終えた」状態（もうこれ以上動かない）。
 *
 * inc-0063: ここに居る解消タスクを「未解決の一本」と数えてしまうと、
 * 同じ origin に二本目・三本目を積み続ける。数える側は必ずこれで除く。
 */
const TERMINAL_RESOLUTION_STATUSES: ReadonlySet<string> = new Set([
  "merged",
  "closed",
  "failed",
  "superseded",
]);

/**
 * その origin に**まだ決着していない**解消タスクがあるか。
 *
 * inc-0063 の3: `handleRebaseConflict` は同じ origin に対して何度でも起票できてしまい、
 * 1 分ごとに 1 本ずつゴミタスクが積まれた。起票の前にここで数える。
 *
 * D3: 台帳（＝イベントログから再生したタスク集合）から導出する。印のファイルは持たない。
 */
export function hasOpenResolutionTask(
  tasks: Array<{ id: string; status: string; projectTag: string; [key: string]: unknown }>,
  originTaskId: string,
  projectTag: string
): boolean {
  return tasks.some((t) => {
    if (t.projectTag !== projectTag) return false;
    if ((t["kind"] as string | undefined) !== "conflict") return false;
    const refs = t["refs"] as string[] | undefined;
    if (!refs || refs[0] !== originTaskId) return false;
    return !TERMINAL_RESOLUTION_STATUSES.has(t.status);
  });
}

/** `deriveOriginResolutionPairs` の追加条件。 */
export interface DeriveOriginResolutionOptions {
  /**
   * そのペアの後始末（origin の再開）を**もう打ったか**。true を返したペアは返さない。
   *
   * inc-0063 の1・2: closed のまま台帳に残る解消タスクが恒久的にペアの片割れになり、
   * 「解消できた → origin を merging へ戻す」が 1 分ごとに再発した。判定はイベントログから
   * 導出する（D3: 消費済みフラグのファイルを作らない）——呼び手が帳簿を引いて渡す。
   */
  isConsumed?: (pair: OriginResolutionPair) => boolean;
}

/**
 * Find all (paused-origin, conflict-resolution) pairs from the current task records.
 *
 * A valid pair is:
 *   - resolution task: kind=conflict, refs[0] = some task ID, and the pair has **not**
 *     already been consumed (= the resume it implies was already performed once;
 *     these are exactly "the terminal states we already handled")
 *   - origin task: status="paused", suspendedFrom="merging", id == resolution.refs[0]
 *
 * This is the canonical derivation function (D3). Called from the merge-result tick
 * to decide whether to resume or fail origin tasks.
 */
export function deriveOriginResolutionPairs(
  tasks: Array<{ id: string; status: string; projectTag: string; [key: string]: unknown }>,
  options: DeriveOriginResolutionOptions = {}
): OriginResolutionPair[] {
  const pairs: OriginResolutionPair[] = [];

  for (const task of tasks) {
    const kind = task["kind"] as string | undefined;
    if (kind !== "conflict") continue;

    // refs[0] is the origin task ID (discovered-from convention)
    const refs = task["refs"] as string[] | undefined;
    if (!refs || refs.length === 0) continue;
    const originTaskId = refs[0]!;

    // Find the origin task (same project)
    const originTask = tasks.find(
      (t) => t.id === originTaskId && t.projectTag === task.projectTag
    );
    if (!originTask) continue;

    // Origin must be paused with suspendedFrom=merging
    if (originTask.status !== "paused") continue;
    const suspendedFrom = originTask["suspendedFrom"] as string | undefined;
    if (suspendedFrom !== "merging") continue;

    const pair: OriginResolutionPair = {
      originTaskId,
      originProjectTag: originTask.projectTag,
      resolutionTaskId: task.id,
      resolutionProjectTag: task.projectTag,
    };

    // 消費済み（この解消タスクによる再開は打ち終わっている）なら返さない。
    // **ここが inc-0063 の周回を止める1行**——docstring にだけ書かれていて実装に無かった条件。
    if (options.isConsumed?.(pair)) continue;

    pairs.push(pair);
  }

  return pairs;
}
