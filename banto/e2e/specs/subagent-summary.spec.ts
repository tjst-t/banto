// **仕事の画面の要約——人がボタンを押したときだけ**（決定・2026-10-20、ユーザー。アーキ仕様 §4.1「4.」・§4.2「2.」、Backlog #490）。
//
// サブエージェントに待たない形で仕事を頼み、仕事の画面の「いまの様子を要約」を押す。小さいモデルは偽物（`fake-runner.ts` の
// `oneShot`——材料の `[[fake-title:…]]` をそのまま答え、呼ばれるたびに `FAKE_ONE_SHOT_LOG` に1行足す）。材料には頼んだ文の頭が
// 入るので、頼んだ文に印を書いておく。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 押す前：ボタンと断り書きが出ていて、要約は無い。サイドバーの一覧の1件にも要約が無い。**小さいモデルは呼ばれていない**
//   2. 押すと：画面に「要約（たった今）」・文・「サイドバーのバックグラウンドの一覧にも出ています。AI には渡しません。」。小さいモデルは
//      1回だけ、その仕事の材料（頼んだ文）で呼ばれた。サイドバーの一覧の1件に「要約：<文>（いま）」
//   3. すぐ「作り直す」を押すと、core の断り（10 秒あけて）がそのまま画面に出て、前の要約は残る
//   4. 画面を開き直しても要約が出ている
//   5. 止めたあと（終わった仕事）は要約が残り、ボタンは出ない
import { test, expect } from "../test-base.js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, FAKE_ONE_SHOT_LOG } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, countAiText, openPaletteEntry, settleProjectsInbox } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Summary";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const SUMMARY = "いまは仕様を読み終え、テストを直しています。";
const LABEL = "要約の試験";
const PROMPT = `[slow 120] 要約の試験の仕事 [[fake-title:${SUMMARY}]]`;

/** 偽の小さいモデルが、要約の指示（core の BACKGROUND_SUMMARY_SYSTEM_PROMPT）で呼ばれた回 */
function summaryCalls(): Array<{ prompt: string }> {
  if (!existsSync(FAKE_ONE_SHOT_LOG)) return [];
  return readFileSync(FAKE_ONE_SHOT_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { system: string; prompt: string })
    .filter((c) => c.system.startsWith("You summarize a piece of background work"));
}

test.afterAll(async ({ request }) => {
  await settleProjectsInbox(request, [PROJECT_NAME]);
});

