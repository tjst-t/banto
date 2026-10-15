import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLS_PREPARING_MARKER } from "@banto/module-contract";
import {
  CONVERT_MAX_BYTES,
  ConvertedStore,
  ConverterPreparingError,
  DocumentConversions,
  TOO_LARGE_MESSAGE,
  type Converter,
  type ConvertTarget,
} from "./converted.js";
import { INSTALLING_MESSAGE, STARTING_MESSAGE, preparingMessageOf } from "./relay-converter.js";
import { createFileSystemServer } from "./server.js";

const D1 = { version: "lo 24.2; recipe 1", fonts: "f1" };

/** 偽の変換役：中身の前に印を付けて返す。何回呼ばれたかを数える */
function fakeConverter(opts: { descriptor?: typeof D1; preparing?: boolean } = {}) {
  const calls: Array<{ target: ConvertTarget; extension: string }> = [];
  let describes = 0;
  const converter: Converter = {
    async describe() {
      describes++;
      if (opts.preparing) throw new ConverterPreparingError(INSTALLING_MESSAGE);
      return opts.descriptor ?? D1;
    },
    async convert(target, extension, data) {
      calls.push({ target, extension });
      if (opts.preparing) throw new ConverterPreparingError(INSTALLING_MESSAGE);
      return { data: Buffer.concat([Buffer.from(`${target}:`), data]), converter: opts.descriptor ?? D1, ms: 5 };
    },
  };
  return { converter, calls, describes: () => describes };
}

