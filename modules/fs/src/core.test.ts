import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileSystemCore } from './core.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'banto-fs-core-'));
  await mkdir(path.join(root, 'repo-a'), { recursive: true });
  await mkdir(path.join(root, 'repo-b'), { recursive: true });
  await writeFile(path.join(root, 'repo-a', 'a.txt'), 'A', 'utf8');
  await writeFile(path.join(root, 'repo-b', 'b.txt'), 'B', 'utf8');
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(root, { recursive: true, force: true });
});

// 決定29：読み取りは広く、書き込みは狭く。
describe('FileSystemCore の書き込み境界', () => {
  it('writeRoot が無ければ、root のどこにでも書ける（今までどおり）', async () => {
    const core = new FileSystemCore(root);
    await core.write('repo-b/new.txt', 'x');
    expect(await readFile(path.join(root, 'repo-b', 'new.txt'), 'utf8')).toBe('x');
  });

  it('writeRoot があれば、その内側は書ける', async () => {
    const core = new FileSystemCore(root, 'repo-a');
    await core.write('repo-a/new.txt', 'x');
    expect(await readFile(path.join(root, 'repo-a', 'new.txt'), 'utf8')).toBe('x');
  });

  it('writeRoot があると、root の内側でも別のリポジトリへは書けない', async () => {
    const core = new FileSystemCore(root, 'repo-a');
    await expect(core.write('repo-b/hacked.txt', 'x')).rejects.toThrow(/書ける範囲の外/);
  });

  it('読み取りは writeRoot に関係なく root 全体を見られる', async () => {
    const core = new FileSystemCore(root, 'repo-a');
    expect(await core.read('repo-b/b.txt')).toBe('B');
  });

  it('一覧も writeRoot に関係なく root 全体を見られる', async () => {
    const core = new FileSystemCore(root, 'repo-a');
    const entries = await core.list('repo-b');
    expect(entries.map((e) => e.name)).toContain('b.txt');
  });

  it('writeRoot 自体が root の外を指していたら、構築時に断る', () => {
    expect(() => new FileSystemCore(root, '../outside')).toThrow(/許された範囲の外/);
  });
});
