// **Project のコンテナと「中で Docker を使う」**（決定・2026-09-25、`docs/specs/v4-security.md` §1）。
//
// 見るもの（規則14——押せたで終わらせず、画面の中身と、本当にコンテナに効いたかまで）：
//   1. Module を使うと Project のコンテナが立ち、設定の「一般」に状態が出る
//   2. 「中で Docker を使う」は既定で切れていて、コンテナにも掛かっていない
//   3. 入れると保存され（読み直しても入っている）、次に Module を使うときにコンテナに効く
//   4. 切ると元に戻る
import { test, expect, type Page } from "../test-base.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

/** banto の外（Incus）から見た、そのコンテナの設定——host の自己申告を信じない（規則1） */
function containerNesting(projectId: string): string {
  const r = spawnSync("incus", ["config", "get", `banto-${projectId}`, "security.nesting"], { encoding: "utf8", input: "" });
  if (r.status !== 0) throw new Error(`incus config get が失敗しました：${r.stderr}`);
  return r.stdout.trim();
}

/** Module を使う（＝コンテナを起こす・設定を合わせる）。shell が繋がるまで */
async function prepareModules(page: Page, projectId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/modules/prepare`, { headers });
        return ((await res.json()).connected ?? []) as string[];
      },
      { timeout: 120_000, message: "Module が繋がるまで" },
    )
    .toEqual(expect.arrayContaining(["shell", "filesystem"]));
}

async function nestingFromApi(page: Page, projectId: string): Promise<boolean> {
  const res = await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/container`, { headers });
  return ((await res.json()) as { nesting: boolean }).nesting;
}

test("中で Docker を使う——既定は切れていて、入れると保存され、次に使うときにコンテナに効く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Project Container", root: mkdtempSync(join(tmpdir(), "banto-e2e-container-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });

  // ---- 1. Module を使うとコンテナが立ち、画面に状態が出る --------------------------------------
  await prepareModules(page, project.id);
  await openApp(page);
  await page.goto(`/settings?project=${project.id}&section=project-general`);
  const section = page.getByTestId("project-container-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByTestId("project-container-status")).toHaveText("動いている", { timeout: 30_000 });

  // ---- 2. 既定は切れている（画面・host・コンテナの3箇所） ------------------------------------
  const toggle = section.getByTestId("project-container-nesting");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await nestingFromApi(page, project.id)).toBe(false);
  expect(containerNesting(project.id), "既定なのにコンテナで Docker が使える設定になっている").toBe("false");

  // ---- 3. 入れる → 保存される → 次に使うときコンテナに効く ------------------------------------
  await toggle.click();
  // **成功したときにだけ現れるもの**を待つ：保存が通ると host から読み直した値で描き直され、押せる状態に戻る
  await expect.poll(() => nestingFromApi(page, project.id), { timeout: 30_000 }).toBe(true);
  await expect(toggle).toBeEnabled({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await prepareModules(page, project.id);
  expect(containerNesting(project.id), "入れたのにコンテナに効いていない").toBe("true");

  // 読み直しても入っている（画面の思い込みではない）。立て直したあとも動いている
  await page.reload();
  await expect(section.getByTestId("project-container-nesting")).toHaveAttribute("aria-checked", "true", {
    timeout: 30_000,
  });
  await expect(section.getByTestId("project-container-status")).toHaveText("動いている");

  // ---- 4. 切ると元に戻る -----------------------------------------------------------------
  await section.getByTestId("project-container-nesting").click();
  await expect.poll(() => nestingFromApi(page, project.id), { timeout: 30_000 }).toBe(false);
  await expect(section.getByTestId("project-container-nesting")).toHaveAttribute("aria-checked", "false");
  await prepareModules(page, project.id);
  expect(containerNesting(project.id), "切ったのにコンテナで Docker が使える設定のまま").toBe("false");

  expect(pageErrors).toEqual([]);
});
