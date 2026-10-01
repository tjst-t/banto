// **Repositories——手元のリポジトリの台帳**（v4-modules.md §2.4、段階1）。
//
// 見るのは、規則13・規則14 の意味で「繋がっていること」：
//   1. 入口（launcher）から AI を介さず人が開け、本物の台帳（Module のデータ置き場）を見ている
//   2. Import が本物の git を読んで判断する——断る理由と次の手、足したあとの行の中身（区切り・GitHub の場所・
//      アカウント・使っている Project）を1つずつ見る
//   3. フォルダが消えた・origin が変わった・一覧から外す／元に戻す——画面に出る値まで見る
//   4. まだ作っていない手（Project を始める・GitHub に公開・clone し直す）は、押すと「まだ作っていない」と言う
//   5. 設定の面にも同じ一覧と既定の置き場が出て、置き場を変えると一覧の説明も変わる
//   6. 狭い幅で縦に積み、はみ出さない
import { test, expect, type FrameLocator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, expectProjectOpen, openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Repositories Project";
const base = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-repositories-")));
const usedRepo = join(base, "used-repo");
const localRepo = join(base, "local-only");
const goneRepo = join(base, "gone-repo");
const plain = join(base, "plain");
const HOME_DIR = `/tmp/banto-e2e-repo-home-${Date.now()}`;

/** 画面が見せる形（home の下は `~/…`）。Module は home を同じ環境から読む */
function shown(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "ignore",
  });
}
function makeRepo(dir: string, origin?: string, commit = true): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  if (origin) git(dir, "remote", "add", "origin", origin);
  if (commit) {
    writeFileSync(join(dir, "README.md"), "e2e\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "first");
  }
}

test.beforeAll(() => {
  makeRepo(usedRepo, "git@github.com:e2e-owner/used-repo.git");
  mkdirSync(join(usedRepo, "sub"));
  makeRepo(localRepo, undefined, false);
  makeRepo(goneRepo, "https://github.com/e2e-owner/gone-repo.git");
  mkdirSync(plain);
});
test.afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function canvasOf(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
}

async function openLauncher(page: Page): Promise<FrameLocator> {
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /リポジトリ/ });
  await expect(entry, "Repositories の入口が Command Palette に出ていない").toBeVisible({ timeout: 60_000 });
  await expect(entry).toContainText("このマシンで扱うリポジトリの一覧");
  await entry.click();
  await expect(page.getByText(/^Canvas — repositories$/)).toBeVisible({ timeout: 60_000 });
  return canvasOf(page);
}

/** Import のダイアログでパスを打って移る */
async function goTo(canvas: FrameLocator, path: string): Promise<void> {
  const input = canvas.getByTestId("repo-import-path");
  await input.fill(path);
  await input.press("Enter");
  await expect(canvas.getByTestId("repo-import-preview").locator(".v")).toHaveText(shown(path), { timeout: 15_000 });
}

const row = (canvas: FrameLocator, path: string) => canvas.locator(`[data-testid="repo-item"][data-repo-path="${path}"]`);

