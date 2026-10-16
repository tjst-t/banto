// **サイドバーで Project をグループに分ける**（決定・2026-10-16、v4-frontend.md §6.43、Backlog #353）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る並び・名前・色・数まで）：
//   1. 「Project」の見出しの「＋」→「新しいグループ…」で作れる。空のグループは「ここへドラッグするか…」の1行
//   2. 見出しの「…」で名前と色を変えられる（点の色まで）
//   3. 行の「…」の「グループへ移す」で入れる・出す。中の Project は 12px 下がり、点と頭文字・見出しの名前と Project の
//      名前の左端がそろう。「…」の位置は見出しと行で同じ
//   4. ドラッグ：見出しに落とす＝そのグループの最後、行に落とす＝その前、「Project」の見出しに落とす＝グループの外
//   5. グループを上へ（並べ替え）、なくすと中の Project はグループの外へ出る（消えない）
//   6. 畳んでも、中の「AI が動いている」と「あなたの番」の件数と数が見出しに残る
//   7. すべて畳む／すべて開く。畳んだレールはグループの色の線で区切る
//   8. リロードしても、別の画面（携帯の幅）でも同じ並び（host が持っている）
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { ADD_PROJECT_OR_GROUP, createProject, fakeTurn, openApp, openNav, waitForProjectModule } from "../helpers.js";

test.setTimeout(420_000);
test.use({ viewport: { width: 1280, height: 900 } });

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const stamp = Date.now().toString(36);
const A = `群A ${stamp}`;
const B = `群B ${stamp}`;
const C = `群C ${stamp}`;
const DEV = `開発群 ${stamp}`;
const DEV2 = `開発 ${stamp}`;
const LAB = `検証群 ${stamp}`;
const OURS = [A, B, C, DEV, DEV2, LAB];

/** 一覧（`sidebar-project-list`）の並び。グループの見出しは「# 名前」。この試験が作ったものだけ */
async function layout(page: Page): Promise<string[]> {
  const rows = await page
    .getByTestId("sidebar-project-list")
    .first()
    .evaluate((ul) =>
      [...ul.children].map((li) => {
        if (li.getAttribute("data-testid") === "sidebar-group") {
          return `# ${li.querySelector('[data-testid="sidebar-group-name"]')?.textContent ?? ""}`;
        }
        return li.querySelector('[data-testid="sidebar-project-name"]')?.textContent ?? null;
      }),
    );
  return rows.filter((r): r is string => r !== null && OURS.some((name) => r === name || r === `# ${name}`));
}

function expectLayout(page: Page, expected: string[], message: string) {
  return expect.poll(() => layout(page), { timeout: 15_000, message }).toEqual(expected);
}

/** その名前の Project の行の見出し（掴む・落とす・右クリックする所） */
function projectHandle(page: Page, name: string): Locator {
  return page
    .getByTestId("sidebar-project-name")
    .filter({ hasText: name })
    .first()
    .locator('xpath=ancestor::*[@data-slot="context-menu-trigger"][1]');
}

function projectRow(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-project-name").filter({ hasText: name }).first().locator("xpath=ancestor::*[@data-sortable-id][1]");
}

function groupHeading(page: Page, name: string): Locator {
  return page.getByTestId("sidebar-group").filter({ has: page.getByTestId("sidebar-group-name").getByText(name, { exact: true }) });
}

/** 掴んで `target` の上に落とす。落とす前に、掴めていること・落とす先が示されていることを見る */
async function dragOnto(page: Page, name: string, target: Locator, targetMark: Locator = target) {
  const from = projectHandle(page, name);
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // 8px 動かして初めて掴む
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 12, { steps: 5 });
  await expect(page.locator("[data-dragging]"), "掴めていない").toHaveCount(1);
  const b = (await target.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2, { steps: 12 });
  await expect(targetMark, "落とす先が示されていない").toHaveAttribute("data-drop-over", "");
  await page.mouse.up();
}

async function openProjectMenu(page: Page, name: string) {
  const row = projectRow(page, name);
  await row.hover();
  await row.getByTestId("sidebar-item-more").first().click();
}

async function moveToGroupByMenu(page: Page, name: string, group: string) {
  await openProjectMenu(page, name);
  await page.getByRole("menuitem", { name: "グループへ移す" }).click();
  await page.getByRole("menuitem", { name: group }).click();
}

async function openGroupMenu(page: Page, name: string) {
  const heading = groupHeading(page, name);
  await heading.hover();
  await heading.getByTestId("sidebar-group-more").click();
}

