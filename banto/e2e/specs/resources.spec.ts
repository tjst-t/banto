// **資源の画面とサイドバーの混んでいる印**（決定・2026-10-09、ユーザー。v4-frontend.md §6.36・v4-security.md §1）。
//
// 見るもの（規則14——画面に出たで終わらせず、本当にコンテナの中で使った量で混むところまで）：
//   1. 設定の「資源」に、この機械と Project のコンテナが出て、開くと Module（shell）が内訳に並ぶ
//   2. コンテナの中でメモリを上限の 9 割より多く掴むと、その Project が「混んでいる」になり、サイドバーに印が出る
//   3. 放すと印が消える
import { test, expect, type Page } from "../test-base.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.setTimeout(240_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

async function prepareModules(page: Page, projectId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/modules/prepare`, { headers });
        return ((await res.json()).connected ?? []) as string[];
      },
      { timeout: 120_000, message: "Module が繋がるまで" },
    )
    .toEqual(expect.arrayContaining(["shell"]));
}

type Snapshot = { projects: Array<{ projectId: string; usedBytes: number; limitBytes?: number; busy: boolean }> };

async function projectResources(page: Page, projectId: string) {
  const snap = (await (await page.request.get(`${CORE_BASE_URL}/api/admin/resources`, { headers })).json()) as Snapshot | null;
  return snap?.projects.find((p) => p.projectId === projectId);
}

test("設定の「資源」に Project のコンテナと内訳が出て、メモリを上限の 9 割より多く使うと混んでいる印が出て、放すと消える", async ({ page }) => {
  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Resources", root: mkdtempSync(join(tmpdir(), "banto-e2e-resources-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });
  await prepareModules(page, project.id);

  // ---- 1. 画面に出る ----
  await openApp(page);
  await page.goto(`/p/${project.id}?settings=1&section=resources`);
  const panel = page.getByTestId("resources-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("resources-host")).toContainText("banto 本体");
  const row = panel.locator(`[data-testid="resources-project"][data-project-id="${project.id}"]`);
  await expect(row, "Project のコンテナが出る").toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("E2E Resources");
  await row.getByRole("button").first().click();
  await expect(row.locator('[data-testid="resources-group"][data-group="modules"]'), "内訳に Module（shell）").toContainText("shell");

  // ---- 2. 上限の 9 割より多く使うと混む ----
  const set = await page.request.put(`${CORE_BASE_URL}/api/projects/${project.id}/container/limits`, {
    headers,
    data: { memoryMiB: 1024, cpus: null, processes: null },
  });
  expect(set.ok()).toBe(true);
  await expect.poll(async () => (await projectResources(page, project.id))?.limitBytes, { timeout: 30_000 }).toBe(1024 * 1024 * 1024);
  const before = (await projectResources(page, project.id))!;
  const grabMiB = Math.ceil((0.95 * before.limitBytes! - before.usedBytes) / (1024 * 1024));
  expect(grabMiB, "掴む量").toBeGreaterThan(0);
  let hog: ChildProcess | undefined = spawn(
    "incus",
    [
      "exec",
      `banto-${project.id}`,
      "--",
      "/usr/local/bin/node",
      "-e",
      `const b=Buffer.alloc(${grabMiB}*1024*1024,1);console.log("held");setInterval(()=>b[0]++,1000)`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const mark = page.getByTestId("sidebar-project-busy");
    await expect(mark, "サイドバーに混んでいる印").toBeVisible({ timeout: 60_000 });
    await expect(mark).toHaveAttribute("aria-label", "E2E Resources が混んでいます");
    await expect(row.getByTestId("resources-chip")).toHaveAttribute("data-busy", "", { timeout: 30_000 });
    await expect(row.getByTestId("resources-project-detail")).toContainText("メモリが上限の");

    // ---- 3. 放すと消える ----
    hog.kill("SIGKILL");
    spawn("incus", ["exec", `banto-${project.id}`, "--", "pkill", "-f", "Buffer.alloc"], { stdio: "ignore" });
    hog = undefined;
    await expect(mark, "放したら印が消える").toBeHidden({ timeout: 60_000 });
  } finally {
    hog?.kill("SIGKILL");
  }
});
