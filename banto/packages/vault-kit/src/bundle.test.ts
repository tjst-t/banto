// **書き出しと取り込み**（決定・2026-10-22、仕様 v4-modules.md §2.1「書き出しと取り込み」）。
//
// 見るのは：束を合言葉で包んで開けること・合言葉違い／書き換え／新しい版／細工した KDF を断ること、人専用であること（AI に
// 出ない・人の刻印が無ければ断る）、入れるもの・入れないもの（参照・oauth-token・空）、共通の置き場は共通へ、同じ置き場の
// 飛ばす／上書き（種別違い・参照は上書きしない）、値が応答に出ないこと。
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
import { BUNDLE_OPEN_FAILED, openBundle, sealBundle } from "./bundle-crypto.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;
const PROJECT = { "dev.banto/caller": { project: "p1" } } as const;
const PASS = "correct horse battery";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-body\n-----END OPENSSH PRIVATE KEY-----\n";
/** 試験を速くする KDF の値（本物の書き出しは N=2^17） */
const FAST = { N: 2 ** 10, r: 8, p: 1 };

function fakeBackend() {
  const secrets = new Map<string, string>();
  const backend: VaultBackend = {
    async getSecret(path) {
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
      return "ssh-ed25519 PUB";
    },
    async loadIntoAgent() {
      throw new Error("使わない");
    },
    async listGroups() {
      return [];
    },
    async createGroup() {},
  };
  return { backend, secrets };
}

