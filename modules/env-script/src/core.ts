/**
 * `script` 環境の core。**リポジトリが自前の環境を提供する経路**（ADR-0001 決定16）。
 *
 * 4つの動詞を、リポジトリが置いたスクリプトへ委譲するだけ。先例は DevPod の
 * `exec:`、CNB buildpack の `bin/build`、CNI プラグイン、GitHub の
 * "Scripts to Rule Them All"（規則12：名前のついた形は自分で考えない）。
 *
 * **これは機能であると同時に、口の検査である。** シェルスクリプトで満たせない口は、
 * 大きすぎる口。**検査は実際に効いた**——4本のつもりで書き始めて、`status` が
 * 足りないことがここで露見した（`ScriptConfig.status` の注記）。
 *
 * ## 安全上、2つの門がある
 *
 * **① リポジトリの中身だけでは有効化されない。** 隔離を作るコードは、その隔離の
 * 中では走れない——`env-create` は banto ホストの権限で走る。だから
 * **`allowedRepos` は運用者が banto 側で書く**もので、リポジトリからは触れない。
 *
 * **② 承認していない内容は走らせない。** エージェントはそのリポジトリで作業するので、
 * スクリプトを書き換えれば自分を閉じ込めている箱の作り手を書き換えられる。
 * 承認の単位は**内容の指紋**で、1バイト変われば承認はやり直しになる。
 *
 * ## 境界を in-process にした理由（要件 C8b）
 *
 * **危ないコードは、すでに自分の子プロセスで走っている。** ここがやるのは spawn だけで、
 * スクリプトが落ちてもこのモジュールは落ちない。一方で承認台帳は banto の
 * イベントログを毎回畳んで得るものなので、プロセス境界を挟むと**写しを持つ**ことになり、
 * それが古くなる（規則3）。**古い承認で走るくらいなら、境界を1つ諦める。**
 */

import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { fingerprint, type ApprovalLedger } from '@banto/core';

/** リポジトリが置く設定。**banto 独自の項目を増やさない**——動詞だけ。 */
export interface ScriptConfig {
  readonly create: string;
  /**
   * いま使えるかを答える。**5本目である。**
   *
   * 4本で足りるつもりで書き始めたが、Factory の再開判定（仕様 §5.3）が
   * 外から聞けなかった。`exec` で代用すると「環境が無い」と「コマンドが落ちた」が
   * 混ざる。**口の検査がここで効いた**——足りないことは、書いてみるまで分からなかった。
   */
  readonly status: string;
  readonly exec: string;
  readonly address: string;
  readonly destroy: string;
}

export type Verb = keyof ScriptConfig;

export const VERBS: readonly Verb[] = ['create', 'status', 'exec', 'address', 'destroy'];

/**
 * リポジトリの宣言の置き場。**探し回らない**——1箇所だけ見る。
 *
 * **`environment.json` ではない。** 同じファイルにテストの走らせ方も入る
 * （仕様 §6 の表は、環境とテストの両方をリポジトリ側に置いている）ので、
 * 環境だけを指す名前にしない。読み手は `@banto/factory` の `DECLARATION_PATH` と同じ。
 */
export const CONFIG_PATH = '.banto/repo.json';

/**
 * 承認されていないスクリプトを走らせようとした。
 *
 * **指紋を値で持つ**（教訓13）。呼び手はこれを使って承認の判断を立てられる
 * ——文字列に埋めてしまうと、立てる側が正規表現で取り出すことになる。
 */
export class UnapprovedScriptError extends Error {
  constructor(
    readonly subject: string,
    readonly print: string,
  ) {
    super(
      `承認されていないスクリプト: ${subject}（指紋 ${print}）。` +
        `内容が変わると承認はやり直しになる——書き換えたなら、それが理由である`,
    );
    this.name = 'UnapprovedScriptError';
  }
}

export interface ScriptResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export class ScriptEnvironmentCore {
  private readonly allowed: readonly string[];

  constructor(
    allowedRepos: readonly string[],
    private readonly ledger: ApprovalLedger,
  ) {
    this.allowed = allowedRepos.map((r) => path.resolve(r));
  }

  /**
   * そのリポジトリが自前の環境を持ってよいかを確かめる（門①）。
   *
   * **「内側にあるか」ではなく「一致するか」で見る。** 根の内側を許すと、
   * 許した1つのリポジトリの下にもう1つ置くだけで通ってしまう。
   */
  private allowedRepo(repo: string): string {
    const target = path.resolve(repo);
    if (!this.allowed.includes(target)) {
      throw new Error(
        `このリポジトリは自前の環境を許可されていない: ${target}。` +
          `許可は banto 側の設定に書く——リポジトリの中身では有効にならない`,
      );
    }
    return target;
  }

