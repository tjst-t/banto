/**
 * 持ち込みのテーマに何を許すか（ADR-0012 決定54・55）。
 *
 * **持ち込みの家はトークンだけ。** 組み込みの家は面のクラス名を名指しできるが、
 * 外から来た家には許さない——面を組み替えたときに崩れたことを見張れるのは、
 * リポジトリの中にある家だけ（`tests/theme-shape.spec.ts`）。外の家は黙って壊れ、
 * 書いた人にもこちらにも分からない。
 *
 * **契約に版がある。** 持ち込みの家が当てにしているのはトークンの名前なので、
 * 名前を変えたら壊れる。版が合わない家は載せず、理由を出す（I2）。
 *
 * 前提: `npm run build:web` 済み（packages/banto-web/dist）。
 */

import { test, expect } from "@playwright/test";
import { startLayoutHost, type LayoutHost, type UserThemeFixture } from "./layoutHost.js";

/** 版が合っている家の台帳（1件）。 */
function family(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sumizome",
    name: "墨染",
    description: "試験用",
    changes: "色",
    css: "sumizome.css",
    contract: 1,
    variants: { light: "sumizome-light", dark: "sumizome-dark" },
    swatch: {
      light: ["#F2F1EE", "#8C3A2E", "#3A3A3A"],
      dark: ["#17181A", "#D97A68", "#B9BCC0"],
    },
    ...overrides,
  };
}

/**
 * 行儀の悪い CSS。変数の上書きに混ぜて、
 * ①面のクラスを狙う規則 ②`:root` に素の宣言を混ぜた規則 ③全体を狙う規則 を入れてある。
 */
const NAUGHTY = `
:root[data-theme="sumizome-light"] {
  --paper: rgb(1, 2, 3);
  color-scheme: light;
}
:root[data-theme="sumizome-light"] .rail {
  display: none;
}
.msg--banto::before { content: "乗っ取り"; }
body { background: rgb(255, 0, 0); }
:root[data-theme="sumizome-light"] { --sumi: rgb(4, 5, 6); position: fixed; }
`;

/** 開いて、その家に切り替える。 */
async function open(page: import("@playwright/test").Page, host: LayoutHost): Promise<void> {
  await page.goto(`http://127.0.0.1:${host.port}/`);
  await page.evaluate(() => localStorage.setItem("banto.theme", "sumizome:light"));
  await page.reload();
  await page.waitForSelector(".msg--banto");
}

test.describe("持ち込みのテーマ", () => {
  test("変数は効くが、面を狙う規則は落とされる", async ({ page }) => {
    const fixture: UserThemeFixture = {
      families: [family()],
      css: { "sumizome.css": NAUGHTY },
    };
    const host = await startLayoutHost(fixture);
    const complaints: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") complaints.push(m.text());
    });
    await open(page, host);

    const seen = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
      rail: getComputedStyle(document.querySelector(".rail")!).display,
      mark: getComputedStyle(document.querySelector(".msg--banto")!, "::before").content,
      body: getComputedStyle(document.body).backgroundColor,
    }));

    // 家として載っている
    expect(seen.theme).toBe("sumizome-light");
    // 変数の上書きは効く
    expect(seen.paper).toBe("rgb(1, 2, 3)");
    // 面を狙う規則は効かない
    expect(seen.rail, "面のクラスを狙う規則が通っている").not.toBe("none");
    expect(seen.mark, "面の中身を書き換える規則が通っている").not.toContain("乗っ取り");
    expect(seen.body, "全体を狙う規則が通っている").not.toBe("rgb(255, 0, 0)");

    // I2: 落としたことを黙らない
    expect(complaints.join("\n")).toMatch(/変数の上書き以外は使えません/);
    await host.close();
  });

  test("`:root` でも素の宣言が混ざった規則は丸ごと落とす（変数だけを通さない）", async ({ page }) => {
    const host = await startLayoutHost({
      families: [family()],
      css: { "sumizome.css": NAUGHTY },
    });
    await open(page, host);

    // 最後の規則は `--sumi` と `position: fixed` が同居している。**規則ごと落とす**
    const sumi = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--sumi").trim()
    );
    expect(sumi, "素の宣言が混ざった規則の変数まで通っている").not.toBe("rgb(4, 5, 6)");
    await host.close();
  });

  test("契約の版が合わない家は載せず、理由を出す", async ({ page }) => {
    const host = await startLayoutHost({
      families: [family({ contract: 99 }), family({ id: "nocontract", contract: undefined })],
      css: { "sumizome.css": ":root[data-theme=\"sumizome-light\"] { --paper: rgb(1,2,3); }" },
    });
    const complaints: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") complaints.push(m.text());
    });
    await open(page, host);

    // 載っていないので、選んでも既定（和紙）のまま
    const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    expect(theme).toBe("washi-light");
    expect(complaints.join("\n")).toMatch(/契約の版が違います/);
    // 版が無いものも同じ扱い（半分だけ効いた家を出さない）
    expect(complaints.join("\n")).toMatch(/nocontract/);
    await host.close();
  });

  test("行儀のよい家はそのまま載る", async ({ page }) => {
    const host = await startLayoutHost({
      families: [family()],
      css: {
        "sumizome.css":
          ':root[data-theme="sumizome-light"] { --paper: rgb(9, 9, 9); color-scheme: light; }',
      },
    });
    await open(page, host);
    const seen = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute("data-theme"),
      paper: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim(),
    }));
    expect(seen.theme).toBe("sumizome-light");
    expect(seen.paper).toBe("rgb(9, 9, 9)");
    await host.close();
  });
});
