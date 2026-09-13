#!/usr/bin/env node
// **Infisical を使う Vault**（role `vault` の2本目、2026-09-12）。
//
// A/B/C の配線と alias 管理は `@banto/vault-kit` が持つ。この Module が書くのは
// 「秘密をどこに置くか」と「メタデータをどこに置くか」だけ。
//
// **メタデータは Infisical の中**（`InfisicalAliasStore`）。組み込み Vault は
// ローカルのファイルで足りるが、Infisical は「複数台のホストで同じ backend を
// 共有する」ことが眼目なので、**メタデータもそこに無いと共有が成立しない**。
//
// **設定 Canvas は持たない。** 横断管理は VaultUI がやるので、backend ごとの
// 薄い画面をもう1枚増やす理由が無い——無いものを在るふりで出さない（規則13）。

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVaultModuleServer } from "@banto/vault-kit";
import { InfisicalConnection, readConfigFromEnv, type InfisicalConfig } from "./client.js";
import { InfisicalBackend } from "./infisical-backend.js";
import { InfisicalAliasStore } from "./infisical-alias-store.js";

export function createInfisicalVaultServer(config: InfisicalConfig, dataDir: string) {
  const conn = new InfisicalConnection(config);
  const backend = new InfisicalBackend(conn);
  return createVaultModuleServer({
    moduleName: "vault-infisical",
    backend,
    aliasStore: new InfisicalAliasStore(conn),
    dataDir,
    // **繋がれないなら立たない**（規則2）——空の一覧を出して
    // 「秘密が1つも無い」ように見せない
    init: () => conn.connect(),
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir =
    process.env.BANTO_VAULT_INFISICAL_DATA_DIR ?? `${process.env.HOME}/.local/share/banto/vault-infisical`;
  const server = createInfisicalVaultServer(readConfigFromEnv(), dataDir);
  await server.connect(new StdioServerTransport());
}
