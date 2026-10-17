// **サイドバーで Project を眠らせる・起こす**（決定・2026-10-16、v4-frontend.md §6.43「スリープ」、Backlog #355）。
//
// 見るもの（規則14——押せたで終わらせず、host の記録・コンテナ・画面に出る並びと文まで）：
//   1. 断られたら理由がそのまま出る（ターンが走っている）。眠らず、行はグループに残る
//   2. 止まるもの（Terminal のセッション）があれば確かめの小窓に並ぶ。「スリープにする」で眠り、行は一番下の
//      「スリープ中」へ移る（枠だけの頭文字・薄い名前・元のグループの点）。コンテナが止まる
//   3. ドラッグ：起きている行を「スリープ中」の見出しへ＝眠らせる、スリープ中の行をグループの見出しへ＝起こしてそこへ
//   4. グループの見出しの「…」の「中の Project を全部スリープに」、スリープ中の行の「…」の「起こすだけ」
//   5. スリープ中の行を押すと起きて、その Project で最後に開いていた Thread（Fork）が開く
//   6. 開いている Project が眠ると会話の上に「スリープ中です」の帯、「起こす」で起きて帯が消える
//   7. 「スリープ中」の開閉はこの端末（`banto.sidebarGroups.v1`）に残る
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

test.setTimeout(420_000);
test.use({ viewport: { width: 1280, height: 900 } });

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const stamp = Date.now().toString(36);
const P1 = `眠り一 ${stamp}`;
const P2 = `眠り二 ${stamp}`;
const P3 = `眠り三 ${stamp}`;
const GROUP = `眠りの群 ${stamp}`;
const SESSION = `e2e-sleep-${stamp}`;

interface HostProject {
  id: string;
  name: string;
  groupId?: string;
  sleep?: { since: string; by: string };
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${CORE_BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const projectOf = async (id: string) => (await api<HostProject[]>("GET", "/api/projects")).body.find((p) => p.id === id)!;
const sleepOf = async (id: string) => (await projectOf(id)).sleep?.by ?? "awake";

function containerState(projectId: string): string {
  return spawnSync("incus", ["list", `banto-${projectId}`, "-f", "csv", "-c", "s"], { encoding: "utf8", input: "" }).stdout.trim();
}

/** 起きている行（Project の名前の行） */
function awakeRow(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-project-name").filter({ hasText: name }).first().locator("xpath=ancestor::*[@data-sortable-id][1]");
}
function awakeHandle(page: Page, name: string): Locator {
  return page
    .getByTestId("sidebar-project-name")
    .filter({ hasText: name })
    .first()
    .locator('xpath=ancestor::*[@data-slot="context-menu-trigger"][1]');
}
/** スリープ中の行（押す所） */
function sleepingRow(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-sleeping-project").filter({ has: page.getByTestId("sidebar-sleeping-name").getByText(name, { exact: true }) });
}
function sleepHeading(page: Page): Locator {
  return page.getByTestId("sidebar-sleep-heading");
}
function groupHeading(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-group").filter({ has: page.getByTestId("sidebar-group-name").getByText(name, { exact: true }) });
}

/** 一覧（`sidebar-project-list`）の並び——グループの見出しは「# 名前」、スリープ中の行は「z 名前」。この試験のものだけ */
async function layout(page: Page): Promise<string[]> {
  const rows = await page
    .getByTestId("sidebar-project-list")
    .first()
    .evaluate((ul) =>
      [...ul.children].map((li) => {
        if (li.getAttribute("data-testid") === "sidebar-group") return `# ${li.querySelector('[data-testid="sidebar-group-name"]')?.textContent ?? ""}`;
        const sleeping = li.querySelector('[data-testid="sidebar-sleeping-name"]')?.textContent;
        if (sleeping) return `z ${sleeping}`;
        return li.querySelector('[data-testid="sidebar-project-name"]')?.textContent ?? null;
      }),
    );
  const ours = [P1, P2, P3, GROUP];
  return rows.filter((r): r is string => r !== null && ours.some((n) => r === n || r === `# ${n}` || r === `z ${n}`));
}
function expectLayout(page: Page, expected: string[], message: string) {
  return expect.poll(() => layout(page), { timeout: 30_000, message }).toEqual(expected);
}

/** スリープ中を開いておく（既定は畳んである） */
async function openSleepSection(page: Page) {
  const heading = sleepHeading(page);
  await expect(heading, "スリープ中の見出しが出ない").toBeVisible({ timeout: 30_000 });
  if ((await heading.getAttribute("data-open")) === null) await heading.getByRole("button", { name: "スリープ中を開く" }).click();
  await expect(heading).toHaveAttribute("data-open", "");
}

/** 掴んで `target` の上に落とす。掴めていること・落とす先が示されていることを見る */
async function dragOnto(page: Page, from: Locator, target: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 5 });
  await expect(page.locator("[data-dragging]"), "掴めていない").toHaveCount(1);
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(target, "落とす先が示されていない").toHaveAttribute("data-drop-over", "");
  await page.mouse.up();
}

