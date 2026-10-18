// **まとめて引く**（決定・2026-10-18、仕様 §2.1「秘密をまとめて引く」）。
//
// `resolveAliases` は `resolveAlias` と同じ確かめを1件ずつ行い、**全部か何もなし**で返す。台帳は1回だけ読み、
// 値は backend の `getSecrets`（無ければ `getSecret` を1件ずつ）、使った日は `markUsedMany`（無ければ `markUsed` を
// 1件ずつ）。backend と台帳への呼び出しを数えて、回数が alias の数に比例しないことを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultModuleServer } from "./server.js";
import { LocalFileAliasStore } from "./alias-store.js";
import type { VaultBackend } from "./backend.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;
const forProject = (project: string) => ({ "dev.banto/caller": { project } });

function recordingBackend() {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  const backend: VaultBackend = {
    async getSecret(path) {
      calls.push(`get ${path}`);
      const v = secrets.get(path);
      if (v === undefined) throw new Error(`vault secret not found: ${path}`);
      return v;
    },
    async putSecret(path, value) {
      secrets.set(path, String(value));
    },
    async deleteSecret(path) {
      secrets.delete(path);
    },
    async listPaths() {
      return [...secrets.keys()];
    },
    async generateKeypair() {
      throw new Error("使わない");
    },
    async publicKeyOf() {
      throw new Error("使わない");
    },
    async loadIntoAgent() {
      throw new Error("使わない");
    },
    async listGroups() {
      return [];
    },
    async createGroup() {},
  };
  return { backend, secrets, calls };
}

/** 台帳を読んだ回数と、使った日を書いた置き場を数える。 */
class CountingStore extends LocalFileAliasStore {
  lists = 0;
  marked: string[] = [];
  /** 試験ごとに名乗らせる（既定は名乗らない——kit が markUsed を1件ずつ呼ぶ） */
  markUsedMany?: (backendPaths: readonly string[]) => Promise<void>;
  override async list() {
    this.lists++;
    return super.list();
  }
  override async markUsed(backendPath: string) {
    this.marked.push(backendPath);
    await super.markUsed(backendPath);
  }
}

async function withKit(
  fn: (c: Client, rec: ReturnType<typeof recordingBackend>, store: CountingStore) => Promise<void>,
  setup: (rec: ReturnType<typeof recordingBackend>, store: CountingStore) => void = () => {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vault-kit-batch-"));
  try {
    const rec = recordingBackend();
    const store = new CountingStore(dir);
    setup(rec, store);
    const server = createVaultModuleServer({ moduleName: "vault-test", backend: rec.backend, aliasStore: store, dataDir: dir });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(s), client.connect(c)]);
    // Project p はグループ pg に紐付く。共通グループの A・B、pg の C を置く
    await admin(client, "setGroupBinding", { projectId: "p", group: "pg" });
    await admin(client, "createAlias", { name: "A", kind: "secret", value: "va" });
    await admin(client, "createAlias", { name: "B", kind: "secret", value: "vb" });
    await admin(client, "createAlias", { name: "C", kind: "secret", group: "pg", value: "vc" });
    rec.calls.length = 0;
    store.lists = 0;
    store.marked.length = 0;
    await fn(client, rec, store);
    await client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const admin = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args, _meta: ADMIN });

const batch = (c: Client, items: Array<Record<string, unknown>>, meta: Record<string, unknown> = forProject("p")) =>
  c.callTool({ name: "resolveAliases", arguments: { items }, _meta: meta });

function valuesOf(result: unknown): Array<{ name: string; group: string; value: string }> {
  return (JSON.parse((result as { content: { text: string }[] }).content[0]!.text) as { values: never }).values;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => assert.fail("断られなかった"),
    (e: Error) => e.message,
  );
}

test("resolveAliases は items の順に値を返す——台帳は1回、値と使った日は1件ずつ（getSecrets・markUsedMany が無い backend）", async () => {
  await withKit(async (c, rec, store) => {
    const values = valuesOf(await batch(c, [{ name: "C" }, { name: "A" }, { name: "B", group: "instance" }]));
    assert.deepEqual(values, [
      { name: "C", group: "pg", value: "vc" },
      { name: "A", group: "instance", value: "va" },
      { name: "B", group: "instance", value: "vb" },
    ]);
    assert.equal(store.lists, 1, `台帳を ${store.lists} 回読んだ`);
    assert.deepEqual(rec.calls, ["get pg/C", "get instance/A", "get instance/B"]);
    assert.deepEqual(store.marked, ["pg/C", "instance/A", "instance/B"]);
  });
});

