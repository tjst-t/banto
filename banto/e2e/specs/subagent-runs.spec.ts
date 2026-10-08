// サブエージェントの入口（launcher、決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」
// 「シンプルすぎるので良い UI に」）。Command Palette の「Module の入口」から、AI を介さずに開く。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 入口に「サブエージェント」が名乗った名前と説明で出て、開くと会話の隣に出る。まだ何も頼んでいなければ
//      空であることと頼み方を言い、開いたまま頼むと一覧に増える
//   2. エージェントごとの資格情報の状態が、チップの文字と色で読める
//   3. 頼んだ仕事が一覧に出て、選ぶと中身（頼んだ文・経過・返答・session id）が読める
//      （会話の隣は狭い形——一覧と中身を行き来する）
//   4. 走っている仕事は「実行中」と最後に呼んだツールが出て、中身には経過が伸びる。
//      一覧の「止める」を押すと取り消しで返る（会話の側にも取り消しとして返る）
//   5. リロードしても記録が残っている。広い画面では一覧と中身が左右に並び、新しい仕事が選ばれている
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded, openPaletteEntry } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Runs";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

test("サブエージェントの入口：仕事の一覧・中身・走っている様子が見え、止められる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-runs-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[];
  const threadId = threads[0]!.id;
  const assistantTexts = async () =>
    ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
      messages: { role: string; text: string }[];
    }).messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);

  // ---- 1. 入口から開く（AI には頼まない）---------------------------------------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /サブエージェント/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("この Project でサブエージェントに頼んだ仕事と、その様子を見る");
  await entry.click();
  await expect(page.getByText(/^Canvas — subagent$/), "入口から Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  // まだ何も頼んでいない——空であることを言い、頼み方を示す（広い形でも中身の欄を空けて並べない）
  await expect(canvas.locator('[data-role="empty"]')).toContainText("まだ頼んだ仕事はありません", { timeout: 60_000 });
  await expect(canvas.locator('[data-role="empty"]')).toContainText("会話で「Claude Code にテストを直させて」のように頼むと、ここに並びます。");
  await expect(canvas.locator('[data-role="run"]')).toHaveCount(0);
  await expect(canvas.locator('[data-role="detail"]')).toHaveCount(0);

  // ---- 画面を開いたまま、仕事を1つ頼んで終わらせる（一覧は取り直しで増える）-------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "メモを書かせて。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[write memo.txt] メモを書いて" } }] }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは、設定の鍵を Vault に探しに行く——Project ごとに初回だけ承認が出る
  // （在りかを聞く口。Shell の envSecrets と同じ）。**成功したときにだけ現れるもの**（返答）を待つ
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
    }
    await expect(page.getByText(/書いた：memo\.txt/).first()).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 180_000 });
  await waitTurnEnded(page, threadId, 1, 120_000);
  const first = JSON.parse((await assistantTexts())[0]!) as { sessionId: string };
  await expect(canvas.locator('[data-role="run"]'), "開いたままの画面に、頼んだ仕事が出てこない").toHaveCount(1, { timeout: 30_000 });
  await expect(canvas.locator('[data-role="empty"]')).toHaveCount(0);

  // ---- 2. エージェントの資格情報の状態 ----------------------------------------------------
  // 会話の隣は狭い形（一覧 → 選ぶと中身）。広い形は 5. で見る
  await expect(canvas.locator('[data-role="agent"][data-agent="fake"]')).toHaveText("Fake Agent（試験用）鍵なし", { timeout: 60_000 });
  await expect(canvas.locator('[data-role="agent"][data-agent="fake"]')).toHaveAttribute("data-tone", "warn");
  await expect(canvas.locator('[data-role="agent"][data-agent="fake"]')).toHaveAttribute(
    "title",
    "鍵は banto 全体の設定の「サブエージェント」で入れる",
  );
  await expect(canvas.locator('[data-role="agent"][data-agent="fake-host"]')).toHaveText(
    "Fake Agent（本体のログイン・試験用）本体のログイン・max",
  );
  await expect(canvas.locator('[data-role="agent"][data-agent="fake-host"]')).toHaveAttribute("data-tone", "ok");

  // ---- 3. 一覧と中身 ---------------------------------------------------------------------
  const rows = canvas.locator('[data-role="run"]');
  await expect(rows).toHaveCount(1);
  await expect(canvas.locator(".list-label")).toHaveText(["終わった仕事1"]);
  const done = rows.first();
  await expect(done.locator('[data-role="status"]')).toHaveText("完了");
  await expect(done.locator('[data-role="prompt"]')).toHaveText("[write memo.txt] メモを書いて");
  await expect(done).toContainText("Fake Agent（試験用）（fake-small）");
  await expect(done).toContainText("ツール 1回");
  await expect(canvas.locator('[data-role="running-count"]')).toHaveCount(0);
  await done.click();
  const detail = canvas.locator('[data-role="detail"]');
  await expect(detail, "狭い形で中身が開かない").toBeVisible();
  await expect(rows.first(), "狭い形なのに一覧が中身と並んでいる").toBeHidden();
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("完了");
  await expect(detail.locator('[data-role="detail-prompt"]')).toHaveText("[write memo.txt] メモを書いて");
  await expect(detail.locator('[data-role="step"] .step-title')).toHaveText(["write memo.txt"]);
  await expect(detail.locator('[data-role="step"]')).toHaveAttribute("data-kind", "other");
  await expect(detail.locator('[data-role="detail-reply"]')).toContainText("書いた：memo.txt");
  await expect(detail.locator('[data-role="detail-session"]')).toHaveText(first.sessionId);
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await expect(rows.first()).toBeVisible();

  // ---- 4. 走っている仕事の様子と「止める」 ---------------------------------------------------
  await composer.fill(
    "長い仕事を頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 45] [draft] 長い仕事" } }] }),
  );
  await composer.press("Enter");
  const running = canvas.locator('[data-role="run-item"][data-status="running"]');
  await expect(running, "走っている仕事が一覧に出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(canvas.locator(".list-label")).toHaveText(["実行中1", "終わった仕事1"]);
  await expect(canvas.locator('[data-role="running-count"]')).toHaveText("1件 実行中");
  await expect(running.locator('[data-role="status"]')).toHaveText("実行中");
  await expect(running.locator('[data-role="prompt"]')).toHaveText("[slow 45] [draft] 長い仕事");
  await expect(running.locator('[data-role="progress"]')).toHaveText("sleep 45", { timeout: 15_000 });
  // 中身：経過が伸び、書きかけの返答が見える
  await running.locator('[data-role="run"]').click();
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("実行中");
  await expect(detail.locator('[data-role="step"] .step-title')).toHaveText(["sleep 45"]);
  await expect(detail.locator('[data-role="detail-progress"]')).toHaveText("作業中");
  await expect(detail.locator('[data-role="detail-reply"]')).toHaveText("書きかけ…", { timeout: 15_000 });
  await expect(detail).toContainText("書いている返答");
  await canvas.getByRole("button", { name: "一覧に戻る" }).click();
  await running.getByRole("button", { name: "止める" }).click();
  await expect(canvas.locator('[data-role="run-item"][data-status="cancelled"] [data-role="status"]')).toHaveText("取り消し", {
    timeout: 20_000,
  });
  await expect(running).toHaveCount(0);
  await expect(canvas.locator('[data-role="running-count"]')).toHaveCount(0);
  await expect(canvas.locator(".list-label")).toHaveText(["終わった仕事2"]);
  // 会話の側にも、取り消しとして返る
  await waitTurnEnded(page, threadId, 2);
  expect(JSON.parse((await assistantTexts())[1]!).stopReason).toBe("cancelled");

  // ---- 5. リロードしても記録が残る（広い画面で開き直す——一覧と中身が左右に並ぶ）----------------
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.reload();
  await expect(page.getByText(/^Canvas — subagent$/)).toBeVisible({ timeout: 30_000 });
  const reloaded = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(reloaded.locator('[data-role="run"] [data-role="status"]')).toHaveText(["取り消し", "完了"], { timeout: 60_000 });
  // 新しい仕事（取り消した方）が選ばれ、一覧と並んで中身が出る
  const wideDetail = reloaded.locator('[data-role="detail"]');
  await expect(wideDetail, "広い形で中身が並んでいない").toBeVisible();
  await expect(reloaded.locator('[data-role="run"]').first()).toBeVisible();
  await expect(reloaded.locator('[data-role="run"]').first()).toHaveAttribute("aria-current", "true");
  await expect(reloaded.locator('[data-role="detail-status"]')).toHaveText("取り消し");
  await expect(wideDetail.locator('[data-role="step"] .step-title')).toHaveText(["sleep 45"]);
  await expect(wideDetail.locator('[data-role="detail-reply"]')).toHaveText("書きかけ…");
  await expect(reloaded.getByRole("button", { name: "一覧に戻る" })).toHaveCount(0);
  await reloaded.locator('[data-role="run"]').nth(1).click();
  await expect(reloaded.locator('[data-role="detail-status"]')).toHaveText("完了");
  await expect(wideDetail.locator('[data-role="detail-reply"]')).toContainText("書いた：memo.txt");

  expect(pageErrors).toEqual([]);
});

