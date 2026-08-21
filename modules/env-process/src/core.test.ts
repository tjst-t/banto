import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { ProcessEnvironmentCore } from './core.js';

let root: string;
let core: ProcessEnvironmentCore;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'banto-env-'));
  await mkdir(path.join(root, 'work'), { recursive: true });
  core = new ProcessEnvironmentCore(root);
});

describe('ProcessEnvironmentCore', () => {
  it('在るディレクトリなら handle を返し、何度呼んでも同じ（要件 B5）', async () => {
    const first = await core.create('work');
    const second = await core.create('work');
    expect(first).toBe(second);
    expect(first).toBe(path.join(root, 'work'));
  });

  // 作りに行くと、worktree の持ち主が Repo と2人になる（決定5）。
  it('無いディレクトリを黙って作らない（規則2）', async () => {
    await expect(core.create('missing')).rejects.toThrow(/作業ディレクトリが無い/);
  });

  // `..` は文字列の見た目では防げない。正規化してから判定していることを確かめる。
  it('root の外は、どの動詞からも触れない', async () => {
    await expect(core.create('../escape')).rejects.toThrow(/許された範囲の外/);
    await expect(core.exec('../escape', 'true')).rejects.toThrow(/許された範囲の外/);
    expect(() => core.address('../escape', 8080)).toThrow(/許された範囲の外/);
  });

  it('環境の中で本物のコマンドが走る', async () => {
    const handle = await core.create('work');
    const result = await core.exec(handle, 'node', ['-e', "process.stdout.write('ok')"]);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok' });
  });

  // ここが要。テストが落ちたことと、テストを走らせられなかったことは別の事実。
  it('終了コードが非ゼロでも投げない——結果として返す（教訓13）', async () => {
    const handle = await core.create('work');
    const result = await core.exec(handle, 'node', ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('cwd は環境の中になる', async () => {
    await writeFile(path.join(root, 'work', 'marker.txt'), 'here', 'utf8');
    const handle = await core.create('work');
    const result = await core.exec(handle, 'node', [
      '-e',
      "process.stdout.write(require('fs').readFileSync('marker.txt','utf8'))",
    ]);
    expect(result.stdout).toBe('here');
  });

  it('待ちを超えたら殺して理由を返す。黙って空を返さない', async () => {
    const handle = await core.create('work');
    await expect(
      core.exec(handle, 'node', ['-e', 'setTimeout(() => {}, 5000)'], 200),
    ).rejects.toThrow(/タイムアウト/);
  });

  it('address は同じホストの宛先を返す（この実装は何もしない）', async () => {
    const handle = await core.create('work');
    expect(core.address(handle, 4173)).toBe('127.0.0.1:4173');
    expect(() => core.address(handle, 70000)).toThrow(/範囲外/);
  });

  // 消してよいものが無いから消さない。ここで消せると、Repo を通さずに worktree を消せる。
  it('destroy は何も消さない', async () => {
    const handle = await core.create('work');
    await core.destroy(handle);
    expect(await core.exists(handle)).toBe(true);
  });
});
