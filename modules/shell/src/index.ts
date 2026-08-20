/**
 * shell モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * この層に条件分岐や整形以上のものが出てきたら、それは core に置くべきもの。
 */

import { defineModule, ok, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { ShellCore } from './core.js';

export const manifest: BantoModule = {
  id: 'shell',
  description: '許可した実行ファイルだけを、タイムアウト付きで走らせる',
  // shell は「落ちやすいもの」の筆頭（要件 C8b）。ハングしたコマンド・暴走した
  // 子プロセスがホストを道連れにしないよう、別プロセスに出す。
  isolation: 'subprocess',
  mcp: { kind: 'subprocess', command: 'node', args: ['modules/shell/dist/serve.js'] },
};

export const shellModule = defineModule({
  manifest,
  createCore: () =>
    new ShellCore(
      (process.env['BANTO_SHELL_ALLOWED'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  tools: (tool) => [
    tool({
      name: 'run',
      description:
        'Run an allowlisted executable with an explicit argument list and a timeout. ' +
        'Always returns the exit code, stdout, and stderr — stderr is never hidden on success.',
      input: {
        command: z.string().describe('Executable name (must be on the allowlist, e.g. "git")'),
        args: z.array(z.string()).describe('Arguments, passed without shell interpolation'),
        timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000)'),
      },
      run: async (core, { command, args, timeoutMs }) => {
        const result = await core.run(command, args, timeoutMs);
        return ok(`exit: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      },
    }),
  ],
});

export { ShellCore } from './core.js';
export type { ShellResult } from './core.js';
