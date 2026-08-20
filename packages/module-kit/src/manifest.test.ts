import { describe, expect, it } from 'vitest';

import { checkManifest, type BantoModule } from './manifest.js';

const base: BantoModule = {
  id: 'sample',
  description: '試験用の最小マニフェスト',
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
};

describe('checkManifest', () => {
  it('妥当な in-process マニフェストは問題を出さない', () => {
    expect(checkManifest(base)).toEqual([]);
  });

  it('isolation が無いと isolation-missing', () => {
    // 型では isolation を必須にしているので、JSON から読んだ想定を再現するには
    // ここでキャストして型の外から壊す必要がある（規則9：any の理由）。
    const broken = { ...base, isolation: undefined } as unknown as BantoModule;
    expect(checkManifest(broken)).toEqual([{ kind: 'isolation-missing', moduleId: 'sample' }]);
  });

  it('isolation が in-process なのに mcp.kind が subprocess だと boundary-mismatch', () => {
    const broken: BantoModule = {
      ...base,
      isolation: 'in-process',
      mcp: { kind: 'subprocess', command: 'python3' },
    };
    const problems = checkManifest(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('boundary-mismatch');
  });

  it('isolation が subprocess なのに mcp.kind が in-process だと boundary-mismatch（逆方向）', () => {
    const broken: BantoModule = {
      ...base,
      isolation: 'subprocess',
      mcp: { kind: 'in-process' },
    };
    const problems = checkManifest(broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.kind).toBe('boundary-mismatch');
  });

  it('secrets を扱うと宣言しつつ in-process だと secrets-in-process', () => {
    const broken: BantoModule = {
      ...base,
      isolation: 'in-process',
      mcp: { kind: 'in-process' },
      handles: ['secrets'],
    };
    expect(checkManifest(broken)).toEqual([{ kind: 'secrets-in-process', moduleId: 'sample' }]);
  });
});
