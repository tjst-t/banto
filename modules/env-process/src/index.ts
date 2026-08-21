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
      output: { handle: z.string() },
      run: async (core, { workdir }) => ({ handle: await core.create(workdir) }),
      summary: (v) => v.handle,
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
      // **返り値の型を決める**（要件 C13）。呼び手が文字列を解かずに済む。
      // **終了コードは隠さない**——落ちたことと走らせられなかったことは別の事実（教訓13）。
      output: { exitCode: z.number(), stdout: z.string(), stderr: z.string() },
      run: async (core, { handle, command, args }) => core.exec(handle, command, args ?? []),
      summary: (v) => `exit=${v.exitCode}\n${v.stdout}${v.stderr}`,
    }),
    tool({
      name: 'status',
      description: 'Report whether the environment is usable right now: "ready" or "gone".',
      input: { handle: z.string().describe('Handle returned by create') },
      output: { status: z.enum(['ready', 'gone']) },
      run: async (core, { handle }) => ({ status: await core.status(handle) }),
      summary: (v) => v.status,
    }),
    tool({
      name: 'address',
      description:
        'Return a host:port reachable from the banto host for a port inside the environment.',
      input: {
        handle: z.string().describe('Handle returned by create'),
        port: z.number().int().describe('Port inside the environment'),
      },
      output: { address: z.string() },
      run: async (core, { handle, port }) => ({ address: core.address(handle, port) }),
      summary: (v) => v.address,
    }),
    tool({
      name: 'destroy',
      description: 'Tear the environment down. This provider owns nothing, so nothing is removed.',
      input: { handle: z.string().describe('Handle returned by create') },
      output: { detail: z.string() },
      run: async (core, { handle }) => ({ detail: await core.destroy(handle) }),
      summary: (v) => v.detail,
    }),
  ],
});

export { ProcessEnvironmentCore, type ExecResult } from './core.js';
