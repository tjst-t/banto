/**
 * Factory の依存を、**MCP のツール呼び出しとして**満たす（要件 C13・決定17）。
 *
 * ここまで Factory は `RepoCore` や `ProcessEnvironmentCore` を**直接握っていた**。
 * 役割（capability）の機構は決定16 で作ったのに、**本物の利用者がいなかった**
 * ——「実装は差し替えられる」は試験の中でしか成り立っていなかった。ここがその穴を塞ぐ。
 *
 * ## 口を跨いでも、型は落ちない
 *
 * 最初の版はここで文字列を解いていた（`yes` / `no` の判定、`JSON.parse`）。
 * **それは MCP の使い方が誤っていた**——`outputSchema` と `structuredContent` が
 * 仕様にあり、SDK 1.30.0 が対応している。しかも**型は宣言ではなく強制**で、
 * 合わないものを返すと `Output validation error` で断られる（実測 2026-08-21）。
 *
 * だからこのファイルに解析は無い。**「代償として文字列を解く」は、払う必要の
 * 無い代償だった**（規則1：確かめる前に決めない、を破ったところ）。
 */

import type { ToolCaller } from '@banto/module-kit';

import type { EnvironmentPort, Implementer, RepoPort } from './ports.js';

/**
 * 役割 `repo`（決定17）。**worktree の持ち主は Repo**（決定5）で、
 * Factory はここを通してしか git に触れない。
 */
export function repoPortOver(caller: ToolCaller): RepoPort {
  const str = async (tool: string, args: Record<string, unknown>, key: string): Promise<string> =>
    String((await caller.callStructured(tool, args))[key]);
  const bool = async (tool: string, args: Record<string, unknown>, key: string): Promise<boolean> =>
    (await caller.callStructured(tool, args))[key] === true;

  return {
    addWorktree: (branch, relative) => str('add_worktree', { branch, path: relative }, 'path'),
    hasWorktree: (relative) => bool('has_worktree', { path: relative }, 'exists'),
    removeWorktree: (relative) => caller.call('remove_worktree', { path: relative }),
    headOf: (ref) => str('head_of', { ref }, 'commit'),
    isAhead: (branch, base) =>
      bool('is_ahead', { branch, ...(base ? { base } : {}) }, 'ahead'),
    // **取り込み済みかは `is_ahead` と測ったことから導く**（engine の注記）。
    // ここに `is_merged` を置くと、空のブランチで自明に真になる罠が戻ってくる。
    isMerged: async (branch, into) =>
      !(await bool('is_ahead', { branch, ...(into ? { base: into } : {}) }, 'ahead')),
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
    create: async (workdir) =>
      String((await caller.callStructured('create', { ...extra, workdir }))['handle']),
    status: async (handle) => {
      const status = (await caller.callStructured('status', { ...extra, handle }))['status'];
      // **契約は MCP 側で強制されている**が、ここでも確かめる——
      // 型が合っていても、値が2つのどちらでもない未来はありうる（規則2）。
      if (status !== 'ready' && status !== 'gone') {
        throw new Error(`status が ready でも gone でもない: ${JSON.stringify(status)}`);
      }
      return status;
    },
    exec: async (handle, command, args) => {
      const r = await caller.callStructured('exec', {
        ...extra,
        handle,
        command,
        args: [...args],
      });
      return {
        exitCode: Number(r['exitCode']),
        stdout: String(r['stdout'] ?? ''),
        stderr: String(r['stderr'] ?? ''),
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
      await caller.callStructured('work', {
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
