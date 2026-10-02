// **左のサイドバーで、並べ替えと名前の変更ができる**（決定・2026-09-11、ユーザー要望）。
//
// 見るのは「操作が通った」ではなく**中身**（規則14）——並びは一覧の文字列そのもの、
// 名前は変えた先の文字が出ているところまで。さらに**リロードしても残る**
// （＝host が持っている。ブラウザの覚えではない、規則3）。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Locator, type Page } from "../test-base.js";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, confirmForkDialog } from "../helpers.js";

test.setTimeout(300_000);

/**
 * その名前の行の**掴む／右クリックする場所**。
 *
 * **行（`li`）そのものを指さない**（実測・2026-09-11）。開いている Project の
 * 行は下にぶら下がる目次まで含むので、(1) 真ん中を押すと Base Thread の行に
 * 当たり、(2) 文字で絞ると Fork の名前でも**親の Project の行**に当たる
 * ——「Fork の名前を変える」つもりで Project の名前を変えていた。
 * 名前そのものから、いちばん近い取っ手へ辿る。
 */
function handleOf(name: Locator) {
  return name.first().locator('xpath=ancestor::*[@data-slot="context-menu-trigger"][1]');
}

function projectHandle(page: Page, name: string) {
  return handleOf(page.getByTestId("sidebar-project-name").filter({ hasText: name }));
}

function forkHandle(page: Page, name: string) {
  return handleOf(page.getByTestId("sidebar-fork-name").filter({ hasText: name }));
}

/** サイドバーに出ている Project 名を、上から順に */
async function projectNames(page: Page): Promise<string[]> {
  return page.getByTestId("sidebar-project-name").allTextContents();
}

test("Project を掴んで並べ替えられる——リロードしても残る", async ({ page }) => {
  await openApp(page);
  await createProject(page, "並びA", mkdtempSync(join(tmpdir(), "banto-e2e-order-a-")));
  await createProject(page, "並びB", mkdtempSync(join(tmpdir(), "banto-e2e-order-b-")));

  const before = await projectNames(page);
  expect(before.slice(-2), "作った2つが一覧の末尾に並んでいない").toEqual(["並びA", "並びB"]);

  // B を A の上へ運ぶ。**先に画面へ入れる**——一覧は Project が増えると
  // スクロールするので、見えていない行の座標へマウスを動かしても
  // そこには別のもの（一覧の外）がある（実測・2026-09-11：15件あると掴めない）
  const a = projectHandle(page, "並びA");
  const b = projectHandle(page, "並びB");
  await b.scrollIntoViewIfNeeded();
  await a.scrollIntoViewIfNeeded();
  const box = await a.boundingBox();
  const from = await b.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  // 8px 動かして初めて掴む（押しただけでは動かない）ので、途中の点も踏む
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 - 12, { steps: 5 });
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 2, { steps: 10 });
  // 掴めていることを、落とす前に確かめる（掴めていなければここで分かる）
  await expect(page.locator("[data-dragging]"), "掴めていない").toHaveCount(1);
  await page.mouse.up();

  await expect
    .poll(async () => (await projectNames(page)).slice(-2), { timeout: 10_000 })
    .toEqual(["並びB", "並びA"]);

  // **host が持っている**——リロードしても、別の経路（API）から見ても同じ
  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await projectNames(page)).slice(-2), { timeout: 30_000 }).toEqual([
    "並びB",
    "並びA",
  ]);
  const listed = (await (
    await page.request.get(`${CORE_BASE_URL}/api/projects`, {
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    })
  ).json()) as Array<{ name: string }>;
  expect(listed.map((p) => p.name).slice(-2)).toEqual(["並びB", "並びA"]);
});

test("右クリックのメニューから、Project の名前を変えられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "まえの名前", mkdtempSync(join(tmpdir(), "banto-e2e-rename-")));

  await projectHandle(page, "まえの名前").click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();

  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  // **いまの名前から始まる**（打ち直しを強いない）
  await expect(dialog.getByLabel("名前")).toHaveValue("まえの名前");
  await dialog.getByLabel("名前").fill("あとの名前");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  await expect(page.locator('[data-slot="sidebar"]').getByText("あとの名前")).toBeVisible();
  await page.reload();
  await expect(
    page.locator('[data-slot="sidebar"]').getByText("あとの名前"),
    "リロードしたら元の名前に戻った（host が持っていない）",
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="sidebar"]').getByText("まえの名前")).toHaveCount(0);
});

