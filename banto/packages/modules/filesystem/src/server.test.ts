import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFileSystemServer } from "./server.js";

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