interface Kit {
  client: Client;
  secrets: Map<string, string>;
  call(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

async function withKits(fn: (src: Kit, dst: Kit) => Promise<void>): Promise<void> {
  const dirs: string[] = [];
  const kits: Kit[] = [];
  try {
    for (const name of ["vault-src", "vault-dst"]) {
      const dir = await mkdtemp(join(tmpdir(), "vault-kit-bundle-"));
      dirs.push(dir);
      const rec = fakeBackend();
      const server = createVaultModuleServer({ moduleName: name, backend: rec.backend, aliasStore: new LocalFileAliasStore(dir), dataDir: dir });
      const [s, c] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0.0.0" });
      await Promise.all([server.connect(s), client.connect(c)]);
      kits.push({
        client,
        secrets: rec.secrets,
        async call(tool, args, meta = ADMIN) {
          try {
            const r = (await client.callTool({ name: tool, arguments: args, _meta: meta })) as {
              content: Array<{ text: string }>;
              isError?: boolean;
            };
            return { text: r.content[0]?.text ?? "", isError: r.isError === true };
          } catch (err) {
            // kit は断るとき投げる（MCP の誤りとして返る）
            return { text: (err as Error).message, isError: true };
          }
        },
      });
    }
    await fn(kits[0]!, kits[1]!);
  } finally {
    for (const k of kits) await k.client.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
}

async function seed(src: Kit): Promise<void> {
  for (const [args, meta] of [
    [{ name: "tok", kind: "secret", value: "s3cret-value-1", note: "API" }, ADMIN],
    [{ name: "npmrc", kind: "file", value: "//registry/:_authToken=FILEVALUE\n", group: "proj-a" }, ADMIN],
    [{ name: "deploy", kind: "ssh-identity", value: KEY, group: "proj-a" }, ADMIN],
  ] as const) {
    const r = await src.call("createAlias", args, meta);
    assert.equal(r.isError, false, r.text);
  }
  // banto が置くログイン（書き出さない）
  const put = await src.call("putSecret", { name: "gh-login", value: "OAUTHVALUE", group: "proj-a" }, ADMIN);
  assert.equal(put.isError, false, put.text);
  // 参照（書き出さない）
  const link = await src.call("linkAlias", { name: "tok", toGroup: "proj-b" }, ADMIN);
  assert.equal(link.isError, false, link.text);
}

// ---- 暗号 ----------------------------------------------------------------------------------------------------

test("束：合言葉で包んで開ける。合言葉違い・書き換え・新しい版・細工した KDF は断る", async () => {
  const sealed = await sealBundle({ hello: "世界" }, PASS, FAST);
  assert.ok(!sealed.includes("世界"), "平文が見えている");
  assert.deepEqual(await openBundle(sealed, PASS), { hello: "世界" });
  await assert.rejects(openBundle(sealed, PASS + "x"), { message: BUNDLE_OPEN_FAILED });

  const file = JSON.parse(sealed) as Record<string, any>;
  const tamper = async (mutate: (f: Record<string, any>) => void, message: string | RegExp = BUNDLE_OPEN_FAILED) => {
    const f = JSON.parse(JSON.stringify(file)) as Record<string, any>;
    mutate(f);
    await assert.rejects(openBundle(JSON.stringify(f), PASS), { message });
  };
  // 中身の1バイト・見出し（塩・IV・KDF の値）を変えたら開けない
  await tamper((f) => {
    const b = Buffer.from(f.data, "base64");
    b[0] = b[0]! ^ 1;
    f.data = b.toString("base64");
  });
  await tamper((f) => (f.kdf.salt = Buffer.alloc(16, 1).toString("base64")));
  await tamper((f) => (f.cipher.iv = Buffer.alloc(12, 1).toString("base64")));
  await tamper((f) => (f.kdf.N = 2 ** 11));
  // 細工した KDF（メモリを食い潰す値）は計算する前に断る
  await tamper((f) => (f.kdf.N = 2 ** 24));
  await tamper((f) => (f.kdf.N = 1000));
  // 新しい版・違う形式
  await tamper((f) => (f.version = 2), /この banto では読めません/);
  await tamper((f) => (f.format = "other"), /書き出したファイルではありません/);
  await assert.rejects(openBundle("not json", PASS), /JSON として読めません/);
  // 短い合言葉では包まない
  await assert.rejects(sealBundle({}, "short", FAST), /12 文字以上/);
});

// ---- 書き出しと取り込み ------------------------------------------------------------------------------------------

test("書き出し：人が預けた秘密だけを束にし、参照と banto のログインは入れない。値は応答に出ない", async () => {
  await withKits(async (src) => {
    await seed(src);
    const r = await src.call("exportBundle", { passphrase: PASS });
    assert.equal(r.isError, false, r.text);
    for (const v of ["s3cret-value-1", "FILEVALUE", "key-body", "OAUTHVALUE"]) assert.ok(!r.text.includes(v), `値 ${v} が応答に出た`);
    const out = JSON.parse(r.text) as { bundle: string; count: number; left: Array<{ name: string; reason: string }>; from: string };
    assert.equal(out.count, 3);
    assert.equal(out.from, "vault-src");
    assert.deepEqual(out.left.map((x) => x.name).sort(), ["gh-login", "tok"]);
    const opened = (await openBundle(out.bundle, PASS)) as { entries: Array<{ name: string; kind: string; shared?: boolean; group: string }> };
    assert.deepEqual(opened.entries.map((e) => `${e.group}/${e.name}:${e.kind}${e.shared ? ":shared" : ""}`).sort().slice(1), [
      "proj-a/deploy:ssh-identity",
      "proj-a/npmrc:file",
    ]);
    assert.ok(opened.entries.some((e) => e.name === "tok" && e.shared === true), "共通の置き場の印が無い");
  });
});

test("取り込み：同じグループ・共通は共通へ置き、値が使える。同じ置き場は既定で飛ばし、上書きを選べば置き換える", async () => {
  await withKits(async (src, dst) => {
    await seed(src);
    const bundle = (JSON.parse((await src.call("exportBundle", { passphrase: PASS })).text) as { bundle: string }).bundle;

    const first = await dst.call("importBundle", { bundle, passphrase: PASS });
    assert.equal(first.isError, false, first.text);
    const r1 = JSON.parse(first.text) as { created: unknown[]; overwritten: unknown[]; skipped: unknown[]; from: string };
    assert.equal(r1.created.length, 3);
    assert.equal(r1.from, "vault-src");
    for (const v of ["s3cret-value-1", "FILEVALUE", "key-body"]) assert.ok(!first.text.includes(v));
    // 値が取り込んだ先で読める（人の管理面から）
    const list = JSON.parse((await dst.call("listAliases", {})).text) as Array<{ name: string; group: string; scope: string; note?: string; kind: string }>;
    const tok = list.find((a) => a.name === "tok")!;
    assert.equal(tok.scope, "shared", "共通の置き場の秘密が共通に入っていない");
    assert.equal(tok.note, "API");
    assert.equal(list.find((a) => a.name === "npmrc")?.group, "proj-a");
    assert.equal(list.find((a) => a.name === "deploy")?.kind, "ssh-identity");
    assert.equal((await dst.call("resolveAlias", { name: "npmrc", group: "proj-a" })).text, "//registry/:_authToken=FILEVALUE\n");
    assert.equal((await dst.call("resolveAlias", { name: "deploy", group: "proj-a" })).text, KEY);
    assert.equal((await dst.call("resolveAlias", { name: "tok" })).text, "s3cret-value-1");

    // もう一度：既定は飛ばす
    await dst.call("replaceSecretValue", { name: "tok", value: "changed-here" });
    const again = JSON.parse((await dst.call("importBundle", { bundle, passphrase: PASS })).text) as { created: unknown[]; skipped: unknown[] };
    assert.equal(again.created.length, 0);
    assert.equal(again.skipped.length, 3);
    assert.equal((await dst.call("resolveAlias", { name: "tok" })).text, "changed-here", "飛ばすのに上書きした");

    // 上書きを選ぶと置き換える。種別が違うものは上書きしない
    await dst.call("deleteAlias", { name: "npmrc", group: "proj-a" });
    await dst.call("createAlias", { name: "npmrc", kind: "secret", value: "other-kind", group: "proj-a" });
    const over = JSON.parse((await dst.call("importBundle", { bundle, passphrase: PASS, onConflict: "overwrite" })).text) as {
      overwritten: Array<{ name: string }>;
      skipped: Array<{ name: string; reason: string }>;
    };
    assert.deepEqual(over.overwritten.map((x) => x.name).sort(), ["deploy", "tok"]);
    assert.deepEqual(over.skipped.map((x) => x.name), ["npmrc"]);
    assert.match(over.skipped[0]!.reason, /種別の違う/);
    assert.equal((await dst.call("resolveAlias", { name: "tok" })).text, "s3cret-value-1");
    assert.equal((await dst.call("resolveAlias", { name: "npmrc", group: "proj-a" })).text, "other-kind");
  });
});

test("取り込み：合言葉違いは何も置かずに断る。書き出し・取り込みは人の刻印が無ければ断り、AI には出ない", async () => {
  await withKits(async (src, dst) => {
    await seed(src);
    const bundle = (JSON.parse((await src.call("exportBundle", { passphrase: PASS })).text) as { bundle: string }).bundle;
    const wrong = await dst.call("importBundle", { bundle, passphrase: "wrong passphrase!!" });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /開けません/);
    assert.equal(dst.secrets.size, 0, "合言葉違いなのに何か置いた");

    for (const meta of [PROJECT, {}]) {
      const ex = await src.call("exportBundle", { passphrase: PASS }, meta);
      assert.equal(ex.isError, true);
      assert.match(ex.text, /人の管理画面からしか/);
      const im = await dst.call("importBundle", { bundle, passphrase: PASS }, meta);
      assert.equal(im.isError, true);
      assert.match(im.text, /人の管理画面からしか/);
    }
    // 短い合言葉では書き出さない
    assert.match((await src.call("exportBundle", { passphrase: "short" })).text, /12 文字以上/);

    const tools = (await src.client.listTools()).tools;
    for (const name of ["exportBundle", "importBundle"]) {
      const t = tools.find((x) => x.name === name);
      assert.equal((t?._meta as Record<string, unknown>)["dev.banto/visibility"], "admin", name);
      // 合言葉・束は監査の識別子に入れない
      const audit = (t?._meta as Record<string, unknown>)["dev.banto/auditArgs"] as string[];
      assert.ok(!audit.includes("passphrase") && !audit.includes("bundle"), name);
    }
  });
});
