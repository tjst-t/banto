/**
 * shell モジュールの core を直接叩く試験。モデルも API も使わない
 * ——自由に、何度でも走らせられる。
 */

import { describe, expect, it } from 'vitest';

import { ShellCore } from './core.js';

describe('ShellCore', () => {
  it('許可された実行ファイルを、標準出力ごと成功で返す', async () => {
    const core = new ShellCore(['node']);
    const result = await core.run('node', ['-e', "process.stdout.write('ok')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('0でない終了コードを、例外にせず値として返す', async () => {
    const core = new ShellCore(['node']);
    const result = await core.run('node', ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('stderr は成功時も隠さずに返す', async () => {
    const core = new ShellCore(['node']);
    const result = await core.run('node', ['-e', "process.stderr.write('warn'); process.exit(0)"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('warn');
  });

  it('timeoutMs を超えたら強制終了し、理由付きで断る', async () => {
    const core = new ShellCore(['node']);
    await expect(core.run('node', ['-e', 'setTimeout(() => {}, 5000)'], 200)).rejects.toThrow(/タイムアウト/);
  });

  it('許可リストに無い実行ファイルは、理由付きで断る', async () => {
    const core = new ShellCore(['node']);
    await expect(core.run('bash', ['-c', 'echo hi'])).rejects.toThrow(/許可されていない実行ファイル: bash/);
  });
});
