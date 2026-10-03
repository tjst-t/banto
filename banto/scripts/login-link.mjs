#!/usr/bin/env node
// **host で打つ、1回だけ使えるログインのリンク**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// まっさらなとき・パスキーを全部なくしたとき・最初の切り替えのときの入り口。**host に入れる人＝持ち主**を
// 最後の頼りにする——リンクの札は API では作らず、banto のデータ置き場にファイルで置く（コンテナからは見えない）。
// 有効なのは 10 分・1回だけ。
//
//   node scripts/login-link.mjs                         # リンクを出す
//   node scripts/login-link.mjs --rotate-machine-token  # 機械の合言葉（authToken）を作り直してからリンクを出す
//                                                       # （作り直したら host の再起動が要る。古い値はそこで効かなくなる）
//
// 設定は BANTO_CONFIG_PATH か ~/.config/banto/config.json から読む。host が動いていなくても出せる
// （札はファイルなので、次に起きた host が読む）。

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "..", "packages", "core", "dist");
const { writeLoginLink, loginLinkUrl } = await import(join(core, "auth", "login-links.js"));
const { loadOrCreateBootstrapConfig, loginOrigins } = await import(join(core, "config", "bootstrap.js"));

const args = process.argv.slice(2);
const configPath =
  process.env.BANTO_CONFIG_PATH ||
  join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "banto", "config.json");

if (!existsSync(configPath)) {
  console.error(`banto の設定がありません：${configPath}（BANTO_CONFIG_PATH で指せます）`);
  process.exit(1);
}

if (args.includes("--rotate-machine-token")) {
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  raw.authToken = randomBytes(32).toString("base64url");
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2), { mode: 0o600 });
  renameSync(tmp, configPath);
  console.log(`機械の合言葉（authToken）を作り直しました：${configPath}`);
  console.log("host を再起動すると古い値は効かなくなります（例：node scripts/restart-when-idle.mjs）。");
  console.log("");
}

const config = loadOrCreateBootstrapConfig(configPath);
const { uiOrigin, apiBaseUrl } = loginOrigins(config);
if (!config.publicUrl && !config.uiOrigin) {
  console.warn(
    `注意：設定に publicUrl も uiOrigin もありません。画面のオリジンを ${uiOrigin} とみなします。` +
      "\n      別の住所で開くなら config.json に publicUrl（例 \"https://banto.example\"）を書いて host を再起動してください。\n",
  );
}
const { code, expiresAt } = await writeLoginLink(config.dataDir);
console.log("このリンクを、入りたい端末のブラウザで開いてください（10分・1回だけ）：");
console.log("");
console.log(`  ${loginLinkUrl(uiOrigin, apiBaseUrl, code)}`);
console.log("");
console.log(`期限：${new Date(expiresAt).toLocaleString()}`);
console.log("入ったら、設定の「ログイン」でパスキーを登録してください。");
