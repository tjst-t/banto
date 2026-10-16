import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFileSystemServer } from "./server.js";
import { listDirectoryOp, readFileOp, writeFileOp, type FileContentBlock } from "./operations.js";
import { unzipSync } from "fflate";

function textOfBlock(block: FileContentBlock): string {
  assert.equal(block.type, "text", `テキストとして返っていない: ${block.type}`);
  return block.type === "text" ? block.text : "";
}

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

// **editFile は unified diff を返す**（MCP 公式の filesystem リファレンス実装と同じ形、
// 2026-09-23）。前後の全文を返すと、AI の文脈にファイルが2回載る
test("editFile は書き換えて、unified diff を返す", async () => {
  await withClient(async (client, root) => {
    await client.callTool({ name: "writeFile", arguments: { path: "a.txt", content: "one\ntwo\nfoo bar\nthree\n" } });
    const result = await client.callTool({
      name: "editFile",
      arguments: { path: "a.txt", edits: [{ oldText: "bar", newText: "baz" }] },
    });
    const diff = (result.content as { text: string }[])[0]!.text;
    assert.equal(
      diff,
      ["--- a/a.txt", "+++ b/a.txt", "@@ -1,4 +1,4 @@", " one", " two", "-foo bar", "+foo baz", " three", ""].join("\n"),
    );
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "one\ntwo\nfoo baz\nthree\n");
  });
});

test("editFile には差分の画面が付いている（決めるのは banto、印を付けるだけ）", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const edit = tools.find((t) => t.name === "editFile");
    assert.equal((edit?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, "ui://banto-filesystem/edit-diff");
    const html = await client.readResource({ uri: "ui://banto-filesystem/edit-diff" });
    const text = (html.contents as { text: string }[])[0]!.text;
    assert.match(text, /data-surface="edit-diff"/);
    // 組み立てた JS が埋まっている（空の画面を配らない）
    assert.match(text, /bundle-ui\.mjs/);
    assert.doesNotMatch(text.slice(text.indexOf("<script>") + 8, text.lastIndexOf("</script>")), /<\/script/i);
  });
});

// ---- 種類ごとの返し方（v4-modules.md §2.2「返り値の型は MIME で出し分ける」）----

test("readFile：表に無い拡張子でも、中身がテキストならテキストで返す（.csv が base64 になっていた）", async () => {
  await withClient(async (client, root) => {
    await writeFile(join(root, "budget.csv"), "項目,予算\nVault,120000\n");
    await writeFile(join(root, "query.sql"), "select 1;\n");
    for (const path of ["budget.csv", "query.sql"]) {
      const result = await client.callTool({ name: "readFile", arguments: { path } });
      const block = (result.content as { type: string; text?: string }[])[0]!;
      assert.equal(block.type, "text", `${path} がテキストで返っていない`);
    }
  });
});

test("readFile：バイナリは MCP の embedded resource の形で返す（SDK の検査を通る）", async () => {
  await withClient(async (client, root) => {
    const pdf = Buffer.from("%PDF-1.4\n\x00\x01binary", "latin1");
    await writeFile(join(root, "spec.pdf"), pdf);
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    // client.callTool は結果を CallToolResultSchema で検査する——形が違えばここで落ちる
    const result = await client.callTool({ name: "readFile", arguments: { path: "spec.pdf" } });
    const block = (result.content as { type: string; resource?: { uri: string; mimeType: string; blob: string } }[])[0]!;
    assert.equal(block.type, "resource");
    assert.equal(block.resource?.mimeType, "application/pdf");
    assert.equal(block.resource?.uri, "file:///spec.pdf");
    assert.deepEqual(Buffer.from(block.resource!.blob, "base64"), pdf);
    const bin = await client.callTool({ name: "readFile", arguments: { path: "blob.bin" } });
    assert.equal((bin.content as { type: string }[])[0]!.type, "resource");
  });
});

