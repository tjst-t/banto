/**
 * task-0011: 基本GUIセットのデータ側Tool（ファイル・Git閲覧）。
 * ADR-0010 決定18・決定24。
 *
 * Kobo にも Worker Pool にも接続せず、テスト用に作った実物の git リポジトリだけで
 * 検証する（受け入れ条件 a3）。git はモックしない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createFileTools, createGitTools, resolveInWorkspace } from "@banto/host";

/** ToolDefinition.execute の第5引数は本Tool群が参照しないためスタブ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由 (I4)
const TOOL_CTX = {} as any;

function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  return result.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

let repo: string;
let fileTools: ReturnType<typeof createFileTools>;
let gitTools: ReturnType<typeof createGitTools>;

/** name で引く（配列の並びに依存しない）。 */
function tool(tools: ReturnType<typeof createFileTools>, name: string) {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `${name} must exist`);
  return found!;
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "banto-fg-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });

  git("init", "-b", "main");
  git("config", "user.email", "test@banto-test.local");
  git("config", "user.name", "banto-test");

  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# テスト\n\n本文\n");
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules", "junk.js"), "//\n");
  git("add", "-A");
  git("commit", "-m", "initial");

  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
  git("add", "-A");
  git("commit", "-m", "change a to 2");

  // 未コミットの変更を1つ残す（git.status / git.diff の検証用）
  fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 3;\n");

  fileTools = createFileTools(repo);
  gitTools = createGitTools(repo);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("[task-0011/a1] file.* （閲覧専用）", () => {
  it("[task-0011/a1] file.* が名前空間規則に従う", () => {
    assert.deepEqual(fileTools.map((t) => t.name), [
      "file.list",
      "file.read",
      "file.stat",
      "file.find",
      "file.grep",
    ]);
  });

  it("[task-0011/a1] 書き込み系のToolは存在しない（閲覧専用・決定24）", () => {
    for (const t of fileTools) {
      assert.doesNotMatch(t.name, /write|delete|remove|move|create/);
    }
  });

  it("[task-0011/a1] file.list がディレクトリを一覧する", async () => {
    const out = textOf(await tool(fileTools, "file.list").execute({}));
    assert.match(out, /src\//);
    assert.match(out, /README\.md/);
  });

  it("[task-0011/a1] 既定で node_modules や .git を隠す", async () => {
    const out = textOf(await tool(fileTools, "file.list").execute({}));
    assert.doesNotMatch(out, /node_modules/);
    assert.doesNotMatch(out, /\.git\b/);
  });

  it("[task-0011/a1] includeHidden で隠さない", async () => {
    const out = textOf(
      await tool(fileTools, "file.list").execute({ includeHidden: true })
    );
    assert.match(out, /node_modules/);
  });

  it("[task-0011/a1] file.read がファイル内容を返す", async () => {
    const out = textOf(
      await tool(fileTools, "file.read").execute({ path: "README.md" })
    );
    assert.match(out, /# テスト/);
    assert.match(out, /本文/);
  });

  it("[task-0011/a1] maxLines で打ち切られ、省略したことが分かる", async () => {
    fs.writeFileSync(path.join(repo, "long.txt"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    const out = textOf(
      await tool(fileTools, "file.read").execute({ path: "long.txt", maxLines: 5 })
    );
    assert.match(out, /line 4/);
    assert.doesNotMatch(out, /line 40/);
    assert.match(out, /省略/, "打ち切ったことを黙って隠さない");
  });

  it("[task-0011/a1] offset で続きから読める", async () => {
    fs.writeFileSync(
      path.join(repo, "long.txt"),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    );
    const first = await tool(fileTools, "file.read").execute({ path: "long.txt", maxLines: 5 }, TOOL_CTX);
    const d1 = first.details as { from: number; to: number; totalLines: number };
    assert.deepEqual([d1.from, d1.to, d1.totalLines], [1, 5, 50]);
    assert.match(textOf(first), /offset: 6/, "続きの読み方を示す");

    const next = await tool(fileTools, "file.read").execute(
      { path: "long.txt", offset: 6, maxLines: 5 },
      TOOL_CTX
    );
    const out = textOf(next);
    assert.match(out, /line 5\b/, "6行目から始まる");
    assert.doesNotMatch(out, /line 4\b/, "前の分は繰り返さない");
    assert.equal((next.details as { from: number }).from, 6);
  });

  it("[task-0011/a1] 総行数はファイル全体から数える（サイズ上限で切っても過少に言わない）", async () => {
    // サイズ上限（200,000 bytes）を超える大きさにする
    const line = "x".repeat(400);
    fs.writeFileSync(
      path.join(repo, "huge.txt"),
      Array.from({ length: 800 }, (_, i) => `L${i + 1} ${line}`).join("\n")
    );
    const r = await tool(fileTools, "file.read").execute(
      { path: "huge.txt", maxLines: 100_000 },
      TOOL_CTX
    );
    const d = r.details as { totalLines: number; to: number };
    assert.equal(d.totalLines, 800, "切った後の残りから数えない");
    assert.ok(d.to < 800, "1回では返しきらない");
    assert.match(textOf(r), /bytes まで/, "サイズで切ったことを黙って隠さない（I2）");

    // 続きを辿れば末尾まで届く
    let at = d.to + 1;
    let reachedLast = false;
    for (let i = 0; i < 20 && at <= 800; i++) {
      const more = await tool(fileTools, "file.read").execute(
        { path: "huge.txt", offset: at, maxLines: 100_000 },
        TOOL_CTX
      );
      const md = more.details as { to: number; content: string };
      if (md.content.includes("L800 ")) reachedLast = true;
      at = md.to + 1;
    }
    assert.ok(reachedLast, "offset を進めれば最終行まで読める");
  });

  it("[task-0011/a1] 1行がサイズ上限より大きいときは途中で切り、進めないことを言う（I2）", async () => {
    // 多バイト文字で埋める。境界で切ると壊れた字が出るので、そこも一緒に見る
    fs.writeFileSync(path.join(repo, "oneline.txt"), `${"あ".repeat(120_000)}\nlast\n`);
    const r = await tool(fileTools, "file.read").execute({ path: "oneline.txt" }, TOOL_CTX);
    const d = r.details as { to: number; partialLine: boolean; content: string };
    assert.equal(d.partialLine, true);
    assert.equal(d.to, 1);
    assert.doesNotMatch(d.content, /�/, "文字の途中で切らない");

    const out = textOf(r);
    assert.match(out, /この行の残りは/, "進めないことを言う");
    assert.match(out, /offset: 2/, "次の行へは進める");
  });

  it("[task-0011/a4] 範囲外の offset は黙って空を返さない（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.read").execute({ path: "README.md", offset: 999 }, TOOL_CTX),
      /past the end/
    );
  });

  it("[task-0011/a4] 不在・種別違いはエラーになる（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.read").execute({ path: "nope.txt" }),
      /No such file/
    );
    await assert.rejects(
      () => tool(fileTools, "file.read").execute({ path: "src" }),
      /is a directory/
    );
    await assert.rejects(
      () => tool(fileTools, "file.list").execute({ path: "README.md" }),
      /Not a directory/
    );
  });

  it("[task-0011/a1] バイナリは中身を出さず、その旨を返す", async () => {
    fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const out = textOf(
      await tool(fileTools, "file.read").execute({ path: "bin.dat" })
    );
    assert.match(out, /バイナリ/);
  });
});

