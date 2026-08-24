/**
 * Factory モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * これで Factory も他のモジュールと同じ口（MCP）に乗る（要件 C13）——
 * 以前は Factory と worker だけが素の TypeScript の口だった、という
 * 2026-08-21 に見つかった食い違いを、Factory 側から埋める。
 */

import { defineModule, ok, type BantoModule, type DefinedModule } from '@banto/module-kit';
import type { EventLog } from '@banto/core';
import type { FactoryPool } from '@banto/factory';
import { z } from 'zod';

import { FactoryCore, runUri, type RunView } from './core.js';

const RUN_VIEW_SCHEMA = z.object({
  runId: z.string(),
  threadId: z.string(),
  branch: z.string(),
  request: z.string(),
  failed: z.boolean(),
  testedCommits: z.array(z.object({ commit: z.string(), passed: z.boolean() })),
  stage: z.string(),
});

export const manifest: BantoModule = {
  id: 'factory',
  description: 'コードを書く・試す・取り込む一連の作業（Factory）を頼む・進める・見る',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  gui: {
    kind: 'in-page',
    // モジュール既定は一覧（PO指摘 2026-08-25：人が直接開ける入口が要る）。
    entry: 'factory/RunsView',
    views: [
      { uriPrefix: 'banto://factory/runs', title: 'Factory', slot: 'launcher' },
      // 個別のRunはAIのshowで指す想定（決定19）ので canvas のまま。
      // 一覧とは別の面を持つので、この面だけentryを上書きする（決定33）。
      { uriPrefix: 'banto://factory/run/', title: 'Factory の Run', entry: 'factory/RunView' },
    ],
  },
};

/**
 * Factory モジュールを1つ組み立てる。
 *
 * `pool` は呼び手（host）が組み立てて渡す——`--repo` を渡していない banto では
 * Factory 自体が無いので、このモジュールもそもそも配線されない
 * （`/api/runs` が 501 を返すのと同じ考え）。
 */
export function factoryModule(log: EventLog, pool: FactoryPool): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new FactoryCore(log, pool),
    tools: (tool) => [
      tool({
        name: 'request_run',
        description:
          'Ask Factory to implement something in a repository: write code, test it, and merge it ' +
          'if it passes (optionally after human review). This only starts the run — it does not ' +
          'block or make progress. Call advance_runs to move it forward, or show the returned uri ' +
          'to let the person watch. Repository is a good default; branch is chosen automatically.',
        input: {
          request: z.string().describe('What to implement, in plain language'),
          repo: z
            .string()
            .optional()
            .describe('Repository, relative to the configured Factory root. Omit for the default repo.'),
          branch: z.string().optional().describe('Branch name. Omit to let Factory choose one.'),
        },
        output: {
          runId: z.string(),
          branch: z.string(),
          uri: z.string().describe('banto:// uri for this run — pass to show so the person can watch'),
        },
        run: async (core, { request, repo, branch }) =>
          core.requestRun({
            request,
            ...(repo === undefined ? {} : { repo }),
            ...(branch === undefined ? {} : { branch }),
          }),
        summary: (v) => `Run ${v.runId} を投げた（branch: ${v.branch}）。進めるには advance_runs。`,
      }),
      tool({
        name: 'advance_runs',
        description:
          'Advance every pending Factory run. This may take a while and uses additional model usage — ' +
          'it runs a sub-agent to implement code, then tests and (if configured) merges it. Only call ' +
          'this when explicitly asked to make progress, not automatically after request_run. Call ' +
          'list_runs afterward to see what happened.',
        input: {},
        run: async (core) => {
          await core.advanceRuns();
          return ok('進めた。list_runs で結果を確認して。');
        },
      }),
      tool({
        name: 'list_runs',
        description: 'List every Factory run and its current stage.',
        input: {},
        output: { runs: z.array(RUN_VIEW_SCHEMA) },
        run: async (core) => ({ runs: await core.listRuns() }),
        summary: (v) =>
          v.runs.length === 0
            ? 'Run はまだ無い'
            : v.runs.map((r) => `${r.runId.slice(0, 8)}: ${r.stage}${r.failed ? '（failed）' : ''}`).join('\n'),
      }),
    ],
    resources: [
      {
        name: 'runs',
        description: 'Every Factory run and its current stage',
        uri: 'banto://factory/runs',
        mimeType: 'application/vnd.banto.factory-runs+json',
        read: async (core) => JSON.stringify(await core.listRuns()),
      },
      {
        name: 'run',
        description: 'One Factory run and its current stage',
        uri: 'banto://factory/run/{runId}',
        mimeType: 'application/vnd.banto.factory-run+json',
        read: async (core, _uri, params) => {
          const raw = params['runId'];
          const runId = Array.isArray(raw) ? raw[0] : raw;
          if (runId === undefined || runId === '') throw new Error('runId が無い');
          const run = await core.describeRun(decodeURIComponent(runId));
          if (run === null) throw new Error(`知らない Run: ${runId}`);
          return JSON.stringify(run);
        },
      },
    ],
  });
}

export { FactoryCore, runUri, type RunView };
