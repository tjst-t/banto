// ステージ2（F2/F3）の回帰。会話を送る→メーターの数値が変わる→リロード→
// 直前の数値が復元される、をブラウザで一通り確認する（CLAUDE.md規則14
// ——「メーターが出る」だけでなく、表示されている実際の数値を見る）。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, expectProjectOpen, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test("会話を送る→文脈使用量メーターの数値が変わる→リロード→数値が復元される", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-context-usage-"));

  await openApp(page);

  await createProject(page, "E2E Context Usage Project", projectRoot);

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
  await expectProjectOpen(page, "E2E Context Usage Project");
  await page.getByRole("button", { name: /文脈使用量/ }).click();
  await expect(page.getByText(textAfterTurn!, { exact: true })).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // SDK側の記憶（auto-memory・CLAUDE.md）が文脈に入っていないこと
  // （§2.9・§2.3、決定・2026-09-05）。`claude_code`プリセットに戻ると
  // 「Memory files」が復活する——bantoのMemoryと真実が二箇所になるので、
  // ここで気づけるようにしておく（実測での見張り、規則1）。
  const threads = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  const project = threads.find((p: { name: string }) => p.name === "E2E Context Usage Project");
  const threadList = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  const thread = await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadList[0].id}`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json();
  const usage = thread.usage.at(-1).contextUsage as { categories?: { name: string; tokens: number }[] };
  const memoryFiles = usage.categories?.find((c) => c.name === "Memory files");
  expect(memoryFiles?.tokens ?? 0).toBe(0);

  // **Memory の割合を分けて見せる**（2026-10-20、ユーザー要望。v4-frontend.md §6.50）——この Project の AI への指示を書いて
  // 1ターン走らせると、メーターの内訳に「Memory」の行と「うち Memory …」が出る。量は core の節ごとの文字数で SDK の
  // System prompt を按分したもの（System prompt から引いた分が Memory になる）
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const put = await page.request.put(`${CORE_BASE_URL}/api/projects/${project.id}/instruction`, {
    headers,
    data: { text: "この Project 固有の指示。".repeat(200) },
  });
  expect(put.ok()).toBe(true);
  const footprint = await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadList[0].id}/prompt-footprint`, { headers })).json();
  expect(footprint.parts.find((p: { kind: string }) => p.kind === "instruction")?.chars ?? 0).toBeGreaterThan(2000);
  expect(footprint.totalChars).toBe(footprint.parts.reduce((n: number, p: { chars: number }) => n + p.chars, 0));

  await composer.fill("目印として「文脈確認790」と1語だけ返してください。");
  await composer.press("Enter");
  await expect(assistantBubble.filter({ hasText: "文脈確認790" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: /文脈使用量/ }).click();
  await expect(page.getByTestId("context-memory-share")).toContainText(/うち Memory [\d,]+ トークン/, { timeout: 15_000 });
  const memoryRow = page.getByRole("button", { name: /^Memory [\d,]+（[\d.]+%）$/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  await expect(page.getByText("この Project の AI への指示", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});
