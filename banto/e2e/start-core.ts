// playwrightのwebServer.command用ラッパー。globalSetupとwebServer起動の
// 順序をPlaywrightに委ねると競合しうる（実測——globalSetup前にcliが起動し、
// config.jsonが無いまま既定値＝本番と同じport/dataDirで立ち上がりEADDRINUSEになった）
// ので、ここで確実にconfig.jsonを書いてからcli.jsを読み込む
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import globalSetup from "./global-setup.ts";
import {
  DATA_DIR,
  FRONTEND_PORT,
  CLAUDE_CONFIG_DIR,
  CLAUDE_CREDENTIALS_DIR,
  NPM_REGISTRY_PORT,
  REGISTRY_BASE_URL,
  REGISTRY_PORT,
  SHELL_HOME_SOURCE,
  SUBAGENT_CLAUDE_CREDENTIALS,
  SUBAGENT_IMPORT_FILE,
  SUBAGENT_IMPORTED_KEY,
} from "./config.ts";
import { startRegistryFixture } from "./registry-fixture.ts";
import { startNpmRegistryFixture } from "./npm-registry-fixture.ts";
import { startGithubFixture } from "./github-fixture.ts";
import { startGithubLoginFixture } from "./github-login-fixture.ts";

globalSetup();

// **回が終わったらコンテナを必ず消す片づけ役を、別のセッションで起こしておく**（追加・2026-10-01、`run-reaper.ts`）。
// `globalTeardown` は外から殺された回（`timeout` の打ち切り・SIGKILL）では走らない。片づけ役は setsid で
// プロセスグループの外に出るので、回ごと殺されても残り、Playwright が居なくなったのを見て core と画面のサーバを止め、
// コンテナを消す。
// 回の印（BANTO_E2E_RUN_ID）は Playwright 本体の pid、このプロセスが core 自身
{
  const reaperLog = openSync(join(dirname(DATA_DIR), "reaper.log"), "a");
  spawn(
    process.execPath,
    [fileURLToPath(new URL("./run-reaper.ts", import.meta.url)), process.env.BANTO_E2E_RUN_ID!, String(process.pid), DATA_DIR, String(FRONTEND_PORT)],
    { detached: true, stdio: ["ignore", reaperLog, reaperLog] },
  ).unref();
  closeSync(reaperLog);
}

// **claude CLI に人の `~/.claude` を触らせない**（決定・2026-09-16、config.ts 参照）。
// Runner が起こす CLI はこのプロセスの env を引き継ぐので、cli.js を読み込む前に置く。
// 記録（projects/sessions）は実行ごとの置き場へ、認証は本物の置き場から。
process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = CLAUDE_CREDENTIALS_DIR;

// **2本目の Vault（Infisical）にも繋ぐ**（2026-09-12）。資格情報が無いと
// 「繋げませんでした」が受信箱に毎回1件出る——試験がそれを数えてしまう。
//
// **訂正・2026-09-20**：vault-infisical は**既定から外れて目録（catalog）へ
// 移った**ので、ここで環境変数を渡しても、**足さない限り立たない**。
// つまりこの実行に Vault は既定で1本しか無い——**「Vault をまたぐ」経路を
// 試したい spec は、自分で2本目を足すこと**（`vault-directory.spec.ts` の
// 「別の Vault へ移せる」が、同じ vault-local を別の置き場でもう1本立てている）。
// **Module を既定から外すと、それが居る前提の試験は落ちずに中身だけ減る**
// ——実際、Vault をまたぐ移動の不具合がこの穴から素通りした。
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

// **E2E は実 LLM を使わない**（決定・2026-09-20、ユーザー）。見たいのは banto 自身の
// 振る舞いで、モデルがどの tool を選ぶかではない。実 LLM を引き金にすると
// 「AI がその 180 秒のうちに呼ばなかった」だけで落ちる——実際フル E2E 5回中2回が
// これで落ちていた。**偽物にするのは AI だけで、tool は本物の MCP を呼ぶ**。
//
// **実物へ黙って落ちる道は作らない**（規則2）——指示の印が無い spec は
// 「ひとこと返す」既定で動く。それで足りない spec は、印を書いて直す。
process.env.BANTO_FAKE_RUNNER = join(
  dirname(fileURLToPath(import.meta.url)),
  "fake-runner.ts",
);