test("Fork も、メニューから名前を変えられる・並べ替えられる", async ({ page }) => {
  await openApp(page);
  await createProject(page, "Fork の並び", mkdtempSync(join(tmpdir(), "banto-e2e-forkorder-")));

  // Fork を2つ作る（会話は要らない——分ける操作だけ）
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Fork を開く" }).click();
    await confirmForkDialog(page);
    const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
    await expect(back).toBeVisible({ timeout: 15_000 });
    await back.click();
    await expect(back).toBeHidden({ timeout: 15_000 });
  }

  const forkRows = page.getByTestId("sidebar-fork-name");
  await expect
    .poll(async () => forkRows.allTextContents(), { timeout: 15_000 })
    .toEqual(["Fork 1", "Fork 2"]);

  // 名前を変える
  await forkHandle(page, "Fork 1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();
  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("名前").fill("設計の枝");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 10_000 }).toEqual([
    "設計の枝",
    "Fork 2",
  ]);

  // メニューから並べ替える（掴めない場面でも並べ替えられる）
  await forkHandle(page, "Fork 2").click({ button: "right" });
  await page.getByRole("menuitem", { name: "上へ移動" }).click();
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 10_000 }).toEqual([
    "Fork 2",
    "設計の枝",
  ]);

  // **どちらも host が持っている**
  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => forkRows.allTextContents(), { timeout: 30_000 }).toEqual([
    "Fork 2",
    "設計の枝",
  ]);
});

test("子（Thread の目次）を開いた Project も、潰れずに一番上まで運べる", async ({ page }) => {
  // ユーザー報告（2026-09-11）：目次を開いている Project を掴むと
  // (1) ぎゅっと圧縮された見た目になり、(2) 一番上に移動させられない。
  // どちらも「その行だけ背が高い」ことから来ていた。
  await openApp(page);
  await createProject(page, "背A", mkdtempSync(join(tmpdir(), "banto-e2e-tall-a-")));
  await createProject(page, "背B", mkdtempSync(join(tmpdir(), "banto-e2e-tall-b-")));
  await createProject(page, "背C", mkdtempSync(join(tmpdir(), "banto-e2e-tall-c-")));

  const rowOf = (name: string) =>
    page
      .getByTestId("sidebar-project-name")
      .filter({ hasText: name })
      .first()
      .locator('xpath=ancestor::*[@data-sortable-id][1]');

  // いま開いている Project（背C）は目次が開いている＝他より背が高い。**目次が開くまで待ってから測る**
  // （改訂・2026-09-25）——目次は Thread の一覧を読み込んでから開くので、作った直後に測ると背が同じに見える
  // （フルの中で1回、32px 同士で落ちた）
  await expect(rowOf("背C").getByText("Base Thread")).toBeVisible({ timeout: 15_000 });
  const tall = await rowOf("背C").boundingBox();
  const short = await rowOf("背A").boundingBox();
  expect(tall!.height, "この試験の前提（目次が開いて背が高い）が崩れている").toBeGreaterThan(
    short!.height,
  );

  // **2つ上へ運ぶ**（背A の上）。直す前は**1つしか上がらなかった**
  // ——背の高い行の中心は、上の行の中心より上に行けないため（実測・2026-09-11）。
  // 「一覧のいちばん上」で見ないのは、前の試験が作った Project が上に積まれていて
  // スクロールが要る＝掴む座標が変わるから（この spec の他の試験と同じ落とし穴）
  const handle = projectHandle(page, "背C");
  await rowOf("背A").scrollIntoViewIfNeeded();
  await handle.scrollIntoViewIfNeeded();
  const target = await rowOf("背A").boundingBox();
  const from = await handle.boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2 - 12, { steps: 5 });
  await page.mouse.move(target!.x + target!.width / 2, target!.y + 4, { steps: 15 });

  // **運んでいる間、潰れていない**——位置だけが動き、大きさは変わらない
  const dragging = page.locator("[data-dragging]");
  await expect(dragging, "掴めていない").toHaveCount(1);
  const look = await dragging.first().evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { scaleX: m.a, scaleY: m.d, height: el.getBoundingClientRect().height };
  });
  expect(look.scaleY, "運んでいる間に縦へ潰れている").toBeCloseTo(1, 2);
  expect(look.scaleX, "運んでいる間に横へ潰れている").toBeCloseTo(1, 2);
  expect(look.height, "運んでいる間だけ他の行と高さが揃っていない").toBeCloseTo(short!.height, 0);

  await page.mouse.up();

  // **2つ上まで届く**（直す前は ["背A","背C","背B"] で止まっていた）
  await expect
    .poll(async () => (await projectNames(page)).filter((n) => n.startsWith("背")), {
      timeout: 10_000,
    })
    .toEqual(["背C", "背A", "背B"]);
  // 落としたら目次は開いたまま（人の選択は変えていない）
  await expect(rowOf("背C").getByText("Base Thread")).toBeVisible();

  await page.reload();
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await projectNames(page)).filter((n) => n.startsWith("背")), {
      timeout: 30_000,
    })
    .toEqual(["背C", "背A", "背B"]);
});

