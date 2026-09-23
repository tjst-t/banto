// **入力欄の下でモデルと reasoning effort を選ぶ**（決定・2026-09-23、ユーザー要望）。
//
// 見るのは「選べた」ではなく**そのモデルでターンが走ったこと**（規則14）——偽 Runner が
// 受け取ったモデルと effort を発言にする（`fake-runner.ts` の `sayRuntime`）。
// 会話の途中で変えると次の1ターンはキャッシュが効かないので、**変える前に確かめる**
// （やめたら変わらない）。選んだものはリロードしても残る（host が持つ）。
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };
const PROJECT_NAME = "E2E Thread Model";

async function hostThread(page: Page): Promise<{ id: string; model?: string; effort?: string; messages: Array<{ role: string }> }> {
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threads = await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })).json();
  return (await page.request.get(`${CORE_BASE_URL}/api/threads/${threads[0].id}`, { headers: HEADERS })).json();
}

async function assistantCount(page: Page): Promise<number> {
  return (await hostThread(page)).messages.filter((m) => m.role === "assistant").length;
}

test("選んだモデルと effort で次のターンが走り、リロードしても残り、途中で変えるときは確かめる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-model-"));
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  // ---- 一覧は host が CLI（ここでは偽物）に聞いたもの。選んでいなければ既定 ------
  const button = page.getByTestId("composer-model");
  await expect(button).toContainText("Default (recommended)", { timeout: 30_000 });
  // **前のメニューが閉じ切ってから開く**——選んだ直後はメニューが閉じる途中で、そこで
  // 押すと開かない（人の手より速く押している）。待つのは時間ではなく、閉じたこと
  const openMenu = async () => {
    await expect(page.getByRole("menu")).toHaveCount(0);
    await button.click();
    await expect(page.getByRole("menu")).toBeVisible();
  };

  // ---- 会話が始まる前は、確かめずに変わる ------------------------------------
  await openMenu();
  await expect(page.getByRole("menuitemradio")).toHaveText([
    /Default \(recommended\)/,
    /Sonnet/,
    /Haiku/,
    "既定",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  await page.getByRole("menuitemradio", { name: /^Sonnet/ }).click();
  await expect(button).toContainText("Sonnet");
  await openMenu();
  await page.getByRole("menuitemradio", { name: "low", exact: true }).click();
  await expect(button).toContainText("Sonnet");
  await expect(button).toContainText("low");
  await expect(page.getByTestId("composer-model-confirm")).toHaveCount(0);
  await expect.poll(async () => { const t = await hostThread(page); return `${t.model}/${t.effort}`; }).toBe("sonnet/low");

  // ---- そのモデルで走る ------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("どのモデルで答えている？" + fakeTurn({ sayRuntime: true }));
  await composer.press("Enter");
  await expect(page.getByText("model=sonnet effort=low"), "選んだモデルでターンが走っていない").toBeVisible({ timeout: 60_000 });
  await expect.poll(() => assistantCount(page), { timeout: 60_000 }).toBe(1);

  // ---- リロードしても残る（host が持っている）--------------------------------
  await page.reload();
  await expect(button).toContainText("Sonnet", { timeout: 30_000 });
  await expect(button).toContainText("low");

  // ---- 会話の途中で変えるときは確かめる。やめたら変わらない --------------------
  await openMenu();
  await page.getByRole("menuitemradio", { name: /^Haiku/ }).click();
  const confirm = page.getByTestId("composer-model-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("高くつきます");
  await confirm.getByRole("button", { name: "やめる" }).click();
  await expect(confirm).toBeHidden();
  await expect(button).toContainText("Sonnet");
  await expect.poll(async () => (await hostThread(page)).model).toBe("sonnet");

  // 変える——Haiku は effort を持たないので、effort は外れる
  await openMenu();
  await page.getByRole("menuitemradio", { name: /^Haiku/ }).click();
  await confirm.getByRole("button", { name: "変える" }).click();
  await expect(button).toContainText("Haiku");
  await expect(button).not.toContainText("low");
  await expect.poll(async () => { const t = await hostThread(page); return `${t.model}/${t.effort}`; }).toBe("haiku/undefined");
  await openMenu();
  await expect(page.getByRole("menuitemradio", { name: "low", exact: true }), "Haiku なのに effort の段が出ている").toHaveCount(0);
  await page.keyboard.press("Escape");

  // 次のターンは Haiku で走る
  await composer.fill("いまは？" + fakeTurn({ sayRuntime: true }));
  await composer.press("Enter");
  await expect(page.getByText("model=haiku effort=(既定)"), "変えたモデルで次のターンが走っていない").toBeVisible({ timeout: 60_000 });
});
