/**
 * 家が「形」も持てるようになった帰結を見張る（PO裁定 2026-08-06・spec-design §6.5）。
 *
 * 家の層（`theme/*.css`）は**面のクラス名を名指しで上書きする**。つまりクラス名が
 * 家に対する契約になった——面を組み替えると、家が**黙って**崩れる。崩れたことに
 * 気づけないのが一番困るので、ここで見張る。
 *
 * やり方：**契約は層そのものから導く**（D3：導出できるものを別に持たない）。
 * `fucho.css` に出てくるクラス名を読み取り、実際の画面に在ることを確かめる。
 * 名前を変えたら、この試験が「どの名前が消えたか」を名指しで落ちる。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startLayoutHost, type LayoutHost } from "./layoutHost.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LAYER = path.join(here, "..", "packages", "banto-web", "src", "theme", "fucho.css");

/**
 * この画面には出ないもの。**出ない理由をここに書く**——書けないものは、
 * 契約から外してよいのか分からないので、書けないなら試験を通してはいけない。
 */
const ABSENT: Record<string, string> = {
  "hold-more": "抱えているものが6本を超えたときだけ出る「+N」",
  "room--branch": "枝を開いているときだけ出る紙（幹の上に重ねる）",
};

/** 層が名指ししているクラス名を読み取る（`:root[data-theme…] .foo .bar` の `.foo`）。 */
function contractClasses(css: string): string[] {
  // 宣言ブロックを落としてセレクタだけにする
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^}]*\}/g, "\n");
  const names = new Set<string>();
  for (const match of selectors.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    const name = match[1]!;
    // 家自身の状態（is-alt / is-active …）は面の名前ではないので契約に入れない
    if (name.startsWith("is-")) continue;
    names.add(name);
  }
  return [...names].sort();
}

let host: LayoutHost;

test.beforeAll(async () => {
  host = await startLayoutHost();
});

test.afterAll(async () => {
  await host.close();
});