async function createGroup(page: Page, name: string) {
  await page.getByRole("button", { name: ADD_PROJECT_OR_GROUP, exact: true }).click();
  await page.getByRole("menuitem", { name: "新しいグループ…" }).click();
  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog.getByRole("heading", { name: "新しいグループ" })).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("名前").fill(name);
  await dialog.getByRole("button", { name: "作る" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

/** 要素の左端・真ん中（x） */
async function xOf(locator: Locator): Promise<{ left: number; center: number }> {
  const box = (await locator.boundingBox())!;
  return { left: box.x, center: box.x + box.width / 2 };
}

/** Project の名前の左隣（頭文字の枠）の真ん中 */
async function initialCenter(page: Page, name: string): Promise<number> {
  return page
    .getByTestId("sidebar-project-name")
    .filter({ hasText: name })
    .first()
    .evaluate((el) => {
      const r = el.previousElementSibling!.getBoundingClientRect();
      return r.x + r.width / 2;
    });
}

test("グループを作る・名前と色・入れる／出す・ドラッグ・並べ替え・なくす・畳んでも印・すべて畳む、リロードと携帯の幅でも同じ", async ({
  page,
  context,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  await createProject(page, A, mkdtempSync(join(tmpdir(), "banto-e2e-group-a-")));
  await createProject(page, B, mkdtempSync(join(tmpdir(), "banto-e2e-group-b-")));
  await createProject(page, C, mkdtempSync(join(tmpdir(), "banto-e2e-group-c-")));
  await expectLayout(page, [A, B, C], "作った3つがグループの外に並んでいない");

  // ---- 1. 作る。空のグループは1行の案内 ----------------------------------------------------------------
  await createGroup(page, DEV);
  await createGroup(page, LAB);
  await expectLayout(page, [A, B, C, `# ${DEV}`, `# ${LAB}`], "作ったグループの見出しが出ていない");
  await expect(groupHeading(page, DEV).locator("xpath=following-sibling::li[1]")).toHaveText(
    "Project をここへドラッグするか、行の「…」から入れます",
  );
  // 色はまだ使っていない色から（青・緑の順）
  await expect(groupHeading(page, DEV).getByTestId("sidebar-group-dot")).toHaveAttribute("data-color", "blue");
  await expect(groupHeading(page, LAB).getByTestId("sidebar-group-dot")).toHaveAttribute("data-color", "green");

  // ---- 2. 名前と色を変える -----------------------------------------------------------------------------
  await openGroupMenu(page, DEV);
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();
  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog.getByLabel("名前")).toHaveValue(DEV);
  await dialog.getByLabel("名前").fill(DEV2);
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expectLayout(page, [A, B, C, `# ${DEV2}`, `# ${LAB}`], "名前が変わっていない");
  await openGroupMenu(page, DEV2);
  await page.getByRole("menuitem", { name: "色" }).click();
  await page.getByRole("menuitemradio", { name: "桃" }).click();
  await expect(groupHeading(page, DEV2).getByTestId("sidebar-group-dot")).toHaveAttribute("data-color", "pink", { timeout: 10_000 });

  // ---- 3. 行の「…」で入れる。字下げとそろえ方 ---------------------------------------------------------
  await moveToGroupByMenu(page, A, DEV2);
  await expectLayout(page, [B, C, `# ${DEV2}`, A, `# ${LAB}`], "行の「…」でグループに入らない");
  await expect(groupHeading(page, DEV2).locator("xpath=following-sibling::li[1]")).not.toHaveText(/ここへドラッグ/);
  // いまの入れ先に印
  await openProjectMenu(page, A);
  await page.getByRole("menuitem", { name: "グループへ移す" }).click();
  await expect(page.getByRole("menuitem", { name: DEV2 }).getByLabel("いま入っている")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  const nameOut = await xOf(page.getByTestId("sidebar-project-name").filter({ hasText: B }).first());
  const nameIn = await xOf(page.getByTestId("sidebar-project-name").filter({ hasText: A }).first());
  expect(nameIn.left - nameOut.left, "グループの中の Project が 12px 下がっていない").toBeCloseTo(12, 0);
  const headingName = await xOf(groupHeading(page, DEV2).getByTestId("sidebar-group-name"));
  expect(headingName.left, "見出しの名前と Project の名前の左端がそろっていない").toBeCloseTo(nameOut.left, 0);
  const dot = await xOf(groupHeading(page, DEV2).getByTestId("sidebar-group-dot"));
  expect(dot.center, "点が頭文字の真ん中にそろっていない").toBeCloseTo(await initialCenter(page, B), 0);
  const headingMore = await xOf(groupHeading(page, DEV2).getByTestId("sidebar-group-more"));
  const rowMore = await xOf(projectRow(page, B).getByTestId("sidebar-item-more").first());
  expect(headingMore.left, "見出しと行で「…」の位置がそろっていない").toBeCloseTo(rowMore.left, 0);

  // 出す（グループに入れない）——グループの外の最後へ。入れ直す
  await moveToGroupByMenu(page, A, "グループに入れない");
  await expectLayout(page, [B, C, A, `# ${DEV2}`, `# ${LAB}`], "「グループに入れない」で外に出ない");
  await moveToGroupByMenu(page, A, DEV2);
  await expectLayout(page, [B, C, `# ${DEV2}`, A, `# ${LAB}`], "入れ直せない");

  // ---- 4. ドラッグ：見出し＝最後、行＝その前、「Project」の見出し＝外 ----------------------------------
  await dragOnto(page, B, groupHeading(page, LAB));
  await expectLayout(page, [C, `# ${DEV2}`, A, `# ${LAB}`, B], "見出しに落としてもそのグループに入らない");
  await dragOnto(page, C, projectHandle(page, A));
  await expectLayout(page, [`# ${DEV2}`, C, A, `# ${LAB}`, B], "行に落としてもその前に入らない");
  await dragOnto(page, A, page.getByTestId("sidebar-projects-heading"));
  await expectLayout(page, [A, `# ${DEV2}`, C, `# ${LAB}`, B], "「Project」の見出しに落としても外に出ない");
  // 見出しに落とすのは最後（いる Project の後ろ）
  await dragOnto(page, A, groupHeading(page, DEV2));
  await expectLayout(page, [`# ${DEV2}`, C, A, `# ${LAB}`, B], "見出しに落としたのに最後に入らない");

  // ---- 5. グループを上へ ---------------------------------------------------------------------------------
  await openGroupMenu(page, DEV2);
  await expect(page.getByRole("menuitem", { name: "グループを上へ" }), "一番上のグループなのに上へ押せる").toBeDisabled();
  await page.keyboard.press("Escape");
  await openGroupMenu(page, LAB);
  await page.getByRole("menuitem", { name: "グループを上へ" }).click();
  await expectLayout(page, [`# ${LAB}`, B, `# ${DEV2}`, C, A], "グループの並びが変わらない");

  // ---- 5''. 畳んだレール（58px）：グループの境目にその色の短い線。グループは畳まない --------------------
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  await sidebar.getByRole("button", { name: "サイドバーを折りたたむ" }).click();
  const lines = sidebar.getByTestId("rail-group-line");
  const groupIdsNow = (await (await page.request.get(`${CORE_BASE_URL}/api/project-groups`, { headers })).json()) as Array<{ id: string; name: string }>;
  const ourGroupIds = [LAB, DEV2].map((name) => groupIdsNow.find((g) => g.name === name)!.id);
  await expect
    .poll(async () => (await lines.evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id")))).filter((id) => ourGroupIds.includes(id!)), {
      timeout: 10_000,
      message: "畳んだレールにグループの線が出ていない",
    })
    .toEqual(ourGroupIds);
  await expect(lines.filter({ has: page.locator(".bg-chart-5") }), "線がグループの色（桃）になっていない").toHaveCount(1);
  await sidebar.getByRole("button", { name: "サイドバーを開く（⌘B / Ctrl-B）" }).click();
  await expectLayout(page, [`# ${LAB}`, B, `# ${DEV2}`, C, A], "サイドバーを開き直したら並びが変わった");

  // ---- 6. 畳んでも印が残る：A で判断待ち（承認を聞く tool）——ターンは走ったまま、あなたの番が1件 ------
  const listed = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string; groupId?: string }>;
  const projectA = listed.find((p) => p.name === A)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectA.id}/threads`, { headers })).json()) as Array<{ id: string; kind: string }>;
  const baseA = threads.find((t) => t.kind === "base")!;
  await waitForProjectModule(page, A, "filesystem");
  const pending = page.request.post(`${CORE_BASE_URL}/api/threads/${baseA.id}/messages`, {
    headers,
    data: {
      prompt: "直下を一覧して" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }], then: "一覧しました。" }),
      permissionMode: "default",
    },
    timeout: 240_000,
  });
  const devHeading = groupHeading(page, DEV2);
  await devHeading.getByRole("button", { name: `グループ「${DEV2}」を畳む` }).click();
  await expectLayout(page, [`# ${LAB}`, B, `# ${DEV2}`], "畳んだのに中の Project が見えている");
  await expect(devHeading).toHaveAttribute("data-collapsed", "");
  await expect(devHeading.getByTestId("sidebar-group-count"), "畳んだ見出しに中の数が無い").toHaveText("2");
  await expect(devHeading.getByTestId("sidebar-group-running"), "畳んでも「AI が動いている」が残らない").toBeVisible({ timeout: 60_000 });
  await expect(devHeading.getByTestId("sidebar-group-turn"), "畳んでも「あなたの番」の件数が残らない").toHaveText("1", { timeout: 60_000 });
  // 開いている見出しには数も印も出さない（中の行で見える）
  await expect(groupHeading(page, LAB).getByTestId("sidebar-group-count")).toHaveCount(0);

  // ---- 7. すべて畳む／すべて開く -------------------------------------------------------------------------
  await page.getByRole("button", { name: "すべて畳む" }).click();
  await expectLayout(page, [`# ${LAB}`, `# ${DEV2}`], "すべて畳むでグループが畳まれない");
  await expect(page.getByText("Base Thread", { exact: true }), "すべて畳むで Thread の目次が畳まれない").toHaveCount(0);
  // 畳んだことはこの端末が覚えている——リロードしても畳んだまま
  await page.reload();
  await expectLayout(page, [`# ${LAB}`, `# ${DEV2}`], "リロードしたら畳んだグループが開いた");
  await page.getByRole("button", { name: "すべて開く" }).click();
  await expectLayout(page, [`# ${LAB}`, B, `# ${DEV2}`, C, A], "すべて開くでグループが開かない");

  // 判断待ちは片づける（答える）——受信箱は spec の替わり目にも片づくが、走ったままのターンを残さない
  const judgments = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ id: string; kind: string; threadId?: string; liveness?: string }>;
  const judgment = judgments.find((i) => i.kind === "judgment" && i.threadId === baseA.id && i.liveness === "live");
  expect(judgment, "判断待ちが無い").toBeDefined();
  const answered = await page.request.post(`${CORE_BASE_URL}/api/inbox/${judgment!.id}/answer`, { headers, data: { answer: { behavior: "deny", message: "試験の後片づけ" } } });
  expect(answered.ok(), `判断待ちに答えられない：${answered.status()}`).toBe(true);
  expect((await pending).ok()).toBe(true);

  // ---- 8. リロードしても、携帯の幅（別の画面）でも同じ並び ----------------------------------------------
  const expected = [`# ${LAB}`, B, `# ${DEV2}`, C, A];
  await page.reload();
  await expectLayout(page, expected, "リロードしたら並びが変わった（host が持っていない）");
  // API から見ても同じ（入れ先）
  const after = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ name: string; groupId?: string }>;
  const groups = (await (await page.request.get(`${CORE_BASE_URL}/api/project-groups`, { headers })).json()) as Array<{ id: string; name: string; color: string }>;
  const idOf = (name: string) => groups.find((g) => g.name === name)?.id;
  expect(groups.filter((g) => OURS.includes(g.name)).map((g) => [g.name, g.color])).toEqual([
    [LAB, "green"],
    [DEV2, "pink"],
  ]);
  // host の並びは Project 全部で1つ（グループの中の順はそれを絞ったもの）
  expect(after.filter((p) => [A, B, C].includes(p.name)).map((p) => [p.name, p.groupId])).toEqual([
    [C, idOf(DEV2)],
    [A, idOf(DEV2)],
    [B, idOf(LAB)],
  ]);

  const phone = await context.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await openApp(phone);
  await openNav(phone);
  await expectLayout(phone, expected, "携帯の幅（Drawer）で並びが違う");
  // 携帯で動かしたものは、開いているパソコンの画面にも届く（projects.changed）
  await moveToGroupByMenu(phone, A, "グループに入れない");
  await expectLayout(phone, [A, `# ${LAB}`, B, `# ${DEV2}`, C], "携帯で「グループに入れない」が効かない");
  await expectLayout(page, [A, `# ${LAB}`, B, `# ${DEV2}`, C], "携帯で動かしたのにパソコンの画面が変わらない");
  await phone.close();

  // ---- 5'. なくすと中の Project はグループの外へ（消えない） ------------------------------------------
  await openGroupMenu(page, DEV2);
  await expect(page.getByText("中の Project は消えず、グループの外に出ます")).toBeVisible();
  await page.getByRole("menuitem", { name: "グループをなくす" }).click();
  await expectLayout(page, [A, C, `# ${LAB}`, B], "なくしたのに中の Project が外に出ない");
  await openGroupMenu(page, LAB);
  await page.getByRole("menuitem", { name: "グループをなくす" }).click();
  await expectLayout(page, [A, C, B], "全部なくしたのに中の Project が外に出ない");
  await page.reload();
  await expect.poll(() => layout(page), { timeout: 30_000 }).toEqual([A, C, B]);

  expect(pageErrors, "画面でエラーが出た").toEqual([]);
});
