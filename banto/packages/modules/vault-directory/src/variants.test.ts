// 窓口から見たグループの「版」（決定・2026-10-06、仕様 §2.1「グループの『版』」）。版を名乗る Vault
// （kit で作った試験用）と名乗らない本物の vault-local を並べ、置き場の読み書きに版が通ることを見る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createVaultServer } from "@banto/module-vault-local";
import { createVaultModuleServer, LocalFileAliasStore, splitVariant, type AliasListOptions, type VaultBackend } from "@banto/vault-kit";
import { createVaultDirectoryServer } from "./server.js";
import type { RelayLike } from "./relay-client.js";

const ADMIN = { "dev.banto/caller": { admin: true } } as const;

class VariantStore extends LocalFileAliasStore {
  override async list(opts?: AliasListOptions) {
    return (await super.list()).filter((m) => {
      const group = m.backendPath.slice(0, m.backendPath.indexOf("/"));
      return splitVariant(group).variant === undefined || (opts?.alsoGroups ?? []).includes(group);
    });
  }
}

function variantBackend(): VaultBackend {
  const secrets = new Map<string, string>();
  return {
    getSecret: async (p) => secrets.get(p) ?? Promise.reject(new Error(`not found: ${p}`)),
    putSecret: async (p, v) => void secrets.set(p, String(v)),
    deleteSecret: async (p) => void secrets.delete(p),
    listPaths: async () => [...secrets.keys()],
    generateKeypair: async () => Promise.reject(new Error("使わない")),
    publicKeyOf: async () => Promise.reject(new Error("使わない")),
    loadIntoAgent: async () => Promise.reject(new Error("使わない")),
    listGroups: async () => ["homelab"],
    createGroup: async () => {},
    variants: async () => ({ label: "環境", options: ["dev", "prod"], default: "dev" }),
    countByVariant: async () => [
      { variant: "dev", filled: 1, total: 5 },
      { variant: "prod", filled: 5, total: 5 },
    ],
  };
}

async function connect(server: { connect: (t: never) => Promise<void> }): Promise<Client> {
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0" });
  await Promise.all([server.connect(s as never), client.connect(c)]);
  return client;
}

test("置き場：版を名乗る Vault だけ版の選択肢を返し、版付きで紐付けると g@prod（グループの選択肢は版を外した名前）", async () => {
  const dirs = [await mkdtemp(join(tmpdir(), "vd-var-a-")), await mkdtemp(join(tmpdir(), "vd-var-b-"))];
  try {
    const vaults = new Map<string, Client>([
      ["vault-local", await connect(createVaultServer(dirs[0]!))],
      [
        "vault-x",
        await connect(
          createVaultModuleServer({ moduleName: "vault-x", backend: variantBackend(), aliasStore: new VariantStore(dirs[1]!), dataDir: dirs[1]! }),
        ),
      ],
    ]);
    await vaults.get("vault-local")!.readResource({ uri: "vault://aliases" });
    const relay: RelayLike = {
      listTargets: async () => [...vaults.keys()].map((name) => ({ name, roles: ["vault"] })),
      callTool: async (target, name, args) => {
        const res = (await vaults.get(target)!.callTool({ name, arguments: args, _meta: ADMIN })) as {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
        if (res.isError) throw new Error(res.content[0]!.text);
        return res.content[0]!.text;
      },
    };
    const ui = await connect(createVaultDirectoryServer({ relay }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await ui.callTool({ name, arguments: args, _meta: ADMIN })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0]!.text);
      return JSON.parse(res.content[0]!.text);
    };

    let places = await call("getPlacements", { projectId: "P" });
    const byImpl = (impl: string) => places.vaults.find((v: { implementation: string }) => v.implementation === impl);
    assert.equal(byImpl("vault-local").variants, null);
    assert.deepEqual(byImpl("vault-x").variants, { label: "環境", options: ["dev", "prod"], default: "dev" });

    // 変える前の見積もりも版付きの置き場で比べる
    const plan = await call("planProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "prod" });
    assert.deepEqual(plan.to, { implementation: "vault-x", group: "homelab@prod" });
    await call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "prod" });

    places = await call("getPlacements", { projectId: "P" });
    assert.deepEqual(places.project, { implementation: "vault-x", group: "homelab@prod", baseGroup: "homelab", variant: "prod" });
    assert.deepEqual(byImpl("vault-x").groups, ["homelab", "instance"], "版付きの置き場がグループの選択肢に混ざった");

    // 既定の版を選べば @ は付かない／無い版・版の無い Vault は断る
    await call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "dev" });
    assert.equal((await call("getPlacements", { projectId: "P" })).project.group, "homelab");
    await assert.rejects(
      () => call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "stg" }),
      /環境「stg」はありません/,
    );
    await assert.rejects(
      () => call("setProjectPlacement", { projectId: "P", implementation: "vault-local", group: "g", variant: "prod" }),
      /版がありません/,
    );

    assert.deepEqual(await call("countVariants", { implementation: "vault-x", group: "homelab" }), [
      { variant: "dev", filled: 1, total: 5 },
      { variant: "prod", filled: 5, total: 5 },
    ]);
    await ui.close();
    for (const c of vaults.values()) await c.close();
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }
});

