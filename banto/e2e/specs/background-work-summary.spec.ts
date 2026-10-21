// **札の手がかりを Module があとから足す・結果で画面を名乗る**（決定・2026-10-20、ユーザー。アーキ仕様 §4.2、v4-frontend.md §6.33、
// Backlog #489）。
//
// 試験用の Module（`fixtures/background-view-module`、同梱の扱いの目録の隠れた1本 `e2e-bgv`）を Project に入れ、AI にその「あとで届ける」tool
// を呼ばせる。tool の定義には画面が無く、結果で `dev.banto/backgroundView` を名乗る。小さいモデルは偽物（`fake-runner.ts` の
// `oneShot`——材料の `[[fake-title:…]]` をそのまま答える）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. Base Thread の行に、カードの題「試験の裏の仕事：w1」
//   2. Module が host の口で要約を頼むと `{summary}` が返り、一覧の1件の説明の下に「要約：<文>（いま）」。行は題のまま
//   3. すぐにもう一度頼むと「10 秒あけて」で断られ、理由がそのまま Module に返る（一覧は前の要約のまま）
//   4. リロードしても要約が出ている（繋いだときの hello にも表が重なる）
//   5. 1件を押すと、Canvas にその Module の入口が開き、`canvasView`＝名乗った select（{ workId: "w1" }）を画面が受け取っている
//   6. 狭い画面：一覧は行の右に浮かばず、行のすぐ下に開く（要約も出る）。1件を押すと Drawer が閉じて、同じ画面が開く
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, aiTextMentioning, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const MODULE = "e2e-bgv";
const PROJECT_NAME = "E2E Background Summary";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SUMMARY = "いまは単体試験を直しています。残りは E2E の1本です。";

let projectId = "";

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

/** 試験用の Module の admin の tool を人の画面の口で呼ぶ。断られたら `{ error }` */
async function summarize(page: Page, text: string): Promise<{ summary?: string; error?: string }> {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, {
    headers,
    data: { server: MODULE, tool: "summarizeWork", arguments: { workId: "w1", text } },
  });
  const body = (await res.json()) as { content?: Array<{ text: string }>; isError?: boolean; error?: string };
  if (!res.ok()) return { error: body.error ?? `${res.status()}` };
  const first = body.content?.[0]?.text ?? "";
  return body.isError ? { error: first } : (JSON.parse(first) as { summary: string });
}

