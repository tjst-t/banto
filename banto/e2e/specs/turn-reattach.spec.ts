// **開き直しても、走っているものは見える**（`turn-stream-reattach`、2026-09-10）。
//
// 実測（2026-09-10、直す前）：走行中にリロードすると、**出力どころか「走っている」
// ことすら画面から消える**——ターンのイベント列は `POST …/messages` の応答の中に
// しか無く、接続が切れたら戻る先が無かった。人からは「送ったのに何も起きていない」。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Turn Reattach Project";

test("走行中にリロードしても、そのターンに繋ぎ直して続きが見える", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-reattach-"));
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()
  )[0].id;

  // 少し長めのターンを始める（リロードする隙を作る）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("1 から 60 までの数字を、1行に1つずつ、番号だけ並べて出して。");
  await composer.press("Enter");
  await page.waitForTimeout(2500);

  // **走行中に開き直す**
  await page.reload();

  // 繋ぎ直した帯が出て、走っていることが分かる
  const band = page.locator('[data-testid="reattached-turn"]');
  await expect(band, "開き直したら、走っていることが画面から消えた").toBeVisible({ timeout: 30_000 });
  await expect(band.getByText(/このターンは走っています/)).toBeVisible();

  // **中身も戻る**——そのターンがここまでに出したものが見える（規則14）
  await expect
    .poll(async () => (await band.innerText()).length, { timeout: 60_000, message: "出力が戻るまで" })
    .toBeGreaterThan(60);

  // ターンが終わったら帯は消え、会話の記録に置き換わる
  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })
        ).json();
        return (t.messages as { role: string }[]).filter((m) => m.role === "assistant").length;
      },
      { timeout: 120_000, message: "ターンが終わるまで" },
    )
    .toBe(1);
  await expect(band, "終わったのに帯が残っている").toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText("60").first(), "記録から会話が戻っていない").toBeVisible({ timeout: 30_000 });
});
