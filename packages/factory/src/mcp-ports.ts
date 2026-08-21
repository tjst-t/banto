/**
 * Factory の依存を、**MCP のツール呼び出しとして**満たす（要件 C13・決定17）。
 *
 * ここまで Factory は `RepoCore` や `ProcessEnvironmentCore` を**直接握っていた**。
 * 役割（capability）の機構は決定16 で作ったのに、**本物の利用者がいなかった**
 * ——「実装は差し替えられる」は試験の中でしか成り立っていなかった。ここがその穴を塞ぐ。
 *
 * ## 口を跨ぐ代償：文字列を解くことになる
 *
 * MCP のツールが返すのはテキストである。**その解析を1箇所に閉じ込める**のが
 * このファイルの役目で、engine には1文字も漏らさない。
 *
 * **知らない値を勝手に寄せない**（規則2）。`yes` でも `no` でもない返事は、
 * 「たぶん no」ではなく**失敗**である——寄せた瞬間に、壊れているのに動いて見える。
 */

import type { ToolCaller } from '@banto/module-kit';

import type { EnvironmentPort, Implementer, RepoPort } from './ports.js';

/** `yes` / `no` だけを受ける。それ以外は**寄せずに投げる。** */
function yesNo(where: string, printed: string): boolean {
  const value = printed.trim();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  throw new Error(`${where} が yes でも no でもない: ${JSON.stringify(value)}`);
}

/**
 * 役割 `repo`（決定17）。**worktree の持ち主は Repo**（決定5）で、
 * Factory はここを通してしか git に触れない。
 */
export function repoPortOver(caller: ToolCaller): RepoPort {
  return {
    addWorktree: (branch, relative) => caller.call('add_worktree', { branch, path: relative }),
    hasWorktree: async (relative) =>
      yesNo('has_worktree', await caller.call('has_worktree', { path: relative })),
    removeWorktree: (relative) => caller.call('remove_worktree', { path: relative }),
    headOf: async (ref) => (await caller.call('head_of', { ref })).trim(),
    isAhead: async (branch, base) =>
      yesNo('is_ahead', await caller.call('is_ahead', { branch, ...(base ? { base } : {}) })),
    // **取り込み済みかは `is_ahead` と測ったことから導く**（engine の注記）。
    // ここに `is_merged` を置くと、空のブランチで自明に真になる罠が戻ってくる。
    isMerged: async (branch, into) =>
      !yesNo('is_ahead', await caller.call('is_ahead', { branch, ...(into ? { base: into } : {}) })),
    merge: (branch, into) => caller.call('merge', { branch, ...(into ? { into } : {}) }),
    rebaseOnto: (relative, onto) =>
      caller.call('rebase_onto', { path: relative, ...(onto ? { onto } : {}) }),
  };
}

/** 役割 `environment`（決定16）。**実装は設定の割り当てで差し替わる。** */
export function environmentPortOver(
  caller: ToolCaller,
  /** `env-script` は `repo` を要る。実装ごとの追加引数はここで埋める。 */
  extra: Record<string, unknown> = {},
): EnvironmentPort {
  return {
    create: async (workdir) => (await caller.call('create', { ...extra, workdir })).trim(),
    status: async (handle) => {
      const printed = (await caller.call('status', { ...extra, handle })).trim();
      if (printed !== 'ready' && printed !== 'gone') {
        throw new Error(`status が ready でも gone でもない: ${JSON.stringify(printed)}`);
      }
      return printed;
    },
    exec: async (handle, command, args) => {
      const printed = await caller.call('exec', { ...extra, handle, command, args: [...args] });
      let parsed: unknown;
      try {
        parsed = JSON.parse(printed);
      } catch {
        // 握りつぶさない。**解けなかったことを、解けた顔で返さない。**
        throw new Error(`exec の返事が JSON でない: ${printed.slice(0, 200)}`);
      }
      const r = parsed as { exitCode?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof r.exitCode !== 'number') {
        throw new Error(`exec の返事に exitCode が無い: ${printed.slice(0, 200)}`);
      }
      return {
        exitCode: r.exitCode,
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
      };
    },
    destroy: (handle) => caller.call('destroy', { ...extra, handle }),
  };
}

/**
 * 役割 `worker`（決定17）。前の実装の「職人」にあたる。
 *
 * **「やった」という自己申告を engine に渡さない。** ここは呼ぶだけで、
 * 仕事が済んだかを判定するのは engine（`isAhead` という現物の観測）。
 */
export function workerImplementerOver(
  caller: ToolCaller,
  absoluteWorkdir: (workdir: string) => string,
): Implementer {
  return {
    implement: async (plan) => {
      await caller.call('work', {
        threadId: plan.threadId,
        // **同じ Run の仕事は同じ id になる。** 呼び手が決めるので、
        // 再開して二度呼んでも別の仕事に見えない。
        queryId: `${plan.runId}:implement`,
        request: plan.request,
        cwd: absoluteWorkdir(plan.workdir),
      });
    },
  };
}