// ---- showFile：人にファイルを見せる（決定・2026-09-23、ユーザー）--------------------

test("showFile は中身を返さず、根からの相対パスと大きさだけを返す（画面が付いている）", async () => {
  await withClient(async (client, root) => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/README.md"), "# 見せる\n");
    // 絶対パスで頼まれても、画面が開く形（相対）で返す
    const result = await client.callTool({ name: "showFile", arguments: { path: join(root, "docs/README.md") } });
    assert.deepEqual(JSON.parse((result.content as { text: string }[])[0]!.text), { path: "docs/README.md", size: 12 });

    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === "showFile");
    assert.equal((show?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "agent");
    assert.equal((show?._meta as { ui?: { resourceUri?: string } })?.ui?.resourceUri, "ui://banto-filesystem/file");
    const html = await client.readResource({ uri: "ui://banto-filesystem/file" });
    assert.match((html.contents as { text: string }[])[0]!.text, /data-surface="file"/);
  });
});

test("showFile はフォルダ・無いファイル・根の外を断る", async () => {
  await withClient(async (client, root) => {
    await mkdir(join(root, "docs"), { recursive: true });
    const refused = async (path: string) => {
      const r = await client.callTool({ name: "showFile", arguments: { path } }).catch((e: unknown) => e);
      return r instanceof Error ? r.message : JSON.stringify(r);
    };
    assert.match(await refused("docs"), /フォルダです/);
    assert.match(await refused("nope.md"), /ENOENT|no such file/);
    assert.match(await refused("../x.md"), /Project の根の外/);
  });
});

// ---- PDF の画面（v4-modules.md §2.2「PDF・Office…」、2026-10-15）-------------------------

test("showFile は PDF・docx・pptx・doc・ppt・odt・odp・表（xlsx・xlsm・xls・ods）なら document の画面を選ばせる。document の HTML は pdf.js と worker、docx-preview と JSZip、SheetJS を同じ画面に入れる", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === "showFile");
    assert.deepEqual((show?._meta as Record<string, unknown>)?.["dev.banto/ui-by-extension"], {
      arg: "path",
      byExtension: Object.fromEntries(["pdf", "docx", "doc", "odt", "pptx", "ppt", "odp", "xlsx", "xlsm", "xls", "ods"].map((e) => [e, "ui://banto-filesystem/document"])),
    });
    const { resources } = await client.listResources();
    const doc = resources.find((r) => r.uri === "ui://banto-filesystem/document");
    assert.equal((doc?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "admin");

    const html = (await client.readResource({ uri: "ui://banto-filesystem/document" })).contents[0] as { text: string };
    assert.match(html.text, /data-surface="document"/);
    // worker → 本体 → 画面の順（本体は worker が globalThis.pdfjsWorker に置かれているのを見て Worker を作らない）
    const worker = html.text.indexOf("globalThis.pdfjsWorker=");
    const lib = html.text.indexOf("globalThis.pdfjsLib=");
    const app = html.text.indexOf("banto-filesystem-document");
    assert.ok(worker > 0 && lib > worker && app > lib, `script の順が違う（worker ${worker}・本体 ${lib}・画面 ${app}）`);
    // JSZip → docx-preview は普通の script で、module の script（画面）より先に走る
    const jszip = html.text.indexOf(".JSZip=");
    const docx = html.text.indexOf("docx-preview <https");
    assert.ok(jszip > 0 && docx > jszip && docx < worker, `Word の描き手の script の順が違う（JSZip ${jszip}・docx-preview ${docx}）`);
    // SheetJS（表）も普通の script で、画面より先に走る
    const sheetjs = html.text.indexOf("function make_xlsx_lib(");
    assert.ok(sheetjs > docx && sheetjs < worker, `表の読み手の script の順が違う（SheetJS ${sheetjs}）`);
    // 中で script が閉じない
    assert.equal(html.text.match(/<\/script>/g)?.length, 6);
    // テキストの画面とファイルブラウザは pdf.js・docx-preview・SheetJS の本体を背負わない——PDF・Office を選んだときに
    // readViewerScript で受けて読み込む（#341）。画面の JS がその名前を見るのはよい（本体が置く globalThis の名前）
    for (const uri of ["ui://banto-filesystem/file", "ui://banto-filesystem/directory"]) {
      const text = ((await client.readResource({ uri })).contents[0] as { text: string }).text;
      assert.doesNotMatch(text, /globalThis\.pdfjsLib=/, uri);
      assert.doesNotMatch(text, /globalThis\.pdfjsWorker=/, uri);
      assert.doesNotMatch(text, /\.JSZip=/, uri);
      assert.doesNotMatch(text, /docx-preview <https/, uri);
      assert.doesNotMatch(text, /make_xlsx_lib/, uri);
      assert.ok(text.length < 500_000, `${uri} が重い（${text.length}）`);
    }
  });
});

