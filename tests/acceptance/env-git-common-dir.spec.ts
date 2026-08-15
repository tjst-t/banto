/**
 * **共通 git ディレクトリの求め方**（`git-common-dir.ts`・2026-08-15）。
 *
 * 検証環境（docker）はワークツリーを `..:/app` で見せるだけなので、リンクされた
 * ワークツリーでは器の中で git が動かない——`.git` が `gitdir: <ホストの絶対パス>` と
 * 書かれたファイルで、その先が器に無いため。**同じ絶対パスに共通 git ディレクトリを
 * 見せれば解ける**ので、「どこを見せればよいか」をここで決めている。
 *
 * 間違えると出方が悪い（git が動かないことが「テストが落ちた」に化ける）ので、
 * 形の3通り——ディレクトリ／ファイル／無い——を一通り確かめる。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveGitCommonDir } from "../../packages/banto-environment-pool/src/git-common-dir.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "banto-gitcommon-"));
}

describe("共通 git ディレクトリの求め方", () => {
  it("`.git` がディレクトリなら、それ自身を返す（普通のリポジトリ）", () => {
    const root = tmpdir();
    fs.mkdirSync(path.join(root, ".git"));
    assert.equal(resolveGitCommonDir(root), path.join(root, ".git"));
  });

  it("`.git` がファイルなら、`commondir` を辿って本体の `.git` を返す（ワークツリー）", () => {
    const root = tmpdir();
    const main = path.join(root, "main");
    const wt = path.join(root, "wt");
    const wtGitDir = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(wt);
    // git が実際に書く形（`commondir` は相対）
    fs.writeFileSync(path.join(wtGitDir, "commondir"), "../..\n");
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.equal(resolveGitCommonDir(wt), path.join(main, ".git"));
  });

  it("`commondir` が無くても、`worktrees/<名前>` を落として本体の `.git` を返す", () => {
    const root = tmpdir();
    const main = path.join(root, "main");
    const wt = path.join(root, "wt");
    const wtGitDir = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${wtGitDir}\n`);

    assert.equal(resolveGitCommonDir(wt), path.join(main, ".git"));
  });

  it("`.git` が無ければ undefined（**推測で mount しない**）", () => {
    assert.equal(resolveGitCommonDir(tmpdir()), undefined);
  });

  it("`.git` ファイルの中身が読めない形なら undefined", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, ".git"), "これは gitfile ではない\n");
    assert.equal(resolveGitCommonDir(root), undefined);
  });

  it("`gitdir:` の指す先が無ければ undefined（**存在しない場所を器に見せない**）", () => {
    const root = tmpdir();
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${path.join(root, "居ない", ".git")}\n`);
    assert.equal(resolveGitCommonDir(root), undefined);
  });

  it("基点が渡されなければ undefined", () => {
    assert.equal(resolveGitCommonDir(undefined), undefined);
  });

  it("この repo 自身で、`git rev-parse --git-common-dir` と同じ答えになる", async () => {
    // **本物と突き合わせる**。上のはこちらが書いた形なので、git が実際に書く形と
    // ずれていても気づけない（このテストは main のチェックアウトでも worktree でも回る）
    const { execFileSync } = await import("node:child_process");
    const repoRoot = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../.."
    );
    const expected = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    assert.equal(resolveGitCommonDir(repoRoot), path.resolve(expected));
  });
});