describe("[task-0011] ワークスペース外は読ませない", () => {
  it("[task-0011] .. でルート外へ出るパスは拒否される", () => {
    assert.throws(() => resolveInWorkspace(repo, "../../etc/passwd"), /outside the workspace/);
    assert.throws(() => resolveInWorkspace(repo, "/etc/passwd"), /outside the workspace/);
  });

  it("[task-0011] シンボリックリンク経由でも外へ出られない", () => {
    const link = path.join(repo, "escape");
    fs.symlinkSync(os.tmpdir(), link);
    assert.throws(() => resolveInWorkspace(repo, "escape/somewhere"), /outside the workspace/);
    fs.rmSync(link);
  });

  it("[task-0011] ルート内は通る", () => {
    assert.equal(
      resolveInWorkspace(repo, "src/a.ts"),
      path.join(fs.realpathSync(repo), "src", "a.ts")
    );
  });

  it("[task-0011/a4] file.read がワークスペース外を拒否する", async () => {
    await assert.rejects(
      () =>
        tool(fileTools, "file.read").execute({ path: "../../etc/passwd" }),
      /outside the workspace/
    );
  });
});

describe("[task-0011/a2] git.* （すべて閲覧専用）", () => {
  it("[task-0011/a2] git.* が名前空間規則に従う", () => {
    assert.deepEqual(gitTools.map((t) => t.name), [
      "git.status",
      "git.diff",
      "git.log",
      "git.branches",
      "git.blame",
      "git.show",
    ]);
  });

  it("[task-0011/a2] 変更操作のToolは存在しない（決定24）", () => {
    for (const t of gitTools) {
      assert.doesNotMatch(t.name, /commit|stage|add|push|checkout|merge|reset|rebase/);
    }
  });

  it("[task-0011/a2] git.status が未コミットの変更を返す", async () => {
    const out = textOf(await tool(gitTools, "git.status").execute({}));
    assert.match(out, /main/);
    assert.match(out, /src\/a\.ts/);
  });

  it("[task-0011/a2] git.diff が作業ツリーの差分を返す", async () => {
    const out = textOf(await tool(gitTools, "git.diff").execute({}));
    assert.match(out, /-export const a = 2;/);
    assert.match(out, /\+export const a = 3;/);
  });

  it("[task-0011/a2] git.diff は stat で要約だけ返せる", async () => {
    const out = textOf(
      await tool(gitTools, "git.diff").execute({ stat: true })
    );
    assert.match(out, /src\/a\.ts/);
    assert.doesNotMatch(out, /\+export const a = 3;/, "本文は含めない");
  });

  it("[task-0011/a2] git.log が履歴を新しい順に返す", async () => {
    const out = textOf(await tool(gitTools, "git.log").execute({}));
    const lines = out.split("\n");
    assert.match(lines[0]!, /change a to 2/);
    assert.match(lines[1]!, /initial/);
  });

  it("[task-0011/a2] git.log は件数とパスで絞れる", async () => {
    const out = textOf(
      await tool(gitTools, "git.log").execute({ limit: 1 })
    );
    assert.equal(out.split("\n").length, 1);

    const scoped = textOf(
      await tool(gitTools, "git.log").execute({ path: "README.md" })
    );
    assert.match(scoped, /initial/);
    assert.doesNotMatch(scoped, /change a to 2/);
  });

  it("[task-0011/a2] git.branches が現在のブランチに印を付けて返す", async () => {
    const out = textOf(await tool(gitTools, "git.branches").execute({}));
    assert.match(out, /^\* main/m);
  });

  it("[task-0011/a2] git.blame が各行の由来を返す", async () => {
    const out = textOf(
      await tool(gitTools, "git.blame").execute({ path: "README.md" })
    );
    assert.match(out, /banto-test/);
    assert.match(out, /# テスト/);
  });

  it("[task-0011/a4] git の失敗は握りつぶさずエラーになる（I2）", async () => {
    await assert.rejects(
      () =>
        tool(gitTools, "git.diff").execute({ ref: "no-such-ref-xyz" }),
      /git diff .* failed/
    );
    await assert.rejects(
      () =>
        tool(gitTools, "git.blame").execute({ path: "no-such-file.txt" }),
      /failed/
    );
  });

  it("[task-0011/a4] gitリポジトリでない場所ではエラーになる（空扱いにしない）", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "banto-notrepo-"));
    const tools = createGitTools(notRepo);
    await assert.rejects(
      () => tool(tools, "git.status").execute({}),
      /failed/
    );
    fs.rmSync(notRepo, { recursive: true, force: true });
  });
});