test("getSecrets・markUsedMany を名乗る backend には、まとめて1回ずつ頼む（1件ずつの口は呼ばない）", async () => {
  const asked: string[][] = [];
  const markedMany: string[][] = [];
  await withKit(
    async (c, rec, store) => {
      const values = valuesOf(await batch(c, [{ name: "A" }, { name: "C" }, { name: "A" }]));
      assert.deepEqual(values.map((v) => v.value), ["va", "vc", "va"]);
      // 同じ置き場は1回だけ頼む
      assert.deepEqual(asked, [["instance/A", "pg/C"]]);
      assert.deepEqual(markedMany, [["instance/A", "pg/C"]]);
      assert.deepEqual(rec.calls, [], "1件ずつの getSecret を呼んだ");
      assert.deepEqual(store.marked, [], "1件ずつの markUsed を呼んだ");
    },
    (rec, store) => {
      rec.backend.getSecrets = async (paths) => {
        asked.push([...paths]);
        return new Map(paths.map((p) => [p, rec.secrets.get(p)!]));
      };
      store.markUsedMany = async (paths) => {
        markedMany.push([...paths]);
      };
    },
  );
});

test("1件でも引けなければ値を1つも返さず、引けなかったもの全部を理由つきで断る（無い・使えない・空・参照の元が無い）", async () => {
  await withKit(async (c, rec, store) => {
    await admin(c, "createAlias", { name: "E", kind: "secret", value: "x" });
    rec.secrets.set("instance/E", "");
    await admin(c, "createAlias", { name: "Q", kind: "secret", group: "qg", value: "vq" });
    await store.createLink({ name: "L", backendPath: "instance/L", linkTo: "gone/L" });
    rec.calls.length = 0;
    store.marked.length = 0;

    const why = await refusal(
      batch(c, [{ name: "A" }, { name: "無い" }, { name: "Q", group: "qg" }, { name: "L" }, { name: "B" }]),
    );
    assert.match(why, /5 件のうち 3 件を引けませんでした（値は1つも渡していません）/);
    assert.match(why, /alias "無い" not found/);
    assert.match(why, /alias "Q" はこの Project からは使えません/);
    assert.match(why, /alias "L" は参照ですが、参照の元がありません/);
    // 引けないものが分かっているなら、値を読みに行かない
    assert.deepEqual(rec.calls, []);

    const empty = await refusal(batch(c, [{ name: "A" }, { name: "E" }]));
    assert.match(empty, /2 件のうち 1 件を引けませんでした/);
    assert.match(empty, /alias "E" の値が空です/);
    assert.equal(empty.includes("va"), false, "引けたものの値が理由に混じっている");
    assert.deepEqual(store.marked, [], "断ったのに使った日を書いた");
  });
});

test("1件ずつの resolveAlias と同じに扱う——参照は元の値・読めない値は理由に・刻印が無ければ断る", async () => {
  await withKit(async (c, rec) => {
    await admin(c, "linkAlias", { name: "A", group: "instance", toGroup: "pg", toName: "A2" });
    rec.calls.length = 0;
    const values = valuesOf(await batch(c, [{ name: "A2" }]));
    assert.deepEqual(values, [{ name: "A2", group: "pg", value: "va" }]);
    assert.deepEqual(rec.calls, ["get instance/A"], "参照の元から読んでいない");

    rec.secrets.delete("instance/B");
    const unread = await refusal(batch(c, [{ name: "A" }, { name: "B" }]));
    assert.match(unread, /alias "B" を読めませんでした: vault secret not found: instance\/B/);

    await assert.rejects(() => batch(c, [{ name: "A" }], {}), /誰のために使うのかが分かりません/);
  });
});

test("items の形が違えば断る（items のほかの引数・空・上限を超える・オブジェクトでない）", async () => {
  await withKit(async (c, rec) => {
    for (const [args, why] of [
      [{ items: [{ name: "A" }], name: "B" }, /items のほかの引数は受けません: name/],
      [{ items: [] }, /1件以上の配列/],
      [{ items: Array.from({ length: 101 }, () => ({ name: "A" })) }, /100 件まで/],
      [{ items: ["A"] }, /items\[0\] はオブジェクトです/],
      [{ items: [{ group: "instance" }] }, /items\[0\]\.name が要ります/],
    ] as const) {
      await assert.rejects(() => c.callTool({ name: "resolveAliases", arguments: args, _meta: forProject("p") }), why);
    }
    assert.deepEqual(rec.calls, []);
  });
});

test("承認は resolveAlias と同じ鍵で受ける（dev.banto/batchOf）・module 限定", async () => {
  await withKit(async (c) => {
    const { tools } = await c.listTools();
    const t = tools.find((x) => x.name === "resolveAliases")!;
    assert.deepEqual(t._meta?.["dev.banto/batchOf"], { tool: "resolveAlias", items: "items" });
    assert.equal(t._meta?.["dev.banto/visibility"], "module");
  });
});
