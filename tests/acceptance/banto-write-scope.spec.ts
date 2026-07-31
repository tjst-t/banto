/**
 * task-0041: 番頭の書き込み（場所ごとに PO が許した範囲だけ）。ADR-0010 決定38。
 *
 * 決定15 は「番頭が work/epics・work/tasks を起票する」と定めているのに、番頭は
 * memory.save 以外に書き込み手段を持っていなかった（P3）。`file.write` でそれを塞ぐ。
 *
 * ここで見たいのは**書けることより書けないこと**——既定が読み取り専用であること、
 * 許可を `**` まで広げても `.git/`（決定37 の抜け道）とホストのデータ置き場
 * （決定38b の自己昇格）には届かないこと。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  PlaceRegistry,
  createFileWriteTools,
  createStaticPlaceProvider,
  type NamespacedToolDefinition,
} from "@banto/host";

let dir: string;
let repo: string;
let hostData: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-write-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git", "refs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "existing.md"), "old\n");
  fs.writeFileSync(path.join(repo, "README.md"), "readme\n");

  // ホスト自身のデータ置き場が、たまたま場所の中にある構成（.banto-demo 等）
  hostData = path.join(repo, "host-data");
  fs.mkdirSync(hostData, { recursive: true });
  fs.writeFileSync(path.join(hostData, "memory.jsonl"), "");
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 指定した書き込み範囲を持つ場所ひとつで `file.write` を組み立てる。 */
function writeTool(writable?: readonly string[]): NamespacedToolDefinition {
  const places = new PlaceRegistry([
    createStaticPlaceProvider([
      { id: "repo", label: "リポジトリ", path: repo, ...(writable ? { writable } : {}) },
    ]),
  ]);
  const tools = createFileWriteTools(places, { protectedPaths: [hostData] });
  return tools.find((t) => t.name === "file.write")!;
}

describe("file.write は既定で書けない（決定38a）", () => {
  it("書き込み範囲を許していない場所は読み取り専用", async () => {
    await assert.rejects(
      () => writeTool().execute({ path: "docs/new.md", content: "x" }),
      /読み取り専用/
    );
    assert.equal(fs.existsSync(path.join(repo, "docs", "new.md")), false);
  });

  it("許した範囲の外は書けない。何が許されているかも返す", async () => {
    await assert.rejects(
      () => writeTool(["docs/**"]).execute({ path: "README.md", content: "x" }),
      /範囲の外.*docs\/\*\*/s
    );
    assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf-8"), "readme\n");
  });

  it("場所の外へ出るパスは書けない（.. でもリンクでも）", async () => {
    await assert.rejects(
      () => writeTool(["**"]).execute({ path: "../escaped.md", content: "x" }),
      /outside the place/
    );
    assert.equal(fs.existsSync(path.join(dir, "escaped.md")), false);
  });
});

describe("どんな設定でも書けない範囲（決定38d）", () => {
  it(".git/ は ** を許しても書けない（決定37 の抜け道を塞ぐ）", async () => {
    await assert.rejects(
      () => writeTool(["**"]).execute({ path: ".git/refs/heads/main", content: "x" }),
      /書き込み禁止/
    );
    assert.equal(fs.existsSync(path.join(repo, ".git", "refs", "heads")), false);
  });

  it("ホスト自身のデータ置き場は ** を許しても書けない（自己昇格を塞ぐ）", async () => {
    // 名前は .banto ではない。BANTO_DATA_DIR は差し替えられるので、名前決め打ちでは守れない
    await assert.rejects(
      () => writeTool(["**"]).execute({ path: "host-data/memory.jsonl", content: "x" }),
      /データ置き場/
    );
    assert.equal(fs.readFileSync(path.join(hostData, "memory.jsonl"), "utf-8"), "");
  });
});

describe("許された範囲には書ける", () => {
  it("新規作成では途中のディレクトリも作られる", async () => {
    const result = await writeTool(["work/**"]).execute({
      path: "work/tasks/task-0999-x.md",
      content: "# 起票\n",
    });
    assert.equal(
      fs.readFileSync(path.join(repo, "work", "tasks", "task-0999-x.md"), "utf-8"),
      "# 起票\n"
    );
    const details = result.details as { created: boolean; place: { id: string } };
    assert.equal(details.created, true);
    // どの場所へ書いたかを常に添える（決定36d）
    assert.equal(details.place.id, "repo");
  });

  it("既存ファイルは全文が置き換わり、上書きだと分かる", async () => {
    const result = await writeTool(["docs/**"]).execute({
      path: "docs/existing.md",
      content: "new\n",
    });
    assert.equal(fs.readFileSync(path.join(repo, "docs", "existing.md"), "utf-8"), "new\n");
    assert.equal((result.details as { created: boolean }).created, false);
    assert.match(result.content[0]!.text!, /上書き/);
  });

  it("ディレクトリは上書きできない", async () => {
    await assert.rejects(
      () => writeTool(["**"]).execute({ path: "docs", content: "x" }),
      /ディレクトリ/
    );
    assert.ok(fs.statSync(path.join(repo, "docs")).isDirectory());
  });
});

describe("場所の選択（決定36e）", () => {
  it("複数あるのに place を省略したら、黙って片方に書かず聞き返す", async () => {
    const other = path.join(dir, "other");
    fs.mkdirSync(other, { recursive: true });
    const places = new PlaceRegistry([
      createStaticPlaceProvider([
        { id: "repo", path: repo, writable: ["**"] },
        { id: "other", path: other, writable: ["**"] },
      ]),
    ]);
    const write = createFileWriteTools(places).find((t) => t.name === "file.write")!;

    await assert.rejects(
      () => write.execute({ path: "a.md", content: "x" }),
      /Multiple places/
    );
    assert.equal(fs.existsSync(path.join(repo, "a.md")), false);
    assert.equal(fs.existsSync(path.join(other, "a.md")), false);

    // 明示すればその場所に書ける
    await write.execute({ path: "a.md", content: "x", place: "other" });
    assert.equal(fs.existsSync(path.join(other, "a.md")), true);
    assert.equal(fs.existsSync(path.join(repo, "a.md")), false);
  });
});
