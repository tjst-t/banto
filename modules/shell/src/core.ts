/**
 * shell モジュールの core。**ドメインロジックはここに1つだけ**（要件 C8a）。
 *
 * シェル文字列を組み立てて `exec` することはしない——`execFile` に
 * コマンドと引数を配列で渡し、シェル展開・注入の経路そのものを無くす。
 * 許可した実行ファイル以外は、理由を値にして断る（教訓13）。
 */

import { execFile } from 'node:child_process';

export interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 許可した実行ファイルだけを、タイムアウト付きで走らせる。
 *
 * AI が触れる範囲は、明示的に許した範囲に限られる（要件 D4）。
 * `allowedExecutables` に無いものは、そもそも起動しない。
 */
export class ShellCore {
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedExecutables: readonly string[]) {
    this.allowed = new Set(allowedExecutables);
  }

  async run(command: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ShellResult> {
    if (!this.allowed.has(command)) {
      throw new Error(
        `許可されていない実行ファイル: ${command}（許可リスト: ${[...this.allowed].join(', ') || '(空)'}）`,
      );
    }

    return new Promise<ShellResult>((resolve, reject) => {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr });
            return;
          }
          const errno = error as NodeJS.ErrnoException & { killed?: boolean };
          if (errno.killed === true) {
            // タイムアウトで強制終了した。黙って空を返さず、理由を投げる（教訓13）。
            reject(new Error(`タイムアウト: ${timeoutMs}ms 以内に終わらなかった（${command}）`));
            return;
          }
          if (typeof errno.code === 'number') {
            // 0 でない終了コードは失敗ではなく結果。投げずに値として返す
            // ——「非ゼロ終了＝例外」にすると、呼び手が exit code を見られなくなる。
            resolve({ exitCode: errno.code, stdout, stderr });
            return;
          }
          // 起動そのものに失敗した（実行ファイルが無い等）。理由を値にして投げる。
          reject(new Error(`実行できなかった: ${command}（${errno.message}）`));
        },
      );
    });
  }
}