async function sleepByMenu(page: Page, name: string) {
  const row = awakeRow(page, name);
  await row.hover();
  await row.getByTestId("sidebar-item-more").first().click();
  await page.getByRole("menuitem", { name: "スリープにする" }).click();
}

test("行の「…」・ドラッグ・グループの見出しで眠らせ、断られた理由と止まるものの確かめが出て、押すと起きて最後の Thread が開く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, P1, mkdtempSync(join(tmpdir(), "banto-e2e-sleep-ui-1-")));
  const p1 = currentProjectId(page);
  await createProject(page, P2, mkdtempSync(join(tmpdir(), "banto-e2e-sleep-ui-2-")));
  const p2 = currentProjectId(page);
  await createProject(page, P3, mkdtempSync(join(tmpdir(), "banto-e2e-sleep-ui-3-")));
  const p3 = currentProjectId(page);
  const threads = async (id: string) => (await api<Array<{ id: string; kind: string }>>("GET", `/api/projects/${id}/threads`)).body;
  const p1Base = (await threads(p1)).find((t) => t.kind === "base")!.id;
  const p2Base = (await threads(p2)).find((t) => t.kind === "base")!.id;

  // P1 と P2 をグループに入れる（スリープ中の行に元のグループの点が出る・起こしてグループへ戻すのを見る）
  const group = await api<{ id: string }>("POST", "/api/project-groups", { name: GROUP });
  expect(group.status, JSON.stringify(group.body)).toBe(201);
  for (const id of [p1, p2]) expect((await api("PUT", `/api/projects/${id}/group`, { groupId: group.body.id })).status).toBe(200);

  // P1 に Fork を立てて開く——「最後に開いていた Thread」になる
  const fork = await api<{ id: string }>("POST", `/api/threads/${p1Base}/fork`, { title: "眠る前の Fork", fresh: true });
  expect(fork.status).toBe(201);
  await page.goto(`/p/${p1}?fork=${fork.body.id}`);
  // Fork を開くと Base は隠れたまま DOM に残る（panel-stack.tsx）——Base と Fork の中身は一緒に読み込まれ、DOM では Base の
  // 入力欄が先に来るので、`/に送る/` の1つ目は隠れた Base の入力欄になる。前面の Fork の入力欄を名指しで待つ
  await expect(page.getByPlaceholder("この Fork Thread に送る")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("眠る前の Fork").first()).toBeVisible({ timeout: 30_000 });
  // P3 の画面へ移る（P1 の画面を開いたままだと、画面が開き直したときに起こす）
  await page.goto(`/p/${p3}`);
  await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
  await expectLayout(page, [P3, `# ${GROUP}`, P1, P2], "初めの並びが違う");

  // ---- 1. 断られた理由（ターンが走っている）--------------------------------------------------------------------------
  const running = fetch(`${CORE_BASE_URL}/api/threads/${p2Base}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "考えて。" + fakeTurn({ thinkMs: 15_000, say: "考え終えました" }) }),
  }).then((r) => r.text());
  await expect
    .poll(async () => (await api<{ lastTurn?: { cause: string; outcome?: string } }>("GET", `/api/threads/${p2Base}`)).body.lastTurn, {
      timeout: 30_000,
      message: "ターンが始まらない",
    })
    .toMatchObject({ cause: "human" });
  await sleepByMenu(page, P2);
  await expect(page.getByText(new RegExp(`「${P2}」をスリープにできませんでした：ターンが走っています`)).first(), "断られた理由が出ない").toBeVisible({
    timeout: 15_000,
  });
  expect(await sleepOf(p2), "断られたのに眠った").toBe("awake");
  await expectLayout(page, [P3, `# ${GROUP}`, P1, P2], "断られたのに並びが変わった");
  await running;
  await waitTurnEnded(page, p2Base, 1);

  // ---- 2. 止まるもの（Terminal のセッション）を確かめてから眠らせる ------------------------------------------------------
  expect(containerState(p1), "P1 のコンテナが動いていない").toBe("RUNNING");
  const tmux = spawnSync(
    "incus",
    ["exec", `banto-${p1}`, "--user", String(process.getuid!()), "--group", String(process.getgid!()), "--", "tmux", "-L", "banto-terminal", "new-session", "-d", "-s", SESSION, "sleep 600"],
    { encoding: "utf8", input: "" },
  );
  expect(tmux.status, tmux.stderr).toBe(0);
  const preview = await api<{ stops: Array<{ label: string }> }>("GET", `/api/projects/${p1}/sleep-preview`);
  expect(preview.body.stops.map((s) => s.label), "止まるものに Terminal のセッションが出ない").toContain(`Terminal のセッション「${SESSION}」が開いています`);

  await sleepByMenu(page, P1);
  const confirm = page.getByTestId("sleep-confirm");
  await expect(confirm, "止まるものがあるのに確かめが出ない").toBeVisible({ timeout: 15_000 });
  await expect(confirm.getByRole("heading")).toHaveText(`「${P1}」をスリープにしますか`);
  await expect(confirm.getByTestId("sleep-confirm-stops")).toHaveText(`Terminal のセッション「${SESSION}」が開いています`);
  await expect(confirm).toContainText("眠っている間は止まります。公開中の URL には届きません。起こすと Service はまた動きます");
  // やめれば眠らない
  await confirm.getByRole("button", { name: "やめる" }).click();
  await expect(confirm).toBeHidden();
  await page.waitForTimeout(1_000);
  expect(await sleepOf(p1), "やめたのに眠った").toBe("awake");

  await sleepByMenu(page, P1);
  await expect(confirm).toBeVisible({ timeout: 15_000 });
  await confirm.getByRole("button", { name: "スリープにする" }).click();
  await expect.poll(() => sleepOf(p1), { timeout: 60_000, message: "スリープにしても眠らない" }).toBe("human");
  await expect.poll(() => containerState(p1), { timeout: 60_000, message: "眠ったのにコンテナが止まらない" }).toBe("STOPPED");
  // 一番下の「スリープ中」へ（既定は畳んである——行は見えず、数だけ）
  await expect(sleepHeading(page)).toBeVisible({ timeout: 30_000 });
  expect(await sleepHeading(page).getAttribute("data-open"), "スリープ中が既定で開いている").toBeNull();
  await expectLayout(page, [P3, `# ${GROUP}`, P2], "眠った Project がグループに残っている");
  await openSleepSection(page);
  await expectLayout(page, [P3, `# ${GROUP}`, P2, `z ${P1}`], "眠った Project が一番下に出ない");
  // 頭文字は枠だけ・元のグループの点
  const p1Sleeping = sleepingRow(page, P1);
  await expect(p1Sleeping.getByTestId("sidebar-sleeping-group-dot")).toHaveAttribute("data-group-id", group.body.id);
  await expect(p1Sleeping.locator("span").first()).toHaveClass(/border/);
  // 開閉はこの端末に残る
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("banto.sidebarGroups.v1") ?? "{}").sleepOpen)).toBe(true);
  // 「…」の頭にいつから
  await p1Sleeping.hover();
  await p1Sleeping.locator("xpath=..").getByTestId("sidebar-sleeping-more").click();
  await expect(page.getByText(/\d+月\d+日からスリープ中/).first()).toBeVisible();
  await page.keyboard.press("Escape");

  // ---- 3. ドラッグで眠らせる（P2 → スリープ中の見出し）・起こしてグループへ（P2 → グループの見出し） ------------------
  await dragOnto(page, awakeHandle(page, P2), sleepHeading(page));
  await expect.poll(() => sleepOf(p2), { timeout: 60_000, message: "スリープ中へ落としても眠らない" }).toBe("human");
  await expectLayout(page, [P3, `# ${GROUP}`, `z ${P1}`, `z ${P2}`], "落とした Project がスリープ中に出ない");

  await dragOnto(page, sleepingRow(page, P2).locator("xpath=.."), groupHeading(page, GROUP));
  await expect.poll(() => sleepOf(p2), { timeout: 60_000, message: "グループへ落としても起きない" }).toBe("awake");
  expect((await projectOf(p2)).groupId).toBe(group.body.id);
  await expectLayout(page, [P3, `# ${GROUP}`, P2, `z ${P1}`], "起こした Project がグループに戻らない");
  await expect.poll(() => containerState(p2), { timeout: 60_000, message: "起こしたのにコンテナが起きない" }).toBe("RUNNING");

  // ---- 4. グループの「中の Project を全部スリープに」・スリープ中の行の「起こすだけ」 ------------------------------------
  const heading = groupHeading(page, GROUP);
  await heading.hover();
  await heading.getByTestId("sidebar-group-more").click();
  await page.getByRole("menuitem", { name: "中の Project を全部スリープに" }).click();
  await expect.poll(() => sleepOf(p2), { timeout: 60_000, message: "全部スリープにしても眠らない" }).toBe("human");
  await expectLayout(page, [P3, `# ${GROUP}`, `z ${P1}`, `z ${P2}`], "全部スリープにした Project がスリープ中に出ない");
  const p2Sleeping = sleepingRow(page, P2);
  await p2Sleeping.hover();
  await p2Sleeping.locator("xpath=..").getByTestId("sidebar-sleeping-more").click();
  await page.getByRole("menuitem", { name: "起こすだけ（開かない）" }).click();
  await expect.poll(() => sleepOf(p2), { timeout: 60_000, message: "起こすだけで起きない" }).toBe("awake");
  await expectLayout(page, [P3, `# ${GROUP}`, P2, `z ${P1}`], "起こしたのにグループに戻らない");
  expect(page.url(), "起こすだけなのに開いた").toContain(`/p/${p3}`);

  // ---- 5. スリープ中の行を押すと起きて、最後に開いていた Fork が開く ------------------------------------------------------
  await sleepingRow(page, P1).click();
  await page.waitForURL(new RegExp(`/p/${p1}\\?fork=${fork.body.id}`), { timeout: 15_000 });
  await expect.poll(() => sleepOf(p1), { timeout: 60_000, message: "押しても起きない" }).toBe("awake");
  await expect.poll(() => containerState(p1), { timeout: 60_000, message: "起きたのにコンテナが起きない" }).toBe("RUNNING");
  await expect(page.getByText("眠る前の Fork").first(), "最後に開いていた Fork が開かない").toBeVisible({ timeout: 30_000 });
  // 帯は Base と Fork の面にそれぞれある（Fork を開いても Base は隠れたまま残る）——起きたらどちらも消える
  await expect(page.getByTestId("project-sleep-banner"), "起きたのに帯が残っている").toHaveCount(0, { timeout: 60_000 });
  await expectLayout(page, [P3, `# ${GROUP}`, P1, P2], "起きた Project がグループに戻らない");
  // スリープ中が空になれば見出しも消える
  await expect(sleepHeading(page).filter({ hasText: "スリープ中" })).toHaveCount((await api<HostProject[]>("GET", "/api/projects")).body.some((p) => p.sleep) ? 1 : 0);

  // ---- 6. 開いている Project が眠ると会話の上に帯、「起こす」で起きる ----------------------------------------------------
  await sleepByMenu(page, P1);
  // Terminal のセッションはコンテナと一緒に止まったので、確かめずに眠る
  await expect.poll(() => sleepOf(p1), { timeout: 60_000, message: "開いている Project が眠らない" }).toBe("human");
  // 前面の Fork の帯（隠れた Base の面にも同じ帯がある）
  const banner = page.getByTestId("panel-overlay").getByTestId("project-sleep-banner");
  await expect(banner).toHaveAttribute("data-state", "asleep", { timeout: 30_000 });
  await expect(banner).toContainText("スリープ中です。会話は読めます。送ると起きます");
  await banner.getByRole("button", { name: "起こす" }).click();
  await expect.poll(() => sleepOf(p1), { timeout: 60_000, message: "帯の「起こす」で起きない" }).toBe("awake");
  await expect(page.getByTestId("project-sleep-banner"), "起こしたのに帯が残っている").toHaveCount(0, { timeout: 60_000 });

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
  // 後始末
  for (const id of [p1, p2, p3]) await api("POST", `/api/projects/${id}/close`);
  await api("DELETE", `/api/project-groups/${group.body.id}`);
});
