// ユーザー報告（2026-09-06）2件の回帰。
//
// 1. permissionMode が記憶されない——リロードすると既定（auto）に戻っていた。
//    選んだ値は host が持つ（決定・2026-09-06）。
// 2. tool 呼び出しが2回あると、**答えていない判断待ちが「回答済みです」になる**
//    ——assistant-ui は結果の無い tool-call part の状態にメッセージ全体の状態を
//    そのまま使う（normalizePartStatus.js の toMessagePartStatus）ため、
//    1つ目の判断待ちの後に来たメッセージで running へ戻すと、まだ答えていない
//    2つ目まで巻き込んで答える口が消えていた。
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Permission Mode Project";

test("permissionModeはリロードしても残り、tool呼び出しが2回でも両方に答えられる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-perm-"));
  writeFileSync(join(projectRoot, "one.txt"), "ひとつめ\n");
  writeFileSync(join(projectRoot, "two.txt"), "ふたつめ\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  // --- 1. permissionMode を default にして、リロードしても残ること ---
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible();

  await page.reload();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 30_000 });
  // **リロード後も default のまま**（以前はここで auto に戻っていた）
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({
    timeout: 15_000,
  });

  // host 側にも残っている（真実は host——画面の表示だけで確かめない）
  const inboxBefore = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  expect(Array.isArray(inboxBefore)).toBe(true);

  // --- 2. tool 呼び出しを2回起こし、**2つとも**答えられること ---
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "filesystem の readFile で one.txt を読み、そのあと同じく readFile で two.txt も読んで、それぞれの中身を教えてください。",
  );
  await composer.press("Enter");

  // 1つ目の判断待ち
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();
  await expect(page.getByText("回答：許可する")).toBeVisible({ timeout: 60_000 });

  // 2つ目の判断待ち——**答える口があること**を見る（以前はここが
  // 「回答済みです」になり、誰も答えられないまま止まっていた）
  await expect
    .poll(
      async () => {
        const open = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return open.filter((i: { kind: string }) => i.kind === "judgment").length;
      },
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);

  await expect(page.getByRole("button", { name: "許可する" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  // 2つとも決着し、会話が最後まで進む
  await expect
    .poll(
      async () => {
        const open = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return open.filter((i: { kind: string }) => i.kind === "judgment").length;
      },
      { timeout: 120_000 },
    )
    .toBe(0);

  // 読んだ中身が実際に返ってくる（規則14——「進んだ」ではなく中身で見る）
  await expect(page.getByText(/ひとつめ/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/ふたつめ/)).toBeVisible({ timeout: 90_000 });

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
