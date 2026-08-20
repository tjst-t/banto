/**
 * repo モジュールの core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * Phase 1 のスコープは「閲覧とコミット」だけ（要件 C5）——worktree（Phase 2）も
 * 鍵の割り当て（Phase 3）もここには置かない。
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `root` の内側で git を操作する。
 *
 * pathspec に渡す文字列は、fs モジュールと同じ判定（正規化してから比較）で
 * root の内側に閉じ込める——「範囲の外を指した」という失敗を、
 * git の曖昧なエラーメッセージに任せない（要件 D4）。
 */
export class RepoCore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** root の内側に閉じ込める。外へ出ようとしたら理由を付けて投げる。 */
  private resolveInside(relative: string): string {
    const target = path.resolve(this.root, relative);
    const rel = path.relative(this.root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`許された範囲の外: ${relative}（root=${this.root}）`);
    }
    return target;
  }

  private async git(args: readonly string[]): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd: this.root }, (error, stdout, stderr) => {
        if (error !== null) {
          // 握りつぶさない。stderr があればそれを、無ければ error のメッセージを理由にする（教訓13）。
          reject(new Error(`git ${args.join(' ')} が失敗した: ${stderr.trim() || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async log(maxCount = 20): Promise<string> {
    const { stdout } = await this.git([
      'log',
      `-n${maxCount}`,
      '--pretty=format:%H%x09%an%x09%ad%x09%s',
      '--date=iso-strict',
    ]);
    return stdout;
  }

  async status(): Promise<string> {
    const { stdout } = await this.git(['status', '--porcelain=v1', '--branch']);
    return stdout;
  }

  async diff(relative?: string): Promise<string> {
    const args = ['diff'];
    if (relative !== undefined) {
      this.resolveInside(relative); // root の外を指したらここで止まる
      args.push('--', relative);
    }
    const { stdout } = await this.git(args);
    return stdout;
  }

  async branches(): Promise<string> {
    const { stdout } = await this.git(['branch', '--list', '--all', '-v']);
    return stdout;
  }

  /** 明示的に渡したパスだけをステージしてコミットする。「全部」を既定にしない（要件 D4）。 */
  async commit(message: string, paths: readonly string[]): Promise<string> {
    if (message.trim().length === 0) throw new Error('コミットメッセージが空');
    if (paths.length === 0) throw new Error('コミット対象のパスが空——何もステージしない');
    for (const p of paths) this.resolveInside(p);
    await this.git(['add', '--', ...paths]);
    const { stdout } = await this.git(['commit', '-m', message]);
    return stdout;
  }

  /**
   * Phase 3 で Vault から ssh-agent の socket を受け取って使う想定
   * （ADR 決定5・要件 D5）。Phase 1 では optional 依存の vault が
   * 台帳に無いので、index.ts の push ツールが呼ぶ前に断る——ここへは届かない。
   */
  async push(remote: string, branch: string): Promise<string> {
    const { stdout } = await this.git(['push', remote, branch]);
    return stdout;
  }
}