test("行の「…」から、右クリックと同じ操作が出る（Fork は Close も）", async ({ page }) => {
  // ユーザー要望（2026-09-11）：Fork 行の合流のアイコンを「…」にして、
  // 右クリックと同じメニューを出す。Close もそのメニューに入れる。
  // Project 行にも、たたむ（目次の開閉）の左に「…」を置く。
  await openApp(page);
  await createProject(page, "点々の spec", mkdtempSync(join(tmpdir(), "banto-e2e-dots-")));

  // Fork を1つ作る
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await expect(back).toBeVisible({ timeout: 15_000 });
  await back.click();
  await expect(back).toBeHidden({ timeout: 15_000 });

  const rowOfFork = page
    .getByTestId("sidebar-fork-name")
    .filter({ hasText: "Fork 1" })
    .first()
    .locator('xpath=ancestor::*[@data-sortable-id][1]');

  // ---- Fork：「…」→ 右クリックと同じ中身＋畳む ---------------------------
  await rowOfFork.hover();
  const forkMore = rowOfFork.getByTestId("sidebar-item-more");
  await expect(forkMore, "Fork 行に「…」が出ていない").toHaveCount(1);
  await forkMore.click();
  const fromMore = await page.getByRole("menuitem").allTextContents();
  expect(fromMore).toEqual(["名前を変える…", "上へ移動", "下へ移動", "Close"]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  // 右クリックでも同じ中身（出し方が2つ、中身は1つ）
  await rowOfFork
    .locator('[data-slot="context-menu-trigger"]')
    .first()
    .click({ button: "right" });
  expect(await page.getByRole("menuitem").allTextContents()).toEqual(fromMore);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);

  // ---- Project：「…」は「たたむ」の左 ------------------------------------
  const rowOfProject = page
    .getByTestId("sidebar-project-name")
    .filter({ hasText: "点々の spec" })
    .first()
    .locator('xpath=ancestor::*[@data-sortable-id][1]');
  await rowOfProject.hover();
  const projectMore = rowOfProject.getByTestId("sidebar-item-more").first();
  await expect(projectMore, "Project 行に「…」が出ていない").toHaveCount(1);
  const moreBox = await projectMore.boundingBox();
  const foldBox = await rowOfProject.getByRole("button", { name: /Thread 一覧を/ }).boundingBox();
  expect(moreBox!.x, "「…」がたたむボタンの左に無い").toBeLessThan(foldBox!.x);
  await projectMore.click();
  expect(await page.getByRole("menuitem").allTextContents()).toEqual([
    "名前を変える…",
    "上へ移動",
    "下へ移動",
  ]);
  await page.keyboard.press("Escape");

  // ---- Close は、押したら本当に閉じる（規則14） --------------------------
  await rowOfFork.hover();
  await forkMore.click();
  await page.getByRole("menuitem", { name: "Close" }).click();
  await expect(
    page.getByTestId("sidebar-fork-name").filter({ hasText: "Fork 1" }),
    "Close したのに一覧に残っている",
  ).toHaveCount(0, { timeout: 15_000 });
  // 削除ではなく整理——閉じた Fork として数えられている
  await expect(page.getByText(/閉じた Fork（\d+）/).first()).toBeVisible({ timeout: 15_000 });
});

