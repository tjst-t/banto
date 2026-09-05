// ステージ2（F2/F3）の回帰。会話を送る→メーターの数値が変わる→リロード→
// 直前の数値が復元される、をブラウザで一通り確認する（CLAUDE.md規則14
// ——「メーターが出る」だけでなく、表示されている実際の数値を見る）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("会話を送る→文脈使用量メーターの数値が変わる→リロード→数値が復元される", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-context-usage-"));

  await page.goto(`/?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);

  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill("E2E Context Usage Project");
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(/Base Thread —/)).toBeVisible({ timeout: 15_000 });

  // 会話前——まだ1ターンも走っていないので、メーターは「実データが無い」を
  // 示すダミー（windowTokens=0、resolveUsageのフォールバック）のまま。
  // 使用率は実データでも小さい会話では四捨五入で0%になるため（規則14の
  // 教訓——見た目のパーセンテージだけでは実データかどうか区別できない）、
  // 内訳の分母（window全体のトークン数）を見る——ここは実データなら
  // rawMaxTokens（数十万〜百万オーダー）、フォールバックなら0のまま
  const meterButton = page.getByRole("button", { name: /文脈使用量/ });
  await meterButton.click();
  await expect(page.getByText(/^0 \/ 0 トークン使用中/)).toBeVisible();
  await page.keyboard.press("Escape");

  const assistantBubble = page.locator('[data-role="assistant"]');
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("目印として「文脈確認789」と1語だけ返してください。");
  await composer.press("Enter");
  await expect(assistantBubble.filter({ hasText: "文脈確認789" })).toBeVisible({ timeout: 60_000 });

  // ターン完了後、内訳の分母が実データ（0ではない）に変わる（規則14——
  // 表示されている実際の値まで見る、ボタンの見た目が変わったことだけでは見ない）。
  // assistantのテキストはSSEの"message"イベントで先に届き、usage.recordedは
  // その後の"done"イベントで届く——アシスタント発言が見えた時点ではまだ
  // このターンのusageが記録し終わっていないことがある。ポップオーバーは
  // 開いたまま（useMockStoreVersionで再描画される）で、値が入るまで
  // リトライしながら待つ
  await meterButton.click();
  const breakdownText = page.getByText(/^[\d,]+ \/ [\d,]+ トークン使用中/);
  await expect(breakdownText).not.toHaveText(/^0 \/ 0 /, { timeout: 15_000 });
  const textAfterTurn = await breakdownText.textContent();
  await page.keyboard.press("Escape");

  // リロード後も直前の値が復元される（thread.usageの永続化、真実は一箇所）
  await page.reload();
  await expect(page.getByText(/Base Thread —/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /文脈使用量/ }).click();
  await expect(page.getByText(textAfterTurn!, { exact: true })).toBeVisible({ timeout: 15_000 });
});
