/**
 * ファイルモジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * この層に条件分岐や整形以上のものが出てきたら、それは core に置くべきもの。
 */

import { defineModule, ok, requiredRoot, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { FileSystemCore } from './core.js';

export const manifest: BantoModule = {
  id: 'fs',
  description: '許された root の内側で、ファイルを読む・書く・並べる',
  // 鍵を扱わず、落ちてもホストを道連れにしない。in-process でよい（要件 C8b）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
};

export const fsModule = defineModule({
  manifest,
  createCore: () => new FileSystemCore(requiredRoot('BANTO_FS_ROOT')),
  tools: (tool) => [
    tool({
      name: 'read',
      description: 'Read a UTF-8 text file, relative to the module root.',
      input: { path: z.string().describe('Path relative to the root') },
      run: async (core, { path: p }) => ok(await core.read(p)),
    }),
    tool({
      name: 'write',
      description: 'Write a UTF-8 text file, relative to the module root. Creates parent directories.',
      input: {
        path: z.string().describe('Path relative to the root'),
        content: z.string().describe('Full file contents'),
      },
      run: async (core, { path: p, content }) => ok(`${await core.write(p, content)} バイト書いた: ${p}`),
    }),
    tool({
      name: 'list',
      description: 'List directory entries, relative to the module root.',
      input: { path: z.string().describe('Directory path relative to the root') },
      run: async (core, { path: p }) =>
        ok((await core.list(p)).map((e) => `${e.kind === 'dir' ? 'd' : '-'} ${e.name} ${e.bytes}`).join('\n')),
    }),
  ],
});

export { FileSystemCore } from './core.js';
