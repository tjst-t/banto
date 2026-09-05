import { defineConfig } from "@playwright/test";
import { CORE_BASE_URL, FRONTEND_BASE_URL, CONFIG_PATH } from "./config.js";

export default defineConfig({
  testDir: "./specs",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
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
      env: { BANTO_CONFIG_PATH: CONFIG_PATH },
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // frontend。Next 16はディレクトリ単位で多重起動を拒否するため、専用の
      // 別portを新たに起こすのではなく既存の開発用devサーバ（常時起動）を
      // 再利用する。落ちていた場合だけ、通常のdevスクリプトと同じ形で起こす
      command: `npm run dev --workspace=@banto/frontend`,
      cwd: new URL("..", import.meta.url).pathname,
      url: FRONTEND_BASE_URL,
      reuseExistingServer: true,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
