import { defineConfig } from "@playwright/test";
import {
  CORE_BASE_URL,
  FRONTEND_BASE_URL,
  FRONTEND_LISTEN_URL,
  FRONTEND_PORT,
  FRONTEND_DIST_DIR,
  CONFIG_PATH,
} from "./config.js";
import { acquireMachineLock } from "./run-lock.ts";

// **同じ機械の E2E は一度に1回**（`run-lock.ts`）。webServer を起こす前に取る——config はここで読まれ終わってから
// webServer が起きる。worker・webServer の子は env の印を見て何もしない
acquireMachineLock(new URL("..", import.meta.url).pathname);

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  fullyParallel: false,
  // **1本ずつ走らせる**（決定・2026-09-10、`e2e-run-isolation`）。
  // `fullyParallel: false` はファイル**内**の順序を固定するだけで、ファイル単位では
  // 複数 worker が並走する——全 spec が同じ core・同じ**受信箱**を共有しているので、
  // 判断待ちを起こす spec 同士が互いの1件を掴んだり、件数の検査が間欠で落ちたりする
  // （規則6——待ちを延ばす類の誤魔化しをせず、構造のほうを直す）
  workers: 1,
  // この回が作ったコンテナを消す（`global-teardown.ts`）
  globalTeardown: "./global-teardown.ts",
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }], ["./spec-timing-reporter.ts"]],
  use: {
    baseURL: FRONTEND_BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // core（banto host）。実データ・本番トークンとは別のdataDir・port
      // （BANTO_CONFIG_PATHで上書き）。start-core.tsが起動直前に確実に
      // config.jsonを書く——globalSetupとwebServer起動の順序に依存しない
      command: `node ${new URL("./start-core.ts", import.meta.url).pathname}`,
      url: `${CORE_BASE_URL}/healthz`,
      // 実行の印（port・置き場を決める）も渡す——別プロセスでも同じ実行になる
      env: { BANTO_CONFIG_PATH: CONFIG_PATH, BANTO_E2E_RUN_ID: process.env.BANTO_E2E_RUN_ID! },
      // **既に誰かが立っていたら相乗りしない**——別の実行の core を掴むと、
      // 受信箱もデータも混ざる。Playwright はここで止まる（黙って続けない）
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // **フロントも E2E 専用に起こす**（訂正・2026-09-13、config.ts 参照）。
      // 以前は人が使っている 4175 を借りていたので、**開発中のビルドが
      // 人の画面を壊していた**。port も dist も実行ごとに分ける。
      //
      // **本番ビルドで試験する**（dev サーバではない）——4175 は 2026-09-07 から
      // `next build` + `next start`。dev で試験すると、人が見ているものと違う
      // ものを見ることになる（規則1）。
      command:
        `npm run build --workspace=@banto/frontend && ` +
        `npm exec --workspace=@banto/frontend -- next start -H 127.0.0.1 -p ${FRONTEND_PORT}`,
      cwd: new URL("..", import.meta.url).pathname,
      env: { BANTO_NEXT_DIST_DIR: FRONTEND_DIST_DIR },
      url: FRONTEND_LISTEN_URL,
      // **黙って相乗りしない**（core と同じ規律）——別の実行のフロントを
      // 掴むと、どのビルドを試験したのか分からなくなる
      reuseExistingServer: false,
      // ビルドを含むので長め
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