// **MCP Registry も偽物にする**（追加・2026-09-21）。**本物の一覧は毎日変わる**ので、
// 「公式が先に出る」という検査が外の都合で落ちる（規則6）。中身は本物から写してある。
// core と同じプロセスで立てるので、core が落ちれば一緒に落ちる（置き去りにならない）
await startRegistryFixture(REGISTRY_PORT);
process.env.BANTO_MCP_REGISTRY_URL = REGISTRY_BASE_URL;
// **npm も偽物にする**——registry から入れた Module を実際に取ってきて繋ぐところ
// まで見るのに要る。本物の npm を叩くと外の都合で落ちる試験になる（規則6）
await startNpmRegistryFixture(NPM_REGISTRY_PORT);

// **GitHub も偽物にする**（追加・2026-09-23）——Skill の取り込みが本物の GitHub を
// 叩かないように。skills Module は host の env を引き継ぐので、ここで置けば届く
const github = await startGithubFixture();
process.env.BANTO_SKILLS_GITHUB_API_URL = github.api;
process.env.BANTO_SKILLS_GITHUB_RAW_URL = github.raw;
// Repositories のアカウント（デバイスフロー・PAT の確かめ）も偽物へ（追加・2026-10-02）。Repositories は banto 本体で
// 動き host の env を継ぐ
const githubLogin = await startGithubLoginFixture();
process.env.BANTO_REPOSITORIES_GITHUB_URL = githubLogin.web;
process.env.BANTO_REPOSITORIES_GITHUB_API_URL = githubLogin.api;

// **Shell のホームへ写す元も偽物にする**（追加・2026-09-23）。資格情報の取り出し役と
// include を入れておく——写したときに外れることを試験が見る
mkdirSync(join(SHELL_HOME_SOURCE, ".config", "git"), { recursive: true });
writeFileSync(
  join(SHELL_HOME_SOURCE, ".gitconfig"),
  [
    "[user]",
    "\tname = E2E Taro",
    "\temail = taro@e2e.invalid",
    '[credential "https://github.com"]',
    "\thelper = !/usr/bin/gh auth git-credential",
    "[include]",
    "\tpath = ~/.gitconfig-secret",
    "",
  ].join("\n"),
);
writeFileSync(join(SHELL_HOME_SOURCE, ".config", "git", "ignore"), "*.e2e-ignored\n");
process.env.BANTO_SHELL_HOME_SOURCE = SHELL_HOME_SOURCE;

// **サブエージェントも偽物にする**（追加・2026-09-24）。本物の Claude Code・OpenCode は
// 資格情報と費用が要り、返事も毎回違う。偽の ACP エージェント（`@banto/module-subagent` の
// `testing/fake-agent`）に差し替える——**閉じ込め・資格情報の受け渡し・再開は本物の経路**を通る
process.env.BANTO_SUBAGENT_FAKE_AGENT = "1";
// コンテナの上限の見張り（`container-pressure.ts`）は1分ごと——試験では2秒にする
process.env.BANTO_CONTAINER_PRESSURE_INTERVAL_MS = "2000";
// サブエージェントの Module は Project のコンテナの中で動き、host の環境を受け継がない——偽物の印だけを
// 中に渡す（決定・2026-09-25。人の banto では使わない口）
process.env.BANTO_CONTAINER_ENV_PASSTHROUGH = "BANTO_SUBAGENT_FAKE_AGENT";
// 設定画面が読むもの（本体の Claude ログインと、鍵の取り込み元）も偽物に向ける——人のものを読まない
writeFileSync(
  SUBAGENT_CLAUDE_CREDENTIALS,
  JSON.stringify({ claudeAiOauth: { accessToken: "e2e-not-a-token", subscriptionType: "max", rateLimitTier: "e2e-tier" } }),
);
process.env.BANTO_SUBAGENT_CLAUDE_CREDENTIALS = SUBAGENT_CLAUDE_CREDENTIALS;
writeFileSync(SUBAGENT_IMPORT_FILE, JSON.stringify({ fake: { type: "api", key: SUBAGENT_IMPORTED_KEY } }));
process.env.BANTO_SUBAGENT_FAKE_IMPORT_FILE = SUBAGENT_IMPORT_FILE;

await import("../packages/core/dist/cli.js");
