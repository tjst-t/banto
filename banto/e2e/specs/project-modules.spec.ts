// **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、2026-09-11、
// Phase 2 の入口）。形はモックで決めた（`docs/specs/v4-frontend.md` §6.15）。
//
// 見るのは「操作が通った」ではなく**効いたか**（規則14）——外したら、その Project で
// **本当に立たない**（host が用意する Module から消える）ところまで。

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openNav, openProjectSettings } from "../helpers.js";

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
  await openProjectSettings(page, "この Project の Module");

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
  await openProjectSettings(page, "この Project の Module");

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

test("一般：名前と Root を直せて、危険な操作（Close）はその下にある", async ({ page }) => {
  // 決定・2026-09-11（ユーザー要望）：Project の層のいちばん上に「一般」を置き、
  // 名前と Root を設定できるようにする。危険な操作（Close）はその画面の下。
  const first = mkdtempSync(join(tmpdir(), "banto-e2e-general-a-"));
  const next = mkdtempSync(join(tmpdir(), "banto-e2e-general-b-"));
  await openApp(page);
  await createProject(page, "一般の spec", first);

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })).json();
  const project = projects.find((p: { name: string }) => p.name === "一般の spec");

  await openProjectSettings(page, "一般");
  const panel = page.getByTestId("project-general-panel");
  await expect(panel, "一般が開かない").toBeVisible({ timeout: 20_000 });
  // **この Project の層のいちばん上が「一般」**（決定・2026-09-11）
  const projectLayerItems = await page
    .locator('p.tracking-wide:has-text("一般の spec") + div button')
    .allTextContents()
    .catch(() => [] as string[]);
  const layerLabels = projectLayerItems.length
    ? projectLayerItems
    : await page.evaluate(() => {
        const heads = [...document.querySelectorAll("p.tracking-wide")];
        const target = heads.find((h) => (h.textContent ?? "").includes("一般の spec"));
        const group = target?.parentElement;
        return [...(group?.querySelectorAll("button") ?? [])].map((b) => (b.textContent ?? "").trim());
      });
  expect(layerLabels[0], "この Project の層の先頭が「一般」ではない").toBe("一般");
  await expect(panel.getByLabel("Project 名")).toHaveValue("一般の spec");
  await expect(panel.getByLabel("Root パス")).toHaveValue(first);

  // ---- 名前と Root を、まとめて直す --------------------------------------
  await panel.getByLabel("Project 名").fill("一般の spec（改）");
  await panel.getByLabel("Root パス").fill(next);
  await page.getByTestId("project-general-bar").getByRole("button", { name: "保存する" }).click();
  await expect(page.getByTestId("project-general-bar"), "保存しても帯が残っている").toHaveCount(0, {
    timeout: 15_000,
  });

  // **host に残っている**——画面の覚えではない
  await expect
    .poll(
      async () => {
        const list = (await (
          await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers: HEADERS })
        ).json()) as Array<{ id: string; name: string; root: string }>;
        return list.find((p) => p.id === project.id);
      },
      { timeout: 15_000, message: "名前と Root が host に残っていない" },
    )
    .toMatchObject({ name: "一般の spec（改）", root: next });

  // **根を変えたら、その根で Module が立つ**（立て直しが効いている）
  await expect
    .poll(
      async () => {
        const res = await page.request.post(
          `${CORE_BASE_URL}/api/projects/${project.id}/modules/prepare`,
          { headers: HEADERS },
        );
        return ((await res.json()) as { connected: string[] }).connected;
      },
      { timeout: 30_000 },
    )
    .toContain("filesystem");

  // ---- 危険な操作は、同じ画面の下 ----------------------------------------
  await expect(panel.getByRole("heading", { name: "危険な操作" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "この Project を Close する" })).toBeVisible();
  // 「危険な操作」という節は、左メニューからは無くなった（一般の中へ移した）
  await expect(page.getByRole("button", { name: "危険な操作", exact: true })).toHaveCount(0);
});

