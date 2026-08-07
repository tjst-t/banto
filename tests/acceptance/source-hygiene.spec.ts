/**
 * inc-0029: **ソースに生の NUL バイトを入れない。**
 *
 * grep 系の道具は NUL を見たファイルを「バイナリ」として丸ごと飛ばす（ripgrep は
 * `binary file matches` とだけ言い、grep / ugrep は `-I` で黙って飛ばす）。つまり
 * **そのファイルはリポジトリを grep しても存在しないファイルとして振る舞う**。
 *
 * 実際に2本入っていた：
 *
 * - `packages/banto-host/src/places.ts`（6個）——glob を正規表現へ写すときの目印。
 *   **場所の砦（決定36g）の実装**が入っている、探し当てられないと困る側のファイル
 * - `packages/banto-web/src/useTabOverflow.ts`（2個）——配列を1つの鍵に潰す区切り
 *
 * どちらも意図的なコードで、**振る舞いは正しい**。まずいのはエスケープ表記
 * （バックスラッシュ・x・ゼロ・ゼロ）ではなく NUL 文字そのものを書いたこと。
 * 書き換えても振る舞いは同じで、ファイルはテキストに戻る。
 *
 * task-0068 で `file.grep` を rg / grep へ委ねたとき、**3つの経路で結果が食い違って**
 * 見つかった。人が読んで気づける類ではないので、機械で見張る（P4）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** git が追いかけているファイル一覧（無視されているものは対象外）。 */
function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .toString("utf-8")
    .split("\0")
    .filter((p) => p.length > 0);
}

/** バイナリとして置いてよいもの（中身が NUL を含むのが当たり前の種類）。 */
const BINARY_SUFFIXES = [
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tar", ".wasm", ".node",
];

describe("[inc-0029] ソースに生の NUL バイトを入れない", () => {
  it("追跡しているテキストファイルに NUL が無い（あると grep から丸ごと消える）", () => {
    const offenders: string[] = [];
    for (const relative of trackedFiles()) {
      if (BINARY_SUFFIXES.some((s) => relative.toLowerCase().endsWith(s))) continue;
      const absolute = path.join(repoRoot, relative);
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(absolute);
      } catch {
        // 追跡されているが手元に無い（sparse checkout 等）。検査の対象にしない
        continue;
      }
      if (buffer.includes(0)) offenders.push(`${relative}（${buffer.filter((b) => b === 0).length} 個）`);
    }

    assert.deepEqual(
      offenders,
      [],
      "生の NUL を含むファイルがある。rg / grep / GitHub のコード検索から丸ごと消えるので、" +
        "エスケープ表記（バックスラッシュ・x・ゼロ・ゼロ）で書くこと（inc-0029）:\n" +
        offenders.join("\n")
    );
  });

  it("直した2本が、実際に grep から見えるようになっている", () => {
    // 元の壊れ方は「ファイルの中に NUL があると、その行が1行も出てこない」
    for (const [file, needle] of [
      ["packages/banto-host/src/places.ts", "DEEP"],
      ["packages/banto-web/src/useTabOverflow.ts", "useTabOverflow"],
    ] as const) {
      const buffer = fs.readFileSync(path.join(repoRoot, file));
      assert.equal(buffer.includes(0), false, `${file} に NUL が戻っている`);
      assert.match(buffer.toString("utf-8"), new RegExp(needle), `${file} の中身が読めない`);
    }
  });
});