describe("[task-0016] file.stat（パスがファイルかディレクトリかを知る）", () => {
  it("[task-0016] ディレクトリを判別する", async () => {
    const out = await tool(fileTools, "file.stat").execute({ path: "src" });
    assert.deepEqual(out.details, { path: "src", type: "dir", size: (out.details as { size: number }).size });
    assert.match(textOf(out), /dir/);
  });

  it("[task-0016] ファイルを判別し、サイズを返す", async () => {
    const out = await tool(fileTools, "file.stat").execute({ path: "README.md" });
    const details = out.details as { path: string; type: string; size: number };
    assert.equal(details.type, "file");
    assert.equal(details.path, "README.md");
    assert.ok(details.size > 0);
  });

  it("[task-0016] 不在はエラー（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.stat").execute({ path: "nope" }),
      /No such path/
    );
  });

  it("[task-0016] ワークスペース外は拒否される", async () => {
    await assert.rejects(
      () =>
        tool(fileTools, "file.stat").execute({ path: "../../etc/passwd" }),
      /outside the workspace/
    );
  });
});

describe("[task-0019] git.show（1コミットが入れた変更）", () => {
  it("[task-0019] メタ情報・変更ファイル一覧・差分を返す", async () => {
    const out = await tool(gitTools, "git.show").execute({ ref: "HEAD" });
    const d = out.details as {
      short: string; subject: string; author: string;
      files: Array<{ status: string; path: string }>; diff: string;
    };

    assert.equal(d.subject, "change a to 2");
    assert.equal(d.author, "banto-test");
    assert.deepEqual(d.files, [{ status: "M", path: "src/a.ts" }]);
    assert.match(d.diff, /-export const a = 1;/);
    assert.match(d.diff, /\+export const a = 2;/);
  });

  it("[task-0019] 最初のコミットでも動く（--root）", async () => {
    const out = await tool(gitTools, "git.show").execute({ ref: "HEAD~1" });
    const d = out.details as { subject: string; files: Array<{ path: string }> };

    assert.equal(d.subject, "initial");
    assert.ok(d.files.length > 0, "初回コミットでも変更ファイルが取れる");
    assert.ok(d.files.some((f) => f.path === "README.md"));
  });

  it("[task-0019] path で差分を1ファイルに絞れる", async () => {
    const all = await tool(gitTools, "git.show").execute({ ref: "HEAD~1" });
    const one = await tool(gitTools, "git.show").execute({ ref: "HEAD~1", path: "README.md" });

    const allDiff = (all.details as { diff: string }).diff;
    const oneDiff = (one.details as { diff: string }).diff;
    assert.match(allDiff, /src\/a\.ts/);
    assert.doesNotMatch(oneDiff, /src\/a\.ts/, "絞ったファイルの差分だけ");
    assert.match(oneDiff, /README\.md/);
  });

  it("[task-0019] 存在しないコミットはエラー（I2）", async () => {
    await assert.rejects(
      () => tool(gitTools, "git.show").execute({ ref: "no-such-ref" }),
      /failed/
    );
  });
});

