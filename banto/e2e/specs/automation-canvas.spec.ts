// **自動化の画面**（v4-frontend.md §6.42、Backlog #318）。
//
// 見ること（画面だけで操作し、中身は host の台帳・会話の記録と突き合わせる）：
//   1. Command Palette の「自動化」で、会話の隣に自動化の画面（Canvas）が開く。まだ無ければ「まだありません」
//   2. その場のフォームで時刻の自動化を作ると一覧に1行出る——名前・きっかけ・届け先・次の時刻・「まだ動いていません」。
//      サイドバーの専用の Fork が稲妻の印で出る（目次に「自動化（n）」の行は出さない）
//   3. 「今すぐ動かす」で専用の Fork にターンが走り、直近の回に「終わりました（今すぐ動かした回）」が出る
//   4. 「会話を開く」で専用の Fork が隣に開き、上に帯（自動化の名前・いつ・毎回まっさら・次は）と AI の返事が出る
//   5. 入口3つ（専用の Fork の帯の「一覧」・サイドバーの専用の Fork の「…」の「自動化の設定を開く」・Command Palette）が、どれも開いている会話を
//      閉じずに隣に開く
//   6. 別タブでも開ける（どの Project のものかを運ぶ）
//   7. 専用の Fork を閉じるときは「自動化を一時停止します」と確かめ、閉じると一覧で一時停止中になる
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, openPaletteEntry, waitTurnEnded } from "../helpers.js";

test.setTimeout(240_000);

const PROJECT_NAME = "E2E Automation Canvas";
const AUTOMATION_NAME = "毎朝のまとめ";
const REPLY = "まとめました：コミットは2件です。";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Run = { runId: string; result: string; cause: string; threadId?: string };
type Automation = {
  id: string;
  name: string;
  paused: boolean;
  source: { kind: string; repeat: { kind: string; time?: string }; timeZone: string };
  target: { kind: string; mode?: string; threadId?: string };
  runs: Run[];
  nextFireAt?: string;
};

/** 自動化の画面が隣に開いていて、`forkId` の会話も閉じていない（入口の決まり：会話を閉じずに隣に開く） */
async function expectCanvasBesideFork(page: Page, forkId: string, via: string): Promise<void> {
  await expect(page.getByTestId("automations"), `${via}から自動化の画面が開かない`).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("automation-row"), `${via}から開いた一覧に自動化が出ない`).toHaveCount(1);
  const url = new URL(page.url());
  expect(url.searchParams.get("canvas"), via).toBe("banto:triggers");
  expect(url.searchParams.get("fork"), `${via}から開いたら会話が閉じた`).toBe(forkId);
  await expect(page.getByTestId("automation-band"), `${via}から開いたら専用の Fork の面が消えた`).toBeVisible();
}

/** サイドバーの専用の Fork の行の「…」から「自動化の設定を開く」を押す */
async function openAutomationsFromForkMenu(page: Page, forkTitle: string): Promise<void> {
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const item = sidebar.locator("li", { has: page.getByTestId("sidebar-fork-name").filter({ hasText: forkTitle }) }).last();
  await item.hover();
  await item.getByTestId("sidebar-item-more").click();
  await page.getByRole("menuitem", { name: "自動化の設定を開く" }).click();
}

async function closeCanvas(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect(page.getByTestId("automations")).toBeHidden({ timeout: 15_000 });
}

