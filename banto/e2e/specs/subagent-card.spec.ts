// **サブエージェントに頼むと、会話にカードが残り、押すと入口の画面でその仕事が開く**（決定・2026-10-01、ユーザー）。
// Fork の「この Fork を開く」と同じ形。Module は runSubagent に `dev.banto/card` の印を付けるだけで、
// banto は画面を会話に埋めずにカードを置く。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 待つ形で頼むと、**走っている間に**（結果が返る前に）カードが出る。題はエージェント、説明は頼んだ内容。
//      会話には画面を埋めない
//   2. カードを押すと Canvas に入口の画面が開き、**その仕事が選ばれて**中身（実行中）が見える
//   3. 待たない形でも同じカードが出る
//   4. リロードしてもカードは残り、古いほうのカードを押すと（新しい仕事があっても）古いほうの仕事が開く
//   5. **Fork の会話で頼んでも**、カードに「開く」があり、押すとその仕事が開く（2026-10-01、ユーザー報告——
//      Fork には Canvas を開く口が渡っておらず、ボタンが出なかった）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, confirmForkDialog, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Card";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function assistantCount(page: Page, threadId: string): Promise<number> {
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: { role: string }[];
  };
  return thread.messages.filter((m) => m.role === "assistant").length;
}

/** 鍵を使うエージェントは、Project ごとに初回だけ Vault の在りかを聞く承認が出る——出ていれば通す */
async function allowIfAsked(page: Page): Promise<void> {
  const allow = page.getByRole("button", { name: "許可する" });
  if ((await allow.count()) > 0) {
    await allow.last().click();
  }
}

test("サブエージェントの呼び出しは会話にカードで残り、押すと入口の画面でその仕事が開く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-card-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const composer = page.getByPlaceholder(/に送る/);
  const cards = page.getByTestId("tool-entry-card");
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const detail = canvas.locator('[data-role="detail"]');

  // ---- 1. 待つ形：走っている間にカードが出る ------------------------------------------------------
  await composer.fill(
    "待って頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 20] 一つ目の仕事" } }] }),
  );
  await composer.press("Enter");
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("fake に頼んだ仕事");
  await expect(cards.first()).toContainText("[slow 20] 一つ目の仕事");
  await expect(cards.first()).toHaveAttribute("data-module", "subagent");
  expect(await assistantCount(page, threadId), "カードが出たのは結果が返ってから（走っている間に出ていない）").toBe(0);
  // 画面は会話に埋めない
  await expect(page.getByTestId("inline-module-view")).toHaveCount(0);

  // ---- 2. 押すと入口の画面が開き、その仕事が選ばれている -----------------------------------------
  await cards.first().getByRole("button", { name: "開く" }).click();
  await expect(page.getByText(/^Canvas — subagent$/), "カードから Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  await expect(detail, "開いた画面で仕事が選ばれていない").toBeVisible({ timeout: 60_000 });
  await expect(detail.locator('[data-role="detail-prompt"]')).toHaveText("[slow 20] 一つ目の仕事");
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("実行中");
  // 承認（あれば）を通すと仕事が進み、開いたままの画面に経過が伸びる
  await expect(async () => {
    await allowIfAsked(page);
    await expect(detail.locator('[data-role="step"] .step-title')).toHaveText(["sleep 20"], { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, threadId, 1, 90_000);
  await expect(canvas.locator('[data-role="detail-status"]'), "終わったのに開いた画面が実行中のまま").toHaveText("完了", { timeout: 15_000 });

  // ---- 3. 待たない形でも同じカードが出る ---------------------------------------------------------
  await composer.fill(
    "待たずに頼んで。" +
      fakeTurn({
        tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "二つ目の仕事", runInBackground: true } }],
      }),
  );
  await composer.press("Enter");
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  await expect(cards.nth(1)).toContainText("fake に頼んだ仕事");
  await expect(cards.nth(1)).toContainText("二つ目の仕事");
  // 終わって届いたもので AI が起きるまで待つ（走っている途中のリロードを避ける）
  await expect.poll(() => assistantCount(page, threadId), { timeout: 120_000 }).toBeGreaterThanOrEqual(3);

  // ---- 4. リロードしても残り、古いほうを押すと古いほうの仕事が開く ------------------------------------
  await page.reload();
  await expect(cards).toHaveCount(2, { timeout: 60_000 });
  await expect(cards.first()).toContainText("[slow 20] 一つ目の仕事");
  await cards.first().getByRole("button", { name: "開く" }).click();
  await expect(detail.locator('[data-role="detail-prompt"]'), "古いカードから新しい仕事が開いた").toHaveText("[slow 20] 一つ目の仕事", {
    timeout: 60_000,
  });
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("完了");
  await cards.nth(1).getByRole("button", { name: "開く" }).click();
  await expect(detail.locator('[data-role="detail-prompt"]')).toHaveText("二つ目の仕事", { timeout: 60_000 });

  // ---- 5. Fork の会話から ---------------------------------------------------------------------
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  await expect(page.getByRole("button", { name: /Base Thread に戻る$/ })).toBeVisible({ timeout: 15_000 });
  const forkComposer = page.getByPlaceholder("この Fork Thread に送る");
  await forkComposer.fill(
    "Fork で頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "三つ目の仕事（Fork）" } }] }),
  );
  await forkComposer.press("Enter");
  const forkCard = cards.filter({ hasText: "三つ目の仕事（Fork）" });
  await expect(forkCard).toHaveCount(1, { timeout: 60_000 });
  await forkCard.getByRole("button", { name: "開く" }).click();
  await expect(detail.locator('[data-role="detail-prompt"]'), "Fork のカードから仕事が開かない").toHaveText("三つ目の仕事（Fork）", {
    timeout: 60_000,
  });
  // Fork は閉じずに残る
  await expect(page.getByRole("button", { name: `${PROJECT_NAME} の Base Thread に戻る` })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
