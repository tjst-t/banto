/**
 * repo モジュールの core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * Phase 2 で worktree を足した（要件 C5）。鍵の割り当て（Phase 3）はまだ置かない。
 *
 * **worktree の持ち主はここである**（決定5）。Factory は git を知らず、ここに頼む
 * ——ワークフローエンジンに git の知識を持たせると、両方に git が散る。
 *
 * Factory の再開判定は**現物を見る**（仕様 §5.3・規則3）ので、
 * 「済んだか」を答える問い（`hasWorktree` / `isMerged` / `headOf`）を口にする。
 * フラグを持たないので、フラグと現実がずれない。
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveInside } from '@banto/module-kit';

/** スレッド作成の候補地（決定32）。**役割`workspace-suggestions`の1実装として返す形。** */
export interface WorkspaceCandidate {
  /** root からの相対パス。`ThreadCreated.workspaceRoot` と同じ形（決定29）。 */
  readonly path: string;
  readonly label: string;
  readonly lastModified: string;
}

export interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `root` の内側で git を操作する。
 *
 * pathspec に渡す文字列は、`@banto/module-kit` の `resolveInside`（正規化してから
 * 比較、fs/env-process/env-dockerと共通）で root の内側に閉じ込める——
 * 「範囲の外を指した」という失敗を、git の曖昧なエラーメッセージに任せない（要件 D4）。
 */
