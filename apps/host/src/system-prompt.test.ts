/**
 * `describeWorkspaceRoot`（PO報告 2026-08-26：「特定のフォルダをスレッドの
 * ルートにしても、LLM側には伝わらず、アプリのRootがスレッドのRootと
 * 認識しているようだ」）。
 *
 * `writeRoot` はこれまで `fs` の書き込み境界にしか使っていなかった——
 * 構造では縛っていたが、システムプロンプトのどこにも書いていなかったので、
 * AI自身はその存在を知りようが無かった。ここは文字列の組み立てだけを見る
 * （本物のClaudeが実際にこの案内に従うかは、本番での実地確認で見る）。
 */

import { describe, expect, it } from 'vitest';

import { describeWorkspaceRoot } from './server.js';

describe('describeWorkspaceRoot', () => {
  it('workspaceRoot が無ければ、何も足さない', () => {
    expect(describeWorkspaceRoot(null)).toBe('');
  });

  it('workspaceRoot があれば、その具体的なパスを案内する', () => {
    const text = describeWorkspaceRoot('my-repo');
    expect(text).toContain('my-repo');
    expect(text).toContain('# Working directory');
  });

  it('読み取りの広さは変えない、と明言する（決定29のまま）', () => {
    const text = describeWorkspaceRoot('my-repo');
    expect(text.toLowerCase()).toContain('read outside it if genuinely needed');
  });
});
