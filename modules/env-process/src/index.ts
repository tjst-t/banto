/**
 * `process` 環境モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * `environment` という役割を名乗る（決定16）。名乗るだけでは足りず、
 * 依存側が書いた `tools` と `tools/list` の突き合わせで実測される（要件 C11）。
 */

import { defineModule, ok, requiredRoot, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { ProcessEnvironmentCore } from './core.js';

export const manifest: BantoModule = {
  id: 'env-process',
  description: 'このホストの、許された範囲のディレクトリでコマンドを走らせる（隔離しない）',
  // 鍵を扱わず、落ちてもホストを道連れにしない。in-process でよい（要件 C8b）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['environment'],
};

export const envProcessModule = defineModule({
  manifest,
  createCore: () => new ProcessEnvironmentCore(requiredRoot('BANTO_ENV_ROOT')),
  tools: (tool) => [
    tool({
      name: 'create',
      description:
        'Prepare an environment rooted at an existing working directory and return its handle. Idempotent.',
      input: { workdir: z.string().describe('Working directory, relative to the environment root') },
      run: async (core, { workdir }) => ok(await core.create(workdir)),
    }),
    tool({
      name: 'exec',
      description:
        'Run a command inside the environment. Returns exit code, stdout and stderr; a non-zero exit is a result, not an error.',
      input: {
        handle: z.string().describe('Handle returned by create'),
        command: z.string().describe('Executable to run (no shell)'),
        args: z.array(z.string()).optional().describe('Arguments, one per element'),
      },
      run: async (core, { handle, command, args }) => {
        // **JSON で返す。** 口を跨ぐと呼び手は文字列を解くことになるので、
        // 散文にすると解析がそこら中に散る。**終了コードは隠さない**——
        // 落ちたことと走らせられなかったことは別の事実（教訓13）。
        return ok(JSON.stringify(await core.exec(handle, command, args ?? [])));
      },
    }),
    tool({
      name: 'status',
      description: 'Report whether the environment is usable right now: "ready" or "gone".',
      input: { handle: z.string().describe('Handle returned by create') },
      run: async (core, { handle }) => ok(await core.status(handle)),
    }),
    tool({
      name: 'address',
      description:
        'Return a host:port reachable from the banto host for a port inside the environment.',
      input: {
        handle: z.string().describe('Handle returned by create'),
        port: z.number().int().describe('Port inside the environment'),
      },
      run: async (core, { handle, port }) => ok(core.address(handle, port)),
    }),
    tool({
      name: 'destroy',
      description: 'Tear the environment down. This provider owns nothing, so nothing is removed.',
      input: { handle: z.string().describe('Handle returned by create') },
      run: async (core, { handle }) => ok(await core.destroy(handle)),
    }),
  ],
});

export { ProcessEnvironmentCore, type ExecResult } from './core.js';
