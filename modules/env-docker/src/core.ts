/**
 * `docker` 環境の core。**2つ目の実装**（決定16 の実装順）。
 *
 * `env-process` の注記にこう書いてある——
 *
 * > **1つ目の実装では口の正しさは分からない。2つ目を足したときに分かる。**
 *
 * これがその2つ目である。**口は1文字も変えずに満たせた**（`create` / `status` /
 * `exec` / `address` / `destroy` の5本）。つまり口は「ディレクトリでコマンドを走らせる」
 * に寄っていなかった、ということがここで実測された。
 *
 * ## 状態を持たない（規則3）
 *
 * **handle はコンテナの名前**で、名前は**作業ディレクトリから決まる**。
 * だから覚えておくものが何も無い——banto が落ちても、同じ作業ディレクトリを
 * 渡せば同じコンテナに着く（要件 B5）。`docker ps` が真実の置き場である。
 *
 * ## `address` がここで初めて仕事をする
 *
 * `env-process` の `address` は `127.0.0.1:port` を返すだけで何もしなかった。
 * ここでは**コンテナの IP を引く**——同じ口が、実装によって別のことをする。
 * 公開モジュールは「docker か VM か」を知らずに、返ってきた文字列だけを使う。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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

/** コンテナの中で作業ツリーが見える場所。**1箇所で決める**（規則3）。 */
export const MOUNT_PATH = '/workspace';

/**
 * 既定のネットワーク名（決定29）。
 *
 * `--network none` は試して捨てた——ホストからコンテナへ届かなくなり、
 * `address`（プレビュー用の到達性）が壊れる（実測。コンテナに IP が付かない）。
 * 代わりに **`--internal` なブリッジ**を使う：実測で確かめたところ、
 * ホスト↔コンテナは届く（`address` が生きる）が、コンテナ→外部インターネットは
 * 塞がる（`docker network create --internal` の効果）。既定でこのネットワークを
 * 使うときだけ、無ければここが作る（運用者が別名を指定したときは作らない
 * ——その名前の用意は運用者の責任）。
 */
export const DEFAULT_NETWORK = 'banto-internal';

/**
 * 作業ディレクトリから決まるコンテナ名。**覚えないための鍵**（規則3）。
 *
 * パスをそのまま名前にできない（docker の名前は `[a-zA-Z0-9][a-zA-Z0-9_.-]*`）ので、
 * **読める部分＋指紋**にする。指紋だけにすると `docker ps` を人が見たときに
 * どれがどれだか分からない——観測は人が読めないと意味が無い（規則4 の精神）。
 */
export function containerNameFor(absoluteWorkdir: string): string {
  const digest = createHash('sha256').update(absoluteWorkdir).digest('hex').slice(0, 10);
  const readable = path.basename(absoluteWorkdir).replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `banto-${readable}-${digest}`;
}

export class DockerEnvironmentCore {
  private readonly root: string;

  constructor(
    root: string,
    /**
     * 走らせる image。**既定値を持たない。**
     *
     * 既定を当てると、リポジトリが要る道具の入っていない箱でテストが走り、
     * 「環境が違うから落ちた」と「実装が壊れているから落ちた」が混ざる（教訓13）。
     */
    private readonly image: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * docker の `--network`。**既定は `DEFAULT_NETWORK`（`--internal` なブリッジ）**
     * （決定29）。
     *
     * ここは人が見ていない状態で走る（Factory）。コンテナはファイルシステムこそ
     * worktree に閉じるが、ネットワークも既定では外部インターネットに出られない
     * ——持ち出しや内部ネットワークへの到達を、既定で塞ぐ。ホストからコンテナへの
     * 到達（`address`、プレビュー用）は保つ。実際に外部通信が要るRunだけ、
     * 運用者が明示的に緩める（`BANTO_DOCKER_NETWORK`）。
     */
    private readonly network: string = DEFAULT_NETWORK,
  ) {
    this.root = path.resolve(root);
    if (image.trim() === '') throw new Error('image が空——何の箱で走らせるかは決めておく');
  }

  private inside(workdir: string): string {
    return resolveInside(this.root, workdir);
  }

