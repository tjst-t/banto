import { describe, expect, it } from 'vitest';

import type { BantoModule, Dependency } from './manifest.js';
import { assertStartable, resolve, type ModuleSource } from './registry.js';

/** 台帳に載せる最小のモジュール。in-process 固定で境界の話とは無関係にする。 */
function moduleOf(
  id: string,
  opts: {
    readonly requires?: readonly Dependency[];
    readonly optional?: readonly Dependency[];
    readonly tools?: readonly string[];
    readonly listTools?: () => Promise<readonly string[]>;
  } = {},
): ModuleSource {
  const manifest: BantoModule = {
    id,
    description: `試験用モジュール ${id}`,
    isolation: 'in-process',
    mcp: { kind: 'in-process' },
    // exactOptionalPropertyTypes: undefined を明示的に渡すのはキーごと省くのと違う扱いなので、
    // 指定が無いときはキー自体を作らない。
    ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
    ...(opts.optional !== undefined ? { optional: opts.optional } : {}),
  };
  return {
    manifest,
    listTools: opts.listTools ?? (async () => opts.tools ?? []),
  };
}

describe('resolve', () => {
  it('すべて満たされていれば problems は空で、全部 ready に入る', async () => {
    const vault = moduleOf('vault', { tools: ['sign'] });
    const repo = moduleOf('repo', {
      requires: [{ module: 'vault', tools: ['sign'] }],
      tools: ['push'],
    });
    const resolution = await resolve([vault, repo]);
    expect(resolution.problems).toEqual([]);
    expect([...resolution.ready].sort()).toEqual(['repo', 'vault']);
  });

  it('必須の依存先モジュールが台帳に無いと required-module-missing', async () => {
    const repo = moduleOf('repo', { requires: [{ module: 'vault', tools: ['sign'] }] });
    const resolution = await resolve([repo]);
    expect(resolution.problems).toEqual([
      { kind: 'required-module-missing', moduleId: 'repo', missing: 'vault' },
    ]);
  });

  it('必須の依存先モジュールはあるがツールが無いと required-tool-missing', async () => {
    // ここが要点：依存にツール名まで書かせているのは、相手がツールを改名/削除したとき
    // 「モジュールはある」だけでは気づけないから。tools/list と突き合わせて初めて分かる
    // ——これを検出できないと、依存は push 時ではなく実際に呼んだ瞬間まで壊れたままになる。
    const vault = moduleOf('vault', { tools: ['sign'] }); // 'sign' はあるが 'signCommit' は無い
    const repo = moduleOf('repo', { requires: [{ module: 'vault', tools: ['signCommit'] }] });
    const resolution = await resolve([vault, repo]);
    expect(resolution.problems).toEqual([
      { kind: 'required-tool-missing', moduleId: 'repo', missing: 'vault', tool: 'signCommit' },
    ]);
  });

  it('任意の依存が満たされないと degradation になり、problem にはならず起動は止まらない', async () => {
    const repo = moduleOf('repo', { optional: [{ module: 'vault', tools: ['sign'] }] });
    const resolution = await resolve([repo]);
    expect(resolution.problems).toEqual([]);
    expect(resolution.degradations).toEqual([
      {
        moduleId: 'repo',
        missing: 'vault',
        tools: ['sign'],
        reason: expect.stringContaining('vault'),
      },
    ]);
    expect(resolution.ready).toContain('repo');
    expect(() => assertStartable(resolution)).not.toThrow();
  });

  it('必須依存の循環（A requires B, B requires A）は cycle として検出する', async () => {
    const a = moduleOf('a', { requires: [{ module: 'b', tools: [] }] });
    const b = moduleOf('b', { requires: [{ module: 'a', tools: [] }] });
    const resolution = await resolve([a, b]);
    expect(resolution.problems.some((p) => p.kind === 'cycle')).toBe(true);
  });

  it('listTools が reject するモジュールは unreachable になり、エラーメッセージが残る', async () => {
    const broken = moduleOf('broken', {
      listTools: async () => {
        throw new Error('接続できなかった: ECONNREFUSED');
      },
    });
    const resolution = await resolve([broken]);
    expect(resolution.problems).toEqual([
      { kind: 'unreachable', moduleId: 'broken', detail: expect.stringContaining('ECONNREFUSED') },
    ]);
  });
});

describe('assertStartable', () => {
  it('problems が無ければ何もしない', () => {
    expect(() => assertStartable({ ready: ['a'], problems: [], degradations: [] })).not.toThrow();
  });

  it('problems があれば、すべてを列挙して投げる', () => {
    expect(() =>
      assertStartable({
        ready: [],
        problems: [
          { kind: 'required-module-missing', moduleId: 'repo', missing: 'vault' },
          { kind: 'duplicate-id', moduleId: 'fs' },
        ],
        degradations: [],
      }),
    ).toThrowError(/repo.*vault[\s\S]*fs/);
  });
});