  /** リポジトリの設定を読む。**足りない動詞があれば止まる**（規則2）。 */
  async config(repo: string): Promise<ScriptConfig> {
    const root = this.allowedRepo(repo);
    const file = path.join(root, CONFIG_PATH);

    let parsed: unknown;
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (raw === null) throw new Error(`設定が無い: ${file}`);
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error(`${file}: JSON として読めない — ${String(cause)}`);
    }

    const env = (parsed as { environment?: Record<string, unknown> }).environment;
    if (env?.['kind'] !== 'script') {
      throw new Error(`${file}: environment.kind が "script" でない`);
    }

    const missing = VERBS.filter((v) => typeof env[v] !== 'string' || env[v] === '');
    if (missing.length > 0) {
      // 欠けた動詞を黙って飛ばすと、その動詞だけが無言で何もしないことになる。
      throw new Error(`${file}: 動詞が足りない: ${missing.join(', ')}`);
    }

    return Object.fromEntries(VERBS.map((v) => [v, env[v] as string])) as unknown as ScriptConfig;
  }

  /** スクリプトの実体の場所。**リポジトリの外は指せない。** */
  private async scriptPath(repo: string, relative: string): Promise<string> {
    const root = this.allowedRepo(repo);
    const target = path.resolve(root, relative);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`スクリプトがリポジトリの外を指している: ${relative}`);
    }
    if (!(await stat(target).catch(() => null))?.isFile()) {
      throw new Error(`スクリプトが無い: ${target}`);
    }
    return target;
  }

  /**
   * いまの内容の指紋。**走らせる直前に取る。**
   *
   * 承認したときの内容と、走らせる内容が同じであることを確かめたいので、
   * 覚えておいた値ではなく、その場で読んで計算する（規則3）。
   */
  async fingerprintOf(repo: string, verb: Verb): Promise<{ subject: string; print: string }> {
    const config = await this.config(repo);
    const relative = config[verb];
    const target = await this.scriptPath(repo, relative);
    return {
      subject: `${path.resolve(repo)}:${relative}`,
      print: fingerprint(await readFile(target, 'utf8')),
    };
  }

  /**
   * 動詞を1つ走らせる（門②を通してから）。
   *
   * **`exec` だけは終了コードを失敗にしない。** 中で走らせたコマンドが落ちたことと、
   * スクリプトを走らせられなかったことは別の事実だからである（教訓13）。
   * 他の動詞では、非ゼロは失敗として投げる。
   *
   * **走らせられなかった場合は、そもそも `close` ではなく `error` が来る**ので、
   * この2つは作り物の約束なしに区別できる。
   */
  async run(
    repo: string,
    verb: Verb,
    args: readonly string[] = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ScriptResult> {
    const { subject, print } = await this.fingerprintOf(repo, verb);
    if (!this.ledger.isApproved(subject, print)) throw new UnapprovedScriptError(subject, print);

    const config = await this.config(repo);
    const target = await this.scriptPath(repo, config[verb]);
    const cwd = this.allowedRepo(repo);

    const result = await new Promise<ScriptResult>((resolve, reject) => {
      // shell を通さない。連結でクォートが壊れるところが注入点になる。
      const child = spawn(target, [...args], { cwd, shell: false });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`タイムアウト（${timeoutMs}ms）: ${verb}`));
      }, timeoutMs);

      child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(new Error(`スクリプトを起動できない: ${target} — ${cause.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });

    if (verb !== 'exec' && result.exitCode !== 0) {
      throw new Error(`${verb} が失敗した（exit=${result.exitCode}）: ${result.stderr.trim()}`);
    }
    return result;
  }

  /** 動詞はいずれも `run` への薄い委譲。**ここに条件分岐を足さない。** */
  async create(repo: string): Promise<string> {
    return (await this.run(repo, 'create')).stdout.trim();
  }

  /** `ready` / `gone` の2値だけ。**中間状態は `start` / `stop` を呼び込む。** */
  async status(repo: string, handle: string): Promise<'ready' | 'gone'> {
    const printed = (await this.run(repo, 'status', [handle])).stdout.trim();
    if (printed !== 'ready' && printed !== 'gone') {
      // 知らない値を勝手に ready に寄せない（規則2）。
      throw new Error(`status が ready でも gone でもない: ${printed}`);
    }
    return printed;
  }

  async exec(repo: string, handle: string, command: readonly string[]): Promise<ScriptResult> {
    return this.run(repo, 'exec', [handle, ...command]);
  }

  async address(repo: string, handle: string, port: number): Promise<string> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`port が範囲外: ${String(port)}`);
    }
    return (await this.run(repo, 'address', [handle, String(port)])).stdout.trim();
  }

  async destroy(repo: string, handle: string): Promise<string> {
    return (await this.run(repo, 'destroy', [handle])).stdout.trim();
  }
}
