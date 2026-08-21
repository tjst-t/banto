/**
 * **返り値の型は宣言ではなく強制である**（要件 C13・決定17）。
 *
 * 最初の版は「MCP はテキストしか返せない」と思い込んで、呼ぶ側で `yes` / `no` を
 * 判定していた。**確かめる前に決めていた**（規則1 を破った）。実際には
 * `outputSchema` / `structuredContent` が仕様にあり、SDK が型違反を断る。
 *
 * ここで固定するのは「型が付く」ことではなく、**破れないこと**である。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { connectInProcess } from './client.js';
import { decline, defineModule } from './define.js';
import type { BantoModule } from './manifest.js';

const manifest: BantoModule = {
  id: 'probe',
  description: '試験用',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
};

const probe = defineModule({
  manifest,
  createCore: () => ({}),
  tools: (tool) => [
    tool({
      name: 'ahead',
      description: '型つきで返す',
      input: { branch: z.string() },
      output: { ahead: z.boolean(), commit: z.string() },
      run: async (_core, { branch }) => ({ ahead: branch === 'x', commit: 'abc123' }),
      summary: (v) => (v.ahead ? '進んでいる' : '進んでいない'),
    }),
    tool({
      name: 'lies',
      description: '宣言と違うものを返す',
      input: {},
      output: { n: z.number() },
      // any の理由（規則9）：**わざと契約を破る**ので、型を通さない。
      run: async () => ({ n: 'これは数ではない' }) as any,
    }),
    tool({
      name: 'plain',
      description: 'テキストだけ返す',
      input: {},
      run: async () => ({ content: [{ type: 'text' as const, text: 'ただの文字' }] }),
    }),
    tool({
      name: 'refuses',
      description: '型つきだが断る',
      input: {},
      output: { ok: z.boolean() },
      run: async () => {
        throw new Error('やらない');
      },
    }),
  ],
});

const connect = () => connectInProcess(probe.createServer());

describe('返り値の型（MCP の outputSchema）', () => {
  it('型が落ちずに往復する。真偽値は真偽値のまま', async () => {
    const caller = await connect();
    try {
      const r = await caller.callStructured('ahead', { branch: 'x' });
      expect(r).toEqual({ ahead: true, commit: 'abc123' });
      expect(typeof r['ahead']).toBe('boolean');
    } finally {
      await caller.close();
    }
  });

  // ここが要。**気をつけるのではなく、破れないようにする。**
  it('宣言と違うものを返すと、呼び手に届く前に断られる', async () => {
    const caller = await connect();
    try {
      await expect(caller.callStructured('lies', {})).rejects.toThrow(/Output validation error/);
    } finally {
      await caller.close();
    }
  });

  // 呼び間違いを「たぶん空」にしない（規則2）。
  it('構造を返さないツールを型つきで呼んだら止まる', async () => {
    const caller = await connect();
    try {
      await expect(caller.callStructured('plain', {})).rejects.toThrow(/構造を返さない/);
    } finally {
      await caller.close();
    }
  });

  // 断りは outputSchema があっても通る（実測して確かめた設計前提）。
  it('型つきのツールでも、断りは理由つきで届く', async () => {
    const caller = await connect();
    try {
      await expect(caller.callStructured('refuses', {})).rejects.toThrow(/やらない/);
    } finally {
      await caller.close();
    }
  });

  it('AI が読むテキストも一緒に出る（同じ事実の別の形）', async () => {
    const caller = await connect();
    try {
      expect(await caller.call('ahead', { branch: 'x' })).toBe('進んでいる');
    } finally {
      await caller.close();
    }
  });
});
