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

/** banto の外（Incus）から見た、そのコンテナの上限 */
function containerLimit(projectId: string, key: string): string {
  const r = spawnSync("incus", ["config", "get", `banto-${projectId}`, key], { encoding: "utf8", input: "" });
  if (r.status !== 0) throw new Error(`incus config get が失敗しました：${r.stderr}`);
  return r.stdout.trim();
}

// **資源の上限**（決定・2026-10-02）：既定は host の資源から計算して付く。banto 全体の「残す分」と Project ごとの値を
// 画面で変えると、動いているコンテナに起こし直さずに効く。Project の値は banto 全体の上限より上げられない
test("資源の上限——既定で付き、banto 全体と Project ごとに画面から変えると、動いているコンテナにそのまま効く", async ({ page }) => {
  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Container Limits", root: mkdtempSync(join(tmpdir(), "banto-e2e-limits-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });
  await prepareModules(page, project.id);

  type Limits = { host: { memoryMiB: number; cpus: number }; ceiling: { memoryMiB: number; cpus: number; processes: number } };
  const before = (await (await page.request.get(`${CORE_BASE_URL}/api/container-limits`, { headers })).json()) as Limits;
  // 既定：4GiB・1コアを残す（中から見える資源で計算される）
  expect(containerLimit(project.id, "limits.memory")).toBe(`${before.ceiling.memoryMiB}MiB`);
  expect(before.ceiling.memoryMiB).toBe(Math.max(1024, before.host.memoryMiB - 4096));
  expect(containerLimit(project.id, "limits.processes")).toBe("8192");
  const startedAt = (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/container`, { headers }).then((r) => r.json())) as {
    container: { status: string };
  };
  expect(startedAt.container.status).toBe("Running");

  try {
    // ---- banto 全体：残すメモリを 5GiB に ----
    await openApp(page);
    await page.goto(`/settings?settings=1&section=container`);
    const panel = page.getByTestId("container-limits-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByTestId("container-limits-reserve-memory").fill("5");
    await panel.getByRole("button", { name: "保存する" }).click();
    const lowered = Math.max(1024, before.host.memoryMiB - 5120);
    await expect.poll(() => containerLimit(project.id, "limits.memory"), { timeout: 30_000 }).toBe(`${lowered}MiB`);

    // ---- Project ごと：メモリ 1.5GiB・CPU 1 コア。上げようとした値（プロセス数）は天井で止まる ----
    await page.goto(`/settings?project=${project.id}&section=project-general`);
    const limits = page.getByTestId("project-container-limits");
    await expect(limits).toBeVisible({ timeout: 30_000 });
    await limits.getByTestId("project-container-limits-memory").fill("1.5");
    await limits.getByTestId("project-container-limits-cpus").fill("1");
    await limits.getByTestId("project-container-limits-processes").fill("999999");
    await limits.getByRole("button", { name: "保存する" }).click();
    await expect(limits.getByTestId("project-container-limits-effective")).toHaveText("メモリ 1.5 GiB・CPU 1 コア分・プロセス 8192", { timeout: 30_000 });
    expect(containerLimit(project.id, "limits.memory")).toBe("1536MiB");
    expect(containerLimit(project.id, "limits.cpu.allowance")).toBe("100ms/100ms");
    expect(containerLimit(project.id, "limits.processes")).toBe("8192");
    // 中にも効いている（cgroup）、起こし直していない
    const inside = spawnSync("incus", ["exec", `banto-${project.id}`, "--", "cat", "/sys/fs/cgroup/memory.max"], { encoding: "utf8", input: "" });
    expect(inside.stdout.trim()).toBe(String(1536 * 1024 * 1024));

    // ---- 空欄に戻すと banto 全体の上限に戻る ----
    await limits.getByTestId("project-container-limits-memory").fill("");
    await limits.getByTestId("project-container-limits-cpus").fill("");
    await limits.getByTestId("project-container-limits-processes").fill("");
    await limits.getByRole("button", { name: "保存する" }).click();
    await expect.poll(() => containerLimit(project.id, "limits.memory"), { timeout: 30_000 }).toBe(`${lowered}MiB`);
  } finally {
    // 他の spec に残さない（core は全 spec で共有）
    await page.request.put(`${CORE_BASE_URL}/api/container-limits`, {
      headers,
      data: { hostReserveMemoryMiB: 4096, hostReserveCpus: 1, processes: 8192 },
    });
  }
});

// **上限に当たったら受信箱で知らせる**（決定・2026-10-05）：Project のメモリを絞り、中で上限を越えて使うと、
// カーネルが止めたことがその Project のお知らせとして出る
test("メモリの上限に当たってプロセスが止められたら、受信箱にその Project のお知らせが出る", async ({ page }) => {
  const project = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: "E2E Container OOM", root: mkdtempSync(join(tmpdir(), "banto-e2e-oom-")) },
    })
  ).json()) as { id: string };
  await page.request.post(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers });
  await prepareModules(page, project.id);
  const set = await page.request.put(`${CORE_BASE_URL}/api/projects/${project.id}/container/limits`, {
    headers,
    data: { memoryMiB: 512, cpus: null, processes: null },
  });
  expect(set.ok()).toBe(true);
  expect(containerLimit(project.id, "limits.memory")).toBe("512MiB");
  // 見張りが基準を取るまで待ってから越える（最初に見た値は知らせない）
  await page.waitForTimeout(5_000);
  const hog = spawnSync(
    "incus",
    ["exec", `banto-${project.id}`, "--", "/usr/local/bin/node", "-e", "const a=[];for(;;)a.push(Buffer.alloc(64<<20,1))"],
    { encoding: "utf8", input: "", timeout: 60_000 },
  );
  expect(hog.status, `上限を越えたのに止められていない：${hog.stderr}`).not.toBe(0);

  type Notice = { kind: string; projectId?: string; title?: string; detail?: string; acknowledged?: boolean };
  await expect
    .poll(
      async () => {
        const all = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Notice[];
        return all.find((i) => i.kind === "notice" && i.projectId === project.id && i.title?.includes("メモリの上限"))?.detail ?? null;
      },
      { timeout: 30_000, message: "受信箱にメモリの上限のお知らせが出ない" },
    )
    .toMatch(/プロセスがカーネルに止められました.*いまの上限：メモリ 0\.5 GiB/);
});
