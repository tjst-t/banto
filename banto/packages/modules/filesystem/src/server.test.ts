import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFileSystemServer } from "./server.js";
import { listDirectoryOp, readFileOp, writeFileOp } from "./operations.js";

async function withClient(fn: (client: Client, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "banto-fs-test-"));
  try {
    const server = createFileSystemServer({ projectRoot: root });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    await fn(client, root);
    await client.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writeFile then readFile roundtrip", async () => {
  await withClient(async (client) => {
    await client.callTool({ name: "writeFile", arguments: { path: "a.txt", content: "hello" } });
    const result = await client.callTool({ name: "readFile", arguments: { path: "a.txt" } });
    assert.equal((result.content as { text: string }[])[0]?.text, "hello");
  });
});

test("editFile replaces text and returns before/after", async () => {
  await withClient(async (client) => {
    await client.callTool({ name: "writeFile", arguments: { path: "a.txt", content: "foo bar" } });
    const result = await client.callTool({
      name: "editFile",
      arguments: { path: "a.txt", edits: [{ oldText: "bar", newText: "baz" }] },
    });
    const { before, after } = JSON.parse((result.content as { text: string }[])[0]!.text);
    assert.equal(before, "foo bar");
    assert.equal(after, "foo baz");
  });
});

test("listDirectory, getFileInfo, deleteFile", async () => {
  await withClient(async (client, root) => {
    await client.callTool({ name: "createDirectory", arguments: { path: "sub" } });
    await client.callTool({ name: "writeFile", arguments: { path: "sub/b.txt", content: "x" } });

    const list = await client.callTool({ name: "listDirectory", arguments: { path: "." } });
    const entries = JSON.parse((list.content as { text: string }[])[0]!.text);
    assert.ok(entries.some((e: { name: string; type: string }) => e.name === "sub" && e.type === "directory"));

    const info = await client.callTool({ name: "getFileInfo", arguments: { path: "sub/b.txt" } });
    const parsed = JSON.parse((info.content as { text: string }[])[0]!.text);
    assert.equal(parsed.size, 1);
    assert.equal(parsed.type, "file");

    await client.callTool({ name: "deleteFile", arguments: { path: "sub/b.txt" } });
    const listAfter = await client.callTool({ name: "listDirectory", arguments: { path: "sub" } });
    assert.deepEqual(JSON.parse((listAfter.content as { text: string }[])[0]!.text), []);
  });
});

test("moveFile and searchFiles", async () => {
  await withClient(async (client) => {
    await client.callTool({ name: "writeFile", arguments: { path: "old.txt", content: "x" } });
    await client.callTool({ name: "moveFile", arguments: { from: "old.txt", to: "renamed.txt" } });
    const search = await client.callTool({ name: "searchFiles", arguments: { path: ".", pattern: "*.txt" } });
    const found = JSON.parse((search.content as { text: string }[])[0]!.text);
    assert.deepEqual(found, ["renamed.txt"]);
  });
});

test("readFile via the file:/// resource template", async () => {
  await withClient(async (client) => {
    await client.callTool({ name: "writeFile", arguments: { path: "readme.md", content: "# hi" } });
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.equal(resourceTemplates[0]?.uriTemplate, "file:///{path}");

    const read = await client.readResource({ uri: "file:///readme.md" });
    assert.equal((read.contents as { text: string }[])[0]?.text, "# hi");
  });
});

// ---- tool の引数は「Project の根からの相対」だけ（決定・2026-09-10）----------
//
// 強制境界は Landlock のままだが、その許可リストは**プロセスを起動するための都合**で
// 根より広い（`/etc`・`/proc`・node のバイナリ）。`readFile("/etc/passwd")` は
// OS には止められない——**tool の契約としては通してはいけない**。

test("根の外の絶対パスは受け取らない——/etc/passwd は tool の契約の外", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fs-scope-"));
  try {
    await assert.rejects(() => readFileOp(dir, "/etc/passwd"), /Project の根の外/);
    await assert.rejects(() => listDirectoryOp(dir, "/"), /Project の根の外/);
    await assert.rejects(() => writeFileOp(dir, "/tmp/banto-escape.txt", "x"), /Project の根の外/);
    // `~` は展開しない（ここはシェルではない）——黙って別の意味にせず、断る
    await assert.rejects(() => readFileOp(dir, "~/.ssh/id_ed25519"), /home からの指定/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **AI は根の中のファイルを絶対パスで指してくる**（実測・2026-09-10——E2E が
// これで落ちた）。守りたいのは「根の外へ出さない」であって書き方ではない。
test("根の中を指す絶対パスは受け取る（AI はこう書いてくる）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fs-scope-"));
  try {
    await writeFile(join(dir, "one.txt"), "ひとつめ\n");
    const block = await readFileOp(dir, join(dir, "one.txt"));
    assert.equal(block.text?.trim(), "ひとつめ");
    const entries = await listDirectoryOp(dir, dir);
    assert.ok(entries.some((e) => e.name === "one.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("`..` で根の外へ出られない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fs-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "banto-fs-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "外の秘密\n");
    await assert.rejects(
      () => readFileOp(dir, `../${basename(outside)}/secret.txt`),
      /Project の根の外/,
    );
    // 根の中は今までどおり読める（中も外も失敗するなら、それは壊れているだけ）
    await writeFile(join(dir, "inside.txt"), "中身\n");
    const block = await readFileOp(dir, "inside.txt");
    assert.equal(block.text?.trim(), "中身");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("記号リンクで根の外を指しても読めない（実体で見る）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fs-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "banto-fs-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "外の秘密\n");
    await symlink(join(outside, "secret.txt"), join(dir, "link.txt"));
    await assert.rejects(() => readFileOp(dir, "link.txt"), /Project の根の外/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("まだ無いパスにも書ける（新規作成は根の中なら通る）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-fs-scope-"));
  try {
    await writeFileOp(dir, "new/dir/file.txt", "書けた");
    const block = await readFileOp(dir, "new/dir/file.txt");
    assert.equal(block.text, "書けた");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
