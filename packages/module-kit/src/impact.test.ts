import { describe, expect, it } from 'vitest';

import { describeImpact, impactOfDisabling } from './impact.js';
import type { BantoModule } from './manifest.js';

const mod = (id: string, over: Partial<BantoModule> = {}): BantoModule => ({
  id,
  description: id,
  isolation: 'in-process',
  mcp: { kind: 'in-process' },
  ...over,
});

describe('無効化したときの影響（要件 C12）', () => {
  it('誰も頼っていなければ、何も壊れない', () => {
    const impact = impactOfDisabling([mod('fs'), mod('shell')], 'fs');
    expect(impact.breakages).toEqual([]);
    expect(describeImpact(impact)).toContain('影響を受けない');
  });

  // 名指しの必須依存。**外せば相手は起動しない**（要件 C11）。
  it('名指しで必須にしている相手は、起動しなくなる', () => {
    const impact = impactOfDisabling(
      [mod('vault', { handles: ['secrets'], isolation: 'subprocess', mcp: { kind: 'subprocess', command: 'v' } }),
       mod('repo', { requires: [{ module: 'vault', tools: ['sign'] }] })],
      'vault',
    );
    expect(impact.breakages).toEqual([
      { moduleId: 'repo', severity: 'blocks-start', via: { module: 'vault' } },
    ]);
    expect(describeImpact(impact)).toContain('起動しなくなる: repo');
  });

  // 任意の依存は起動を止めない。**そのツールだけが理由つきで断る**（要件 C11）。
  it('任意の依存は、そのツールだけが断るようになる', () => {
    const impact = impactOfDisabling(
      [mod('vault'), mod('repo', { optional: [{ module: 'vault', tools: ['sign'], usedBy: ['push'] }] })],
      'vault',
    );
    expect(impact.breakages[0]).toMatchObject({
      moduleId: 'repo',
      severity: 'declines',
      declining: ['push'],
    });
    expect(describeImpact(impact)).toContain('断るようになる: repo（push）');
  });

  /**
   * **差し替えられることが、この設計の狙いである**（決定16）。
   * 他に担い手が居るなら、外しても壊れない——ここを見落とすと
   * 「外せません」と嘘をつくことになる。
   */
  it('役割に他の担い手が居れば、外しても壊れない', () => {
    const manifests = [
      mod('env-process', { provides: ['environment'] }),
      mod('env-docker', { provides: ['environment'] }),
      mod('factory', { requires: [{ capability: 'environment', tools: ['create'] }] }),
    ];
    expect(impactOfDisabling(manifests, 'env-process').breakages).toEqual([]);
    expect(impactOfDisabling(manifests, 'env-process').orphanedCapabilities).toEqual([]);
  });

  it('最後の担い手を外すと、頼っている側が起動しなくなる', () => {
    const manifests = [
      mod('env-process', { provides: ['environment'] }),
      mod('factory', { requires: [{ capability: 'environment', tools: ['create'] }] }),
    ];
    const impact = impactOfDisabling(manifests, 'env-process');
    expect(impact.orphanedCapabilities).toEqual(['environment']);
    expect(impact.breakages).toEqual([
      { moduleId: 'factory', severity: 'blocks-start', via: { capability: 'environment' } },
    ]);
  });

  // 担い手が居なくなること自体は、頼る側が居なくても伝える価値がある。
  it('誰も頼っていなくても、担い手が居なくなることは言う', () => {
    const impact = impactOfDisabling([mod('env-process', { provides: ['environment'] })], 'env-process');
    expect(impact.breakages).toEqual([]);
    expect(describeImpact(impact)).toContain('environment の担い手が居なくなる');
  });

  // 呼び手が事前に存在を確かめなくて済むように、知らない id でも答える。
  it('知らないモジュールでも答える（空の影響）', () => {
    expect(impactOfDisabling([mod('fs')], 'nope').breakages).toEqual([]);
  });
});