test("置き場の変更：まだ紐付いていない版付きの置き場に同じ名前があれば、見積もりで衝突と出し、移さない（prod の本物の値を守る）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vd-var-c-"));
  try {
    const vault = await connect(
      createVaultModuleServer({ moduleName: "vault-x", backend: variantBackend(), aliasStore: new VariantStore(dir), dataDir: dir }),
    );
    const relay: RelayLike = {
      listTargets: async () => [{ name: "vault-x", roles: ["vault"] }],
      callTool: async (_target, name, args) => {
        const res = (await vault.callTool({ name, arguments: args, _meta: ADMIN })) as {
          isError?: boolean;
          content: Array<{ text: string }>;
        };
        if (res.isError) throw new Error(res.content[0]!.text);
        return res.content[0]!.text;
      },
    };
    const ui = await connect(createVaultDirectoryServer({ relay }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await ui.callTool({ name, arguments: args, _meta: ADMIN })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0]!.text);
      return JSON.parse(res.content[0]!.text);
    };
    // dev に紐付いた Project。prod には同じ名前の本物の値（ansible-homelab の形）
    await call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab" });
    await vault.callTool({ name: "createAlias", arguments: { name: "HOST", kind: "secret", group: "homelab", value: "" + "dev" }, _meta: ADMIN });
    await vault.callTool({ name: "createAlias", arguments: { name: "HOST", kind: "secret", group: "homelab@prod", value: "pve" }, _meta: ADMIN });

    const plan = await call("planProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "prod" });
    assert.deepEqual(plan.moving, ["HOST"]);
    assert.deepEqual(plan.conflicts, ["HOST"], "移す先の版にある同じ名前を見落とした");
    await assert.rejects(
      () => call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "prod", migrate: true }),
      /移す先に同じ名前があります/,
    );
    const prod = (await vault.callTool({ name: "resolveAlias", arguments: { name: "HOST", group: "homelab@prod" }, _meta: ADMIN })) as {
      content: Array<{ text: string }>;
    };
    assert.equal(prod.content[0]!.text, "pve");

    // 移さずに変えるのはできる。変えたあと、紐付けた版付きの置き場が variantGroups に出る（一覧に出る版付きの置き場）
    await call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab", variant: "prod" });
    const places = await call("getPlacements", { projectId: "P" });
    assert.deepEqual(places.vaults[0].variantGroups, ["homelab@prod"]);
    await ui.close();
    await vault.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **「移す」「参照を作る」で版を選べる**（2026-10-07、ユーザー「Env の指定もできる必要があるかも」）。画面は選んだ
