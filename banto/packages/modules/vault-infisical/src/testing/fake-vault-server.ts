// 試験用：偽の Infisical 接続（fake-connection.ts）の上に、本物と同じ形で Vault の MCP サーバを立てる
// （2026-10-18、Backlog #389）。**繋ぎ方は server.ts と同じ**——backend が値を置いた・消したら台帳の一覧を捨てさせる。
// ほかの Module の試験（Shell の通しの試験）から、Infisical に繋がずに使う
import { createVaultModuleServer } from "@banto/vault-kit";
import { InfisicalAliasStore } from "../infisical-alias-store.js";
import { InfisicalBackend } from "../infisical-backend.js";
import { fakeConnection, type FakeRateLimit } from "./fake-connection.js";

export function fakeInfisicalVaultServer(opts: { moduleName: string; dataDir: string; rateLimit?: FakeRateLimit }) {
  const fake = fakeConnection(opts.rateLimit ? { rateLimit: opts.rateLimit } : {});
  const aliasStore = new InfisicalAliasStore(fake.conn);
  const backend = new InfisicalBackend(fake.conn, () => aliasStore.forget());
  const server = createVaultModuleServer({ moduleName: opts.moduleName, backend, aliasStore, dataDir: opts.dataDir });
  return { server, ...fake };
}
