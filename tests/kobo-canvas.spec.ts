/**
 * 工場の面（`kobo.board` / `kobo.review`）が**使えること**を、実物を描いて見張る。
 *
 * **2026-08-08：ボードを帳場に作り替えた**（7列の対称カンバンをやめた）。
 * 検体の**意図は変えていない**——「主が幅を使うか」「字が切れないか」「経緯が重ならないか」
 * 「詳細から戻れるか」。作りが変わったので、見る場所だけ移した。
 * **横スクロールの掴み手の検体は落とした**——帳場は横に流さないので、
 * 7列目が切れるという壊れ方そのものが無くなった（それが元の報告だった）。
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
    await page.waitForSelector(".kb-counter");
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

  test("**横に流れない**（7列目が切れる、という壊れ方をなくした）", async ({ page }) => {
    const overflow = await page.locator(".cv-work-main").evaluate(
      (el) => el.scrollWidth - el.clientWidth
    );
    expect(overflow, "面が横にはみ出している（切れて見えなくなる札が出る）").toBeLessThanOrEqual(1);

    const board = (await page.locator(".kb-counter").boundingBox())!;
    const cols = page.locator(".kb-zone");
    await expect(cols, "主（待っている）と従（流れ）の2区画が要る").toHaveCount(2);

    // **2区画とも右端まで収まっていること**
    for (let i = 0; i < 2; i++) {
      const box = (await cols.nth(i).boundingBox())!;
      expect(
        box.x + box.width,
        `${i === 0 ? "主" : "従"}の区画が面からはみ出している`
      ).toBeLessThanOrEqual(board.x + board.width + 1);
    }

    // **主が従より広い。** 同じ幅だと2つの主役になり、どちらを見ればよいか分からない
    const main = (await cols.nth(0).boundingBox())!;
    const quiet = (await cols.nth(1).boundingBox())!;
    expect(main.width, "待っているものが流れより狭い（主従が逆）").toBeGreaterThan(quiet.width);
  });

  test("札の題が横に切れない（はみ出さない）", async ({ page }) => {
    const titles = page.locator(".kb-slip-title");
    const count = await titles.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const over = await titles.nth(i).evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over, `${i} 番目の札の題が横にはみ出している`).toBeLessThanOrEqual(1);
    }
  });

  test("選ぶと詳細が出る。経緯の行が重ならない", async ({ page }) => {
    await page.locator(".kb-slip").first().click();
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

  test("まばらでも、待たせているものが主に集まる（横に流れない）", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-counter");

    // 検体は failed 2 と closed 1。closed は既定で出ない（prop-0001 第1段）ので、
    // **主に 2 枚だけ**が並び、流れは空になる
    await expect(page.locator(".kb-slip.is-stuck")).toHaveCount(2);
    await expect(page.locator(".kb-slip.is-mine")).toHaveCount(0);

    // **まばらでも横に流れない**（元の壊れ方は、まばらなのに列が押し出されることだった）
    const overflow = await page.locator(".cv-work-main").evaluate(
      (el) => el.scrollWidth - el.clientWidth
    );
    expect(overflow, "まばらなのに横にはみ出している").toBeLessThanOrEqual(1);
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
    await page.waitForSelector(".kb-counter");
    await page.locator(".kb-slip").first().click();

    const detail = (await page.locator(".cv-work-detail").boundingBox())!;
    const canvas = (await page.locator(".cv-work").boundingBox())!;
    expect(detail.width / canvas.width, "詳細が面いっぱいを使っていない").toBeGreaterThan(0.98);

    // 被せている以上、戻れないと出られない
    const back = page.locator(".cv-work-detail .cv-back");
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator(".cv-work-detail")).toHaveCount(0);
  });

  test("担当の職人へ飛べる", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-counter");
    await page.locator(".kb-slip").first().click();
    await expect(page.locator(".kb-goto-worker").first()).toBeVisible();
  });

  test("受け持ちで絞れる（2つ以上のときだけ出す）", async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-counter");
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
    await page.waitForSelector(".kb-counter");
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
      page.locator(".kb-stage-item").filter({ hasText: "同期のリトライ" }).first(),
      "動いているものが流れに出ていない（前提が崩れている）"
    ).toBeVisible();
    await expect(
      page.locator(".kb-slip.is-stuck"),
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

test.describe("落ちた札を、切り直さずに直す（task-0081/0082）", () => {
  let host: KoboHost;
  test.beforeAll(async () => {
    host = await startKoboHost();
  });
  test.afterAll(async () => {
    await host.close();
  });

  test.beforeEach(async ({ page }) => {
    await open(page, host);
    await page.waitForSelector(".kb-counter");
    // 止まっている札を開く
    await page.locator(".kb-slip.is-stuck").first().click();
    await page.waitForSelector(".cv-work-detail");
  });

  test("**なぜ落ちたかが読める**（番号だけでなく検証ログの中身まで）", async ({ page }) => {
    await expect(page.getByText("なぜ落ちたか")).toBeVisible();
    await expect(page.locator(".kb-why-reason")).toContainText("verify_failed:a4");
    // ここが要点——番号から先はログにしか無い
    await expect(page.locator(".kb-why-log")).toContainText("期待した値と違います");
  });

  test("戻した回数が出る（P6：同じところを何度も叩いていないか）", async ({ page }) => {
    await expect(page.locator(".kb-why-again")).toContainText("2 回");
  });

  test("**直す道具が3つとも在る**。理由を書くまで押せない", async ({ page }) => {
    const rework = page.getByRole("button", { name: "中身を直させる" });
    const reverify = page.getByRole("button", { name: "検証だけやり直す" });
    const abandon = page.getByRole("button", { name: "畳む" });
    for (const b of [rework, reverify, abandon]) {
      await expect(b).toBeVisible();
      // 理由は帳簿に残り職人にも渡る。空のまま押させない
      await expect(b).toBeDisabled();
    }
    await page.getByLabel("直す理由").fill("検証環境の道具が足りていない");
    for (const b of [rework, reverify, abandon]) await expect(b).toBeEnabled();
  });
});
