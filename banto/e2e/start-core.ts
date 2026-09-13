// playwrightのwebServer.command用ラッパー。globalSetupとwebServer起動の
// 順序をPlaywrightに委ねると競合しうる（実測——globalSetup前にcliが起動し、
// config.jsonが無いまま既定値＝本番と同じport/dataDirで立ち上がりEADDRINUSEになった）
// ので、ここで確実にconfig.jsonを書いてからcli.jsを読み込む
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import globalSetup from "./global-setup.ts";

globalSetup();

// **2本目の Vault（Infisical）にも繋ぐ**（2026-09-12）。同梱の既定に入って
// いるので、資格情報が無いと「繋げませんでした」が受信箱に毎回1件出る
// ——試験がそれを数えてしまうし、何より**2本ある状態を試験できない**。
//
// 資格情報は開発用の Infisical（`packages/modules/vault-infisical/dev/`）から取る。
// **無ければ渡さない**——そのときは vault-infisical が繋がらず、受信箱に理由が
// 出る（黙って緑にしない、規則2）。立て方は同 `dev/README.md`。
const identity = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/modules/vault-infisical/dev/.identity.json",
);
if (existsSync(identity)) {
  const c = JSON.parse(readFileSync(identity, "utf8")) as Record<string, string>;
  process.env.BANTO_INFISICAL_SITE_URL = c.siteUrl;
  process.env.BANTO_INFISICAL_CLIENT_ID = c.clientId;
  process.env.BANTO_INFISICAL_CLIENT_SECRET = c.clientSecret;
  process.env.BANTO_INFISICAL_PROJECT_ID = c.projectId;
  process.env.BANTO_INFISICAL_ENVIRONMENT = c.environment;
} else {
  console.warn("[e2e] 開発用の Infisical が未用意——vault-infisical は繋がりません");
}

await import("../packages/core/dist/cli.js");
