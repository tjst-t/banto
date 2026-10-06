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