test("readFileRange はバイトの範囲を base64 で返し、末尾で切り、4MiB を超える頼みと根の外を断る", async () => {
  await withClient(async (client, root) => {
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    await writeFile(join(root, "a.pdf"), bytes);
    const read = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "readFileRange", arguments: { path: "a.pdf", ...args } });
      return JSON.parse((r.content as { text: string }[])[0]!.text) as { offset: number; length: number; size: number; data: string };
    };
    const mid = await read({ offset: 10, length: 20 });
    assert.deepEqual({ ...mid, data: undefined }, { offset: 10, length: 20, size: 300, data: undefined });
    assert.deepEqual(Buffer.from(mid.data, "base64"), bytes.subarray(10, 30));
    const tail = await read({ offset: 290, length: 100 });
    assert.equal(tail.length, 10);
    assert.deepEqual(Buffer.from(tail.data, "base64"), bytes.subarray(290));
    assert.equal((await read({ offset: 1000, length: 10 })).length, 0);

    const refused = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "readFileRange", arguments: args }).catch((e: unknown) => e);
      return r instanceof Error ? r.message : JSON.stringify(r);
    };
    assert.match(await refused({ path: "a.pdf", offset: 0, length: 4 * 1024 * 1024 + 1 }), /4194304 バイトまで/);
    assert.match(await refused({ path: "a.pdf", offset: -1, length: 1 }), /offset/);
    assert.match(await refused({ path: "../a.pdf", offset: 0, length: 1 }), /Project の根の外/);

    const { tools } = await client.listTools();
    assert.equal((tools.find((t) => t.name === "readFileRange")?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "admin");
  });
});

test("readPdfAsset は pdf.js の日本語の CMap を渡し、フォルダの外は指させない", async () => {
  await withClient(async (client) => {
    const r = await client.callTool({ name: "readPdfAsset", arguments: { kind: "cmap", name: "UniJIS-UCS2-H.bcmap" } });
    const data = Buffer.from((JSON.parse((r.content as { text: string }[])[0]!.text) as { data: string }).data, "base64");
    assert.ok(data.length > 1000, `CMap が短い（${data.length}）`);
    const refused = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "readPdfAsset", arguments: args }).catch((e: unknown) => e);
      return res instanceof Error ? res.message : JSON.stringify(res);
    };
    assert.match(await refused({ kind: "cmap", name: "../package.json" }), /名前として使えません/);
    assert.match(await refused({ kind: "other", name: "x" }), /cmap か standardFont/);
  });
});