test("面の題は Project 名だけ——そこを右クリックすると名前を変えられる", async ({ page }) => {
  // ユーザー要望（2026-09-11）：「Base Thread — プロジェクト名」は「プロジェクト名」に。
  // 題のところも右クリックで名前を変えられるように。
  await openApp(page);
  await createProject(page, "題の spec", mkdtempSync(join(tmpdir(), "banto-e2e-title-")));

  const header = page.locator("header").first();
  await expect(header.getByText("題の spec", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByText(/^Base Thread —/),
    "「Base Thread —」の接頭辞が残っている",
  ).toHaveCount(0);

  // ---- 題を右クリック → Project の名前を変える ---------------------------
  await header.getByText("題の spec", { exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();
  const dialog = page.getByTestId("rename-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByLabel("名前")).toHaveValue("題の spec");
  await dialog.getByLabel("名前").fill("題を変えた");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // 題にもサイドバーにも、変えた名前が出る（同じ真実を見ている）
  await expect(header.getByText("題を変えた", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByTestId("sidebar-project-name").filter({ hasText: "題を変えた" }),
  ).toHaveCount(1);

  // ---- Fork の題も同じ ----------------------------------------------------
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await expect(back).toBeVisible({ timeout: 15_000 });
  const forkTitle = page.getByText("Fork 1", { exact: true }).last();
  await forkTitle.click({ button: "right" });
  await page.getByRole("menuitem", { name: "名前を変える…" }).click();
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel("名前").fill("枝の名前");
  await dialog.getByRole("button", { name: "保存する" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByTestId("sidebar-fork-name").filter({ hasText: "枝の名前" })).toHaveCount(1);
});

test("Fork と Close のアイコンは、下向き（会話が流れる向き）に出す", async ({ page }) => {
  // ユーザー要望（2026-09-11）：会話は下に流れるので、分岐も合流も下側が直感に近い。
  // **見た目の指定は画面から測る**（`-scale-y-100` が実際に効いているか）
  await openApp(page);
  await createProject(page, "向きの spec", mkdtempSync(join(tmpdir(), "banto-e2e-icon-")));

  // **Tailwind v4 は `transform` ではなく `scale` に出す**（実測・2026-09-11）
  // ——`transform` を見ていると、効いていても "none" に見える
  const scaleYOf = async (locator: import("@playwright/test").Locator) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el);
      if (style.scale && style.scale !== "none") return Number(style.scale.split(" ").at(-1));
      return new DOMMatrixReadOnly(style.transform).d;
    });

  // ヘッダの「Fork を開く」
  const forkButtonIcon = page.getByRole("button", { name: "Fork を開く" }).locator("svg").first();
  expect(await scaleYOf(forkButtonIcon), "Fork のアイコンが上下反転していない").toBeCloseTo(-1, 2);

  // サイドバーの Fork 行と、メニューの Close
  await page.getByRole("button", { name: "Fork を開く" }).click();
  await confirmForkDialog(page);
  const back = page.getByRole("button", { name: /Base Thread に戻る$/ });
  await expect(back).toBeVisible({ timeout: 15_000 });
  expect(
    await scaleYOf(page.getByRole("button", { name: "この Fork Thread を Close" }).locator("svg").first()),
    "Close のアイコンが上下反転していない",
  ).toBeCloseTo(-1, 2);
  await back.click();

  const row = page
    .getByTestId("sidebar-fork-name")
    .first()
    .locator('xpath=ancestor::*[@data-sortable-id][1]');
  expect(await scaleYOf(row.locator("svg").first()), "一覧の Fork アイコンが反転していない").toBeCloseTo(
    -1,
    2,
  );
});
