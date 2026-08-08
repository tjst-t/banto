/**
 * 工場の面（`kobo.board` / `kobo.review`）が**使えること**を、実物を描いて見張る。
 *
 * PO報告 2026-08-07：「キャンバスの工場のUIもレビューのUIも壊れていて使い物にならない」。
 * 原因は3つとも**寸法の話**で、型検査もユニットテストも一切気づけない類だった：
 *
 *   1. ボード（横に流すカンバン）が `SplitView` の**狭い方**に入っていた。
 *      340px の中に 230px の列——1列半しか見えず、隣に空の「選んでください」が広く居座る
 *   2. 札の題が横にはみ出して**切れていた**（`S4a8d2f-1-1: Tauri ... 格の完成確`）
 *   3. レビューは判断待ちが0でも2枚に割れ、**空の面が2つ**並んでいた
 *
 * だから見るのは「描けたか」ではなく**寸法**：主が広いか・字が切れていないか・
 * 空のときに1枚か。ここを数字で押さえておかないと、同じ形でまた崩れる。
 *
 * 前提: `npm run build:web` 済み（`packages/banto-web/dist`）。
 */

import { test, expect } from "@playwright/test";
import { startKoboHost, type KoboHost } from "./koboHost.js";

const WIDE = { width: 1500, height: 900 };

async function open(page: import("@playwright/test").Page, host: KoboHost): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto(`http://127.0.0.1:${host.port}/`);
}

test.describe("工場のボード", () => {
  let host: KoboHost;
  test.beforeAll(async () => {
    host = await startKoboHost();
  });
  test.afterAll(async () => {
    await host.close();
  });

  test.beforeEach(async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");
  });

  test("何も選んでいないとき、ボードがキャンバスの幅をほぼ全部使う", async ({ page }) => {
    // **空の詳細ペインを描かない**——これが「1列半しか見えない」の正体だった
    await expect(page.locator(".cv-work-detail")).toHaveCount(0);

    const board = await page.locator(".cv-work-main").boundingBox();
    const canvas = await page.locator(".cv-work").boundingBox();
    expect(board, "ボードが描けていない").not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(
      board!.width / canvas!.width,
      "ボードがキャンバスの幅を使い切っていない（狭い方に入っている）"
    ).toBeGreaterThan(0.98);
  });

  test("列が複数見えている（1列半しか見えない、にならない）", async ({ page }) => {
    const board = (await page.locator(".kb-board").boundingBox())!;
    const cols = page.locator(".kb-col");
    await expect(cols).toHaveCount(7);

    let visible = 0;
    for (let i = 0; i < 7; i++) {
      const box = await cols.nth(i).boundingBox();
      // 右端まで収まっている列だけ数える
      if (box && box.x + box.width <= board.x + board.width + 1) visible += 1;
    }
    expect(visible, "見えている列が少なすぎる").toBeGreaterThanOrEqual(4);
  });

  test("札の題が横に切れない（はみ出さない）", async ({ page }) => {
    const titles = page.locator(".kb-card-title");
    const count = await titles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const over = await titles.nth(i).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over, `${i} 番目の札の題が横にはみ出している`).toBeLessThanOrEqual(1);
    }
  });

  test("選ぶと詳細が出る。経緯の行が重ならない", async ({ page }) => {
    await page.locator(".cv-card").first().click();
    await expect(page.locator(".cv-work-detail")).toHaveCount(1);

    // 種類と中身が重なっていた（`state_transitioned` が固定幅を超えていた）
    const rows = page.locator(".kb-history li");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      const boxes = await rows.nth(i).evaluate((li) => {
        const type = li.querySelector(".kb-history-type") as HTMLElement | null;
        const detail = li.querySelector(".kb-history-detail") as HTMLElement | null;
        if (!type || !detail) return null;
        const a = type.getBoundingClientRect();
        const b = detail.getBoundingClientRect();
        return { typeRight: a.right, detailLeft: b.left };
      });
      if (!boxes) continue;
      expect(boxes.detailLeft, `${i} 行目の経緯が重なっている`).toBeGreaterThanOrEqual(
        boxes.typeRight - 1
      );
    }
  });
});

