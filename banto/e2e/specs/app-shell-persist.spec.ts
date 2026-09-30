// **外枠は、面をまたいでも作り直さない**（`app-shell-shared-layout`、2026-09-10）。
//
// `/`・`/p/[id]`・`/settings` がそれぞれ AppShell を持っていたので、面をまたぐと
// トップバー・レール・その中で開いているもの（Command Palette 等）が**作り直される**。
// 実測（2026-09-06）：ホームで「新しい Project」を入力している最中に自動リダイレクトが
// 入ると、ダイアログごと入力が消えた。
//
// 作り直されたかどうかは**DOM の節が生き残るか**で見る——テストから印を付け、
// 面を移ったあとにも残っていれば、同じ節がそのまま使われている。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { openApp, openNav, createProject } from "../helpers.js";

test("面をまたいでも、外枠（レール）は作り直されない", async ({ page }) => {
  await openApp(page);
  if (!/\/p\//.test(page.url())) {
    await createProject(page, "外枠", mkdtempSync(join(tmpdir(), "banto-e2e-shell-")));
  }

  const rail = page.locator('[data-slot="sidebar"]').first();
  await expect(rail).toBeVisible();
  // その節にだけ印を付ける（React の管理外なので、作り直されれば消える）
  await rail.evaluate((el) => el.setAttribute("data-persist-probe", "1"));

  // Project → 設定
  await openNav(page);
  await page.getByRole("link", { name: "設定" }).click();
  await page.waitForURL(/[?&]settings=1/);
  await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
    "data-persist-probe",
    "1",
    { timeout: 10_000 },
  );

  // 設定 → Project（戻り）
  await openNav(page);
  await page.locator('[data-slot="sidebar"]').first().getByRole("link").first().click();
  await page.waitForURL(/\/p\//);
  await expect(page.locator('[data-slot="sidebar"]').first()).toHaveAttribute(
    "data-persist-probe",
    "1",
    { timeout: 10_000 },
  );
});

test("開いている「新しい Project」は、面を移っても入力ごと残る", async ({ page }) => {
  await openApp(page);
  if (!/\/p\//.test(page.url())) {
    await createProject(page, "外枠2", mkdtempSync(join(tmpdir(), "banto-e2e-shell2-")));
  }

  // このダイアログはレール（＝外枠）の中にある。外枠が作り直されると道連れになる
  await openNav(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  const name = page.getByLabel("Project 名");
  await expect(name).toBeVisible();
  await name.fill("入力の途中");

  // クライアント側で面を移る（ダイアログが上に居るので、押せるかは問わずに
  // click を投げる——ホームの自動リダイレクトと同じ「人が押していない移動」）
  // ダイアログが開いている間、背後は aria-hidden なので役割では引けない
  // 設定の口は Project の文脈を連れていく（§6.16——`?settings=1&project=…`、いまの画面の上に重ねる）
  await page.locator('a[href*="settings=1"]').first().dispatchEvent("click");
  await page.waitForURL(/[?&]settings=1/, { timeout: 10_000 });
  await expect(name).toHaveValue("入力の途中", { timeout: 10_000 });
});
