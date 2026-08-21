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

  /**
   * **プロセスで信用していないものを、画面で信用しない**（決定20）。
   * `isolation` と同じ2択にしてあるので、規則も同じ形になる。
   */
  describe('画面の境界（要件 C1・C14）', () => {
    const withGui = (gui: BantoModule['gui'], over: Partial<BantoModule> = {}): BantoModule => ({
      ...base,
      ...over,
      ...(gui === undefined ? {} : { gui }),
    });

    it('in-process なモジュールの in-page な画面は通る', () => {
      expect(
        checkManifest(
          withGui({ kind: 'in-page', entry: './views/Sample', views: [{ uriPrefix: 'banto://sample/file/', title: 'ファイル' }] }),
        ),
      ).toEqual([]);
    });

    it('kind が無いと gui-kind-missing（既定値を持たない）', () => {
      const broken = withGui({ entry: './x', views: [] } as unknown as BantoModule['gui']);
      expect(checkManifest(broken)).toContainEqual({ kind: 'gui-kind-missing', moduleId: 'sample' });
    });

    // プロセスを分けた意味が、画面側で消える。
    it('subprocess なのに in-page だと断る', () => {
      const broken = withGui(
        { kind: 'in-page', entry: './x', views: [] },
        { isolation: 'subprocess', mcp: { kind: 'subprocess', command: 'python3' } },
      );
      expect(checkManifest(broken)).toContainEqual({
        kind: 'gui-in-page-outside',
        moduleId: 'sample',
        detail: 'isolation が subprocess なのに gui.kind が in-page',
      });
    });

    // 鍵を扱うものの画面が、合言葉の cookie と同じページに居てはいけない。
    it('secrets を扱うのに in-page だと断る', () => {
      const broken = withGui(
        { kind: 'in-page', entry: './x', views: [] },
        { handles: ['secrets'], isolation: 'subprocess', mcp: { kind: 'subprocess', command: 'x' } },
      );
      expect(checkManifest(broken)).toContainEqual({
        kind: 'gui-in-page-outside',
        moduleId: 'sample',
        detail: 'secrets を扱うと宣言しているのに gui.kind が in-page',
      });
    });

    // 名乗れると、他のモジュールが持っているものを横取りできる。
    it('自分の URI 空間の外は名乗れない', () => {
      const broken = withGui({
        kind: 'sandboxed',
        entry: 'https://example.test/view.js',
        views: [{ uriPrefix: 'banto://fs/file/', title: '横取り' }],
      });
      expect(checkManifest(broken)).toContainEqual({
        kind: 'gui-view-outside-uri',
        moduleId: 'sample',
        uriPrefix: 'banto://fs/file/',
      });
    });

    // sandboxed なら、外側のモジュールでも画面を持てる（要件 C6）。
    it('subprocess でも sandboxed なら通る', () => {
      expect(
        checkManifest(
          withGui(
            { kind: 'sandboxed', entry: 'https://example.test/view.js', views: [] },
            { isolation: 'subprocess', mcp: { kind: 'subprocess', command: 'python3' } },
          ),
        ),
      ).toEqual([]);
    });
  });
});
