import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      // modules/ を入れ忘れると、試験ファイルが存在するのに一度も走らない。
      "modules/*/src/**/*.test.ts",
    ],
  },
});