async function withDirs(fn: (root: string, store: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "banto-conv-root-"));
  const data = await mkdtemp(join(tmpdir(), "banto-conv-data-"));
  try {
    await fn(root, join(data, "converted"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
}

test("同じ中身は変換し直さない。中身が変わったら変換し直す", async () => {
  await withDirs(async (root, dir) => {
    const f = join(root, "a.docx");
    await writeFile(f, "DOC1");
    const fake = fakeConverter();
    const c = new DocumentConversions(new ConvertedStore(dir), fake.converter);
    const first = await c.convert(f, "pdf");
    assert.deepEqual(first, { status: "converted", target: "pdf", mimeType: "application/pdf", bytes: 8, cached: false, ms: 5 });
    const again = await c.convert(f, "pdf");
    assert.equal(again.status === "converted" && again.cached, true);
    assert.equal(fake.calls.length, 1, "同じ中身を変換し直した");
    // 同じ中身の別のファイルも変換し直さない（鍵は中身）
    await writeFile(join(root, "copy.docx"), "DOC1");
    assert.equal(((await c.convert(join(root, "copy.docx"), "pdf")) as { cached: boolean }).cached, true);
    await writeFile(f, "DOC2-changed");
    await utimes(f, new Date(), new Date(Date.now() + 5000));
    assert.equal(((await c.convert(f, "pdf")) as { cached: boolean }).cached, false);
    assert.equal(fake.calls.length, 2);
  });
});

test("変換役の版・フォントの印が変わったら作り直す。印は置き場に覚え、起こし直しても読むだけなら変換役に聞かない", async () => {
  await withDirs(async (root, dir) => {
    const f = join(root, "a.xlsx");
    await writeFile(f, "XLSX");
    const first = fakeConverter();
    await new DocumentConversions(new ConvertedStore(dir), first.converter).convert(f, "spreadsheet");
    // 起こし直した FileSystem：変換役が用意中でも、変換したものは引ける
    const restarted = new DocumentConversions(new ConvertedStore(dir), fakeConverter({ preparing: true }).converter);
    assert.match(await restarted.convertedPath(f, "spreadsheet"), /\.xlsx$/);
    // 日本語フォントを足した変換役（印が違う）は、変換した返事で覚え直し、次からは新しい印で引く
    const fonts = fakeConverter({ descriptor: { ...D1, fonts: "f2" } });
    const c = new DocumentConversions(new ConvertedStore(dir), fonts.converter);
    await c.convert(f, "spreadsheet"); // 覚えていた印（f1）で当たる
    assert.equal(fonts.calls.length, 0);
    await writeFile(join(root, "b.xlsx"), "OTHER");
    await c.convert(join(root, "b.xlsx"), "spreadsheet"); // 変換して f2 を覚える
    assert.equal(((await c.convert(f, "spreadsheet")) as { cached: boolean }).cached, false, "印が変わったのに作り直していない");
  });
});

test("7MB を超えると理由を出し、変換役に渡さない。変換できない種類も断る", async () => {
  await withDirs(async (root, dir) => {
    const f = join(root, "big.pptx");
    await writeFile(f, Buffer.alloc(CONVERT_MAX_BYTES + 1));
    const fake = fakeConverter();
    const c = new DocumentConversions(new ConvertedStore(dir), fake.converter);
    await assert.rejects(c.convert(f, "pdf"), { message: TOO_LARGE_MESSAGE });
    await writeFile(join(root, "a.docx"), "x");
    await assert.rejects(c.convert(join(root, "a.docx"), "spreadsheet"), /計算し直せません/);
    await writeFile(join(root, "a.txt"), "x");
    await assert.rejects(c.convert(join(root, "a.txt"), "pdf"), /PDF にできません/);
    assert.equal(fake.calls.length, 0);
  });
});

test("変換役を入れている途中なら、壊れたとは言わず「入れています」を返す", async () => {
  await withDirs(async (root, dir) => {
    const f = join(root, "a.docx");
    await writeFile(f, "x");
    const c = new DocumentConversions(new ConvertedStore(dir), fakeConverter({ preparing: true }).converter);
    assert.deepEqual(await c.convert(f, "pdf"), { status: "preparing", message: INSTALLING_MESSAGE });
  });
  assert.equal(preparingMessageOf(`${TOOLS_PREPARING_MARKER} documents に要る道具を入れています（初回だけ、数分）。あとで`), INSTALLING_MESSAGE);
  assert.equal(preparingMessageOf(`${TOOLS_PREPARING_MARKER} documents を起こしています。あとで`), STARTING_MESSAGE);
  assert.equal(preparingMessageOf("documents を起こせませんでした：apt が失敗"), undefined);
});

test("置き場は上限を超えたら使っていないものから消す（いま置いたものと変換役の印は残す）", async () => {
  await withDirs(async (_root, dir) => {
    const store = new ConvertedStore(dir, 10);
    await store.saveDescriptor(D1);
    await store.put("old", "pdf", Buffer.alloc(6));
    const old = store.pathFor("old", "pdf");
    await utimes(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await store.put("mid", "pdf", Buffer.alloc(4));
    await store.put("new", "pdf", Buffer.alloc(5));
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["converter.json", "mid.pdf", "new.pdf"].sort());
    assert.deepEqual(await store.loadDescriptor(), D1);
  });
});

test("画面は元のパス＋converted で変換したものを読む（写しのパスは出さない）。変換前は理由を返す", async () => {
  await withDirs(async (root, dir) => {
    await writeFile(join(root, "plan.docx"), "DOCX");
    const fake = fakeConverter();
    const server = createFileSystemServer({ projectRoot: root, conversions: new DocumentConversions(new ConvertedStore(dir), fake.converter) });
    const [s, cl] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(cl)]);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.find((t) => t.name === "convertDocument")?._meta?.["dev.banto/visibility"], "admin");
      await assert.rejects(
        client.callTool({ name: "readFileRange", arguments: { path: "plan.docx", offset: 0, length: 100, converted: true } }),
        /まだ変換していません/,
      );
      const done = await client.callTool({ name: "convertDocument", arguments: { path: "plan.docx" } });
      const outcome = JSON.parse((done.content as { text: string }[])[0]!.text) as Record<string, unknown>;
      assert.equal(outcome.path, "plan.docx");
      assert.equal(outcome.status, "converted");
      assert.ok(!JSON.stringify(outcome).includes(dir), "置き場のパスが返っている");
      const range = await client.callTool({ name: "readFileRange", arguments: { path: "plan.docx", offset: 0, length: 100, converted: true } });
      const r = JSON.parse((range.content as { text: string }[])[0]!.text) as { data: string; size: number };
      assert.equal(Buffer.from(r.data, "base64").toString(), "pdf:DOCX");
      // 元のファイルはそのまま読める
      const orig = await client.callTool({ name: "readFileRange", arguments: { path: "plan.docx", offset: 0, length: 100 } });
      assert.equal(Buffer.from((JSON.parse((orig.content as { text: string }[])[0]!.text) as { data: string }).data, "base64").toString(), "DOCX");
      // 根の外は converted でも断る
      await assert.rejects(
        client.callTool({ name: "readFileRange", arguments: { path: "../x.docx", offset: 0, length: 1, converted: true } }),
        /根の外/,
      );
    } finally {
      await client.close();
    }
  });
});
