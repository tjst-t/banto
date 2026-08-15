/**
 * リポジトリの**共通 git ディレクトリ**（`git rev-parse --git-common-dir`）を求める。
 *
 * **何のために要るか。** 検証環境（docker）はワークツリーを `..:/app` で見せるだけなので、
 * **リンクされたワークツリーでは器の中で git が動かない**。ワークツリーの `.git` は
 * ディレクトリではなく**ファイル**で、中身は
 *
 *   gitdir: /home/…/banto/.git/worktrees/<名前>
 *
 * ——**ホストの絶対パス**を指している。その先は器に見えていないので、`git ls-files` は
 * `fatal: not a git repository` で exit 128 になる。git を呼ぶテストは全部これで落ちる
 * （しかも「git が動いていない」ではなく「テストが失敗した」という顔をして落ちる）。
 *
 * 直し方は**同じ絶対パスに共通 git ディレクトリを見せる**こと。そうすれば `gitdir:` の
 * 行はそのまま辿れる。ここはその「どこを見せればよいか」を決めるだけの純関数で、
 * 見せる仕掛け（compose の volume）はドライバと compose ファイルの側にある。
 *
 * **`git` を起こさずファイルだけで解く。** `git rev-parse --git-common-dir` を打つ手も
 * あるが、(a) 単体で試せる形にしたい (b) プールのホストに git が入っている前提を足したくない
 * ——形式は `gitfile`（git 本体の `setup.c`）で決まっていて、読むだけで足りる。
 *
 * I2 / 「推測で mount しない」: 読めない・形が違う・指す先が無いときは `undefined` を返す。
 * 当てずっぽうの場所を器に見せるより、git が使えないまま落ちるほうがまだ追える。
 *
 * D6: node:fs / node:path のみ。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `base` のリポジトリの共通 git ディレクトリ（絶対パス）。
 *
 * - `.git` が**ディレクトリ**（普通のリポジトリ）→ その `.git` 自身
 * - `.git` が**ファイル**（リンクされたワークツリー）→ 本体の `.git`
 *   （`gitdir:` の先の `commondir` を辿る。無ければ `…/worktrees/<名前>` を落とす）
 * - `.git` が無い／読めない／形が違う → `undefined`
 */
export function resolveGitCommonDir(base: string | undefined): string | undefined {
  if (!base) return undefined;
  const dotGit = path.join(path.resolve(base), ".git");

  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined; // git 管理下ではない
  }
  // 普通のリポジトリ。共通 git ディレクトリは `.git` そのもの
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return undefined;

  let text: string;
  try {
    text = fs.readFileSync(dotGit, "utf-8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return undefined;

  // 相対で書かれることもある（`git worktree add --relative-paths`）。基点は `.git` の在る場所
  const gitDir = path.resolve(path.dirname(dotGit), match[1]!);
  if (!fs.existsSync(gitDir)) return undefined;

  // `commondir` が真。中身は `../..` のような相対パスであることが多い
  const commondirFile = path.join(gitDir, "commondir");
  if (fs.existsSync(commondirFile)) {
    try {
      const rel = fs.readFileSync(commondirFile, "utf-8").trim();
      if (rel.length > 0) {
        const common = path.resolve(gitDir, rel);
        if (fs.existsSync(common)) return common;
      }
    } catch {
      // 読めなければ下の綴りへ落ちる（**黙って諦めない**）
    }
  }

  // `commondir` が無い／読めないときの落ち先。`<本体>/.git/worktrees/<名前>` から
  // `<本体>/.git` を取り出す
  const marker = `${path.sep}worktrees${path.sep}`;
  const idx = gitDir.indexOf(marker);
  const fallback = idx >= 0 ? gitDir.slice(0, idx) : gitDir;
  return fs.existsSync(fallback) ? fallback : undefined;
}
