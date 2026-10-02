// 携帯のナビ（≡ で開く Drawer）——別 Project の Fork へ、Fork から別の Thread へ、それぞれ少ない手で行ける
// （2026-10-02、ユーザー要望）。
//
// 以前は (1) Drawer で別 Project を押すと Drawer が閉じ、その Project の Fork へ行くにはもう一度開く必要があった、
// (2) Fork の面には ≡ が無く、← で Base に戻ってから開くしかなかった。
// いまは Drawer を外枠に1つだけ持ち（mobile-nav-drawer.tsx）、Fork のある Project を押すと閉じずに目次を開く。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp, confirmForkDialog } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const PLAIN = "E2E Mobile Nav 素の Project";
const FORKED = "E2E Mobile Nav Fork のある Project";

test("携帯で、別 Project の Fork へも、Fork から別の Thread へも、Drawer を開き直さずに行ける", async ({ page }) => {
  await openApp(page);
  await createProject(page, PLAIN, mkdtempSync(join(tmpdir(), "banto-e2e-mobile-nav-a-")));
  await createProject(page, FORKED, mkdtempSync(join(tmpdir(), "banto-e2e-mobile-nav-b-")));

  // FORKED に Fork を1つ作る（1ターン終えて resume-point が立ってから分ける——project-thread-fork.spec.ts と同じ）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("目印" + fakeTurn({ say: "はい" }));
  await composer.press("Enter");
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const forked = projects.find((p: { name: string }) => p.name === FORKED);
  const baseThreadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${forked.id}/threads`, { headers })).json()
  )[0].id;
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${baseThreadId}`, { headers })).json()) as {
          resumePoint?: string;
        }).resumePoint,
      { timeout: 60_000, message: "1ターン目が終わって resume-point が立つまで" },
    )
    .toBeTruthy();
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  await expect(back).toBeVisible({ timeout: 15_000 });

  const nav = page.getByRole("button", { name: "Project と Thread の一覧を開く" }).locator("visible=true");
  const drawer = page.getByRole("dialog", { name: "Project と Thread の一覧" });
  const projectRow = (name: string) => drawer.getByTestId("sidebar-project-name").filter({ hasText: name });

  // ---- (2) Fork の面にも ≡ がある。そこから別 Project（Fork なし）へ1回で行ける -------------
  await expect(nav, "Fork の面に ≡ が無い").toHaveCount(1);
  await nav.click();
  await expect(drawer).toBeVisible();
  const forkName = (await drawer.getByTestId("sidebar-fork-name").first().textContent()) ?? "";
  expect(forkName).not.toBe("");
  await projectRow(PLAIN).click();
  // Fork の無い Project では選ぶものが無いので、今までどおり閉じる
  await expect(drawer, "Fork の無い Project を選んだのに Drawer が残った").toBeHidden({ timeout: 10_000 });
  await expect(page).toHaveURL(new RegExp(`/p/(?!${forked.id})`));
  await expect(page.getByPlaceholder(`${PLAIN} の Base Thread に送る`)).toBeVisible({ timeout: 30_000 });

  // ---- (1) Fork のある Project を押すと、Drawer は閉じずにその目次を開いて待つ ---------------
  await nav.click();
  await expect(drawer).toBeVisible();
  await projectRow(FORKED).click();
  await expect(page).toHaveURL(new RegExp(`/p/${forked.id}(\\?|$)`), { timeout: 15_000 });
  // 下の画面が替わったあとも Drawer が残り、その Project の Fork が見えている
  await expect(page.getByPlaceholder(`${FORKED} の Base Thread に送る`)).toBeAttached({ timeout: 30_000 });
  await expect(drawer, "Fork のある Project を選んだら Drawer が閉じた").toBeVisible();
  const forkRow = drawer.getByTestId("sidebar-fork-name").filter({ hasText: forkName });
  await expect(forkRow).toBeVisible();
  await forkRow.click();
  await expect(drawer).toBeHidden({ timeout: 10_000 });
  await expect(page).toHaveURL(/[?&]fork=/);
  await expect(back).toBeVisible({ timeout: 15_000 });
});
