// **Fork を作る前に名前を聞く。ヘッダの Fork だけ「会話を引き継ぐか」を選べる**
// （決定・2026-10-02、ユーザー要望。v4-frontend.md §6.32）。
//
// 見るのは：
//   1. ヘッダの「Fork を開く」で名前と始め方を聞かれる。既定は「会話を引き継ぐ」。やめれば何も作らない
//   2. 名前を付けて「まっさらで始める」を選ぶと、その名前の Fork が会話も resume-point も持たずに立つ
//   3. 発言の下の「ここから Fork」は名前だけ聞き（始め方は出ない）、会話を引き継ぐ。空のままなら連番

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp } from "../helpers.js";

// 前面の1枚だけが出る幅で見る（同じ aria-label が Base と Fork に並ばない）
test.use({ viewport: { width: 390, height: 844 } });

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

type ThreadJson = {
  id: string;
  kind: string;
  title?: string;
  resumePoint?: string;
  messages: { role: string }[];
};

test("Fork は名前を聞いて作り、ヘッダからだけ「まっさらで始める」を選べる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "Fork の名前の spec", mkdtempSync(join(tmpdir(), "banto-e2e-forkdialog-")));

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === "Fork の名前の spec");
  const listThreads = async () =>
    (await (
      await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers: HEADERS })
    ).json()) as ThreadJson[];
  const getThread = async (id: string) =>
    (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${id}`, { headers: HEADERS })).json()) as ThreadJson;
  const baseId = (await listThreads())[0]!.id;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(`返事をください${fakeTurn({ say: "ひとつめの返事" })}`);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "ひとつめの返事" })).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await getThread(baseId)).resumePoint, { timeout: 60_000, message: "ターンが終わるまで" })
    .toBeTruthy();

  const dialog = page.getByTestId("fork-dialog");
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });

  // ---- 1. ヘッダの Fork：名前と始め方を聞く。やめれば作らない -------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radiogroup")).toBeVisible();
  await expect(dialog.getByTestId("fork-start-continue")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("fork-start-fresh")).toHaveAttribute("aria-checked", "false");
  await dialog.getByRole("button", { name: "やめる" }).click();
  await expect(dialog).toBeHidden();
  expect((await listThreads()).filter((t) => t.kind === "fork"), "やめたのに Fork ができた").toHaveLength(0);

  // ---- 2. 名前を付けて、まっさらで始める -------------------------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await dialog.getByLabel("名前").fill("調べもの");
  await dialog.getByTestId("fork-start-fresh").click();
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(back).toBeVisible({ timeout: 15_000 });
  const forkLayer = page.locator('[data-testid="panel-overlay"][data-layer="fork"]');
  await expect(forkLayer.getByText("調べもの", { exact: true }).first(), "付けた名前が題に出ない").toBeVisible();
  await expect(
    forkLayer.locator('[data-role="assistant"]'),
    "まっさらで始めたのに親の会話が写っている",
  ).toHaveCount(0);

  const fresh = (await listThreads()).find((t) => t.kind === "fork")!;
  expect(fresh.title).toBe("調べもの");
  const freshState = await getThread(fresh.id);
  expect(freshState.messages, "まっさらな Fork が親の会話を持っている").toHaveLength(0);
  expect(freshState.resumePoint, "まっさらな Fork が親のセッションを引き継いでいる").toBeUndefined();

  await back.click();
  await expect(back).toBeHidden({ timeout: 15_000 });

  // ---- 3. 発言の下の Fork：名前だけ聞き、会話を引き継ぐ ------------------------
  await page.locator('[data-role="assistant"]').last().hover();
  await page.getByTestId("fork-from-message").last().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radiogroup"), "発言の下の Fork で始め方を聞いている").toHaveCount(0);
  await dialog.getByTestId("fork-dialog-submit").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await expect(forkLayer.getByText("Fork 2", { exact: true }).first(), "名前が空なら連番になる").toBeVisible();

  const continued = (await listThreads()).find((t) => t.kind === "fork" && t.id !== fresh.id)!;
  expect(continued.title, "空の名前が名前として残った").toBeUndefined();
  const continuedState = await getThread(continued.id);
  expect(
    continuedState.messages.some((m) => m.role === "assistant"),
    "発言の下から分けた Fork が会話を引き継いでいない",
  ).toBe(true);
  expect(continuedState.resumePoint, "発言の下から分けた Fork がセッションを引き継いでいない").toBeTruthy();
});