// 走っている間は1.5秒ごとに読み直して丸ごと描き直す——中の枠（頼んだ内容・中身の本文）を下へスクロールしても、
// 読み直しのあとに先頭へ戻されない（2026-10-07、ユーザー報告）
test("サブエージェントの入口：走っている仕事の中の枠をスクロールしても、読み直しで先頭へ戻らない", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-runs-scroll-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // 低い画面にして、中身の本文もはみ出させる
  await page.setViewportSize({ width: 1280, height: 560 });

  await openApp(page);
  await createProject(page, `${PROJECT_NAME} Scroll`, projectRoot);
  await waitForProjectModule(page, `${PROJECT_NAME} Scroll`, "subagent");
  const longPrompt = ["[slow 40] 長い頼み", ...Array.from({ length: 60 }, (_, i) => `${i + 1} 行目：ここまで読んだ`)].join("\n");
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("長い頼みを出して。" + fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: longPrompt } }] }));
  await composer.press("Enter");

  await openPaletteEntry(page, /サブエージェント/);
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  const running = canvas.locator('[data-role="run-item"][data-status="running"]');
  const detail = canvas.locator('[data-role="detail"]');
  // 鍵を Vault に探しに行く承認が初回だけ出る——tool を始めた（経過に出た）まで押し続ける
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await expect(running).toHaveCount(1, { timeout: 5_000 });
    if ((await detail.count()) === 0) await running.locator('[data-role="run"]').click();
    await expect(detail.locator('[data-role="step"] .step-title')).toHaveText(["sleep 40"], { timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  const prompt = detail.locator('[data-role="detail-prompt"]');
  await expect(prompt).toContainText("60 行目：ここまで読んだ");

  // 頼んだ内容の枠と中身の本文を、どちらも一番下まで送る
  const toBottom = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  };
  const promptTop = await prompt.evaluate(toBottom);
  const detailTop = await detail.evaluate(toBottom);
  expect(promptTop, "頼んだ内容の枠がスクロールできない（長さが足りない）").toBeGreaterThan(0);
  expect(detailTop, "中身の本文がスクロールできない（画面が高すぎる）").toBeGreaterThan(0);

  // 読み直しで描き直されたこと（経過の時刻が進む）を確かめてから、位置を見る
  const clock = detail.locator(".step-end .step-at");
  const before = await clock.textContent();
  await page.waitForTimeout(5_000);
  await expect(clock).not.toHaveText(before ?? "");
  await expect(running).toHaveCount(1);
  expect(await prompt.evaluate((el) => el.scrollTop), "頼んだ内容の枠が先頭へ戻された").toBe(promptTop);
  expect(await detail.evaluate((el) => el.scrollTop), "中身の本文が先頭へ戻された").toBe(detailTop);

  // 止めて片づける
  await canvas.locator(".detail-head").getByRole("button", { name: "止める" }).click();
  await expect(canvas.locator('[data-role="detail-status"]')).toHaveText("取り消し", { timeout: 20_000 });
  expect(pageErrors).toEqual([]);
});
