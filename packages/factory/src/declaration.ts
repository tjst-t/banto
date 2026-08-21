/**
 * **リポジトリが banto に宣言すること**（仕様 §6）。
 *
 * 仕様の表はこう分けている——リポジトリ側には
 * 「どういう環境が要るか」と「**テストの走らせ方**」、banto 側には
 * 「どの provider を使うか・並行数・人を待つか」。
 * **プロジェクトについて恒久的に真なことだけが、リポジトリに書ける**（要件 R7）。
 *
 * ## どこから読むか——**取り込み先のブランチから**
 *
 * 作業ツリーから読むと、そこで働いているエージェントが**自分のテストの
 * 走らせ方を書き換えられる**。`test` を `true` にすれば、何を壊しても緑になる。
 * これは決定16 の安全上の②（承認していないスクリプトを走らせない）と
 * まったく同じ形の穴なので、同じ考えで塞ぐ——**読むのは取り込み先の側**。
 *
 * 宣言を変えるには、その変更が先に取り込まれていなければならない。
 * つまり**人の確認を通った宣言だけが効く**。
 *
 * ## 無いときは走らせない
 *
 * 宣言が無ければテストの走らせ方は分からない。**既定のコマンドを当てない**
 * ——`npm test` を当てると、テストの無いリポジトリで「0件が通った」になる。
 * 分からないなら止まって人に上げる（規則2）。
 */

import type { TestCommand } from './ports.js';

/** リポジトリの宣言の置き場。**探し回らない**——1箇所だけ見る。 */
export const DECLARATION_PATH = '.banto/repo.json';

/** いま読む項目。**増やすときは仕様 §6 の表に足してから。** */
export interface RepoDeclaration {
  readonly test: TestCommand;
}

/**
 * 宣言を読む。**壊れていたら止まる**（規則2）。
 *
 * `raw` が `null`（ファイルが無い）は呼び手が扱う——「宣言していない」は
 * 壊れているのとは別のことである。
 */
export function parseDeclaration(raw: string, where = DECLARATION_PATH): RepoDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${where}: JSON として読めない — ${String(cause)}`);
  }

  const test = (parsed as { test?: unknown }).test;
  if (test === undefined) {
    throw new Error(`${where}: test が無い（例: {"test": {"command": "npm", "args": ["test"]}}）`);
  }

  const { command, args } = test as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error(`${where}: test.command が文字列でない`);
  }
  // **args は省ける。** 省いたのと空なのは同じ意味なので、ここで1つに寄せる。
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    throw new Error(`${where}: test.args が文字列の配列でない`);
  }

  return { test: { command, args: (args as string[] | undefined) ?? [] } };
}
