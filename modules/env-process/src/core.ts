/**
 * `process` 環境の core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * **これは「隔離しない」実装である。** コンテナも VM も使わず、banto と同じホストの
 * 同じ権限で、指定されたディレクトリの中でコマンドを走らせるだけ。
 *
 * それでも最初に作る理由は2つある（決定16 の実装順）：
 *
 * 1. **Factory が動き出すのに、隔離の強度は要らない。** 要るのは口が在ることだけ
 * 2. **1つ目の実装では口の正しさは分からない。2つ目を足したときに分かる。**
 *    だから1つ目は一番安いものにして、早く2つ目（docker）へ行く
 *
 * **状態を持たない。** handle は環境の根のパスそのもので、`create` は
 * 「在ることを確かめて返す」だけ。だから**プロセスが落ちても handle は生き続ける**
 * ——覚えておく必要が無いものを覚えない（規則3）。要件 B5 がそのまま効く。
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveInside } from '@banto/module-kit';

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `exec` の既定の待ち時間。超えたら殺して**理由を返す**——黙って空を返さない。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ProcessEnvironmentCore {
  private readonly root: string;

  /**
   * 環境として許す範囲の根。**既定値を持たない**（`requiredRoot` を通す）。
   *
   * 既定を `process.cwd()` にすると、そのとき居たディレクトリでコマンドが走る
   * ——repo モジュールで実際に事故が起きた形である（2026-08-20 の `git push`）。
   */
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private inside(workdir: string): string {
    return resolveInside(this.root, workdir);
  }

  /**
   * 環境を1つ用意して handle を返す。
   *
   * **ディレクトリを作らない。** worktree を所有するのは Repo であり（決定5）、
   * ここが作ると持ち主が2人になる。在ることを確かめるだけ。
   *
   * **何度呼んでも同じ handle を返す。** 耐久ワークフローが落ちて再開したとき、
   * この段をやり直しても同じ環境に着く必要がある（要件 B5）。
   */
  async create(workdir: string): Promise<string> {
    const target = this.inside(workdir);
    const found = await stat(target).catch(() => null);
    if (!found?.isDirectory()) {
      // 握りつぶして作りに行かない（規則2）。作るのは Repo の仕事である。
      throw new Error(`作業ディレクトリが無い: ${target}——先に用意する（worktree は Repo が作る）`);
    }
    return target;
  }

  /** その handle がいま使えるか。**保存した印ではなく現物を見る**（規則3）。 */
  async exists(handle: string): Promise<boolean> {
    const target = this.inside(handle);
    return (await stat(target).catch(() => null))?.isDirectory() === true;
  }

  /**
   * いま使えるかを、**口の外から聞けるようにする**（決定16。仕様 §8-3 の持ち越しの答え）。
   *
   * これを口に入れないと、Factory の再開判定（仕様 §5.3）が成り立たない。
   * `exec` で代用しようとすると「環境が無い」と「コマンドが落ちた」が混ざる
   * ——後者は結果、前者は失敗で、**混ぜてはいけない2つの事実**である（教訓13）。
   *
   * 値は2つだけにする。`stopped` のような中間状態は `start` / `stop` を
   * 呼び込むので、**要るようになってから3つ目を足す。**
   */
  async status(handle: string): Promise<'ready' | 'gone'> {
    return (await this.exists(handle)) ? 'ready' : 'gone';
  }

  /**
   * 環境の中でコマンドを走らせる。
   *
   * **シェルを通さない。** `shell: true` にすると引数の連結でクォートが壊れ、
   * そこが注入点になる。呼ぶ側に配列で渡させる。
   */
  async exec(
    handle: string,
    command: string,
    args: readonly string[] = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ExecResult> {
    const cwd = this.inside(handle);
    if (!(await this.exists(cwd))) throw new Error(`環境が無い: ${cwd}`);

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(command, [...args], { cwd, shell: false });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`タイムアウト（${timeoutMs}ms）: ${command}`));
      }, timeoutMs);

      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // **終了コードは失敗にしない。** テストが落ちたことと、テストを走らせられな
        // かったことは別の事実で、呼び手が区別できないといけない（教訓13）。
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }

  /**
   * 中の port へ届く宛先を返す（決定16 の到達性の規則）。
   *
   * この実装では**何もしない**——同じホストなので `127.0.0.1` でそのまま届く。
   * 何もしなくてよいことが、この口が正しく割れている証拠でもある：
   * 公開モジュールは「docker か VM か」を知らずに、この文字列だけを受け取る。
   */
  address(handle: string, port: number): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port が範囲外: ${String(port)}`);
    }
    this.inside(handle);
    return `127.0.0.1:${port}`;
  }

  /**
   * 環境を畳む。**この実装では何も消さない。**
   *
   * 消すものが無いからではなく、**消してよいものが無いから**である
   * ——worktree の持ち主は Repo（決定5）。ここで消すと、Factory が
   * Repo に頼まずに worktree を消せてしまう。
   */
  async destroy(handle: string): Promise<string> {
    const target = this.inside(handle);
    return `${target} は畳まない（作業ツリーの持ち主は repo モジュール）`;
  }
}