test("readViewerScript はファイルブラウザが PDF・Office を描く道具の JS を渡す（AI には見せない）", async () => {
  await withClient(async (client) => {
    const read = async (name: string) => {
      const r = await client.callTool({ name: "readViewerScript", arguments: { name } });
      return JSON.parse((r.content as { text: string }[])[0]!.text) as { text: string; module: boolean };
    };
    const pdfjs = await read("pdfjs");
    assert.equal(pdfjs.module, true);
    assert.match(pdfjs.text, /globalThis\.pdfjsLib=/);
    const xlsx = await read("xlsx");
    assert.equal(xlsx.module, false);
    assert.ok(xlsx.text.length > 100_000, `SheetJS が短い（${xlsx.text.length}）`);
    // HTML の script を途中で閉じる文字列は残っていない
    for (const name of ["pdfjs-worker", "jszip", "docx-preview"]) assert.doesNotMatch((await read(name)).text, /<\/script/i, name);
    const refused = await client.callTool({ name: "readViewerScript", arguments: { name: "../package.json" } }).catch((e: unknown) => e);
    assert.match(refused instanceof Error ? refused.message : JSON.stringify(refused), /のどれかです/);
    const { tools } = await client.listTools();
    assert.equal((tools.find((t) => t.name === "readViewerScript")?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "admin");
  });
});

// ---- 人の操作だけの口（ファイルブラウザが使う、admin）--------------------------

test("uploadFile はバイト列をそのまま置く（画像も壊れない）", async () => {
  await withClient(async (client, root) => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await client.callTool({ name: "uploadFile", arguments: { path: "img/logo.png", data: png.toString("base64") } });
    assert.deepEqual(await readFile(join(root, "img/logo.png")), png);
    // 根の外へは置けない
    const outside = await client.callTool({ name: "uploadFile", arguments: { path: "../escape.bin", data: "AA==" } }).catch((e: unknown) => e);
    assert.match(String((outside as Error).message ?? JSON.stringify(outside)), /Project の根の外/);
  });
});

test("downloadFiles は選んだファイルを ZIP にまとめる（中の名前は根からの相対）", async () => {
  await withClient(async (client, root) => {
    await writeFile(join(root, "a.txt"), "A");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/b.md"), "# B");
    const result = await client.callTool({ name: "downloadFiles", arguments: { paths: ["a.txt", "docs/b.md"] } });
    const block = (result.content as { type: string; resource: { uri: string; mimeType: string; blob: string } }[])[0]!;
    assert.equal(block.type, "resource");
    assert.equal(block.resource.mimeType, "application/zip");
    assert.match(block.resource.uri, /-files\.zip$/);
    const files = unzipSync(new Uint8Array(Buffer.from(block.resource.blob, "base64")));
    assert.deepEqual(Object.keys(files).sort(), ["a.txt", "docs/b.md"]);
    assert.equal(Buffer.from(files["docs/b.md"]!).toString(), "# B");
  });
});

