// **その発言の時点から枝を分ける**（決定・2026-09-11、ユーザー要望）。
//
// 見るのは3つ：
//   1. 操作の帯（コピー等）が**本文の左端にそろっている**
//   2. 帯の Fork を押すと、**その発言の時点**から分かれる
//   3. **Clear した後でも、Clear より前の発言から分かれる**
//      ——Clear は「次のターンで resume-point を渡さない」だけで、
//        手放したセッションの id は記録に残っている（アーキ仕様 §2.2）

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, confirmForkDialog } from "../helpers.js";

test.setTimeout(300_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

/** ターンが終わって、host の記録に返事が入るまで */
async function waitForAssistantCount(page: Page, threadId: string, count: number) {
  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
        ).json();
        return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
      },
      { timeout: 120_000, message: `返事が ${count} 件になるまで` },
    )
    .toBe(count);
}

test("操作の帯は本文の左端にそろい、そこから枝を分けられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "枝の spec", mkdtempSync(join(tmpdir(), "banto-e2e-forkmsg-")));

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === "枝の spec");
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json()
  )[0].id;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("「いちばん目」とだけ返して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "いちばん目" })).toBeVisible({
    timeout: 90_000,
  });
  await waitForAssistantCount(page, threadId, 1);

  // ---- 1. 帯が本文の左端にそろっている ------------------------------------
  await page.locator('[data-role="assistant"]').last().hover();
  const textLeft = await page
    .locator('[data-slot="aui_assistant-message-content"]')
    .last()
    .evaluate((el) => el.getBoundingClientRect().x + parseFloat(getComputedStyle(el).paddingLeft));
  const copyIcon = await page.getByRole("button", { name: "Copy" }).first().locator("svg").first().boundingBox();
  expect(copyIcon!.x, "コピーボタンが本文の左端にそろっていない").toBeCloseTo(textLeft, 0);

  // Fork は**コピーの右**に出る
  const forkIcon = await page.getByTestId("fork-from-message").first().locator("svg").first().boundingBox();
  expect(forkIcon!.x, "Fork ボタンがコピーの右に無い").toBeGreaterThan(copyIcon!.x);

  // ---- 2. その発言から分かれる --------------------------------------------
  await page.getByTestId("fork-from-message").first().click();
  await confirmForkDialog(page);
  await expect(page.getByRole("button", { name: /Base Thread に戻る$/ }), "Fork が開かない").toBeVisible({
    timeout: 30_000,
  });
  // **分かれた先は、その時点までの会話を持っている**（規則14）
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "いちばん目" }).last()).toBeVisible();

  const threads = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json()) as Array<{ id: string; kind: string }>;
  const fork = threads.find((t) => t.kind === "fork")!;
  const forkState = (await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${fork.id}`, { headers: HEADERS })
  ).json()) as { resumePoint?: string; messages: { text: string }[] };
  const baseState = (await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
  ).json()) as { resumePoint?: string };
  expect(forkState.resumePoint, "分けた時点のセッションに戻っていない").toBe(baseState.resumePoint);
});

test("Clear した後でも、Clear より前の発言から枝を分けられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "畳んでから分ける", mkdtempSync(join(tmpdir(), "banto-e2e-forkclear-")));

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === "畳んでから分ける");
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json()
  )[0].id;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("「畳む前」とだけ返して。");
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "畳む前" })).toBeVisible({
    timeout: 90_000,
  });
  await waitForAssistantCount(page, threadId, 1);
  const sessionBefore = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })).json()) as {
      resumePoint?: string;
    }
  ).resumePoint;
  expect(sessionBefore, "1ターン目のセッションが立っていない").toBeTruthy();

  // Clear（会話を畳む）——次のターンは新しい会話として始まる
  await page.getByRole("button", { name: "Thread の操作" }).click();
  await page.getByRole("menuitem", { name: "Clear" }).click();
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers: HEADERS })
          ).json()) as { resumePoint?: string }
        ).resumePoint,
      { timeout: 30_000, message: "Clear で resume-point が切れるまで" },
    )
    .toBeUndefined();

  // **畳む前の発言から分ける**——横線より上の発言の帯を使う
  await page.locator('[data-role="assistant"]').filter({ hasText: "畳む前" }).first().hover();
  await page.getByTestId("fork-from-message").first().click();
  await confirmForkDialog(page);
  await expect(page.getByRole("button", { name: /Base Thread に戻る$/ })).toBeVisible({ timeout: 30_000 });

  const threads = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
  ).json()) as Array<{ id: string; kind: string }>;
  const fork = threads.find((t) => t.kind === "fork")!;
  const forkState = (await (
    await page.request.get(`${CORE_BASE_URL}/api/threads/${fork.id}`, { headers: HEADERS })
  ).json()) as { resumePoint?: string; markers: unknown[]; messages: { text: string }[] };

  expect(forkState.resumePoint, "Clear 前のセッションへ戻れていない").toBe(sessionBefore);
  // 横線（Clear）はその後の出来事なので、分けた先には入らない
  expect(forkState.markers.length, "Clear の横線まで持って行っている").toBe(0);
  expect(forkState.messages.length, "畳む前のやり取りを持っていない").toBeGreaterThan(0);
});
