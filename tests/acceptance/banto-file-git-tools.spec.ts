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
    assert.deepEqual(fileTools.map((t) => t.name), ["file.list", "file.read", "file.stat"]);
  });

  it("[task-0011/a1] 書き込み系のToolは存在しない（閲覧専用・決定24）", () => {
    for (const t of fileTools) {
      assert.doesNotMatch(t.name, /write|delete|remove|move|create/);
    }
  });

  it("[task-0011/a1] file.list がディレクトリを一覧する", async () => {
    const out = textOf(await tool(fileTools, "file.list").execute("c1", {}, undefined, undefined, TOOL_CTX));
    assert.match(out, /src\//);
    assert.match(out, /README\.md/);
  });

  it("[task-0011/a1] 既定で node_modules や .git を隠す", async () => {
    const out = textOf(await tool(fileTools, "file.list").execute("c1", {}, undefined, undefined, TOOL_CTX));
    assert.doesNotMatch(out, /node_modules/);
    assert.doesNotMatch(out, /\.git\b/);
  });

  it("[task-0011/a1] includeHidden で隠さない", async () => {
    const out = textOf(
      await tool(fileTools, "file.list").execute("c1", { includeHidden: true }, undefined, undefined, TOOL_CTX)
    );
    assert.match(out, /node_modules/);
  });

  it("[task-0011/a1] file.read がファイル内容を返す", async () => {
    const out = textOf(
      await tool(fileTools, "file.read").execute("c1", { path: "README.md" }, undefined, undefined, TOOL_CTX)
    );
    assert.match(out, /# テスト/);
    assert.match(out, /本文/);
  });

  it("[task-0011/a1] maxLines で打ち切られ、省略したことが分かる", async () => {
    fs.writeFileSync(path.join(repo, "long.txt"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    const out = textOf(
      await tool(fileTools, "file.read").execute(
        "c1",
        { path: "long.txt", maxLines: 5 },
        undefined,
        undefined,
        TOOL_CTX
      )
    );
    assert.match(out, /line 4/);
    assert.doesNotMatch(out, /line 40/);
    assert.match(out, /省略/, "打ち切ったことを黙って隠さない");
  });

  it("[task-0011/a4] 不在・種別違いはエラーになる（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.read").execute("c1", { path: "nope.txt" }, undefined, undefined, TOOL_CTX),
      /No such file/
    );
    await assert.rejects(
      () => tool(fileTools, "file.read").execute("c1", { path: "src" }, undefined, undefined, TOOL_CTX),
      /is a directory/
    );
    await assert.rejects(
      () => tool(fileTools, "file.list").execute("c1", { path: "README.md" }, undefined, undefined, TOOL_CTX),
      /Not a directory/
    );
  });

  it("[task-0011/a1] バイナリは中身を出さず、その旨を返す", async () => {
    fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const out = textOf(
      await tool(fileTools, "file.read").execute("c1", { path: "bin.dat" }, undefined, undefined, TOOL_CTX)
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
        tool(fileTools, "file.read").execute(
          "c1",
          { path: "../../etc/passwd" },
          undefined,
          undefined,
          TOOL_CTX
        ),
      /outside the workspace/
    );
  });
});

