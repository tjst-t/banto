// **公開サイト（site/）のスクリーンショットを撮る**（追加・2026-10-14）。通常の E2E（`../playwright.config.ts` の
// `specs/`）には入らない——ここの `*.shots.ts` は、この設定を名指ししたときだけ走る：
//
//   cd banto/e2e && npx playwright test -c site-shots/playwright.config.ts
//
// 出力は `site/src/assets/screens/<名前>.png`（上書き）。core・画面・偽物の AI は E2E と同じものを使う——違うのは
//   - core は1本（場面は1つの banto に作る）
//   - 偽の AI は人の発言の文面から指示を引く（`BANTO_FAKE_SCRIPT`、`scene.ts` の SCRIPT）——発言に印の JSON が出ない
import { defineConfig } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.BANTO_E2E_WORKERS ??= "1";
// E2E の設定を先に読む——Incus に繋がる形で自分を起こし直し、回の印（RUN_DIR）と機械のロックを決める
const { default: base } = await import("../playwright.config.ts");
const { RUN_DIR } = await import("../config.js");
const { FAKE_SCRIPT_ENV } = await import("../fake-runner.js");
const { SCRIPT } = await import("./scene.ts");

// core（webServer）は主プロセスの env を引き継ぐので、起こす前に置く
const scriptFile = join(RUN_DIR, "site-shots-script.json");
writeFileSync(scriptFile, JSON.stringify(SCRIPT, null, 2));
process.env[FAKE_SCRIPT_ENV] = scriptFile;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  ...base,
  testDir: here("."),
  testMatch: /.*\.shots\.ts$/,
  // 場面を作る（コンテナを4つ起こし、AI のターンを十数本回す）ので長め
  timeout: 900_000,
  workers: 1,
  globalTeardown: here("../global-teardown.ts"),
  reporter: [["list"]],
  outputDir: here("./test-results"),
});