test("画面から時刻の自動化を作り、今すぐ動かすと専用の Fork で走って直近の回に出る。入口3つと別タブ、閉じる確認", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-automation-canvas-")));
  const projectId = currentProjectId(page);
  const api = `${CORE_BASE_URL}/api/projects/${projectId}/automations`;
  const list = async () => ((await (await page.request.get(api, { headers })).json()) as { automations: Automation[] }).automations;

  // ---- 1. Command Palette から開く。会話（Base）はそのまま ------------------------------------------------------
  await openPaletteEntry(page, /^自動化/);
  await expect(page.getByTestId("automations")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("自動化", { exact: true }).first(), "Canvas の見出しが「自動化」でない").toBeVisible();
  await expect(page.getByTestId("automations-empty")).toBeVisible();
  await expect(page.getByTestId("automations-how")).toContainText("前の回がまだ動いている");
  expect(new URL(page.url()).searchParams.get("canvas")).toBe("banto:triggers");
  await expect(page.getByPlaceholder(/に送る/).first(), "自動化を開いたら会話が消えた").toBeVisible();
  // 目次に「自動化（n）」の行は出さない（2026-10-18、ユーザー）
  await expect(page.getByTestId("sidebar-automations")).toHaveCount(0);

  // ---- 2. その場のフォームで作る ----------------------------------------------------------------------------
  // 時計がこの試験の間に動かない時刻（12時間後、UTC）
  const at = new Date(Date.now() + 12 * 3_600_000);
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  await page.getByTestId("automation-add").click();
  const form = page.getByTestId("automation-form");
  await expect(form).toBeVisible();
  await form.getByTestId("automation-when-daily").click();
  await form.getByTestId("automation-time").fill(`${hh}:${mm}`);
  await form.getByRole("combobox", { name: "タイムゾーン" }).click();
  await page.getByRole("option", { name: /（UTC）$/ }).click();
  await expect(form.getByTestId("automation-when-preview")).toContainText(`毎日 ${Number(hh)}:${mm}`);
  await form.getByLabel("毎回届ける指示").fill("昨日からのコミットをまとめてください。" + fakeTurn({ say: REPLY }));
  await form.getByLabel("名前").fill(AUTOMATION_NAME);
  await form.getByTestId("automation-submit").click();
  await expect(form, "足したのにフォームが閉じない").toBeHidden({ timeout: 15_000 });

  // 台帳と突き合わせる
  const [created] = await list();
  expect(created, "台帳に自動化が無い").toBeTruthy();
  expect(created!.name).toBe(AUTOMATION_NAME);
  expect(created!.source).toEqual({ kind: "time", repeat: { kind: "daily", time: `${Number(hh)}:${mm}` }, timeZone: "UTC" });
  expect(created!.target.kind).toBe("dedicated");
  expect(created!.target.mode).toBe("fresh");
  const forkId = created!.target.threadId!;
  expect(forkId, "専用の Fork が立っていない").toBeTruthy();

  // 一覧の1行
  const row = page.getByTestId("automation-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("automation-name")).toHaveText(AUTOMATION_NAME);
  const summary = row.getByTestId("automation-summary");
  await expect(summary).toContainText(`毎日 ${Number(hh)}:${mm}（`);
  await expect(summary).toContainText("毎回まっさら");
  await expect(row.getByTestId("automation-next")).toHaveText(new RegExp(`^次は (今日|明日) ${Number(hh)}:${mm}$`));
  await expect(row.getByTestId("automation-last-run")).toHaveText("まだ動いていません");
  await expect(row.getByTestId("automation-paused")).toHaveCount(0);

  // サイドバー：専用の Fork は稲妻の印で出る（host が立てた Fork を取り直して足す）。目次に「自動化（n）」の行は無い
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const forkRow = sidebar.locator("a", { has: page.getByTestId("sidebar-fork-name").filter({ hasText: AUTOMATION_NAME }) });
  await expect(forkRow, "専用の Fork がサイドバーに出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(forkRow.locator("svg.lucide-zap"), "専用の Fork の印が稲妻でない").toHaveCount(1);

  // ---- 3. 今すぐ動かす：専用の Fork でターンが走り、直近の回に出る ---------------------------------------------
  await row.getByRole("button", { name: AUTOMATION_NAME }).click();
  const details = row.getByTestId("automation-details");
  await expect(details.getByTestId("automation-instruction")).toContainText("昨日からのコミットをまとめてください。");
  await expect(details).toContainText("専用の Fork に、毎回まっさらな会話で届けます。");
  await expect(details).toContainText("終わった回を出します。");
  await details.getByTestId("automation-run-now").click();
  await waitTurnEnded(page, forkId, 1);
  await expect.poll(async () => (await list())[0]!.runs.map((r) => `${r.cause}:${r.result}`), { message: "台帳の回が done にならない" }).toEqual([
    "manual:done",
  ]);
  await expect(row.getByTestId("automation-last-run"), "直近の回が画面に出ない").toHaveText(/^前の回（今日 \d{1,2}:\d{2}）：終わりました$/, {
    timeout: 15_000,
  });
  await expect(row.locator('[data-testid="automation-run-strip"] > span')).toHaveCount(1);
  await expect(row.locator('[data-testid="automation-run-strip"] > span[data-result="done"]')).toHaveCount(1);
  const run = details.getByTestId("automation-run");
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-result", "done");
  await expect(run).toContainText("終わりました（今すぐ動かした回）");
  await expect(details.getByTestId("automation-message"), "届けたのに「動かしませんでした」が出た").toHaveCount(0);

  // ---- 4. 会話を開く：専用の Fork が隣に開き、帯と AI の返事が出る ----------------------------------------------
  await details.getByTestId("automation-open-thread").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("fork")).toBe(forkId);
  expect(new URL(page.url()).searchParams.get("canvas"), "会話を開いたら一覧が閉じた").toBe("banto:triggers");
  const band = page.getByTestId("automation-band");
  await expect(band).toBeVisible({ timeout: 15_000 });
  await expect(band.getByTestId("automation-band-text")).toHaveText(
    new RegExp(`^自動化「${AUTOMATION_NAME}」で動く会話です（毎日 ${Number(hh)}:${mm}（.+）・毎回まっさら）。次は (今日|明日) ${Number(hh)}:${mm}。$`),
  );
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: REPLY })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("delivered-title").filter({ hasText: `自動化「${AUTOMATION_NAME}」` })).toBeVisible();

  // ---- 5. 入口3つ：どれも会話を閉じずに隣に開く ------------------------------------------------------------
  await closeCanvas(page);
  await band.getByTestId("automation-band-list").click();
  await expectCanvasBesideFork(page, forkId, "専用の Fork の帯の「一覧」");

  await closeCanvas(page);
  await expect(sidebar.getByTestId("sidebar-automations"), "目次に「自動化（n）」の行が出ている").toHaveCount(0);
  await openAutomationsFromForkMenu(page, AUTOMATION_NAME);
  await expectCanvasBesideFork(page, forkId, "サイドバーの専用の Fork の「…」の「自動化の設定を開く」");

  await closeCanvas(page);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  // 「cron」でも引ける
  await page.getByPlaceholder(/検索/).first().fill("cron");
  const paletteEntry = page.getByRole("option", { name: /^自動化/ });
  await expect(paletteEntry, "「cron」で自動化が引けない").toBeVisible();
  await expect(paletteEntry, "Command Palette の「自動化」に件数が添えられていない").toContainText("この Project の自動化（1 件）");
  await paletteEntry.click();
  await expectCanvasBesideFork(page, forkId, "Command Palette");

  // ---- 6. 別タブでも開ける ------------------------------------------------------------------------------
  const [tab] = await Promise.all([page.context().waitForEvent("page"), page.getByRole("button", { name: "別タブで開く" }).click()]);
  await expect(tab.getByTestId("automation-row"), "別タブに自動化が出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(tab.getByTestId("automation-name")).toHaveText(AUTOMATION_NAME);
  await expect(tab.getByTestId("automation-last-run")).toHaveText(/^前の回（今日 \d{1,2}:\d{2}）：終わりました$/);
  await expect(tab.getByText(`自動化 - ${PROJECT_NAME}`), "別タブの見出しに Project の名前が無い").toBeVisible({ timeout: 15_000 });
  expect(new URL(tab.url()).searchParams.get("project")).toBe(projectId);
  await tab.close();
  await expect(page.getByTestId("automations"), "別タブへ出したのに元の画面が開いたまま").toBeHidden({ timeout: 15_000 });

  // ---- 7. 専用の Fork を閉じるときは「自動化を一時停止します」と確かめる -----------------------------------------
  await page.getByRole("button", { name: "この Fork Thread を Close" }).click();
  const warning = page.getByTestId("close-fork-warning");
  await expect(warning).toBeVisible();
  await expect(warning.getByTestId("close-fork-automation")).toContainText(`自動化「${AUTOMATION_NAME}」を一時停止します。`);
  await warning.getByRole("button", { name: "それでも閉じる" }).click();
  await expect.poll(async () => (await list())[0]!.paused, { message: "閉じたのに一時停止にならない" }).toBe(true);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  await page.getByPlaceholder(/検索/).first().fill("自動化");
  await page.getByRole("option", { name: /^自動化/ }).click();
  await expect(page.getByTestId("automation-row").getByTestId("automation-paused"), "一覧に一時停止中が出ない").toHaveText("一時停止中", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("automation-next"), "一時停止中なのに次の時刻を出している").toHaveCount(0);
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: AUTOMATION_NAME }), "閉じた専用の Fork がサイドバーに残る").toHaveCount(0);

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