describe("[task-0011/a2] git.* （すべて閲覧専用）", () => {
  it("[task-0011/a2] 5つのToolが名前空間規則に従う", () => {
    assert.deepEqual(gitTools.map((t) => t.name), [
      "git.status",
      "git.diff",
      "git.log",
      "git.branches",
      "git.blame",
    ]);
  });

  it("[task-0011/a2] 変更操作のToolは存在しない（決定24）", () => {
    for (const t of gitTools) {
      assert.doesNotMatch(t.name, /commit|stage|add|push|checkout|merge|reset|rebase/);
    }
  });

  it("[task-0011/a2] git.status が未コミットの変更を返す", async () => {
    const out = textOf(await tool(gitTools, "git.status").execute("c1", {}, undefined, undefined, TOOL_CTX));
    assert.match(out, /main/);
    assert.match(out, /src\/a\.ts/);
  });

  it("[task-0011/a2] git.diff が作業ツリーの差分を返す", async () => {
    const out = textOf(await tool(gitTools, "git.diff").execute("c1", {}, undefined, undefined, TOOL_CTX));
    assert.match(out, /-export const a = 2;/);
    assert.match(out, /\+export const a = 3;/);
  });

  it("[task-0011/a2] git.diff は stat で要約だけ返せる", async () => {
    const out = textOf(
      await tool(gitTools, "git.diff").execute("c1", { stat: true }, undefined, undefined, TOOL_CTX)
    );
    assert.match(out, /src\/a\.ts/);
    assert.doesNotMatch(out, /\+export const a = 3;/, "本文は含めない");
  });

  it("[task-0011/a2] git.log が履歴を新しい順に返す", async () => {
    const out = textOf(await tool(gitTools, "git.log").execute("c1", {}, undefined, undefined, TOOL_CTX));
    const lines = out.split("\n");
    assert.match(lines[0]!, /change a to 2/);
    assert.match(lines[1]!, /initial/);
  });

  it("[task-0011/a2] git.log は件数とパスで絞れる", async () => {
    const out = textOf(
      await tool(gitTools, "git.log").execute("c1", { limit: 1 }, undefined, undefined, TOOL_CTX)
    );
    assert.equal(out.split("\n").length, 1);

    const scoped = textOf(
      await tool(gitTools, "git.log").execute("c1", { path: "README.md" }, undefined, undefined, TOOL_CTX)
    );
    assert.match(scoped, /initial/);
    assert.doesNotMatch(scoped, /change a to 2/);
  });

  it("[task-0011/a2] git.branches が現在のブランチに印を付けて返す", async () => {
    const out = textOf(await tool(gitTools, "git.branches").execute("c1", {}, undefined, undefined, TOOL_CTX));
    assert.match(out, /^\* main/m);
  });

  it("[task-0011/a2] git.blame が各行の由来を返す", async () => {
    const out = textOf(
      await tool(gitTools, "git.blame").execute("c1", { path: "README.md" }, undefined, undefined, TOOL_CTX)
    );
    assert.match(out, /banto-test/);
    assert.match(out, /# テスト/);
  });

  it("[task-0011/a4] git の失敗は握りつぶさずエラーになる（I2）", async () => {
    await assert.rejects(
      () =>
        tool(gitTools, "git.diff").execute(
          "c1",
          { ref: "no-such-ref-xyz" },
          undefined,
          undefined,
          TOOL_CTX
        ),
      /git diff .* failed/
    );
    await assert.rejects(
      () =>
        tool(gitTools, "git.blame").execute(
          "c1",
          { path: "no-such-file.txt" },
          undefined,
          undefined,
          TOOL_CTX
        ),
      /failed/
    );
  });

  it("[task-0011/a4] gitリポジトリでない場所ではエラーになる（空扱いにしない）", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "banto-notrepo-"));
    const tools = createGitTools(notRepo);
    await assert.rejects(
      () => tool(tools, "git.status").execute("c1", {}, undefined, undefined, TOOL_CTX),
      /failed/
    );
    fs.rmSync(notRepo, { recursive: true, force: true });
  });
});

describe("[task-0016] file.stat（パスがファイルかディレクトリかを知る）", () => {
  it("[task-0016] ディレクトリを判別する", async () => {
    const out = await tool(fileTools, "file.stat").execute(
      "c1", { path: "src" }, undefined, undefined, TOOL_CTX
    );
    assert.deepEqual(out.details, { path: "src", type: "dir", size: (out.details as { size: number }).size });
    assert.match(textOf(out), /dir/);
  });

  it("[task-0016] ファイルを判別し、サイズを返す", async () => {
    const out = await tool(fileTools, "file.stat").execute(
      "c1", { path: "README.md" }, undefined, undefined, TOOL_CTX
    );
    const details = out.details as { path: string; type: string; size: number };
    assert.equal(details.type, "file");
    assert.equal(details.path, "README.md");
    assert.ok(details.size > 0);
  });

  it("[task-0016] 不在はエラー（I2）", async () => {
    await assert.rejects(
      () => tool(fileTools, "file.stat").execute("c1", { path: "nope" }, undefined, undefined, TOOL_CTX),
      /No such path/
    );
  });

  it("[task-0016] ワークスペース外は拒否される", async () => {
    await assert.rejects(
      () =>
        tool(fileTools, "file.stat").execute(
          "c1", { path: "../../etc/passwd" }, undefined, undefined, TOOL_CTX
        ),
      /outside the workspace/
    );
  });
});