test("入口から開いた一覧で、Import の判断・足した行の中身・見つからない・外す／戻す・origin の直しまで本物の台帳で動く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, usedRepo);
  let canvas = await openLauncher(page);
  await expectProjectOpen(page, PROJECT_NAME, "Canvas を開いたら会話が消えた");

  // ---- 1. 台帳は空から始まる（この実行のデータ置き場） -----------------------------
  await expect(canvas.getByTestId("repo-list-empty"), "台帳が空なのに空の案内が出ない").toContainText(
    "まだ知っているリポジトリがありません",
    { timeout: 60_000 },
  );
  await expect(canvas.getByTestId("repo-list-lead")).toContainText("~/banto に置きます");
  // 繋がっていない入口は出さない（規則13）
  await expect(canvas.getByRole("button", { name: "URL から clone" })).toHaveCount(0);
  await expect(canvas.getByRole("button", { name: "新しいリポジトリ" })).toHaveCount(0);

  // ---- 2. Import：断る理由と次の手 ------------------------------------------------
  await canvas.getByTestId("repo-import-open").click();
  await expect(canvas.getByTestId("repo-import-dialog")).toBeVisible();
  const message = canvas.getByTestId("repo-import-message");
  const submit = canvas.getByTestId("repo-import-submit");

  await goTo(canvas, plain);
  await expect(message).toHaveText("git のリポジトリではありません。Import できるのは git のリポジトリだけです。");
  await expect(submit).toBeDisabled();

  await goTo(canvas, join(base, "nope", "deeper"));
  await expect(message).toHaveText("このフォルダはありません。");
  await canvas.getByTestId("repo-import-go-nearest").click();
  await expect(canvas.getByTestId("repo-import-preview").locator(".v")).toHaveText(shown(base));
  // 中のフォルダは名前だけ並ぶ
  await expect(canvas.getByTestId("repo-import-entry")).toHaveText(["gone-repo", "local-only", "plain", "used-repo"]);

  await goTo(canvas, join(usedRepo, "sub"));
  await expect(message).toHaveText("used-repo のリポジトリの中のフォルダです。Import できるのはリポジトリの一番上だけです。");
  await expect(submit).toBeDisabled();
  await canvas.getByTestId("repo-import-go-top").click();
  await expect(message).toHaveText("git のリポジトリです。この場所のまま一覧に足します。");
  const facts = canvas.getByTestId("repo-import-facts");
  await expect(facts).toContainText("github.com/e2e-owner/used-repo");
  await expect(facts).toContainText("main · 1 コミット");
  await expect(facts).toContainText("読むだけ");
  await submit.click();

  // **成功したときにだけ出るもの**を待つ（規則14）——足した行と、お知らせ
  await expect(canvas.getByTestId("repo-flash")).toContainText(`used-repo を一覧に足しました（フォルダは ${shown(usedRepo)} のまま）`);
  const used = row(canvas, usedRepo);
  await expect(used).toBeVisible();
  await expect(canvas.locator('[data-testid="repo-group"][data-group="used"] h3')).toHaveText("Project で使っている1 件");
  await expect(used.getByTestId("repo-path")).toHaveText(shown(usedRepo));
  await expect(used.getByTestId("repo-remote")).toContainText("e2e-owner/used-repo");
  await expect(used.getByTestId("repo-account")).toContainText("読むだけ");
  await expect(used.getByTestId("repo-project")).toHaveText(PROJECT_NAME);

  // もう一覧にある——「一覧で見る」
  await canvas.getByTestId("repo-import-open").click();
  await goTo(canvas, usedRepo);
  await expect(message).toHaveText("used-repo は、もう一覧にあります。");
  await expect(submit).toBeDisabled();
  await canvas.getByTestId("repo-import-show").click();
  await expect(canvas.getByTestId("repo-import-dialog")).toHaveCount(0);

  // このマシンにだけ（origin なし・コミットなし）と、あとで消すもの
  for (const path of [localRepo, goneRepo]) {
    await canvas.getByTestId("repo-import-open").click();
    await goTo(canvas, path);
    await expect(message).toHaveText("git のリポジトリです。この場所のまま一覧に足します。");
    await submit.click();
    await expect(row(canvas, path)).toBeVisible({ timeout: 15_000 });
  }
  const local = row(canvas, localRepo);
  await expect(local.getByTestId("repo-local-only")).toHaveText("このマシンにだけ");
  await expect(local.getByTestId("repo-remote")).toContainText("コミットなし");
  await expect(local.getByTestId("repo-account"), "GitHub に無いものにアカウントが出ている").toHaveAttribute("data-empty", "");
  // 「Project はまだ無い」の中は、このマシンにだけ → 名前順
  const unusedRows = canvas.locator('[data-testid="repo-group"][data-group="unused"] [data-testid="repo-item"]');
  await expect(unusedRows).toHaveCount(2);
  await expect(unusedRows.nth(0)).toHaveAttribute("data-repo-path", localRepo);
  await expect(unusedRows.nth(1)).toHaveAttribute("data-repo-path", goneRepo);

  // ---- 3. まだ作っていない手は、押すと「まだ作っていない」と言う ------------------------
  await local.getByTestId("repo-publish-open").click();
  await expect(local.getByTestId("repo-not-yet")).toHaveText("GitHub に公開する手は、まだ作っていません。");
  await local.getByTestId("repo-start-project").click();
  await expect(local.getByTestId("repo-not-yet")).toContainText("Project を始める手は、まだ作っていません。");
  await expect(local.getByTestId("repo-not-yet")).toContainText(shown(localRepo));

  // ---- 4. フォルダが消えた——開き直すと、見つからない行が区切りの一番上に --------------------
  rmSync(goneRepo, { recursive: true, force: true });
  await page.reload();
  canvas = canvasOf(page);
  const gone = row(canvas, goneRepo);
  await expect(gone).toHaveAttribute("data-state", "missing", { timeout: 60_000 });
  await expect(gone.getByTestId("repo-missing-flag")).toHaveText("フォルダが見つかりません");
  await expect(gone.getByTestId("repo-remote")).toContainText("e2e-owner/gone-repo");
  await expect(gone.getByTestId("repo-remote")).toContainText("覚えている場所");
  await expect(unusedRows.nth(0)).toHaveAttribute("data-repo-path", goneRepo);
  await gone.getByTestId("repo-reclone").click();
  await expect(gone.getByTestId("repo-not-yet")).toHaveText("clone し直す手は、まだ作っていません。");

  // 絞り込み（件数つき）と検索
  const filter = canvas.getByTestId("repo-filter");
  await expect(filter.locator('[data-filter="all"]')).toHaveText("すべて3");
  await expect(filter.locator('[data-filter="local"]')).toHaveText("このマシンにだけ1");
  await expect(filter.locator('[data-filter="missing"]')).toHaveText("見つからない1");
  await filter.locator('[data-filter="missing"]').click();
  await expect(canvas.getByTestId("repo-item")).toHaveCount(1);
  await expect(canvas.getByTestId("repo-item")).toHaveAttribute("data-repo-path", goneRepo);
  await filter.locator('[data-filter="all"]').click();
  await canvas.getByTestId("repo-search").fill("local");
  await expect(canvas.getByTestId("repo-item")).toHaveCount(1);
  await expect(canvas.getByTestId("repo-item")).toHaveAttribute("data-repo-path", localRepo);
  await canvas.getByTestId("repo-search").fill("zzz-none");
  await expect(canvas.getByTestId("repo-list-none")).toContainText("「zzz-none」に当たるリポジトリはありません。");
  await canvas.getByRole("button", { name: "すべて表示する" }).click();
  await expect(canvas.getByTestId("repo-item")).toHaveCount(3);

  // ---- 5. 一覧から外す（フォルダは消さない）・元に戻す -------------------------------------
  await local.getByTestId("repo-row-menu").click();
  await expect(local.getByTestId("repo-remove-note")).toContainText("フォルダは消さず、そのまま残ります");
  await expect(local.getByTestId("repo-remove-note")).toContainText(shown(localRepo));
  await local.getByTestId("repo-remove").click();
  await expect(canvas.getByTestId("repo-flash")).toContainText(`local-only を一覧から外しました（フォルダは ${shown(localRepo)} のままです）`);
  await expect(local).toHaveCount(0);
  expect(existsSync(join(localRepo, ".git")), "一覧から外したらフォルダが消えた").toBe(true);
  await canvas.getByTestId("repo-undo").click();
  await expect(row(canvas, localRepo)).toBeVisible({ timeout: 15_000 });
  await expect(canvas.getByTestId("repo-item")).toHaveCount(3);

  // 見つからない行は、その場で外せる（覚えている場所が無いときの次の手）——ここでは「…」から
  await gone.getByTestId("repo-row-menu").click();
  await expect(gone.getByTestId("repo-remove-note")).toHaveText("一覧の記録だけを消します。GitHub の e2e-owner/gone-repo には触りません。");
  await gone.getByTestId("repo-remove").click();
  await expect(gone).toHaveCount(0);
  await expect(canvas.getByTestId("repo-filter").locator('[data-filter="missing"]'), "見つからないものが無いのに札が残っている").toHaveCount(0);

  // ---- 6. origin が変わった——origin を正として直し、一度だけ知らせる --------------------------
  git(usedRepo, "remote", "set-url", "origin", "https://github.com/e2e-org/used-repo.git");
  await page.reload();
  canvas = canvasOf(page);
  const corrected = row(canvas, usedRepo).getByTestId("repo-corrected");
  await expect(corrected).toContainText("origin に合わせて直しました", { timeout: 60_000 });
  await expect(corrected).toContainText("前は e2e-owner/used-repo");
  await expect(row(canvas, usedRepo).getByTestId("repo-remote")).toContainText("e2e-org/used-repo");
  await canvas.getByTestId("repo-corrected-dismiss").click();
  await expect(corrected).toHaveCount(0);
  await page.reload();
  canvas = canvasOf(page);
  await expect(row(canvas, usedRepo).getByTestId("repo-remote")).toContainText("e2e-org/used-repo", { timeout: 60_000 });
  await expect(row(canvas, usedRepo).getByTestId("repo-corrected"), "見たお知らせがまた出た").toHaveCount(0);

  // ---- 7. 狭い幅：縦に積み、はみ出さない -------------------------------------------------
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(canvas.locator("thead").first()).toBeHidden();
  const overflow = await page
    .frameLocator('[data-testid="module-canvas-frame"]')
    .frameLocator("iframe")
    .locator("body")
    .evaluate((b) => b.scrollWidth - b.clientWidth);
  expect(overflow, "狭い幅で横にはみ出している").toBeLessThanOrEqual(0);

  expect(pageErrors).toEqual([]);
});