describe("[task-0020] file.find（名前でファイルを探す）", () => {
  it("[task-0020] glob でファイル名に一致するものを返す", async () => {
    const out = await tool(fileTools, "file.find").execute({ pattern: "*.ts" });
    const d = out.details as { matches: Array<{ path: string }> };
    assert.deepEqual(d.matches.map((m) => m.path), ["src/a.ts"]);
  });

  it("[task-0020] / を含むパターンはパス全体に照合する", async () => {
    const out = await tool(fileTools, "file.find").execute({ pattern: "src/*.ts" });
    assert.equal((out.details as { matches: unknown[] }).matches.length, 1);

    const none = await tool(fileTools, "file.find").execute({ pattern: "other/*.ts" });
    assert.equal((none.details as { matches: unknown[] }).matches.length, 0);
  });

  it("[task-0020] 既定で node_modules を探さない、includeHidden で探す", async () => {
    const hidden = await tool(fileTools, "file.find").execute({ pattern: "junk.js" });
    assert.equal((hidden.details as { matches: unknown[] }).matches.length, 0);

    const shown = await tool(fileTools, "file.find").execute({ pattern: "junk.js", includeHidden: true });
    assert.equal((shown.details as { matches: unknown[] }).matches.length, 1);
  });

  it("[task-0020] limit で打ち切り、打ち切ったことを明示する", async () => {
    const out = await tool(fileTools, "file.find").execute({ pattern: "*", limit: 1 });
    const d = out.details as { matches: unknown[]; truncated: boolean };
    assert.equal(d.matches.length, 1);
    assert.equal(d.truncated, true);
    assert.match(textOf(out), /打ち切り/);
  });

  it("[task-0020] 一致なしはその旨を返す（エラーにしない）", async () => {
    const out = await tool(fileTools, "file.find").execute({ pattern: "*.nonexistent" });
    assert.equal((out.details as { matches: unknown[] }).matches.length, 0);
    assert.match(textOf(out), /一致するファイルなし/);
  });

  it("[task-0020] ワークスペース外の起点は拒否される", async () => {
    await assert.rejects(
      () =>
        tool(fileTools, "file.find").execute({ pattern: "*", path: "../.." }),
      /outside the workspace/
    );
  });
});

