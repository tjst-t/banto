/**
 * repo モジュールの core を直接叩く試験。モデルも API も使わない
 * ——自由に、何度でも走らせられる。
 *
 * banto 自身のリポジトリに対しては試験しない（教訓 shared-worktree）。
 * `mkdtemp` で作った使い捨てのリポジトリだけを対象にする。
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { RepoCore } from './core.js';

const execFileAsync = promisify(execFile);

describe('RepoCore', () => {
  let root: string;
  let core: RepoCore;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'banto-repo-core-test-'));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Banto Test'], { cwd: root });
    await writeFile(path.join(root, 'a.txt'), 'one\n', 'utf8');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root });
    await execFileAsync('git', ['commit', '-q', '-m', 'first commit'], { cwd: root });
    core = new RepoCore(root);
  });

  it('log で直近のコミットが見える', async () => {
    const log = await core.log();
    expect(log).toContain('first commit');
  });

  it('status で working tree の変更が見える', async () => {
    await writeFile(path.join(root, 'b.txt'), 'two\n', 'utf8');
    const status = await core.status();
    expect(status).toContain('b.txt');
  });

  it('diff で変更内容が見える', async () => {
    await writeFile(path.join(root, 'a.txt'), 'one\nmodified\n', 'utf8');
    const diff = await core.diff('a.txt');
    expect(diff).toContain('modified');
  });

  it('branches で現在のブランチが見える', async () => {
    const branches = await core.branches();
    expect(branches).toContain('main');
  });

  it('commit で明示したパスだけをステージしてコミットできる', async () => {
    await writeFile(path.join(root, 'c.txt'), 'three\n', 'utf8');
    await core.commit('add c', ['c.txt']);
    const log = await core.log();
    expect(log).toContain('add c');
  });

  it('パスを渡さない commit は理由付きで断る', async () => {
    await expect(core.commit('empty', [])).rejects.toThrow(/コミット対象のパスが空/);
  });

  it('root の外を指した diff は理由付きで断る', async () => {
    await expect(core.diff('../outside.txt')).rejects.toThrow(/許された範囲の外/);
  });

  it('root の外を指した commit は理由付きで断る', async () => {
    await expect(core.commit('escape', ['../outside.txt'])).rejects.toThrow(/許された範囲の外/);
  });
});

// 決定32：スレッド作成の候補地。root の直下に複数リポジトリが並ぶ、という
// 上の describe とは違う形の root を使うので、別立てにする。
describe('RepoCore.listCandidates（決定32）', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'banto-repo-candidates-'));
    for (const name of ['repo-a', 'repo-b']) {
      await mkdir(path.join(root, name), { recursive: true });
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: path.join(root, name) });
    }
    // git ではないただのディレクトリ。候補に出てはいけない。
    await mkdir(path.join(root, 'not-a-repo'), { recursive: true });
    // ディレクトリではないファイル。これも候補に出てはいけない。
    await writeFile(path.join(root, 'note.txt'), 'x', 'utf8');
  });

  it('.git を持つディレクトリだけを候補として返す', async () => {
    const core = new RepoCore(root);
    const candidates = await core.listCandidates();
    const paths = candidates.map((c) => c.path).sort();
    expect(paths).toEqual(['repo-a', 'repo-b']);
  });

  it('候補は path・label・lastModified を持つ', async () => {
    const core = new RepoCore(root);
    const candidates = await core.listCandidates();
    const a = candidates.find((c) => c.path === 'repo-a');
    expect(a).toMatchObject({ path: 'repo-a', label: 'repo-a' });
    expect(a?.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
