import { describe, expect, it } from 'vitest';

import type { BantoModule, Dependency } from './manifest.js';
import { assertStartable, availabilityFor, resolve, type ModuleSource } from './registry.js';

/** 台帳に載せる最小のモジュール。in-process 固定で境界の話とは無関係にする。 */
function moduleOf(
  id: string,
  opts: {
    readonly requires?: readonly Dependency[];
    readonly optional?: readonly Dependency[];
    readonly tools?: readonly string[];
    readonly provides?: readonly string[];
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
    ...(opts.provides !== undefined ? { provides: opts.provides } : {}),
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

/**
 * 役割による依存（ADR-0001 決定16）。
 *
 * 眼目は「**依存側を1文字も変えずに実装を差し替えられる**」ことなので、
 * それを直接確かめる試験を置く。
 */
describe('resolve —— 役割（capability）', () => {
  const ENV_TOOLS = ['create', 'exec', 'address', 'destroy'];
  const factory = (extra: Record<string, unknown> = {}) =>
    moduleOf('factory', {
      requires: [{ capability: 'environment', tools: ENV_TOOLS }],
      ...extra,
    });

  it('割り当てがあれば解ける。ツールも突き合わせる', async () => {
    const resolution = await resolve(
      [moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }), factory()],
      new Map([['environment', 'env-process']]),
    );
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toContain('factory');
  });

  // これが決定16 の眼目。factory 側は1文字も変わらない。
  it('依存側を変えずに実装を差し替えられる', async () => {
    const sources = [
      moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }),
      moduleOf('env-docker', { provides: ['environment'], tools: ENV_TOOLS }),
      factory(),
    ];
    for (const chosen of ['env-process', 'env-docker']) {
      const resolution = await resolve(sources, new Map([['environment', chosen]]));
      expect(resolution.problems).toEqual([]);
    }
  });

  // 黙って選ばれた既定は忘れられる（C8c と同じ理由）。
  it('候補が1つでも、割り当てが無ければ起動しない', async () => {
    const resolution = await resolve([
      moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }),
      factory(),
    ]);
    const problem = resolution.problems[0];
    expect(problem?.kind).toBe('capability-unbound');
    // 直せるように候補を出す。「決まっていません」だけでは直せない（教訓13）。
    expect(problem).toMatchObject({ candidates: ['env-process'] });
    expect(resolution.ready).not.toContain('factory');
  });

  // Capability は string なので、型では綴りを守れない。ここで捕まえる。
  it('名乗る実装が1つも無ければ止まる（綴り違いがここで出る）', async () => {
    const resolution = await resolve([factory()], new Map([['enviroment', 'x']]));
    expect(resolution.problems[0]?.kind).toBe('capability-no-provider');
  });

  it('割り当てた実装がその役割を名乗っていなければ止まる', async () => {
    const resolution = await resolve(
      [moduleOf('fs', { tools: ENV_TOOLS }), moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }), factory()],
      new Map([['environment', 'fs']]),
    );
    expect(resolution.problems[0]).toMatchObject({ kind: 'capability-not-provided', bound: 'fs' });
  });

  // **名乗るだけでは足りない**（規則1）。役割の実体はツール名の集合である。
  it('名乗っていてもツールが欠けていれば止まる', async () => {
    const resolution = await resolve(
      [moduleOf('env-half', { provides: ['environment'], tools: ['create', 'destroy'] }), factory()],
      new Map([['environment', 'env-half']]),
    );
    expect(resolution.problems.map((p) => p.kind)).toEqual([
      'required-tool-missing',
      'required-tool-missing',
    ]);
    expect(resolution.problems).toContainEqual(
      expect.objectContaining({ tool: 'exec', missing: 'env-half' }),
    );
  });

  // 役割を挟むだけで循環の検出をすり抜けられては困る。
  it('役割を挟んだ循環も見つかる', async () => {
    const resolution = await resolve(
      [
        moduleOf('a', { provides: ['environment'], requires: [{ module: 'b', tools: [] }], tools: ENV_TOOLS }),
        moduleOf('b', { requires: [{ capability: 'environment', tools: [] }] }),
      ],
      new Map([['environment', 'a']]),
    );
    expect(resolution.problems.some((p) => p.kind === 'cycle')).toBe(true);
  });

  it('任意の役割依存が未割り当てなら、起動は止めず degradation にする（要件 C12）', async () => {
    const resolution = await resolve([
      moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }),
      moduleOf('factory', {
        optional: [{ capability: 'environment', tools: ENV_TOOLS, usedBy: ['verify'] }],
      }),
    ]);
    expect(resolution.problems).toEqual([]);
    expect(resolution.ready).toContain('factory');
    // 実装が決まっていないので「欠けている相手」は null。無理に埋めない。
    expect(resolution.degradations[0]).toMatchObject({
      moduleId: 'factory',
      capability: 'environment',
      missing: null,
    });
  });

  // 手で組み立てさせない——台帳が言うことと、モジュールが断ることを一致させる。
  it('availabilityFor は degradation とそのまま噛み合う', async () => {
    const dep = { capability: 'environment', tools: ENV_TOOLS, usedBy: ['verify'] } as const;
    const resolution = await resolve([
      moduleOf('env-process', { provides: ['environment'], tools: ENV_TOOLS }),
      moduleOf('factory', { optional: [dep] }),
    ]);
    const availability = availabilityFor('factory', resolution);
    expect(availability.has(dep)).toBe(false);
    expect(availability.reasonFor(dep)).toContain('environment');
    // 満たされている依存は、通す。
    expect(availability.has({ module: 'env-process', tools: [] })).toBe(true);
  });
});
