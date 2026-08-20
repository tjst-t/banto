/**
 * ディスク上のマニフェストを台帳に載せる。
 *
 * **他言語モジュールが自力で載れるようにするための経路**（要件 C6）。
 * TypeScript のモジュールは `defineModule` から `BantoModule` を直接渡せるが、
 * Python のモジュールにその手段は無い。`manifest.json` を置くだけで載れなければ、
 * 「他言語も書ける」は形式的な主張で終わる。
 *
 * ここも Agent SDK に依存しない。使うのは標準の MCP クライアントだけ（決定6）。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { checkManifest, describeProblem, type BantoModule } from './manifest.js';
import type { ModuleSource } from './registry.js';

/**
 * `manifest.json` を読んで検査する。
 *
 * **読めたら通す、ではない。** JSON から来る値は型で守られていないので、
 * ここで `checkManifest` に掛ける。問題があれば理由を全部並べて投げる
 * ——「読み込みに失敗しました」だけでは直せない（教訓13）。
 */
export async function loadManifest(manifestPath: string): Promise<BantoModule> {
  let parsed: unknown;
  const raw = await readFile(manifestPath, 'utf8');
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${manifestPath}: JSON として読めない — ${String(cause)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${manifestPath}: マニフェストが object でない`);
  }

  const manifest = parsed as BantoModule;
  const problems = checkManifest(manifest);
  if (problems.length > 0) {
    throw new Error(
      `${manifestPath}: マニフェストが契約に合わない:\n${problems.map((p) => `  - ${describeProblem(p)}`).join('\n')}`,
    );
  }
  return manifest;
}

/**
 * subprocess のモジュールを台帳の1件にする。
 *
 * `listTools` は**実際に起動して `tools/list` を聞く**。宣言は自己申告なので、
 * 突き合わせる相手が要る（要件 C11）——相手がツール名を変えたら、使う瞬間ではなく
 * **接続の時点で**落ちてほしい。
 *
 * `args` の相対パスは `repoRoot` から解決する。呼び出し元の cwd に依存させない
 * ——依存させると、どこから起動したかで結果が変わる。
 */
export function subprocessSource(manifest: BantoModule, repoRoot: string): ModuleSource {
  return {
    manifest,
    listTools: async () => {
      if (manifest.mcp.kind !== 'subprocess') {
        throw new Error(`${manifest.id}: subprocess ではない（mcp.kind=${manifest.mcp.kind}）`);
      }
      const client = new Client({ name: 'banto-registry', version: '0.0.0' });
      const transport = new StdioClientTransport({
        command: manifest.mcp.command,
        args: (manifest.mcp.args ?? []).map((a) =>
          a.startsWith('-') || path.isAbsolute(a) ? a : path.resolve(repoRoot, a),
        ),
      });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        return listed.tools.map((t) => t.name);
      } finally {
        // 聞き終わったら必ず落とす。台帳を作るためだけに起動したプロセスを残さない。
        await client.close().catch(() => undefined);
      }
    },
  };
}

/** in-process のモジュールを台帳の1件にする。すでに手元にあるので聞きに行かない。 */
export function inProcessSource(manifest: BantoModule, toolNames: readonly string[]): ModuleSource {
  return { manifest, listTools: async () => toolNames };
}