test("設定の Repositories の面に同じ一覧と既定の置き場が出て、置き場を変えると一覧の説明も変わる", async ({ page }) => {
  await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  const pane = page.locator('[data-testid="module-settings-canvas"][data-module="repositories"]');
  await expect(pane).toBeVisible({ timeout: 30_000 });
  const inner = pane.locator("iframe").contentFrame().frameLocator("iframe");

  // 前の試験で足した2つ（同じ台帳）
  await expect(row(inner, usedRepo)).toBeVisible({ timeout: 60_000 });
  await expect(row(inner, localRepo)).toBeVisible();
  // 設定の面からは Project の一覧も引ける（banto 全体の設定から押した人の操作）
  await expect(row(inner, usedRepo).getByTestId("repo-project")).toHaveText(PROJECT_NAME);

  const section = inner.getByTestId("repo-home-section");
  const input = inner.getByTestId("repo-home-input");
  await expect(input).toHaveValue("~/banto");
  await expect(inner.getByTestId("repo-home-reset"), "既定のままなのに「戻す」が出ている").toHaveCount(0);

  // ホームそのものは断る
  await input.fill("~");
  await inner.getByTestId("repo-home-save").click();
  await expect(inner.getByTestId("repo-home-error")).toHaveText("ホームや / をそのまま置き場にはできません。その下のフォルダを選んでください");

  await input.fill(HOME_DIR);
  await inner.getByTestId("repo-home-save").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`既定の置き場を ${HOME_DIR} にしました`);
  await expect(inner.getByTestId("repo-list-lead")).toContainText(`${HOME_DIR} に置きます`);
  await expect(section).toContainText("まだ無いフォルダなら、最初に使うときに作ります。");

  // 入口から開き直しても同じ値（真実は Module の設定の1箇所）
  await page.reload();
  await page.getByRole("button", { name: "Repositories", exact: true }).click();
  const again = page.locator('[data-testid="module-settings-canvas"][data-module="repositories"]').locator("iframe").contentFrame().frameLocator("iframe");
  await expect(again.getByTestId("repo-home-input")).toHaveValue(HOME_DIR, { timeout: 60_000 });
  await again.getByTestId("repo-home-reset").click();
  await expect(again.getByTestId("repo-home-input")).toHaveValue("~/banto");
  await expect(again.getByTestId("repo-list-lead")).toContainText("~/banto に置きます");
});