test("会話のヘッダに、左と同じ入口（設定・履歴）を置かない", async ({ page }) => {
  // ユーザー指摘・2026-09-11：右上の設定・履歴はサイドバーの下と同じ機能しか
  // 無いので消す。同じ機能への入口を2つ持たない（規則3）
  await openApp(page);
  await createProject(page, "ヘッダの spec", mkdtempSync(join(tmpdir(), "banto-e2e-header-")));
  const header = page.locator("header").first();
  await expect(header.getByRole("button", { name: "Project 設定" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "履歴" })).toHaveCount(0);
  // 左には在る（消したのは重複だけ——行けなくなっていない）
  await expect(page.locator('[data-slot="sidebar"]').getByRole("link", { name: "設定", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="sidebar"]').getByRole("button", { name: "履歴" })).toBeVisible();
});

test("Root パスは、打っても選んでもよい", async ({ page }) => {
  // ユーザー要望・2026-09-11：フォルダ選択のダイアログを出して選べるように。
  // **文字入力も残したうえで**——打つほうが速いときもある。
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-pick-"));
  mkdirSync(join(root, "えらぶ先"), { recursive: true });
  await openApp(page);
  await createProject(page, "選ぶ spec", root);
  await openProjectSettings(page, "一般");

  const panel = page.getByTestId("project-general-panel");
  const input = panel.getByLabel("Root パス");
  await expect(input, "打てる入力欄が無い").toHaveValue(root);

  // ---- 選ぶ ---------------------------------------------------------------
  await panel.getByRole("button", { name: "選ぶ" }).click();
  const picker = page.getByTestId("path-picker");
  await expect(picker).toBeVisible({ timeout: 15_000 });
  // いま入っているパスから始まる（近くから探せる）
  await expect(picker.getByTestId("path-picker-current")).toHaveText(root);
  // 中のフォルダが並ぶ——**その場に在るものが出る**（規則14）
  await picker.getByTestId("path-picker-entry").filter({ hasText: "えらぶ先" }).click();
  await expect(picker.getByTestId("path-picker-current")).toHaveText(join(root, "えらぶ先"));
  // 1つ上へ戻れる
  await picker.getByRole("button", { name: "上へ" }).click();
  await expect(picker.getByTestId("path-picker-current")).toHaveText(root);
  // もう一度入って、ここにする
  await picker.getByTestId("path-picker-entry").filter({ hasText: "えらぶ先" }).click();
  await picker.getByRole("button", { name: "ここにする" }).click();
  await expect(picker).toBeHidden({ timeout: 10_000 });
  await expect(input, "選んだのに入力欄へ入っていない").toHaveValue(join(root, "えらぶ先"));

  // ---- 打つのも、そのままできる ------------------------------------------
  await input.fill(root);
  await expect(input).toHaveValue(root);
});

test("新しい Project：最初は空。選ぶと home から始まる", async ({ page }) => {
  // ユーザー指摘・2026-09-11：名前の例（「決済まわりの改修」）は要らない。
  // Root の初期値（`~/worktrees/`）もおかしい——**その場所を使うかは人が決める**。
  await openApp(page);
  await openNav(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();

  const dialog = page.getByRole("dialog").first();
  await expect(dialog.getByLabel("Project 名"), "名前に初期値が入っている").toHaveValue("");
  // 例の文言そのものが出ていないこと（placeholder 属性は無い＝null）
  expect(
    await dialog.getByLabel("Project 名").getAttribute("placeholder"),
    "名前に例が出ている",
  ).toBeNull();
  await expect(dialog.getByLabel("Root パス"), "Root に初期値が入っている").toHaveValue("");

  // **選ぶと home から始まる**（何も入っていないので、host の既定）
  await dialog.getByRole("button", { name: "選ぶ" }).click();
  const picker = page.getByTestId("path-picker");
  await expect(picker).toBeVisible({ timeout: 15_000 });
  const home = process.env.HOME ?? "";
  await expect(picker.getByTestId("path-picker-current")).toHaveText(home);
});
