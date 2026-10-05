// **履歴を上へ辿っている間に、中身の高さが伸びない**
// （`mobile-transcript-height-jump`、2026-09-10）。
//
// 症状：携帯幅で上へ辿る間に、履歴の器の scrollHeight が伸びる。新しい発言は
// 来ていないのに伸びるので、指で追っている位置がずれる。
//
// 原因は `content-visibility: auto`（`contain-intrinsic-size: auto 200px`）だった
// ——まだ画面に入っていない発言は**見込みの 200px**で数えられ、辿って初めて実寸に
// 置き換わる。**実データ（54発言）で測って確かめた**：15,770px → 29,742px
// （+13,972）。無効にすると 31,589px のまま動かない。
//
// **この spec だけでは症状を再現できない**（実測・2026-09-10）——短い会話では
// 上のほうも「画面の近く」に入ってしまい、見込みのまま残る発言が作れない。
// そこで**2つ見る**：辿る間に伸びないこと（振る舞い）と、履歴の項目に
// `content-visibility` が付いていないこと（**原因そのもの**）。
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Transcript Height Project";

const scrollHeight = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    return sc?.scrollHeight ?? 0;
  });

test("履歴を上へ辿っても、中身の高さは増えない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-height-"));
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  const threadId: string = (
    await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()
  )[0].id;

  // 画面より長い履歴を作る（コードブロックは行が畳まれないので高さが出る）
  const composer = page.getByPlaceholder(/に送る/);
  for (let turn = 1; turn <= 3; turn++) {
    await composer.fill(
      `${turn}回目。40行のコードブロックを1つだけ出して。中身は \`const a1 = 1;\` のように` +
        "変数名の番号だけを 1 から 40 まで変えた行を、1行ずつ。説明は書かないで。",
    );
    await composer.press("Enter");
    await waitTurnEnded(page, threadId, turn, 120_000);
  }

  // **一度リロードする**——人が踏むのは「開き直した会話を辿る」場面で、そのときの
  // 上のほうは**一度も描かれていない**（走らせた直後は全部描かれている）
  await page.reload();
  await expect(page.getByPlaceholder(/に送る/)).toBeVisible({ timeout: 30_000 });
  // 窓を小さくして、器から遠いぶんを増やす
  await page.setViewportSize({ width: 390, height: 400 });
  await expect
    .poll(async () => await scrollHeight(page), { timeout: 30_000, message: "履歴が戻るまで" })
    .toBeGreaterThan(500);

  // 高さが落ち着くまで待つ
  let previous = await scrollHeight(page);
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(400);
        const now = await scrollHeight(page);
        const stable = now === previous && now > 0;
        previous = now;
        return stable;
      },
      { timeout: 30_000, message: "高さが落ち着くまで" },
    )
    .toBe(true);

  // ---- ① 振る舞い：辿る間に伸びない --------------------------------------
  const start = await scrollHeight(page);
  await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    sc?.scrollTo({ top: sc.scrollHeight, behavior: "instant" });
  });

  const samples: number[] = [];
  for (let step = 0; step < 25; step++) {
    const done = await page.evaluate(() => {
      const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
      if (!sc) return true;
      sc.scrollBy({ top: -sc.clientHeight * 0.8, behavior: "instant" });
      return sc.scrollTop <= 0;
    });
    await page.waitForTimeout(120);
    samples.push(await scrollHeight(page));
    if (done) break;
  }
  const grew = Math.max(...samples) - start;
  expect(grew, `上へ辿る間に中身が ${grew}px 伸びた（開始 ${start}px）`).toBeLessThanOrEqual(0);

  // ---- ② 原因そのもの：履歴の項目に content-visibility を付けない ---------
  // 短い会話では①だけでは捕まえられない（上のほうも「画面の近く」に入るため）。
  // **戻ってきたら分かるように**、原因の側も見る
  const withContentVisibility = await page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]');
    if (!sc) return ["履歴の器が無い"];
    return [...sc.querySelectorAll<HTMLElement>("*")]
      .filter((el) => {
        const value = getComputedStyle(el).contentVisibility;
        return value === "auto" || value === "hidden";
      })
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)}`)
      .slice(0, 5);
  });
  expect(
    withContentVisibility,
    "履歴の項目に content-visibility が付いている（辿る間に高さが伸びる）",
  ).toEqual([]);
});