// グループと版から `g@prod` を作って toGroup に渡す——窓口はそれをそのまま中継し、まだどこも紐付けていない版へも
// 移せる・置ける。その版に同じ名前の本物の値があれば、kit が置く先の版も読んで断る（上書きしない）
test("移す・参照：toGroup の g@prod を中継し、まだ紐付いていない版に同じ名前があれば上書きせずに断る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vd-var-d-"));
  try {
    const vault = await connect(
      createVaultModuleServer({ moduleName: "vault-x", backend: variantBackend(), aliasStore: new VariantStore(dir), dataDir: dir }),
    );
    const direct = async (name: string, args: Record<string, unknown>) => {
      const res = (await vault.callTool({ name, arguments: args, _meta: ADMIN })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0]!.text);
      return res.content[0]!.text;
    };
    const relay: RelayLike = {
      listTargets: async () => [{ name: "vault-x", roles: ["vault"] }],
      callTool: async (_target, name, args) => direct(name, args),
    };
    const ui = await connect(createVaultDirectoryServer({ relay }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = (await ui.callTool({ name, arguments: args, _meta: ADMIN })) as { isError?: boolean; content: Array<{ text: string }> };
      if (res.isError) throw new Error(res.content[0]!.text);
      return JSON.parse(res.content[0]!.text);
    };
    const rowsIn = async (group: string) =>
      (JSON.parse(await direct("listAliases", { alsoGroups: [group] })) as Array<{ name: string; group: string; linkTo?: unknown }>).filter(
        (r) => r.group === group,
      );

    await call("setProjectPlacement", { projectId: "P", implementation: "vault-x", group: "homelab" });
    await direct("createAlias", { name: "HOST", kind: "secret", group: "homelab@prod", value: "pve" });
    await direct("createAlias", { name: "HOST", kind: "secret", group: "homelab", value: "dev-host" });
    await direct("createAlias", { name: "TOKEN", kind: "secret", group: "homelab", value: "tok" });

    // prod に同じ名前の本物の値がある——移す・参照のどちらも断る。prod の値も dev の元も残る
    await assert.rejects(
      () => call("migrateAlias", { name: "HOST", implementation: "vault-x", group: "homelab", toGroup: "homelab@prod" }),
      /既に別の秘密があります/,
    );
    await assert.rejects(
      () => call("linkAlias", { name: "HOST", implementation: "vault-x", group: "homelab", toGroup: "homelab@prod" }),
      /既に別の秘密があります/,
    );
    assert.equal(await direct("resolveAlias", { name: "HOST", group: "homelab@prod" }), "pve", "prod の本物の値が上書きされた");
    assert.equal(await direct("resolveAlias", { name: "HOST", group: "homelab" }), "dev-host", "移せなかったのに元が消えた");

    // 空いていれば、まだ紐付いていない版へ移せる・参照を置ける
    const moved = await call("migrateAlias", { name: "TOKEN", implementation: "vault-x", group: "homelab", toGroup: "homelab@prod" });
    assert.deepEqual(moved.to, { implementation: "vault-x", group: "homelab@prod" });
    assert.equal(await direct("resolveAlias", { name: "TOKEN", group: "homelab@prod" }), "tok");
    await call("linkAlias", { name: "HOST", implementation: "vault-x", group: "homelab", toGroup: "homelab@prod", toName: "DEV_HOST" });
    const prod = await rowsIn("homelab@prod");
    assert.deepEqual(prod.map((r) => r.name).sort(), ["DEV_HOST", "HOST", "TOKEN"]);
    assert.deepEqual(prod.find((r) => r.name === "DEV_HOST")!.linkTo, { group: "homelab", name: "HOST" });
    // 紐付いていない版の行は、ふだんの一覧（窓口の横断）には出ない——画面はこれを先に言う（getPlacements の variantGroups に無い）
    const listed = await call("listAliases", {});
    assert.equal(listed.aliases.some((a: { group: string }) => a.group === "homelab@prod"), false);
    assert.deepEqual((await call("getPlacements", { projectId: "P" })).vaults[0].variantGroups, []);
    await ui.close();
    await vault.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