  /** docker を1回叩く。**終了コードを結果として返す**——失敗にしない（教訓13）。 */
  private docker(args: readonly string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'docker',
        [...args],
        { timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // `error.code` が数値なら「docker は動いたが、中身が非ゼロ」。
          // それは結果であって失敗ではない。docker 自体が起動できない場合だけ投げる。
          const code = (error as { code?: unknown } | null)?.code;
          if (error !== null && typeof code !== 'number') {
            reject(new Error(`docker ${args.join(' ')} を走らせられない: ${error.message}`));
            return;
          }
          resolve({ exitCode: typeof code === 'number' ? code : 0, stdout, stderr });
        },
      );
      child.on('error', reject);
    });
  }

  /** 失敗を握りつぶさない版（規則2）。**在るはずのものが無いなら止まる。** */
  private async dockerOrThrow(args: readonly string[]): Promise<string> {
    const r = await this.docker(args);
    if (r.exitCode !== 0) {
      throw new Error(`docker ${args.join(' ')} が失敗した: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout.trim();
  }

  /**
   * 既定のネットワークだけ、無ければ作る。
   *
   * 運用者が別名を渡したときは何もしない——その名前を用意する責任は運用者側
   * （`BANTO_DOCKER_IMAGE` と同じ考え方。決定29）。**何度呼んでも安全**
   * （`docker network inspect` で在ることを確かめてから作る）。
   */
  private async ensureNetwork(): Promise<void> {
    if (this.network !== DEFAULT_NETWORK) return;
    const r = await this.docker(['network', 'inspect', DEFAULT_NETWORK]);
    if (r.exitCode === 0) return;
    await this.dockerOrThrow(['network', 'create', '--internal', DEFAULT_NETWORK]);
  }

  /**
   * 環境を1つ用意して handle（＝コンテナ名）を返す。
   *
   * **何度呼んでも同じ handle。** 名前が作業ディレクトリから決まるので、
   * 落ちて再開してもこの段をやり直せる（要件 B5）。
   *
   * **ディレクトリは作らない。** worktree の持ち主は Repo（決定5）。
   * 在ることを確かめて、bind mount するだけ。
   */
  async create(workdir: string): Promise<string> {
    const target = this.inside(workdir);
    const found = await stat(target).catch(() => null);
    if (!found?.isDirectory()) {
      throw new Error(`作業ディレクトリが無い: ${target}——先に用意する（worktree は Repo が作る）`);
    }

    const name = containerNameFor(target);
    const state = await this.stateOf(name);
    if (state === 'running') return name;
    // 止まっているだけなら起こす。**作り直さない**——中で入れたものが消える。
    if (state === 'stopped') {
      await this.dockerOrThrow(['start', name]);
      return name;
    }

    await this.ensureNetwork();

    await this.dockerOrThrow([
      'run',
      '--detach',
      '--name',
      name,
      '--workdir',
      MOUNT_PATH,
      // **既定で外部インターネットに出られない**（決定29）。
      '--network',
      this.network,
      // **作業ツリーだけを渡す。** ホストの他の場所は見えない。
      '--mount',
      `type=bind,source=${target},target=${MOUNT_PATH}`,
      // 何もしないと即座に終わる。**眠らせておく箱**にする。
      '--entrypoint',
      'sh',
      this.image,
      '-c',
      'while true; do sleep 3600; done',
    ]);
    return name;
  }

  /**
   * コンテナの生死。**保存した印ではなく `docker` に聞く**（規則3）。
   *
   * 3つ返すのは内部だけ。口には `ready` / `gone` の2つしか出さない
   * （`env-process` と同じ理由——中間状態は `start` / `stop` を呼び込む）。
   */
  private async stateOf(name: string): Promise<'running' | 'stopped' | 'none'> {
    const r = await this.docker(['inspect', '--format', '{{.State.Running}}', name]);
    if (r.exitCode !== 0) return 'none';
    return r.stdout.trim() === 'true' ? 'running' : 'stopped';
  }

  /** その handle がいま使えるか。**現物を見る。** */
  async status(handle: string): Promise<'ready' | 'gone'> {
    return (await this.stateOf(handle)) === 'running' ? 'ready' : 'gone';
  }

  /**
   * 環境の中でコマンドを走らせる。
   *
   * **シェルを通さない。** `docker exec` に配列でそのまま渡す——
   * 連結すると、そこが注入点になる（`env-process` と同じ）。
   */
  async exec(
    handle: string,
    command: string,
    args: readonly string[] = [],
  ): Promise<ExecResult> {
    if ((await this.status(handle)) !== 'ready') throw new Error(`環境が無い: ${handle}`);
    const r = await this.docker(['exec', '--workdir', MOUNT_PATH, handle, command, ...args]);
    return r;
  }

  /**
   * 中の port へ届く宛先（決定16 の到達性の規則）。
   *
   * **ここで初めてこの口が仕事をする。** `env-process` は同じホストなので
   * `127.0.0.1` を返すだけだったが、コンテナは自分の IP を持つ。
   * 呼び手（公開モジュール）はどちらなのかを知らない。
   */
  async address(handle: string, port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port が範囲外: ${String(port)}`);
    }
    const ip = await this.dockerOrThrow([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      handle,
    ]);
    if (ip === '') throw new Error(`コンテナに IP が無い: ${handle}`);
    return `${ip}:${port}`;
  }

  /**
   * 環境を畳む。**コンテナは消す。作業ツリーは消さない。**
   *
   * コンテナはこの実装が作ったものなので、持ち主はここである。
   * 作業ツリーの持ち主は Repo（決定5）なので、bind mount を外すだけ。
   */
  async destroy(handle: string): Promise<string> {
    if ((await this.stateOf(handle)) === 'none') return `${handle} は既に無い`;
    await this.dockerOrThrow(['rm', '--force', handle]);
    return `${handle} を消した（作業ツリーは残る——持ち主は repo モジュール）`;
  }
}
