// **本文のリンクは別タブで開く**（追加・2026-09-18、ユーザー要望）。
//
// 同じタブで出ていくと**会話から離れてしまう**——走行中のターンがあれば、
// そこへ戻る道も分からなくなる。
//
// **属性まで見る**（規則14）。「リンクが出た」では見たことにならない
// ——`target` が付いていなければ同じタブで開くし、`rel` が無ければ開いた先から
// `window.opener` でこちらのタブを触れる。
//
// **AI の気分に依存させない**ために、書いてもらうのは「そのまま写す1行」だけ
// （4回続けて通ることを測ってから入れた——`docs/notes/2026-09-18-connect-gate.md`）。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApp, createProject, fakeTurn } from "../helpers.js";

test.setTimeout(240_000);

test("本文のリンクは別タブで開く（target と rel まで見る）", async ({ page }) => {
  await openApp(page);
  await createProject(page, `E2E Links ${Date.now()}`, mkdtempSync(join(tmpdir(), "banto-e2e-links-")));

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "リンクを1つ書いてください。" + fakeTurn({ say: "[example](https://example.com/)" }),
  );
  await composer.press("Enter");

  const link = page
    .locator('[data-slot="aui_assistant-message-root"] a[href="https://example.com/"]')
    .first();
  await expect(link, "本文にリンクが出ない").toBeVisible({ timeout: 180_000 });

  expect(await link.getAttribute("target"), "同じタブで開いてしまう").toBe("_blank");
  // **`noopener` が無いと、開いた先からこちらのタブを触れる**
  expect(await link.getAttribute("rel") ?? "", "rel が付いていない").toContain("noopener");
});