test.describe("家の層が名指ししているもの（クラス名の契約）", () => {
  test("層が当てにしているクラス名が、実際の画面に在る", async ({ page }) => {
    const required = contractClasses(fs.readFileSync(LAYER, "utf8")).filter((c) => !(c in ABSENT));
    expect(required.length, "層から契約を読み取れていない").toBeGreaterThan(10);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.evaluate(() => localStorage.setItem("banto.theme", "fucho:light"));
    await page.reload();
    await page.waitForSelector(".msg--banto");

    const missing = await page.evaluate(
      (names) => names.filter((n) => document.getElementsByClassName(n).length === 0),
      required
    );
    expect(
      missing,
      `符牒の層が当てにしているクラス名が画面から消えています。` +
        `面を組み替えたなら theme/fucho.css も直してください: ${missing.join(", ")}`
    ).toEqual([]);
  });

  test("層は符牒の家にしか当たらない（和紙へ漏れない）", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.waitForSelector(".shell");

    /** 家で姿が変わるもの：レールの地と、番頭の印。 */
    const look = async (): Promise<{ bar: string; mark: string }> =>
      page.evaluate(() => ({
        bar: getComputedStyle(document.querySelector(".rail")!).backgroundColor,
        mark: getComputedStyle(document.querySelector(".msg--banto")!, "::before").content,
      }));

    const washi = await look();
    expect(washi.mark, "和紙は落款のまま").toBe('"番"');

    await page.evaluate(() => localStorage.setItem("banto.theme", "fucho:light"));
    await page.reload();
    await page.waitForSelector(".msg--banto");
    const fucho = await look();
    expect(fucho.mark, "符牒は `»`").toBe('"»"');
    expect(fucho.bar, "符牒の上段は墨の地").not.toBe(washi.bar);
  });

  test("符牒では面の頭が升に収まる（浮いた札にしない）", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.evaluate(() => localStorage.setItem("banto.theme", "fucho:light"));
    await page.reload();
    await page.waitForSelector(".work-head");

    /* 帯の中は全部が同じ升。角丸の札を浮かせない（PO報告 2026-08-06）。
       タブ列は無くなった（ADR-0017 決定79）ので、帯として残るのは面の頭だけ */
    const fit = await page.evaluate(() => {
      const bar = document.querySelector(".work-head")!.getBoundingClientRect();
      const btn = document.querySelector(".work-head .room-back")!.getBoundingClientRect();
      const radius = getComputedStyle(document.querySelector(".work-head .room-back")!).borderRadius;
      return { barTop: bar.top, barBottom: bar.bottom, btnTop: btn.top, btnBottom: btn.bottom, radius };
    });
    expect(fit.btnTop).toBeGreaterThanOrEqual(fit.barTop);
    expect(fit.btnBottom).toBeLessThanOrEqual(fit.barBottom);
    expect(fit.radius, "符牒では角を落とす").toBe("0px");
  });

  /**
   * **符牒の札は `f`（⌥）のときだけ**（PO裁定 2026-08-06）。どの家でも同じ。
   *
   * 符牒の家では一時「行の中に常置」していたが、押せるものを探していないときに画面が
   * 記号で埋まる。行の中に置くとタブの幅も変わり、`useTabOverflow` の勘定が動いて
   * 押そうとしたタブが収納へ落ちる。
   */
  for (const family of ["washi", "fucho"]) {
    test(`札は f を押すまで出ない：${family}`, async ({ page }) => {
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto(`http://127.0.0.1:${host.port}/`);
      await page.evaluate((f) => localStorage.setItem("banto.theme", `${f}:light`), family);
      await page.reload();
      await page.waitForSelector(".work-head");

      /** レールとキャンバスのタブに、札（`::before` / `::after`）が出ているか。 */
      const chips = async (): Promise<string[]> =>
        page.evaluate(() =>
          [".pj[data-key]", ".hold[data-key]"].flatMap((sel) => {
            const el = document.querySelector(sel);
            if (!el) return [];
            return (["::before", "::after"] as const)
              .map((pseudo) => getComputedStyle(el, pseudo).content)
              .filter((content) => content !== "none" && content !== "")
              .map((content) => `${sel}${content}`);
          })
        );

      expect(await chips(), "f を押していないのに札が出ている").toEqual([]);

      await page.keyboard.press("f");
      await expect(page.locator("html")).toHaveClass(/is-alt/);
      const shown = await chips();
      expect(shown.length, "f を押しても札が出ない").toBeGreaterThan(0);

      // もう一度押したら消える（出したキーで畳める）
      await page.keyboard.press("f");
      await expect(page.locator("html")).not.toHaveClass(/is-alt/);
      expect(await chips(), "畳んだのに札が残っている").toEqual([]);
    });
  }

  /**
   * 面は器いっぱいに敷く（PO報告 2026-08-06）。
   * 和紙の「浮いた紙」（左右に 12px の余白）のままだと、キャンバスのスクロールバーと
   * チャットの間に用のない空きが出る。
   */
  test("符牒では面が器いっぱいに敷かれる（右端に空きが出ない）", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${host.port}/`);
    await page.evaluate(() => localStorage.setItem("banto.theme", "fucho:light"));
    await page.reload();
    await page.waitForSelector(".canvas-body");

    const flush = await page.evaluate(() => {
      const pane = document.querySelector(".canvas-pane")!.getBoundingClientRect();
      const body = document.querySelector(".canvas-body")!.getBoundingClientRect();
      return { paneRight: pane.right, bodyRight: body.right, paneLeft: pane.left, bodyLeft: body.left };
    });
    expect(flush.paneRight - flush.bodyRight, "右端に空きがある").toBe(0);
    expect(flush.bodyLeft - flush.paneLeft, "左端に空きがある").toBe(0);
  });
});
