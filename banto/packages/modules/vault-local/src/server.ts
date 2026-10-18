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
//
// **設定 Canvas は持たない**（2026-10-07、ユーザー）。以前は alias の名前を並べるだけの画面
// （`ui://banto-vault-local/config`）を渡していたが、設定することが無く、同じ一覧は窓口の管理 Canvas にある
// ——設定画面に「Vault（ローカル）」が出ても、開いて決められることが無かった（規則13）

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createVaultModuleServer, LocalFileAliasStore, ownerRelayFromEnv, type OwnerRelay } from "@banto/vault-kit";
import { SopsBackend } from "./sops-backend.js";

export function createVaultServer(dataDir: string, ownerRelay?: OwnerRelay) {
  const backend = new SopsBackend(dataDir);
  return createVaultModuleServer({
    moduleName: "vault-local",
    backend,
    aliasStore: new LocalFileAliasStore(dataDir),
    dataDir,
    init: () => backend.init(),
    // 持ち主でない呼び元に banto のログインを渡す前に、持ち主を呼ぶ中継（2026-10-18、Backlog #405）
    ...(ownerRelay ? { ownerRelay } : {}),
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const dataDir = process.env.BANTO_VAULT_DATA_DIR ?? `${process.env.HOME}/.local/share/banto/vault`;
  const server = createVaultServer(dataDir, ownerRelayFromEnv("vault-local"));
  await server.connect(new StdioServerTransport());
}
