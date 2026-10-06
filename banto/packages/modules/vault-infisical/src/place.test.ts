// サブフォルダの秘密（決定・2026-10-06）：グループは直下のフォルダのまま、名前はグループからの相対の道。
// Infisical の SDK の口を記録する偽の接続で「何を読み・どこに書くか」を見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { InfisicalAliasStore } from "./infisical-alias-store.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { backendPathOf, placeOf } from "./place.js";
import type { InfisicalConnection } from "./client.js";

type Stored = { secretValue: string; secretComment?: string };

function fakeConnection() {
  const secrets = new Map<string, Stored>(); // "/g/sub\0key"
  const folders = new Set<string>(); // "/g", "/g/sub"
  const at = (path: string, key: string) => `${path}\0${key}`;
  const conn = {
    scope: { projectId: "p1", environment: "prod" },
    folders: () => ({
      async create(opts: { name: string; path: string }) {
        const full = opts.path === "/" ? `/${opts.name}` : `${opts.path}/${opts.name}`;
        if (opts.path !== "/" && !folders.has(opts.path)) throw new Error(`parent folder ${opts.path} not found`);
        if (folders.has(full)) throw new Error("Folder already exists");
        folders.add(full);
      },
      async listFolders() {
        return [...folders].filter((f) => f.split("/").length === 2).map((f) => ({ name: f.slice(1) }));
      },
    }),
    secrets: () => ({
      async listSecrets() {
        return {
          secrets: [...secrets.entries()].map(([k, v]) => {
            const [secretPath, secretKey] = k.split("\0");
            return { secretPath, secretKey, secretComment: v.secretComment ?? "" };
          }),
        };
      },
      async getSecret(opts: { secretName: string; secretPath: string }) {
        const got = secrets.get(at(opts.secretPath, opts.secretName));
        if (!got) throw new Error("not found");
        return { secretValue: got.secretValue };
      },
      async createSecret(key: string, opts: { secretPath: string; secretValue: string; secretComment?: string }) {
        if (!folders.has(opts.secretPath)) throw new Error(`folder ${opts.secretPath} not found`);
        if (secrets.has(at(opts.secretPath, key))) throw new Error("Secret already exist");
        secrets.set(at(opts.secretPath, key), { secretValue: opts.secretValue, secretComment: opts.secretComment });
      },
      async updateSecret(key: string, opts: { secretPath: string; secretValue?: string; secretComment?: string }) {
        const cur = secrets.get(at(opts.secretPath, key));
        if (!cur) throw new Error("not found");
        secrets.set(at(opts.secretPath, key), {
          secretValue: opts.secretValue ?? cur.secretValue,
          secretComment: opts.secretComment ?? cur.secretComment,
        });
      },
      async deleteSecret(key: string, opts: { secretPath: string }) {
        if (!secrets.delete(at(opts.secretPath, key))) throw new Error("not found");
      },
    }),
  };
  return { conn: conn as unknown as InfisicalConnection, secrets, folders };
}

test("置き場の読み方：`g/sub/KEY` はフォルダ `/g/sub` の `KEY`、根の秘密はグループに属さない", () => {
  assert.deepEqual(placeOf("g/KEY"), { group: "g", subfolders: [], key: "KEY", folder: "/g" });
  assert.deepEqual(placeOf("g/a/b/KEY"), { group: "g", subfolders: ["a", "b"], key: "KEY", folder: "/g/a/b" });
  assert.equal(backendPathOf("/g/sub", "KEY"), "g/sub/KEY");
  assert.equal(backendPathOf("/g/sub/", "KEY"), "g/sub/KEY");
  assert.equal(backendPathOf("/", "KEY"), undefined);
  // 階層の外を指す段・空の段は通さない
  assert.throws(() => placeOf("g/../KEY"), /フォルダ名/);
  assert.throws(() => placeOf("g//KEY"), /フォルダ名/);
  assert.throws(() => placeOf("../KEY"), /グループ名/);
  assert.throws(() => placeOf("g/sub/"), /秘密の名前が空/);
});

