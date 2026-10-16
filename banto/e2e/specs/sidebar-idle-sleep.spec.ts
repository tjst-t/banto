// **しばらく開いていない Project**（決定・2026-10-16、アーキ仕様 §2.2「しばらく開いていない Project」・v4-frontend.md §6.43、
// Backlog #356）。14日は待てないので、試験だけの口（config.json の `testOnlyIdleCheck`、`POST /api/test-only/idle-check`）で
// 時計を「15日後」の時刻で、名指しの Project だけ1回回す——ほかの試験の Project には触らない。
//
// 見るもの（規則14——押せたで終わらせず、host の記録・画面の文・数・名前と日数まで）：
//   1. ask（既定）：14日開いていない Project が、スリープ中の見出しのすぐ上の問いに出る（件数・名前と日数）。いま開いている
//      Project は host が候補にしていても問いに入れない
//   2. 「今はしない」で問いが消え、host の一覧からも idle が消え、`project-activity.json` に dismissedAt が残る
//   3. 問いの「スリープにする」で眠る（人が眠らせた——by human）。スリープ中へ移る
//   4. 「スリープ中」の見出しの「…」で選ぶ：自動でスリープにする → 時計で聞かずに眠る（by auto、行の「…」に「自動でスリープ」）
//   5. 何もしない → 時計が回っても眠らず、聞かない
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "../test-base.js";
import { AUTH_TOKEN, CORE_BASE_URL, DATA_DIR } from "../config.js";
import { createProject, currentProjectId, openApp } from "../helpers.js";

test.setTimeout(300_000);
test.use({ viewport: { width: 1280, height: 900 } });

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const stamp = Date.now().toString(36);
const IDLE = `開いていない ${stamp}`;
const OPEN = `開いている ${stamp}`;
const AUTO = `自動で眠る ${stamp}`;
const OFF = `何もしない ${stamp}`;
const DAY = 24 * 60 * 60 * 1000;

interface HostProject {
  id: string;
  name: string;
  sleep?: { since: string; by: string };
  idle?: { days: number; suggestSleep: boolean };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await api<T>(method, path, body);
  expect(res.status, `${method} ${path}：${JSON.stringify(res.body)}`).toBeLessThan(300);
  return res.body;
}
const projectOf = async (id: string) => (await api<HostProject[]>("GET", "/api/projects")).body.find((p) => p.id === id)!;

/** API で作る（Base の会話も。機械のトークンなので人の操作には数えない） */
async function makeProject(name: string): Promise<string> {
  const created = await ok<{ id: string }>("POST", "/api/projects", { name, root: mkdtempSync(join(tmpdir(), "banto-e2e-idle-")) });
  await ok("POST", `/api/projects/${created.id}/threads`);
  return created.id;
}

/** 時計を「今から days 日後」の時刻で、名指しの Project だけ1回回す */
async function idleCheck(projectIds: string[], days: number): Promise<void> {
  await ok("POST", "/api/test-only/idle-check", { now: new Date(Date.now() + days * DAY).toISOString(), projectIds });
}

function suggestion(page: Page): Locator {
  return page.getByTestId("sidebar-sleep-suggestion");
}
function sleepingRow(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-sleeping-project").filter({ has: page.getByTestId("sidebar-sleeping-name").getByText(name, { exact: true }) });
}
function awakeName(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-project-name").getByText(name, { exact: true });
}

async function openSleepSection(page: Page): Promise<void> {
  const heading = page.getByTestId("sidebar-sleep-heading");
  await expect(heading).toBeVisible({ timeout: 30_000 });
  if ((await heading.getAttribute("data-open")) === null) await heading.getByRole("button", { name: "スリープ中を開く" }).click();
}

/** 「スリープ中」の見出しの「…」で選ぶ。選ぶ前に、いま選ばれているものが host の値どおりかも見る */
async function chooseAutoSleep(page: Page, current: string, next: string): Promise<void> {
  const heading = page.getByTestId("sidebar-sleep-heading");
  await heading.hover();
  await heading.getByRole("button", { name: "スリープ中の設定" }).click();
  const menu = page.getByTestId("sidebar-auto-sleep-menu");
  await expect(menu.getByText("14日開いていない Project を")).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: current }), "いまの選択が host の値と違う").toHaveAttribute("aria-checked", "true");
  await expect(menu.getByText("スリープ中はコンテナ・Module・Service を止めて資源を返します。", { exact: false })).toBeVisible();
  await menu.getByRole("menuitemradio", { name: next }).click();
}

