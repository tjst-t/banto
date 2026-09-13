#!/usr/bin/env node
// **banto 同梱の Vault**（role `vault`、実装は SOPS + age）。
//
// A(agent)/B(module)/C(admin) の tool・resource 配線と alias 管理は
// `@banto/vault-kit` が持つ（切り出し・2026-09-12）。**この Module が書くのは
// 「秘密をどう置くか」だけ**——仕様 §2.1 D節が最初から言っていた形。
//
// メタデータは **banto がローカルに持つ**（`LocalFileAliasStore`）。組み込みの
// backend は「メタデータの持ち方自体を banto が決められる」（§2.1 D節）ので
// これでよい。**共有が眼目の backend（Infisical 等）は別の置き場を使う**。

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVaultModuleServer, LocalFileAliasStore } from "@banto/vault-kit";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { SopsBackend } from "./sops-backend.js";

export function createVaultServer(dataDir: string) {
  const backend = new SopsBackend(dataDir);
  return createVaultModuleServer({
    moduleName: "vault",
    backend,
    aliasStore: new LocalFileAliasStore(dataDir),
    dataDir,
    configApp: { uri: CONFIG_APP_URI, html: CONFIG_APP_HTML, name: "Vault" },
    init: () => backend.init(),
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_VAULT_DATA_DIR ?? `${process.env.HOME}/.local/share/banto/vault`;
  const server = createVaultServer(dataDir);
  await server.connect(new StdioServerTransport());
}
