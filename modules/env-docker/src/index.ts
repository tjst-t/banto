/**
 * `docker` 環境モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * `environment` という役割を名乗る（決定16）。**`env-process` と同じ5本**で、
 * 引数も返り値も同じ形——差し替えられることが、ここで初めて実物で確かめられる。
 */

import { defineModule, requiredRoot, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { DockerEnvironmentCore } from './core.js';

export const manifest: BantoModule = {
  id: 'env-docker',
  description: 'コンテナの中でコマンドを走らせる（作業ツリーだけを bind mount する）',
  // docker を叩く子プロセスを spawn するだけ。鍵を扱わない（要件 C8b）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['environment'],
};

/**
 * 走らせる image。**既定値を持たない**（`requiredRoot` と同じ考え）。
 *
 * 既定を当てると、リポジトリが要る道具の入っていない箱でテストが走り、
 * 「環境が違うから落ちた」と「実装が壊れているから落ちた」が混ざる（教訓13）。
 */
function requiredImage(): string {
  const value = process.env['BANTO_DOCKER_IMAGE'];
  if (value === undefined || value.trim() === '') {
    throw new Error('BANTO_DOCKER_IMAGE が要る——何の箱で走らせるかは運用者が決める');
  }
  return value;
}

export const envDockerModule = defineModule({
  manifest,
  createCore: () => new DockerEnvironmentCore(requiredRoot('BANTO_ENV_ROOT'), requiredImage()),
  tools: (tool) => [
    tool({
      name: 'create',
      description:
        'Start (or reuse) a container with the working directory bind-mounted, and return its handle. Idempotent.',
      input: { workdir: z.string().describe('Working directory, relative to the environment root') },
      output: { handle: z.string() },
      run: async (core, { workdir }) => ({ handle: await core.create(workdir) }),
      summary: (v) => v.handle,
    }),
    tool({
      name: 'exec',
      description:
        'Run a command inside the container. Returns exit code, stdout and stderr; a non-zero exit is a result, not an error.',
      input: {
        handle: z.string().describe('Handle returned by create'),
        command: z.string().describe('Executable to run (no shell)'),
        args: z.array(z.string()).optional().describe('Arguments, one per element'),
      },
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
        'Return a host:port reachable from the banto host for a port inside the container.',
      input: {
        handle: z.string().describe('Handle returned by create'),
        port: z.number().int().describe('Port inside the environment'),
      },
      output: { address: z.string() },
      run: async (core, { handle, port }) => ({ address: await core.address(handle, port) }),
      summary: (v) => v.address,
    }),
    tool({
      name: 'destroy',
      description: 'Remove the container. The working tree is left alone — repo owns it.',
      input: { handle: z.string().describe('Handle returned by create') },
      output: { detail: z.string() },
      run: async (core, { handle }) => ({ detail: await core.destroy(handle) }),
      summary: (v) => v.detail,
    }),
  ],
});

export { DockerEnvironmentCore, MOUNT_PATH, containerNameFor, type ExecResult } from './core.js';
