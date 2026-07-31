/**
 * 外部コマンドを呼ぶ口（ADR-0010 決定36b・task-0039）。
 *
 * repo-manager は `ghq` / `gwq` / `git` の**前面**であって、自分では何も覚えない（D3）。
 * その全部がここを通る。差し替え可能にしてあるのは、受け入れテストが Kobo も Banto も
 * 起こさずに動くため（task-0039 a6）——`ghq` が入っていない機械でも中身を検証できる。
 *
 * D6: node:child_process のみ。**シェルを介さない**（`execFile` 相当。引数は配列で渡す）。
 *     `git` を呼ぶ既存コードと同じ扱いにしてある。
 * I2: 「コマンドが無い」と「コマンドが失敗した」を分ける。前者は未導入なので静かに
 *     何も返さない（決定36b）、後者は握りつぶさず呼び出し側へ渡す。
 */

import { execFile } from "node:child_process";

export interface CommandResult {
  /** 終了コード 0 なら true。 */
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * コマンド自体が見つからなかった（未導入）。
   *
   * `ok: false` と分けているのが要点。未導入は決定36b で「場所を1つも返さない」と
   * 決めた**正常な状態**だが、コマンドがあるのに失敗したのは異常であり、
   * 黙って空を返すと壊れていることに気づけない。
   */
  notFound: boolean;
}

/** コマンドを1つ実行する関数。テストではこれを差し替える。 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string }
) => Promise<CommandResult>;

/** 実際に外部コマンドを起こす既定の実装。 */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, maxBuffer: 8 * 1024 * 1024, encoding: "utf-8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ ok: false, stdout: "", stderr: String(error.message), notFound: true });
          return;
        }
        resolve({ ok: !error, stdout, stderr, notFound: false });
      }
    );
  });

/**
 * 実行して標準出力を返す。未導入なら `undefined`、失敗なら例外（I2）。
 *
 * 呼び出し側は `undefined` を「この道具は無い」として扱えばよく、
 * 壊れているのか無いのかを判別するためのコードを書かなくて済む。
 */
export async function output(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  options?: { cwd?: string }
): Promise<string | undefined> {
  const result = await run(command, args, options);
  if (result.notFound) return undefined;
  if (!result.ok) {
    throw new Error(
      `${command} ${args.join(" ")} が失敗しました: ${result.stderr.trim() || "(出力なし)"}`
    );
  }
  return result.stdout;
}
