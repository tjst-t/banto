/**
 * worker モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * **中核同梱だが、口は他のモジュールと同じ**（要件 C13）。中核とモジュールの違いは
 * 口ではなく出荷元だけ、というのがこのモジュールの存在理由そのものである。
 *
 * `defineModule` を const ではなく関数で包むのは、環境変数で表せないもの
 * （イベントログ・繋ぐモジュール）を要るため——文字列で渡せないものを
 * 文字列で渡す形にすると、どこかで写しになる（規則3）。
 */

import { defineModule, ok, type BantoModule, type DefinedModule } from '@banto/module-kit';
import { z } from 'zod';

import { WorkerCore, type WorkerOptions } from './core.js';

export const manifest: BantoModule = {
  id: 'worker',
  description: 'サブエージェントを1人動かして、作業ツリーの中で仕事をさせる',
  // Runner を内側で握る。落ちるのはサブエージェント側のプロセスで、ここではない。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['worker'],
};

export function workerModule(options: WorkerOptions): DefinedModule {
  return defineModule({
    manifest,
    createCore: () => new WorkerCore(options),
    tools: (tool) => [
      tool({
        name: 'work',
        description:
          'Run one subagent to do the requested work in the given directory. Returns how many turns it took and what the runtime reported — not whether the work is actually done; the caller checks that against the world.',
        input: {
          threadId: z.string().describe('Thread this work belongs to'),
          queryId: z.string().describe('Caller-chosen id for this piece of work'),
          request: z.string().describe('What to do'),
          cwd: z.string().describe('Absolute path to work in'),
        },
        run: async (core, order) => {
          const result = await core.work(order);
          return ok(
            `turns=${result.turns} runtime=${result.succeeded ? 'succeeded' : 'failed'}\n${result.detail}`,
          );
        },
      }),
    ],
  });
}

export { WorkerCore, type WorkOrder, type WorkResult, type WorkerOptions } from './core.js';
