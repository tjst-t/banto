/**
 * `script` 環境モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * **`defineModule` を const ではなく関数で包む。** このモジュールは環境変数で表せない
 * ものを2つ要る——許可されたリポジトリの一覧と、承認台帳（ログを毎回畳んで得る）。
 * 文字列で渡せないものを文字列で渡す形にすると、どこかで写しになる（規則3）。
 */

import { defineModule, ok, type BantoModule, type DefinedModule } from '@banto/module-kit';
import { NOTHING_APPROVED, type ApprovalLedger } from '@banto/core';
import { z } from 'zod';

import { ScriptEnvironmentCore } from './core.js';

export const manifest: BantoModule = {
  id: 'env-script',
  description: 'リポジトリが置いたスクリプトに、環境の動詞を委譲する',
  // 危ないコードは spawn した子プロセスで走るので、ここが落ちる筋は薄い。
  // 一方で承認台帳は毎回畳んで得るものなので、境界を挟むと写しになる（core.ts の注記）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['environment'],
};

export interface EnvScriptOptions {
  /**
   * 自前の環境を持ってよいリポジトリ（絶対パス）。**運用者が banto 側で書く。**
   * 空なら1つも許可されていない——**既定は「何も許さない」**（門①）。
   */
  readonly allowedRepos: readonly string[];
  /** 承認台帳。渡さなければ**何も承認されていない**（門②）。 */
  readonly ledger?: ApprovalLedger;
}

export function envScriptModule(options: EnvScriptOptions): DefinedModule {
  return defineModule({
    manifest,
    createCore: () =>
      new ScriptEnvironmentCore(options.allowedRepos, options.ledger ?? NOTHING_APPROVED),
    tools: (tool) => [
      tool({
        name: 'create',
        description:
          'Run the repository’s create script and return the handle it prints on stdout.',
        input: { repo: z.string().describe('Absolute path of an allowed repository') },
        run: async (core, { repo }) => ok(await core.create(repo)),
      }),
      tool({
        name: 'status',
        description: 'Report whether the environment is usable right now: "ready" or "gone".',
        input: {
          repo: z.string().describe('Absolute path of an allowed repository'),
          handle: z.string().describe('Handle returned by create'),
        },
        run: async (core, { repo, handle }) => ok(await core.status(repo, handle)),
      }),
      tool({
        name: 'exec',
        description:
          'Run a command inside the environment via the repository’s exec script. A non-zero exit is a result, not an error.',
        input: {
          repo: z.string().describe('Absolute path of an allowed repository'),
          handle: z.string().describe('Handle returned by create'),
          command: z.array(z.string()).describe('Command and arguments, one per element'),
        },
        run: async (core, { repo, handle, command }) => {
          // env-process と同じ形で返す（役割が同じなら、返す形も同じでなければ
          // 呼び手が実装ごとに解析を分けることになる）。
          return ok(JSON.stringify(await core.exec(repo, handle, command)));
        },
      }),
      tool({
        name: 'address',
        description:
          'Return a host:port reachable from the banto host, via the repository’s address script.',
        input: {
          repo: z.string().describe('Absolute path of an allowed repository'),
          handle: z.string().describe('Handle returned by create'),
          port: z.number().int().describe('Port inside the environment'),
        },
        run: async (core, { repo, handle, port }) => ok(await core.address(repo, handle, port)),
      }),
      tool({
        name: 'destroy',
        description: 'Tear the environment down via the repository’s destroy script.',
        input: {
          repo: z.string().describe('Absolute path of an allowed repository'),
          handle: z.string().describe('Handle returned by create'),
        },
        run: async (core, { repo, handle }) => ok(await core.destroy(repo, handle)),
      }),
    ],
  });
}

export {
  CONFIG_PATH,
  ScriptEnvironmentCore,
  UnapprovedScriptError,
  VERBS,
  type ScriptConfig,
  type ScriptResult,
  type Verb,
} from './core.js';
