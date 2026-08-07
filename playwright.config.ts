/**
 * ブラウザ試験の持ち場を決める。
 *
 * **`tests/` の直下だけを見る。** 設定が無かったころは既定（リポジトリ全体の
 * `**\/*.spec.ts`）が効いていて、`tests/acceptance` と `tests/e2e`——node:test で書かれた
 * 別の runner の試験——まで読み込んでいた。読み込むだけで `describe()` が走るので、
 * ブラウザ試験を1本流すたびに daemon が何十個も立ち上がり、node:test の生の出力が
 * 混ざっていた（I2: 気づけない形で混ざるものは、その場で断つ）。
 *
 * 走らせ方の分担：
 * - `npx playwright test` … ブラウザ試験（`tests/*.spec.ts`）
 * - `npm test` … 受け入れ試験（`tests/acceptance`, node:test）
 * - `npm run test:e2e` … e2e（`tests/e2e`, node:test）
 *
 * どの試験も**ビルド済みのUI**（`packages/banto-web/dist`）を自前の偽ホストから配る。
 * 常駐しているホストには繋がないので、`npm run build:web` だけが前提。
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  // `*` は `/` を跨がない。`tests/acceptance/…` と `tests/e2e/…` はここに入らない
  testMatch: "*.spec.ts",
  // 失敗の理由がその場で読めるように（試験の数は少なく、まとめる意味がない）
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
});
