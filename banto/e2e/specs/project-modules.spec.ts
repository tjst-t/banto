// **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、2026-09-11、
// Phase 2 の入口）。形はモックで決めた（`docs/specs/v4-frontend.md` §6.15）。
//
// 見るのは「操作が通った」ではなく**効いたか**（規則14）——外したら、その Project で
// **本当に立たない**（host が用意する Module から消える）ところまで。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.setTimeout(300_000);

const HEADERS = { authorization: `Bearer ${AUTH_TOKEN}` };

test("Module をその場で外して保存すると、その Project では立たなくなる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "Module 選択", mkdtempSync(join(tmpdir(), "banto-e2e-modsel-")));

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === "Module 選択");

  // 最初は全部繋がっている（host の宣言がそのまま）
  const prepared = await (
    await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`, { headers: HEADERS })
  ).json();
  expect(prepared.connected, "はじめから filesystem が繋がっていない").toContain("filesystem");

  // ---- 設定の「この Project の Module」へ ---------------------------------
  await page.getByRole("button", { name: "Project 設定" }).click();
  await page.waitForURL(/\/settings\?project=/, { timeout: 20_000 });
  await page.getByRole("button", { name: "この Project の Module" }).click();

  const fsRow = page.locator('[data-testid="module-row"][data-module="filesystem"]');
  await expect(fsRow, "Module の一覧が出ていない").toBeVisible({ timeout: 20_000 });
  await expect(fsRow).toHaveAttribute("data-state", "linked");
  // 宣言から出している中身（役割・どこに1本立つか・閉じ込め）
  await expect(fsRow.getByText("filesystem", { exact: true }).first()).toBeVisible();
  await expect(fsRow.getByText("この Project に1本")).toBeVisible();
  await expect(fsRow.getByText("Project の外は読めない")).toBeVisible();

  // ---- ダイアログ無しで外し、保存で差分を確かめる --------------------------
  await fsRow.getByRole("button", { name: /外す/ }).click();
  await expect(page.locator('[role="alertdialog"]'), "外した瞬間に確認が出ている").toHaveCount(0);
  await expect(fsRow).toHaveAttribute("data-state", "removed");
  const bar = page.getByTestId("module-draft-bar");
  await expect(bar).toContainText("未保存の変更 1 件");

  await bar.getByRole("button", { name: "保存する" }).click();
  const dialog = page.getByTestId("module-save-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText("filesystem");
  await expect(dialog).toContainText("この Project 用の1つが落ちる");
  await dialog.getByRole("button", { name: "保存する" }).click();

  // 保存したら帯が消え、行は「繋げる Module」側になる
  await expect(bar).toHaveCount(0, { timeout: 15_000 });
  await expect(fsRow).toHaveAttribute("data-state", "off", { timeout: 15_000 });

  // ---- **本当に立たない**（host が用意する Module から消えた） --------------
  await expect
    .poll(
      async () => {
        const res = await page.request.post(
          `${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`,
          { headers: HEADERS },
        );
        return ((await res.json()) as { connected: string[] }).connected;
      },
      { timeout: 30_000, message: "外したのに filesystem が立ち続けている" },
    )
    .not.toContain("filesystem");

  // 開き直しても外れたまま（host が覚えている——ブラウザの覚えではない）
  await page.reload();
  await expect(fsRow).toHaveAttribute("data-state", "off", { timeout: 30_000 });

  // ---- 繋ぎ直すと戻る ----------------------------------------------------
  await fsRow.getByRole("button", { name: /繋ぐ/ }).click();
  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存する" }).click();
  await page.getByTestId("module-save-dialog").getByRole("button", { name: "保存する" }).click();
  await expect(fsRow).toHaveAttribute("data-state", "linked", { timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const res = await page.request.post(
          `${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`,
          { headers: HEADERS },
        );
        return ((await res.json()) as { connected: string[] }).connected;
      },
      { timeout: 30_000, message: "繋ぎ直したのに立たない" },
    )
    .toContain("filesystem");
});

test("要るものを外すと、その場で警告が出る（保存の差分にも出る）", async ({ page }) => {
  await openApp(page);
  await createProject(page, "依存の警告", mkdtempSync(join(tmpdir(), "banto-e2e-moddep-")));
  await page.getByRole("button", { name: "Project 設定" }).click();
  await page.waitForURL(/\/settings\?project=/, { timeout: 20_000 });
  await page.getByRole("button", { name: "この Project の Module" }).click();

  // shell は vault が要る（宣言の dependsOn）——vault を外すと shell が動かない
  const shellRow = page.locator('[data-testid="module-row"][data-module="shell"]');
  await expect(shellRow).toBeVisible({ timeout: 20_000 });
  await expect(shellRow.getByText(/vault が要る/)).toBeVisible();

  await page.locator('[data-testid="module-row"][data-module="vault"]').getByRole("button", { name: /外す/ }).click();
  await expect(
    shellRow.getByText(/このままでは動きません/),
    "要るものを外したのに、その場で何も言わない",
  ).toBeVisible({ timeout: 10_000 });

  await page.getByTestId("module-draft-bar").getByRole("button", { name: "保存する" }).click();
  await expect(page.getByTestId("module-save-dialog")).toContainText("「shell」");
  await page.getByTestId("module-save-dialog").getByRole("button", { name: "やめる" }).click();
  // やめたのだから、何も変わっていない
  await expect(page.getByTestId("module-draft-bar")).toContainText("未保存の変更 1 件");
});
