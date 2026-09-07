// Fork Thread が親と**別のSDKセッション**で走ることの回帰
// （アーキ仕様§2.2「Fork Thread の最初のターンで、セッションを分岐させる」、
// 決定・2026-09-05）。
//
// 分岐させないと、引き継いだresume-pointをそのまま`resume`することになり、
// Base と Fork が**同じセッションを共有して会話が1本に混ざる**——実際に
// そうなっていた（ユーザー報告・2026-09-05。Base側のAIが「直前のターンは
// Forkでした」と答え、Forkの話が Base の文脈に出ていた）。
//
// AIの返信内容そのものではなく、**記録されたresume-point**で見る
// （非決定的なものに依存しない、規則1）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Fork Session Project";

test("Fork Threadの最初のターンで、親と別のセッションへ分岐する", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-fork-session-"));
  const apiHeaders = { authorization: `Bearer ${AUTH_TOKEN}` };

  type ThreadRecord = { id: string; kind: string; resumePoint?: string; ownsSession: boolean };
  async function threads(): Promise<ThreadRecord[]> {
    const projects = await (
      await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: apiHeaders })
    ).json();
    const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
    if (!project) return [];
    return await (
      await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: apiHeaders })
    ).json();
  }

  await openApp(page);

  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // Base Threadで1ターン。**resume-pointが記録されるまで**待つ——バブルが
  // 見えた時点ではまだ生成中でありうる（記録はSSEの"done"で入る）。
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("目印として「親の枝111」と1語だけ返してください。");
  await composer.press("Enter");
  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: "親の枝111" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await threads()).find((t) => t.kind === "base")?.resumePoint ?? null, { timeout: 30_000 })
    .not.toBeNull();

  const baseBefore = (await threads()).find((t) => t.kind === "base")!;

  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(page.getByText(/Fork Thread —/)).toBeVisible({ timeout: 15_000 });

  // 作られた直後は親のresume-pointを**借りている**だけ（自分のものではない）
  const forkAtCreation = (await threads()).find((t) => t.kind === "fork")!;
  expect(forkAtCreation.resumePoint).toBe(baseBefore.resumePoint);
  expect(forkAtCreation.ownsSession).toBe(false);

  // Fork Threadで1ターン走らせると、ここでセッションが分岐する
  const forkComposer = page.getByPlaceholder(/に送る/).last();
  await forkComposer.fill("目印として「枝の先222」と1語だけ返してください。");
  await forkComposer.press("Enter");
  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: "枝の先222" }).last(),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await threads()).find((t) => t.kind === "fork")?.ownsSession ?? false, { timeout: 30_000 })
    .toBe(true);

  const after = await threads();
  const base = after.find((t) => t.kind === "base")!;
  const fork = after.find((t) => t.kind === "fork")!;

  expect(fork.resumePoint).toBeTruthy();
  expect(fork.resumePoint).not.toBe(base.resumePoint);
  // 親の枝は元のまま続けられる（§8「元の枝もそのまま続けられる」）
  expect(base.resumePoint).toBe(baseBefore.resumePoint);
});