test.describe("工場のボード（まばらなとき）", () => {
  let host: KoboHost;
  test.beforeAll(async () => {
    // 実機で PO が見たのと同じ形：止まっているものと終わったものだけ
    host = await startKoboHost({
      tasks: [
        { taskId: "task-0001", projectTag: "loamium", status: "failed", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認と ROADMAP 更新" },
        { taskId: "task-0002", projectTag: "loamium", status: "failed", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認（監査再試行・task-0001 引き継ぎ）" },
        { taskId: "task-0003", projectTag: "loamium", status: "closed", title: "S4a8d2f-1-1: Tauri プロジェクト骨格の完成確認（task-0002 引き継ぎ）" },
      ] as never,
    });
  });
  test.afterAll(async () => {
    await host.close();
  });

  test("空の列は畳んで、中身のある列に幅を渡す", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");

    // 空の列は畳む（見出しだけ）。
    // **6列**なのは prop-0001 第1段から——検体の3件のうち `closed` の1件は
    // 既定で出なくなり、「終わった」列も空になる。残るのは failed 2件が入る
    // 「止まっている」列だけ（落ちたものは既定に残す）
    await expect(page.locator(".kb-col.is-empty")).toHaveCount(6);

    const board = (await page.locator(".kb-board").boundingBox())!;
    const cols = page.locator(".kb-col");
    let visible = 0;
    for (let i = 0; i < 7; i++) {
      const box = await cols.nth(i).boundingBox();
      if (box && box.x + box.width <= board.x + board.width + 1) visible += 1;
    }
    // **まばらなら横スクロールなしで全部見える**のが要点
    expect(visible, "まばらなのに列が収まっていない").toBe(7);
  });
});

test.describe("レビューの面", () => {
  test("判断待ちが無いとき、空の面は1つだけ", async ({ page }) => {
    const host = await startKoboHost({ tasks: [] as never, active: "review" });
    try {
      await open(page, host);
      await page.waitForSelector(".cv-empty, .cv-view");
      await page.waitForTimeout(400);
      // 「ありません」と「選んでください」が並んでいた（PO報告のスクリーンショット）
      await expect(page.locator(".cv-empty")).toHaveCount(1);
      await expect(page.locator(".cv-split")).toHaveCount(0);
    } finally {
      await host.close();
    }
  });

  test("判断待ちがあれば、先頭を開いた状態で差し出す", async ({ page }) => {
    const host = await startKoboHost({ active: "review" });
    try {
      await open(page, host);
      await page.waitForSelector(".cv-split");
      // **着いた先が「選んでください」では一往復無駄になる**
      await expect(page.locator("text=判断するものを選ぶ")).toHaveCount(0);
      await expect(page.locator("text=求める判断").first()).toBeVisible();
    } finally {
      await host.close();
    }
  });
});

test.describe("工場のボード（PO要望 2026-08-07 第2報）", () => {
  let host: KoboHost;
  test.beforeAll(async () => {
    host = await startKoboHost();
  });
  test.afterAll(async () => {
    await host.close();
  });

  test("詳細は面いっぱいを使い、戻る導線がある", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");
    await page.locator(".cv-card").first().click();

    const detail = (await page.locator(".cv-work-detail").boundingBox())!;
    const canvas = (await page.locator(".cv-work").boundingBox())!;
    expect(detail.width / canvas.width, "詳細が面いっぱいを使っていない").toBeGreaterThan(0.98);

    // 被せている以上、戻れないと出られない
    const back = page.locator(".cv-work-detail .cv-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator(".cv-work-detail")).toHaveCount(0);
  });

  test("横スクロールの掴み手が面の下端にある", async ({ page }) => {
    await open(page, host);
    const board = (await page.locator(".kb-board").boundingBox())!;
    const shell = (await page.locator(".cv-work-main").boundingBox())!;
    // ボードが面の高さいっぱいに伸びていれば、掴み手も下端に出る
    expect(
      board.y + board.height,
      "ボードが中身の高さしか無い（掴み手が札のすぐ下に浮く）"
    ).toBeGreaterThan(shell.y + shell.height - 40);
  });

  test("担当の職人へ飛べる", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");
    await page.locator(".cv-card").first().click();
    await expect(page.locator(".kb-goto-worker").first()).toBeVisible();
  });

  test("受け持ちで絞れる（2つ以上のときだけ出す）", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");
    // この検体は受け持ち1つなので、絞りは出さない（要らない口を出さない）
    await expect(page.locator('select[aria-label="受け持ちで絞る"]')).toHaveCount(0);
  });
});

test.describe("工場のボードの既定（prop-0001 第1段）", () => {
  let host: KoboHost;
  test.beforeAll(async () => {
    host = await startKoboHost();
  });
  test.afterAll(async () => {
    await host.close();
  });

  test.beforeEach(async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-board");
  });

  test("既定では片が付いたものを出さない。落ちたものは出す", async ({ page }) => {
    // **終わったタスクは消えないので、放っておくと 100 件の枠を埋めて
    // 動いているタスクを押し出す**（実機で 340 件中 100 件しか出ない状態になっていた）。
    // 直す前のボードは `state: "all"` を渡していて、ここが素通りしていた
    await expect(
      page.getByText("vault の走査を打ち切れるようにする"),
      "merged が既定で出ている（枠を食う）"
    ).toHaveCount(0);
    await expect(
      page.getByText("ノートの並び替えを安定にする"),
      "closed が既定で出ている（枠を食う）"
    ).toHaveCount(0);

    // **落ちたものは残す。** 「終わった」と「止まっている」は違う——
    // 外すと、一番忘れられやすいものが見えなくなる
    // failed は「止まっている」列に出る（task-0110 / 0111）
    await expect(
      page.locator(".kb-card-title").filter({ hasText: "同期のリトライ" }).first(),
      "動いているものが出ていない（前提が崩れている）"
    ).toBeVisible();
    const failedCol = page.locator(".kb-col").filter({ hasText: "止まっている" });
    await expect(
      failedCol.locator(".kb-card-title"),
      "failed が既定から消えている（落ちたタスクが忘れられる）"
    ).toHaveCount(2);
  });

  test("切り替えれば片が付いたものも出る（隠しただけで捨てていない）", async ({ page }) => {
    await page.getByRole("button", { name: "片が付いたものも見る" }).click();
    await expect(
      page.getByText("vault の走査を打ち切れるようにする"),
      "切り替えても merged が出てこない（本当に消えている）"
    ).toBeVisible();
    // 押した状態が分かること（押しても何も変わらないように見えない）
    await expect(page.getByRole("button", { name: /片が付いたものも/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