export class RepoCore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolveInside(relative: string): string {
    return resolveInside(this.root, relative);
  }

  private async git(args: readonly string[]): Promise<GitOutput> {
    return this.gitIn(this.root, args);
  }

  /** 作業ツリーの中で走らせる。**rebase はブランチが出ている側でしかできない。** */
  private async gitIn(cwd: string, args: readonly string[]): Promise<GitOutput> {
    return new Promise((resolve, reject) => {
      execFile('git', [...args], { cwd }, (error, stdout, stderr) => {
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
  /**
   * 作業ツリーを1つ用意する。**何度呼んでも同じ状態に着く**（要件 B5）。
   *
   * ブランチも作業ツリーも既に在れば、作り直さずそのまま返す——耐久ワークフローは
   * 落ちて再開したときに同じ段をもう一度呼ぶので、ここが冪等でないと再開できない。
   */
  async addWorktree(branch: string, relative: string, from = 'HEAD'): Promise<string> {
    const target = this.resolveInside(relative);
    if (await this.hasWorktree(relative)) return target;

    const exists = await this.hasBranch(branch);
    // ブランチが在るなら作らない。`-b` を付けて呼ぶと「既に在る」で失敗する。
    const args = exists
      ? ['worktree', 'add', target, branch]
      : ['worktree', 'add', '-b', branch, target, from];
    await this.git(args);
    return target;
  }

  /** その作業ツリーが在るか。**保存した印ではなく git に聞く**（規則3）。 */
  async hasWorktree(relative: string): Promise<boolean> {
    const target = this.resolveInside(relative);
    const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
    return stdout.split('\n').some((line) => line === `worktree ${target}`);
  }

  async hasBranch(branch: string): Promise<boolean> {
    const { stdout } = await this.git(['branch', '--list', '--format=%(refname:short)']);
    return stdout.split('\n').some((line) => line.trim() === branch);
  }

  /** 作業ツリーを畳む。**在らなければ何もしない**——再開で二度呼ばれても同じ。 */
  async removeWorktree(relative: string): Promise<string> {
    const target = this.resolveInside(relative);
    if (!(await this.hasWorktree(relative))) return `${target} は無い`;
    await this.git(['worktree', 'remove', '--force', target]);
    return `${target} を畳んだ`;
  }

  /** その ref の指す commit。**テスト結果の鍵になる**（仕様 §5.3）。 */
  async headOf(ref: string): Promise<string> {
    const { stdout } = await this.git(['rev-parse', ref]);
    return stdout.trim();
  }

  /**
   * その ref に在るファイルの中身。**作業ツリーではなく、その ref のもの。**
   *
   * リポジトリの宣言（仕様 §6）を**取り込み先のブランチから**読むために要る。
   * 作業ツリーから読むと、そこで働いているエージェントが自分のテストの
   * 走らせ方を書き換えられる——`env-script` の承認と同じ穴になる（決定16 の②）。
   *
   * **無いことは失敗ではない。** 宣言していないリポジトリは普通に在るので、
   * 呼び手が区別できる形（`null`）で返す。読めたのに壊れている、は呼び手の判断。
   */
  async showFile(ref: string, relative: string): Promise<string | null> {
    return this.git(['show', `${ref}:${relative}`]).then(
      ({ stdout }) => stdout,
      () => null,
    );
  }

  /**
   * `branch` が `into` に取り込まれているか。
   *
   * **これが merge 段の「済んだか」の判定である**（仕様 §5.3）。
   * `--is-ancestor` は含まれていれば 0、いなければ 1 を返す——後者は失敗ではないので、
   * git の終了コードをそのまま例外にしてしまわないよう、ここだけ自前で見る。
   */
  async isMerged(branch: string, into = 'main'): Promise<boolean> {
    return this.git(['merge-base', '--is-ancestor', branch, into]).then(
      () => true,
      () => false,
    );
  }

  /**
   * `branch` を `into` へ取り込む。**衝突したら止まる**（規則2）。
   *
   * 黙って `-X ours` などで解決しない——どちらを採るかは、機構が決めてよいことではない。
   * 失敗したら merge を中断して、作業ツリーを元の状態へ戻す。
   */
  async merge(branch: string, into = 'main'): Promise<string> {
    if (await this.isMerged(branch, into)) return `${branch} は既に ${into} に入っている`;
    const before = await this.headOf(into);
    await this.git(['checkout', into]);
    try {
      await this.git(['merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
    } catch (cause) {
      // 中途半端な状態を残さない。戻せなければ、それも理由に含めて投げる。
      await this.git(['merge', '--abort']).catch(() => undefined);
      await this.git(['reset', '--hard', before]).catch(() => undefined);
      throw cause;
    }
    return this.headOf(into);
  }

  /**
   * 作業ツリーの中で、ブランチを `onto` の先端に載せ直す（要件 B7）。
   *
   * **衝突したら中断して止まる**（規則2）。載せ直すと commit の sha が変わるので、
   * その sha に鍵を付けていたテスト結果は**自動的に無効になる**——
   * 明示的に消す必要が無い（仕様 §5.3）。
   */
  async rebaseOnto(relative: string, onto = 'main'): Promise<string> {
    const target = this.resolveInside(relative);
    try {
      await this.gitIn(target, ['rebase', onto]);
    } catch (cause) {
      await this.gitIn(target, ['rebase', '--abort']).catch(() => undefined);
      throw cause;
    }
    const { stdout } = await this.gitIn(target, ['rev-parse', 'HEAD']);
    return stdout.trim();
  }

  /** そのブランチが `base` より先に進んでいるか。**implement 段の「済んだか」。** */
  async isAhead(branch: string, base = 'main'): Promise<boolean> {
    const { stdout } = await this.git(['rev-list', '--count', `${base}..${branch}`]);
    return Number(stdout.trim()) > 0;
  }

  async push(remote: string, branch: string): Promise<string> {
    const { stdout } = await this.git(['push', remote, branch]);
    return stdout;
  }

  /**
   * root の直下で、`.git` を持つディレクトリを候補として返す（決定32）。
   *
   * **1階層だけ見る**——`workspaceRoot`（決定29）が広いrootからの相対パス1段で
   * 表される形と揃える。新しい順（`lastModified` 降順）に並べる。
   */
  async listCandidates(): Promise<WorkspaceCandidate[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const candidates: WorkspaceCandidate[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(this.root, entry.name);
      const hasGit = await stat(path.join(dirPath, '.git')).then(
        () => true,
        () => false,
      );
      if (!hasGit) continue;
      const info = await stat(dirPath);
      candidates.push({ path: entry.name, label: entry.name, lastModified: info.mtime.toISOString() });
    }
    return candidates.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  }
}
