/**
 * `none` 公開モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * `publish` という役割を名乗る（決定16）。**環境を知らない**——受け取るのは
 * `host:port` だけで、それが docker のものか Proxmox のものかは見ない。
 * これが N×M を N＋M にしている境目そのものである。
 */

import { defineModule, ok, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { NonePublishCore } from './core.js';

export const manifest: BantoModule = {
  id: 'publish-none',
  description: '受け取った host:port をそのまま URL にする（外へは出さない）',
  // 鍵を扱わず、外部に触れない。in-process でよい（要件 C8b）。
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  provides: ['publish'],
};

export const publishNoneModule = defineModule({
  manifest,
  createCore: () => new NonePublishCore(),
  tools: (tool) => [
    tool({
      name: 'publish',
      description:
        'Turn a host:port into a URL. This provider creates no route: the URL is reachable from the banto host only. The name is accepted and ignored.',
      input: {
        hostPort: z.string().describe('host:port, as returned by the environment address tool'),
        name: z.string().optional().describe('Ignored by this provider'),
      },
      // **届く範囲も型で返す**（要件 C13）。URL だけ返すと、外から開けると誤解される
      // ——呼び手が文字列から読み取る形にすると、いつか読み落とされる。
      output: {
        url: z.string(),
        reachableFrom: z.string().describe('Where this URL actually resolves from'),
      },
      run: async (core, { hostPort }) => core.publish(hostPort),
      summary: (v) => `${v.url}\n（届く範囲: ${v.reachableFrom}）`,
    }),
    tool({
      name: 'unpublish',
      description: 'Tear a published route down. This provider creates none, so nothing is removed.',
      input: { name: z.string().describe('Name given to publish') },
      run: async (core, { name }) => ok(core.unpublish(name)),
    }),
  ],
});

export { NonePublishCore, type Published } from './core.js';