test("一覧はサブフォルダの秘密も数え、名前はグループからの相対の道にする（同じ名前でも道が違えば別）", async () => {
  const { conn, secrets } = fakeConnection();
  secrets.set("/ansible-homelab\0PROXMOX_API_HOST", { secretValue: "h" });
  secrets.set("/ansible-homelab/generated\0ADGUARD_PASSWORD", { secretValue: "a" });
  secrets.set("/ansible-homelab/network\0ARUBA_USER", { secretValue: "u", secretComment: "スイッチ" });
  secrets.set("/ansible-homelab/network\0PROXMOX_API_HOST", { secretValue: "dup" });
  secrets.set("/\0ROOT_ONLY", { secretValue: "r" });
  const list = await new InfisicalAliasStore(conn).list();
  const rows = list.map((a) => [a.name, a.backendPath]).sort();
  assert.deepEqual(rows, [
    ["PROXMOX_API_HOST", "ansible-homelab/PROXMOX_API_HOST"],
    ["generated/ADGUARD_PASSWORD", "ansible-homelab/generated/ADGUARD_PASSWORD"],
    ["network/ARUBA_USER", "ansible-homelab/network/ARUBA_USER"],
    ["network/PROXMOX_API_HOST", "ansible-homelab/network/PROXMOX_API_HOST"],
  ]);
  assert.equal(list.find((a) => a.name === "network/ARUBA_USER")!.note, "スイッチ");
  assert.equal(list.find((a) => a.name === "network/ARUBA_USER")!.kind, "secret");

  const backend = new InfisicalBackend(conn);
  assert.deepEqual((await backend.listPaths()).sort(), rows.map(([, p]) => p).sort());
});

test("backend はサブフォルダの秘密を読み・書き（フォルダを順に作る）・消せる", async () => {
  const { conn, secrets, folders } = fakeConnection();
  const backend = new InfisicalBackend(conn);
  await backend.putSecret("proj/generated/KEY", "v1");
  assert.deepEqual([...folders].sort(), ["/proj", "/proj/generated"]);
  assert.equal(await backend.getSecret("proj/generated/KEY"), "v1");
  await backend.putSecret("proj/generated/KEY", "v2"); // 既にあれば上書き、フォルダも作り直さない
  assert.equal(secrets.get("/proj/generated\0KEY")!.secretValue, "v2");
  await backend.deleteSecret("proj/generated/KEY");
  assert.equal(secrets.size, 0);
  await assert.rejects(() => backend.putSecret("proj/../KEY", "x"), /フォルダ名/);
});

test("注記の書き直し・参照もサブフォルダで動く（参照はフォルダを . でつなぐ）", async () => {
  const { conn, secrets, folders } = fakeConnection();
  folders.add("/tools").add("/tools/cf").add("/proj");
  secrets.set("/tools/cf\0TOKEN", { secretValue: "real" });
  const store = new InfisicalAliasStore(conn);
  await store.update("tools/cf/TOKEN", { note: "Cloudflare" });
  assert.equal(JSON.parse(secrets.get("/tools/cf\0TOKEN")!.secretComment!).note, "Cloudflare");
  assert.equal(JSON.parse(secrets.get("/tools/cf\0TOKEN")!.secretComment!).name, "cf/TOKEN");

  await store.createLink({ name: "net/CF", backendPath: "proj/net/CF", linkTo: "tools/cf/TOKEN" });
  assert.equal(secrets.get("/proj/net\0CF")!.secretValue, "${prod.tools.cf.TOKEN}");
  const link = (await store.list()).find((a) => a.backendPath === "proj/net/CF")!;
  assert.equal(link.linkTo, "tools/cf/TOKEN");
  await store.deleteLink("proj/net/CF");
  assert.equal(secrets.has("/proj/net\0CF"), false);
  await assert.rejects(() => store.assertCanLinkTo("tools/my.sub/TOKEN"), /"\." を含むフォルダ名を指せません/);
});