describe("[task-0020] file.grep（中身を検索する）", () => {
  it("[task-0020] 一致行を行番号つきで返す", async () => {
    const out = await tool(fileTools, "file.grep").execute({ pattern: "export const a" });
    const d = out.details as { hits: Array<{ path: string; line: number; text: string }> };

    assert.equal(d.hits.length, 1);
    assert.equal(d.hits[0]!.path, "src/a.ts");
    assert.equal(d.hits[0]!.line, 1);
    assert.match(textOf(out), /src\/a\.ts:1:/);
  });

  it("[task-0020] glob で対象ファイルを絞れる", async () => {
    const md = await tool(fileTools, "file.grep").execute({ pattern: "テスト", glob: "*.md" });
    assert.equal((md.details as { hits: unknown[] }).hits.length, 1);

    const ts = await tool(fileTools, "file.grep").execute({ pattern: "テスト", glob: "*.ts" });
    assert.equal((ts.details as { hits: unknown[] }).hits.length, 0);
  });

  it("[task-0020] ignoreCase が効く", async () => {
    const exact = await tool(fileTools, "file.grep").execute({ pattern: "EXPORT" });
    assert.equal((exact.details as { hits: unknown[] }).hits.length, 0);

    const loose = await tool(fileTools, "file.grep").execute({ pattern: "EXPORT", ignoreCase: true });
    assert.ok((loose.details as { hits: unknown[] }).hits.length > 0);
  });

  it("[task-0020] 正規表現として扱われる", async () => {
    const out = await tool(fileTools, "file.grep").execute({ pattern: "const (a|b) =" });
    assert.ok((out.details as { hits: unknown[] }).hits.length > 0);
  });

  it("[task-0020] 壊れた正規表現は黙って0件にせずエラー（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.grep").execute({ pattern: "[bad(" }),
      /Invalid regular expression/
    );
  });

  it("[task-0020] バイナリは検索対象にしない", async () => {
    fs.writeFileSync(path.join(repo, "bin2.dat"), Buffer.from([0x00, 0x41, 0x42, 0x00]));
    const out = await tool(fileTools, "file.grep").execute({ pattern: "AB", includeHidden: true });
    const d = out.details as { hits: Array<{ path: string }> };
    assert.equal(d.hits.some((h) => h.path === "bin2.dat"), false);
  });

  it("[task-0020] limit で打ち切り、打ち切ったことを明示する", async () => {
    const out = await tool(fileTools, "file.grep").execute({ pattern: ".", limit: 2 });
    const d = out.details as { hits: unknown[]; truncated: boolean };
    assert.equal(d.hits.length, 2);
    assert.equal(d.truncated, true);
    assert.match(textOf(out), /打ち切り/);
  });
});