test("Module が頼んだ要約がサイドバーの1件に出て、結果で名乗った画面がその select で開く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const installed = await page.request.post(`${CORE_BASE_URL}/api/modules/catalog/${MODULE}`, { headers, data: { name: MODULE } });
  expect(installed.status(), `試験用の Module を入れられなかった：${await installed.text()}`).toBeLessThan(300);

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-bg-summary-")));
  await waitForProjectModule(page, PROJECT_NAME, MODULE);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const line = sidebar.getByTestId("thread-background");
  const list = page.getByTestId("background-list");
  const items = list.getByTestId("background-item");

  // ---- 1. 待たない仕事を1つ頼む --------------------------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("裏で仕事を始めて。" + fakeTurn({ tools: [{ server: MODULE, name: "startWork", args: { workId: "w1" } }] }));
  await composer.press("Enter");
  await expect(aiTextMentioning(page, "仕事 w1 を始めました"), "tool の結果が AI に返らない").toHaveCount(1, { timeout: 60_000 });
  await waitTurnEnded(page, threadId, 1);
  await expect(line, "Base Thread の行に裏の仕事の印が出ない").toHaveText("試験の裏の仕事：w1", { timeout: 30_000 });
  await line.click();
  await expect(items).toHaveCount(1);
  await expect(items.first().getByTestId("background-item-summary"), "頼んでいないのに要約が出ている").toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  // ---- 2. Module が要約を頼む ----------------------------------------------------------------------------
  const first = await summarize(page, `頼んだ文：試験を直して\n経過：…\n[[fake-title:${SUMMARY}]]`);
  expect(first, `要約が返らない：${JSON.stringify(first)}`).toEqual({ summary: SUMMARY });
  // 行は題のまま（高さを変えない）
  await expect(line).toHaveText("試験の裏の仕事：w1");
  await line.click();
  const summaryLine = items.first().getByTestId("background-item-summary");
  await expect(summaryLine, "一覧の1件に要約が出ない").toHaveText(`要約：${SUMMARY}（いま）`, { timeout: 15_000 });
  await expect(items.first()).toContainText("試験の裏の仕事：w1");
  await expect(items.first()).toContainText(/e2e-bgv・(いま|\d+分前に)頼んだ/);
  await page.keyboard.press("Escape");

  // ---- 3. すぐにもう一度頼むと断られる ---------------------------------------------------------------------
  const again = await summarize(page, "[[fake-title:二つ目の要約]]");
  expect(again.error, `10 秒あけずに頼めた：${JSON.stringify(again)}`).toMatch(/前の要約から 10 秒あけてください/);

  // ---- 4. リロードしても出ている（hello に表が重なる） ------------------------------------------------------
  await page.reload();
  await expect(line).toHaveText("試験の裏の仕事：w1", { timeout: 60_000 });
  await line.click();
  await expect(summaryLine, "リロードしたら要約が消えた（hello に重なっていない）").toHaveText(`要約：${SUMMARY}（いま）`);

  // ---- 5. 1件を押すと、名乗った画面がその select で開く -------------------------------------------------------
  await items.first().click();
  await expect(list).toBeHidden();
  await expect(page.getByText(`Canvas — ${MODULE}`, { exact: true }), "Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  const url = new URL(page.url());
  expect(url.searchParams.get("canvas")).toBe(`${MODULE}:ui://e2e-background-view/works`);
  expect(url.searchParams.get("canvasView")).toBe(JSON.stringify({ workId: "w1" }));
  expect(url.searchParams.get("canvasTool"), "定義に画面の無い tool を toolCallId で開いた").toBeNull();
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(canvas.locator('[data-role="selected"]'), "開いた画面に select が渡っていない").toHaveText("選んだ仕事：w1", { timeout: 60_000 });

  expect(pageErrors, `画面で例外が出た：${pageErrors.join(" / ")}`).toEqual([]);
});

test.describe("狭い画面", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("一覧は行のすぐ下に開き、要約も出て、1件を押すと Drawer が閉じて同じ画面が開く", async ({ page }) => {
    expect(projectId, "前の試験が Project を作っていない").not.toBe("");
    await openApp(page);
    await page.goto(`/p/${projectId}?bantoHost=${CORE_BROWSER_URL}`);
    await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });

    const nav = page.getByRole("button", { name: "Project と Thread の一覧を開く" }).locator("visible=true");
    const drawer = page.getByRole("dialog", { name: "Project と Thread の一覧" });
    await nav.click();
    await expect(drawer).toBeVisible();
    const line = drawer.getByTestId("thread-background");
    await expect(line).toHaveText("試験の裏の仕事：w1", { timeout: 30_000 });
    await expect(line).toHaveAttribute("aria-expanded", "false");
    await line.click();
    await expect(line).toHaveAttribute("aria-expanded", "true");

    // 行の右に浮かぶ一覧（Popover）ではなく、Drawer の中の行のすぐ下
    const inline = drawer.getByTestId("background-inline");
    await expect(inline).toBeVisible();
    await expect(page.locator('[data-slot="popover-content"]'), "狭い画面で一覧が行の右に浮かんだ").toHaveCount(0);
    const lineBox = (await line.boundingBox())!;
    const inlineBox = (await inline.boundingBox())!;
    expect(inlineBox.y, "一覧が行の下に開いていない").toBeGreaterThanOrEqual(lineBox.y + lineBox.height - 1);
    expect(inlineBox.x + inlineBox.width, "一覧が Drawer の外にはみ出した").toBeLessThanOrEqual((await drawer.boundingBox())!.x + (await drawer.boundingBox())!.width + 1);
    const item = inline.getByTestId("background-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("background-item-summary")).toHaveText(new RegExp(`^要約：${SUMMARY}（(いま|\\d+分前)）$`));

    // もう一度押すと閉じる
    await line.click();
    await expect(inline).toHaveCount(0);
    await line.click();
    await inline.getByTestId("background-item").click();
    await expect(drawer, "1件を押しても Drawer が閉じない").toBeHidden({ timeout: 10_000 });
    const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
    await expect(canvas.locator('[data-role="selected"]')).toHaveText("選んだ仕事：w1", { timeout: 60_000 });
  });
});