test("仕事の画面で「いまの様子を要約」を押したときだけ要約ができ、画面とサイドバーに出る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const before = summaryCalls().length;

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-sa-sum-")));
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const line = sidebar.getByTestId("thread-background");
  const list = page.getByTestId("background-list");
  const item = list.getByTestId("background-item");

  // ---- 待たない形で1つ頼む -----------------------------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "待たずに頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: PROMPT, label: LABEL, runInBackground: true } }] }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await expect.poll(() => countAiText(page, /待たずに頼みました/), { timeout: 10_000 }).toBe(1);
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, threadId, 1);
  await expect(line, "Base Thread の行に裏の仕事が出ない").toHaveText(LABEL, { timeout: 30_000 });

  // ---- 1. 押す前 -------------------------------------------------------------------------------------
  await openPaletteEntry(page, /サブエージェント/);
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const running = canvas.locator('[data-role="run-item"][data-status="running"]');
  await expect(running.locator('[data-role="progress"]')).toHaveText("sleep 120", { timeout: 60_000 });
  await running.locator('[data-role="run"]').click();
  const now = canvas.locator('[data-role="detail"] [data-role="now"]');
  const ask = now.locator('[data-role="summarize"]');
  await expect(ask).toHaveText("いまの様子を要約");
  await expect(now).toContainText("押したときだけ、小さいモデルで2文にまとめます。本体の Claude の使用量に数えます。");
  await expect(now.locator('[data-role="summary"]')).toHaveCount(0);
  // 要約は「いまやっていること」の下
  expect(
    await now.evaluate((el) => {
      const doing = el.querySelector('[data-role="now-doing"]')!;
      const box = el.querySelector('[data-role="summary-box"]')!;
      return Boolean(doing.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  ).toBe(true);
  await line.click();
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("background-item-summary"), "押していないのに要約が出ている").toHaveCount(0);
  await page.keyboard.press("Escape");
  // 走っている間の取り直し（1.5 秒ごと）を何回か挟んでも、押さなければ小さいモデルは呼ばれない
  await page.waitForTimeout(5_000);
  expect(summaryCalls().length - before, "押していないのに要約の口が呼ばれた").toBe(0);

  // ---- 2. 押す --------------------------------------------------------------------------------------
  await ask.click();
  const summary = now.locator('[data-role="summary"]');
  await expect(summary.locator('[data-role="summary-text"]'), "押したのに要約が出ない").toHaveText(SUMMARY, { timeout: 30_000 });
  await expect(summary.locator('[data-role="summary-when"]')).toHaveText("要約（たった今）");
  await expect(summary.locator('[data-role="summary-note"]')).toHaveText("サイドバーのバックグラウンドの一覧にも出ています。AI には渡しません。");
  await expect(now.locator('[data-role="summary-working"]')).toHaveCount(0);
  await expect(summary.locator('[data-role="summarize"]')).toHaveText("作り直す");
  const calls = summaryCalls().slice(before);
  expect(calls, "小さいモデルが1回だけ呼ばれていない").toHaveLength(1);
  expect(calls[0]!.prompt).toContain("要約の試験の仕事");
  expect(calls[0]!.prompt).toContain(`呼び名：${LABEL}`);
  // サイドバーの一覧の1件にも出る（行は題のまま）
  await expect(line).toHaveText(LABEL);
  await line.click();
  await expect(item.getByTestId("background-item-summary"), "サイドバーの一覧に要約が出ない").toHaveText(`要約：${SUMMARY}（いま）`, { timeout: 15_000 });
  await page.keyboard.press("Escape");

  // ---- 3. すぐ作り直すと、core の断りがそのまま出る ---------------------------------------------------------
  await summary.locator('[data-role="summarize"]').click();
  await expect(now.locator('[data-role="summary-error"]'), "断りが画面に出ない").toContainText(
    /要約を作れませんでした：前の要約から 10 秒あけてください（あと \d+ 秒）/,
    { timeout: 15_000 },
  );
  await expect(now.locator('[data-role="summary-error"] [data-role="summarize"]')).toHaveText("もう一度");
  await expect(summary.locator('[data-role="summary-text"]'), "断られたら前の要約が消えた").toHaveText(SUMMARY);
  expect(summaryCalls().length - before, "断られた回に小さいモデルを呼んだ").toBe(1);

  // ---- 4. 開き直しても出ている ---------------------------------------------------------------------------
  await page.reload();
  await openPaletteEntry(page, /サブエージェント/);
  // 選んでいた仕事は見ている場所（view-state）から戻る——狭い形では一覧ではなくその中身が開く
  await expect(canvas.locator('[data-role="detail-title"]'), "開き直したらその仕事に戻らない").toHaveText(LABEL, { timeout: 60_000 });
  await expect(now.locator('[data-role="summary-text"]'), "開き直したら要約が消えた").toHaveText(SUMMARY, { timeout: 30_000 });

  // ---- 5. 止めたあとも残り、ボタンは出ない -------------------------------------------------------------------
  await canvas.locator(".detail-head").getByRole("button", { name: "止める" }).click();
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("取り消し", { timeout: 20_000 });
  await expect(now.locator('[data-role="summary-text"]')).toHaveText(SUMMARY);
  await expect(now.locator('[data-role="summarize"]'), "終わった仕事に要約のボタンが出ている").toHaveCount(0);
  await expect(now.locator('[data-role="summary-error"]')).toHaveCount(0);
  await expect(line, "止めたのにサイドバーに残っている").toHaveCount(0, { timeout: 30_000 });
  expect(summaryCalls().length - before).toBe(1);

  expect(pageErrors, `画面で例外が出た：${pageErrors.join(" / ")}`).toEqual([]);
});
