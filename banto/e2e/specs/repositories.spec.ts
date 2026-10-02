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
//   7. GitHub のアカウント（段階2）：PAT・ブラウザでログイン（デバイスフロー）・確かめる・更新の失敗が受信箱に出る・
//      もう一度ログイン・外す。台帳の「扱うアカウント」が一覧に出る。GitHub は偽物（`e2e/github-login-fixture.ts`）
import { test, expect, type FrameLocator, type Page, type Route } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, expectProjectOpen, openApp } from "../helpers.js";
import {
  E2E_GITHUB_CLIENT_ID,
  E2E_GITHUB_DEVICE_LOGIN,
  E2E_GITHUB_PAT,
  E2E_GITHUB_PAT_LOGIN,
  setGithubLoginFixture,
} from "../github-login-fixture.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Repositories Project";
const base = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-repositories-")));
const usedRepo = join(base, "used-repo");
const localRepo = join(base, "local-only");
const goneRepo = join(base, "gone-repo");
/** 持ち主が PAT のアカウントと同じリポジトリ（段階2の試験で Import する）。最初の試験がたどるフォルダの外に置く */
const ownedBase = realpathSync(mkdtempSync(join(tmpdir(), "banto-e2e-repositories-owned-")));
const ownedRepo = join(ownedBase, "owned-repo");
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
  makeRepo(ownedRepo, `git@github.com:${E2E_GITHUB_PAT_LOGIN}/owned-repo.git`);
  mkdirSync(plain);
});
test.afterAll(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(ownedBase, { recursive: true, force: true });
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

/**
 * **開いた直後に打つ**——開いたときの読み込み（`~`）が、打っている途中に返る形を必ず作る（1字ずつ打つので、
 * 打ち終わる前に返る）。以前はここで入力欄が作り直され、打った字の後ろに「~」が残った（5回に1回）
 */
async function typeRightAfterOpening(page: Page, canvas: FrameLocator, path: string): Promise<void> {
  // 開いたときの読み込み（`~` をたどる）だけを遅らせる——本物の banto では速く返り、打ち始める前に済んでしまう
  const slowHome = async (route: Route) => {
    const body = route.request().postDataJSON() as { arguments?: { path?: string } } | null;
    if (body?.arguments?.path === "~") await new Promise((r) => setTimeout(r, 400));
    await route.fallback();
  };
  await page.route("**/ui-tool-call", slowHome);
  await canvas.getByTestId("repo-import-open").click();
  const input = canvas.getByTestId("repo-import-path");
  // 人と同じに、入っている「~」を消してから打つ
  await input.fill("");
  await input.pressSequentially(path, { delay: 10 });
  await input.press("Enter");
  await expect(canvas.getByTestId("repo-import-preview").locator(".v")).toHaveText(shown(path), { timeout: 15_000 });
  await expect(input).toHaveValue(shown(path));
  await page.unroute("**/ui-tool-call", slowHome);
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

  // もう一覧にある——「一覧で見る」（開いた直後に打つ）
  await typeRightAfterOpening(page, canvas, usedRepo);
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

test("設定の Repositories の面で GitHub のアカウントを登録・確かめ・外せて、更新の失敗は受信箱に出て、一覧に扱うアカウントが出る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // 出すトークンの寿命を5分の余裕より短くして、確かめるたびに更新が走るようにする
  await setGithubLoginFixture({ script: ["pending", "authorized"], accessTokenTtl: 60, refreshError: null });
  const openPane = async () => {
    await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    const pane = page.locator('[data-testid="module-settings-canvas"][data-module="repositories"]');
    await expect(pane).toBeVisible({ timeout: 30_000 });
    return pane.locator("iframe").contentFrame().frameLocator("iframe");
  };
  let inner = await openPane();
  const section = inner.getByTestId("gh-accounts-section");
  const account = (login: string) => inner.locator(`[data-testid="gh-account"][data-login="${login}"]`);

  // ---- 1. 空・client ID が無い間はブラウザでログインを選べず、手順が出る ------------------------
  await expect(inner.getByTestId("gh-accounts-empty")).toHaveText("まだありません。登録すると、GitHub のリポジトリをそのアカウントで扱えます。", { timeout: 60_000 });
  await expect(inner.getByTestId("gh-client-id-steps")).toContainText("「Enable Device Flow」に印を入れる");
  await inner.getByTestId("gh-account-add").click();
  await expect(inner.getByTestId("gh-method-browser")).toBeDisabled();
  await expect(inner.getByTestId("gh-method-paste")).toBeChecked();

  // ---- 2. PAT を貼る——GitHub で login を確かめ、Vault に預け、画面には alias の名前だけ ----------------
  await inner.getByTestId("gh-pat-input").fill("ghp_not_valid_at_all");
  await inner.getByTestId("gh-account-submit").click();
  await expect(inner.getByTestId("gh-account-error")).toContainText("この PAT では GitHub に入れませんでした");
  await expect(inner.getByTestId("gh-account-error")).toContainText("401");
  await inner.getByTestId("gh-pat-input").fill(E2E_GITHUB_PAT);
  await inner.getByTestId("gh-account-submit").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_PAT_LOGIN} を登録しました`);
  const patRow = account(E2E_GITHUB_PAT_LOGIN);
  await expect(patRow.getByTestId("gh-account-credential")).toContainText(`PAT $github-${E2E_GITHUB_PAT_LOGIN}-pat（vault-local`);
  await expect(patRow.getByTestId("gh-account-ssh")).toHaveText("SSH 鍵なし（HTTPS で clone・push）");
  await expect(inner.getByTestId("gh-account-form"), "登録したのに欄が残っている").toHaveCount(0);

  // 台帳：持ち主が PAT の login と同じものは、そのアカウントで扱う。違うもの（e2e-org）は読むだけ
  await inner.getByTestId("repo-import-open").click();
  await inner.getByTestId("repo-import-path").fill(ownedRepo);
  await inner.getByTestId("repo-import-path").press("Enter");
  await expect(inner.getByTestId("repo-import-facts")).toContainText(`${E2E_GITHUB_PAT_LOGIN} で扱います`, { timeout: 15_000 });
  await inner.getByTestId("repo-import-submit").click();
  await expect(row(inner, ownedRepo).getByTestId("repo-account-login")).toHaveText(E2E_GITHUB_PAT_LOGIN, { timeout: 15_000 });
  await expect(row(inner, usedRepo).getByTestId("repo-account-readonly")).toHaveText("読むだけ");

  // ---- 3. client ID を入れると手順が消え、ブラウザでログインが選べる -------------------------------
  await inner.getByTestId("gh-client-id").fill("123");
  await inner.getByTestId("gh-client-id-save").click();
  await expect(inner.getByTestId("gh-client-id-error")).toContainText("client ID の形が違います");
  await inner.getByTestId("gh-client-id").fill(E2E_GITHUB_CLIENT_ID);
  await inner.getByTestId("gh-client-id-save").click();
  await expect(inner.getByTestId("repo-flash")).toContainText("client ID を保存しました");
  await expect(inner.getByTestId("gh-client-id-steps")).toHaveCount(0);

  // ---- 4. ブラウザでログイン：コードと開く先を出し、許可されたら登録 ----------------------------------
  await inner.getByTestId("gh-account-add").click();
  await expect(inner.getByTestId("gh-method-browser")).toBeChecked();
  await inner.getByTestId("gh-account-submit").click();
  await expect(inner.getByTestId("gh-login-code")).toHaveText("WDJB-MJHT");
  await expect(inner.getByTestId("gh-login-status")).toContainText("GitHub で許可されるのを待っています（このコードはあと 15 分で切れます）");
  await expect(inner.getByTestId("gh-login-open")).toHaveText("github.com/login/device を開く");
  // 押すと banto が別のタブで開く（ui/open-link）。**本物の github.com には行かせない**（規則6）——開いた先だけを見る
  await page.context().route("https://github.com/**", (route) => route.fulfill({ contentType: "text/plain", body: "fake github" }));
  const popup = page.waitForEvent("popup");
  await inner.getByTestId("gh-login-open").click();
  expect((await popup).url()).toBe("https://github.com/login/device");
  await (await popup).close();
  // 偽の GitHub は1回「待って」と答え、次で許可する——interval（5秒）どおりに2回聞くので10秒ほど
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_DEVICE_LOGIN} をブラウザでログインして登録しました`, { timeout: 30_000 });
  const appRow = account(E2E_GITHUB_DEVICE_LOGIN);
  await expect(appRow.getByTestId("gh-account-credential")).toContainText(`ブラウザでログイン（GitHub App）· $oauth-github-${E2E_GITHUB_DEVICE_LOGIN}（vault-local`);
  await expect(inner.getByTestId("gh-login")).toHaveCount(0);
  await expect(inner.getByTestId("gh-account")).toHaveCount(2);

  // ---- 5. 確かめる：期限が近いので取り直し（更新が通る）、GitHub に入れる ------------------------------
  const before = (await setGithubLoginFixture({})).refreshCalls;
  await appRow.getByTestId("gh-account-verify").click();
  await expect(appRow.getByTestId("gh-account-verified")).toHaveText(`GitHub に ${E2E_GITHUB_DEVICE_LOGIN} として入れました`);
  expect((await setGithubLoginFixture({})).refreshCalls, "期限が近いのに取り直していない").toBe(before + 1);
  await patRow.getByTestId("gh-account-verify").click();
  await expect(patRow.getByTestId("gh-account-verified")).toHaveText(`GitHub に ${E2E_GITHUB_PAT_LOGIN} として入れました`);

  // ---- 6. 更新に失敗：理由が行に出て、受信箱に1件 ----------------------------------------------------
  await setGithubLoginFixture({ refreshError: "bad_refresh_token" });
  await appRow.getByTestId("gh-account-verify").click();
  await expect(appRow.getByTestId("gh-account-verify-error")).toContainText(`${E2E_GITHUB_DEVICE_LOGIN} のログインを更新できませんでした`);
  await expect(appRow.getByTestId("gh-account-refresh-failure")).toContainText("ログインを更新できませんでした：GitHub が更新の鍵（refresh token）を受け付けませんでした");
  // 秘密はどの画面にも出ていない
  for (const frame of page.frames()) {
    const html = await frame.content().catch(() => "");
    expect(html.includes(E2E_GITHUB_PAT), "PAT が画面に出ている").toBe(false);
    expect(/gh[ur]_fake_/.test(html), "ログインのトークンが画面に出ている").toBe(false);
  }

  await openApp(page);
  await page.getByRole("button", { name: "受信箱" }).click();
  const notice = page.getByTestId("inbox-notice").filter({ hasText: `GitHub @${E2E_GITHUB_DEVICE_LOGIN} のログインを更新できませんでした` });
  await expect(notice, "更新の失敗が受信箱に出ていない").toHaveCount(1, { timeout: 30_000 });
  await expect(notice).toContainText("もう一度「ブラウザでログイン」してください");
  await page.keyboard.press("Escape");

  // ---- 7. もう一度ログイン：置き場を置き換え、失敗の印が消える ------------------------------------------
  await setGithubLoginFixture({ refreshError: null, script: ["authorized"] });
  inner = await openPane();
  await account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-relogin").click({ timeout: 60_000 });
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_DEVICE_LOGIN} のログインを新しくしました`, { timeout: 30_000 });
  await expect(account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-refresh-failure")).toHaveCount(0);
  await expect(inner.getByTestId("gh-account")).toHaveCount(2);
  await account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-verify").click();
  await expect(account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-verified")).toHaveText(`GitHub に ${E2E_GITHUB_DEVICE_LOGIN} として入れました`);

  // ---- 8. 外す：ログインは Vault から消し、PAT は残す。台帳は覚えたまま「登録が外れている」 -------------------
  await account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-remove").click();
  await expect(account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-remove-note")).toContainText("Vault に置いたログイン情報も消します");
  await account(E2E_GITHUB_DEVICE_LOGIN).getByTestId("gh-account-remove-confirm").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_DEVICE_LOGIN} の登録を外しました（Vault のログイン情報も消しました）`);
  await account(E2E_GITHUB_PAT_LOGIN).getByTestId("gh-account-remove").click();
  await expect(account(E2E_GITHUB_PAT_LOGIN).getByTestId("gh-account-remove-note")).toContainText("PAT は Vault に残ります");
  await account(E2E_GITHUB_PAT_LOGIN).getByTestId("gh-account-remove-confirm").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_PAT_LOGIN} の登録を外しました（PAT は Vault に残しています）`);
  await expect(inner.getByTestId("gh-accounts-empty")).toBeVisible();
  await expect(row(inner, ownedRepo).getByTestId("repo-account-readonly")).toContainText(`${E2E_GITHUB_PAT_LOGIN} は登録が外れています`);

  // Vault の一覧：ログインは消え、PAT は残っている（値は出ない）
  await page.getByRole("button", { name: "Vault（ローカル）", exact: true }).click();
  const vaultInner = page.locator('[data-testid="module-settings-canvas"][data-module="vault-local"] iframe').contentFrame().frameLocator("iframe");
  await expect(vaultInner.getByText(`github-${E2E_GITHUB_PAT_LOGIN}-pat`).first()).toBeVisible({ timeout: 60_000 });
  await expect(vaultInner.getByText(`oauth-github-${E2E_GITHUB_DEVICE_LOGIN}`)).toHaveCount(0);
  await expect(vaultInner.getByText(E2E_GITHUB_PAT)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