test("人の操作だけの口は AI に見せない（admin）", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    for (const name of ["uploadFile", "downloadFiles", "getRoot"]) {
      const tool = tools.find((t) => t.name === name);
      assert.equal((tool?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "admin", `${name} が admin でない`);
    }
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
    assert.equal(textOfBlock(block).trim(), "ひとつめ");
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
    assert.equal(textOfBlock(block).trim(), "中身");
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
    assert.equal(textOfBlock(block), "書けた");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **コメントは Project ごとの置き場に残す**（v4-modules.md §2.2「PDF・Office…」の「コメント」、Backlog #307）。
// 鍵は根からの相対パス、ハッシュ・時刻・id は host が付ける（画面が持ってきた値を信じない）、ファイルが変わったら
// 前に付けたものの `fileHash` がいまの `hash` と違う
test("getComments／saveComments はコメントを置き場に残し、ハッシュを host が付け、ファイルが変わると分かる", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "banto-fs-comments-"));
  const before = process.env.BANTO_MODULE_DATA_DIR;
  process.env.BANTO_MODULE_DATA_DIR = dataDir;
  try {
    await withClient(async (client, root) => {
      await mkdir(join(root, "docs"));
      await writeFile(join(root, "docs/plan.pdf"), "%PDF-1.4 one");
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        if (r.isError) throw new Error((r.content as { text: string }[])[0]?.text);
        return JSON.parse((r.content as { text: string }[])[0]!.text) as {
          path: string;
          hash: string;
          comments: Array<{ id: string; body: string; fileHash: string; anchor: unknown; createdAt: string; updatedAt?: string }>;
        };
      };
      const empty = await call("getComments", { path: "docs/plan.pdf" });
      assert.deepEqual(empty.comments, []);
      assert.match(empty.hash, /^[0-9a-f]{64}$/);

      const saved = await call("saveComments", {
        path: join(root, "docs/plan.pdf"),
        comments: [
          { anchor: { kind: "text", page: 3, quote: "受信箱の見直しについて" }, body: "ここは結論を先に", fileHash: "画面が書いた嘘" },
          { anchor: { kind: "region", page: 5, rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 } }, body: "凡例が読めない" },
          { anchor: { kind: "cell", sheet: "シート1", range: "D4", value: "1,200" }, body: "単価が古い" },
        ],
      });
      // 絶対パスで指しても鍵は根からの相対
      assert.equal(saved.path, "docs/plan.pdf");
      assert.equal(saved.comments.length, 3);
      for (const c of saved.comments) assert.equal(c.fileHash, empty.hash, "ハッシュを画面の値のまま残した");
      const stored = JSON.parse(await readFile(join(dataDir, "comments.json"), "utf8")) as { files: Record<string, unknown[]> };
      assert.deepEqual(Object.keys(stored.files), ["docs/plan.pdf"]);

      // 直す：同じ id は付けた時刻とハッシュを保つ。ファイルが変わったあとも、前のハッシュのまま
      await writeFile(join(root, "docs/plan.pdf"), "%PDF-1.4 two");
      const first = saved.comments[0]!;
      const edited = await call("saveComments", {
        path: "docs/plan.pdf",
        comments: [{ ...first, body: "結論を先に書く", fileHash: "x", createdAt: "1999-01-01T00:00:00Z" }, saved.comments[1]],
      });
      assert.notEqual(edited.hash, empty.hash);
      assert.equal(edited.comments[0]!.id, first.id);
      assert.equal(edited.comments[0]!.body, "結論を先に書く");
      assert.equal(edited.comments[0]!.fileHash, empty.hash);
      assert.equal(edited.comments[0]!.createdAt, first.createdAt);
      assert.ok(edited.comments[0]!.updatedAt);
      assert.equal(edited.comments[1]!.updatedAt, undefined);
      const reread = await call("getComments", { path: "docs/plan.pdf" });
      assert.deepEqual(reread.comments, edited.comments);

      // 形の崩れたもの・根の外は断る
      await assert.rejects(
        client.callTool({ name: "saveComments", arguments: { path: "docs/plan.pdf", comments: [{ anchor: { kind: "page", page: 0 }, body: "x" }] } }),
        /page は 1 以上の整数です/,
      );
      await assert.rejects(client.callTool({ name: "getComments", arguments: { path: "/etc/passwd" } }), /根の外/);

      // 空にすると消える
      const cleared = await call("saveComments", { path: "docs/plan.pdf", comments: [] });
      assert.deepEqual(cleared.comments, []);
      const after = JSON.parse(await readFile(join(dataDir, "comments.json"), "utf8")) as { files: Record<string, unknown[]> };
      assert.deepEqual(after.files, {});

      const { tools } = await client.listTools();
      for (const name of ["getComments", "saveComments"]) {
        assert.equal((tools.find((t) => t.name === name)?._meta as Record<string, unknown>)?.["dev.banto/visibility"], "admin");
      }
    });
  } finally {
    if (before === undefined) delete process.env.BANTO_MODULE_DATA_DIR;
    else process.env.BANTO_MODULE_DATA_DIR = before;
    await rm(dataDir, { recursive: true, force: true });
  }
});