test("14日開いていない Project を聞く・「今はしない」で消える・自動で眠らせる・何もしない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const ours: string[] = [];
  try {
    expect((await ok<{ mode: string }>("GET", "/api/settings/auto-sleep")).mode, "既定が ask ではない").toBe("ask");
    const idleId = await makeProject(IDLE);
    ours.push(idleId);

    // いま開いている Project（画面から作る＝開く）
    await openApp(page);
    await createProject(page, OPEN, mkdtempSync(join(tmpdir(), "banto-e2e-idle-open-")));
    const openId = currentProjectId(page);
    ours.push(openId);
    await expect(awakeName(page, IDLE)).toBeVisible({ timeout: 30_000 });
    await expect(suggestion(page), "時計が回る前に聞いた").toHaveCount(0);

    // ---- 1. 15日後の時刻で時計を回すと、両方が候補になる。画面はいま開いている Project を入れない ----------------
    await idleCheck([idleId, openId], 1);
    expect((await projectOf(idleId)).idle, "1日では候補にならないはず").toBeUndefined();
    await idleCheck([idleId, openId], 15);
    expect((await projectOf(idleId)).idle).toEqual({ days: 15, suggestSleep: true });
    expect((await projectOf(openId)).idle, "host は開いているかを知らないので候補にする").toEqual({ days: 15, suggestSleep: true });
    await expect(suggestion(page)).toBeVisible({ timeout: 30_000 });
    await expect(suggestion(page)).toContainText("14日以上開いていない Project が 1 件あります");
    await expect(page.getByTestId("sidebar-sleep-suggestion-names")).toHaveText(`${IDLE}（15日）`);
    // 問いは一覧の中で、スリープ中の見出しより上（あれば）。行は起きたまま元の場所に残る
    await expect(awakeName(page, IDLE)).toBeVisible();

    // ---- 2. 「今はしない」で消える。host の一覧からも消え、dismissedAt が残る --------------------------------------
    await suggestion(page).getByRole("button", { name: "今はしない" }).click();
    await expect(suggestion(page), "「今はしない」で問いが消えない").toHaveCount(0, { timeout: 15_000 });
    expect((await projectOf(idleId)).idle).toBeUndefined();
    const activity = JSON.parse(readFileSync(join(DATA_DIR, "project-activity.json"), "utf8")) as Record<string, { dismissedAt?: string }>;
    expect(Date.now() - Date.parse(activity[idleId]?.dismissedAt ?? "0"), "dismissedAt が今になっていない").toBeLessThan(60_000);
    expect(activity[openId]?.dismissedAt, "名指ししていない Project まで「今はしない」にした").toBeUndefined();

    // ---- 3. さらに14日たったらまた聞く。問いの「スリープにする」で眠る（人が眠らせた） ------------------------------
    await idleCheck([idleId], 15);
    await expect(page.getByTestId("sidebar-sleep-suggestion-names")).toHaveText(`${IDLE}（15日）`, { timeout: 30_000 });
    await suggestion(page).getByRole("button", { name: "スリープにする" }).click();
    await expect.poll(async () => (await projectOf(idleId)).sleep?.by ?? "awake", { timeout: 120_000, message: "問いから眠らせられない" }).toBe("human");
    await expect(suggestion(page)).toHaveCount(0, { timeout: 15_000 });
    await openSleepSection(page);
    await expect(sleepingRow(page, IDLE)).toBeVisible({ timeout: 30_000 });
    await expect(awakeName(page, IDLE)).toHaveCount(0);

    // ---- 4. 自動でスリープにする：時計で聞かずに眠る -----------------------------------------------------------
    const autoId = await makeProject(AUTO);
    ours.push(autoId);
    await expect(awakeName(page, AUTO)).toBeVisible({ timeout: 30_000 });
    await chooseAutoSleep(page, "スリープにするか聞く", "自動でスリープにする");
    await expect.poll(async () => (await ok<{ mode: string }>("GET", "/api/settings/auto-sleep")).mode).toBe("auto");
    await idleCheck([autoId], 15);
    await expect.poll(async () => (await projectOf(autoId)).sleep?.by ?? "awake", { timeout: 120_000, message: "auto で眠らない" }).toBe("auto");
    expect((await projectOf(autoId)).idle, "auto なのに聞いた").toBeUndefined();
    await expect(suggestion(page)).toHaveCount(0);
    await expect(sleepingRow(page, AUTO)).toBeVisible({ timeout: 30_000 });
    await sleepingRow(page, AUTO).hover();
    await sleepingRow(page, AUTO).locator("xpath=..").getByTestId("sidebar-sleeping-more").click();
    await expect(page.getByRole("menu").getByText("自動でスリープ", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");

    // ---- 5. 何もしない：時計が回っても眠らず、聞かない --------------------------------------------------------
    const offId = await makeProject(OFF);
    ours.push(offId);
    await expect(awakeName(page, OFF)).toBeVisible({ timeout: 30_000 });
    await chooseAutoSleep(page, "自動でスリープにする", "何もしない");
    await expect.poll(async () => (await ok<{ mode: string }>("GET", "/api/settings/auto-sleep")).mode).toBe("off");
    await idleCheck([offId], 30);
    const off = await projectOf(offId);
    expect(off.sleep, "off なのに眠らせた").toBeUndefined();
    expect(off.idle, "off なのに聞いた").toBeUndefined();
    await expect(suggestion(page)).toHaveCount(0);
    await expect(awakeName(page, OFF)).toBeVisible();

    expect(pageErrors, "画面で例外が出た").toEqual([]);
  } finally {
    // ほかの試験に残さない：設定を既定へ戻し、この試験の候補を今の時刻で見直して消す
    await api("PUT", "/api/settings/auto-sleep", { mode: "ask" });
    if (ours.length > 0) await api("POST", "/api/test-only/idle-check", { now: new Date().toISOString(), projectIds: ours });
  }
});
