// **Repositories——手元のリポジトリの台帳**（v4-modules.md §2.4、段階1）。
//
// 見るのは、規則13・規則14 の意味で「繋がっていること」：
//   1. 入口（launcher）から AI を介さず人が開け、本物の台帳（Module のデータ置き場）を見ている
//   2. Import が本物の git を読んで判断する——断る理由と次の手、足したあとの行の中身（区切り・GitHub の場所・
//      アカウント・使っている Project）を1つずつ見る
//   3. フォルダが消えた・origin が変わった・一覧から外す／元に戻す——画面に出る値まで見る
//   4. まだ作っていない手（GitHub に公開）は、押すと「まだ作っていない」と言う。Project を始める・clone し直すは段階3で
//      繋いだ（core の新しい Project の画面・clone のダイアログが開く）
//   5. 設定の面にも同じ一覧と既定の置き場が出て、置き場を変えると一覧の説明も変わる
//   6. 狭い幅で縦に積み、はみ出さない
//   7. GitHub のアカウント（段階2）：PAT・ブラウザでログイン（デバイスフロー）・確かめる・更新の失敗が受信箱に出る・
//      もう一度ログイン・外す。台帳の「扱うアカウント」が一覧に出る。GitHub は偽物（`e2e/github-login-fixture.ts`）
//   8. URL から clone・新しいリポジトリ（段階3）：本物の git で偽の GitHub から clone（公開・アカウントの非公開・読めない）、
//      clone し直す、新しいリポジトリ、「Project も作る」で core の新しい Project の画面がフォルダ入りで開き、作れる
import { test, expect, type FrameLocator, type Page, type Route } from "../test-base.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // 空のときも、始める3つの手（Import・URL から clone・新しいリポジトリ）を出す（段階3で繋いだ）
  await expect(canvas.getByTestId("repo-list-empty").getByRole("button", { name: "URL から clone" })).toHaveCount(1);
  await expect(canvas.getByTestId("repo-list-empty").getByRole("button", { name: "新しいリポジトリ" })).toHaveCount(1);

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

  // ---- 3. まだ作っていない手は、押すと「まだ作っていない」と言う。Project を始めるは core の画面をフォルダ入りで開く ----
  await local.getByTestId("repo-publish-open").click();
  await expect(local.getByTestId("repo-not-yet")).toHaveText("GitHub に公開する手は、まだ作っていません。");
  await local.getByTestId("repo-start-project").click();
  const newProject = page.getByRole("dialog", { name: "新しい Project" });
  await expect(newProject, "「Project を始める」で core の新しい Project の画面が開かない").toBeVisible({ timeout: 15_000 });
  await expect(newProject.getByLabel("Project 名")).toHaveValue("local-only");
  await expect(newProject.locator("#new-project-path")).toHaveValue(localRepo);
  await page.keyboard.press("Escape");
  await expect(newProject).toHaveCount(0);

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
  // 「clone し直す」は clone のダイアログを、元の場所に clone し直す形で開く（ここでは押さずに閉じる）
  await gone.getByTestId("repo-reclone").click();
  await expect(canvas.getByTestId("repo-band-message")).toHaveText("ここに clone し直します——一覧にありますが、フォルダが見つかりません。");
  await expect(canvas.getByTestId("repo-clone-band-path")).toHaveText(shown(goneRepo));
  await canvas.getByTestId("repo-clone-dialog").getByRole("button", { name: "やめる" }).click();
  await expect(canvas.getByTestId("repo-clone-dialog")).toHaveCount(0);

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

test("URL から clone・新しいリポジトリ：偽の GitHub から本物の git で clone し、clone し直し、新しく作り、Project の画面がフォルダ入りで開く", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const repoHome = `/tmp/banto-e2e-clone-home-${Date.now()}`;
  const suffix = Date.now().toString(36);
  const pub = `pub-${suffix}`;
  const secret = `secret-${suffix}`;
  await setGithubLoginFixture({ addRepo: { owner: "e2e-octo", name: pub } });
  await setGithubLoginFixture({ addRepo: { owner: E2E_GITHUB_PAT_LOGIN, name: secret, private: true } });
  const openPane = async () => {
    await page.goto(`/settings?bantoToken=${AUTH_TOKEN}&bantoHost=${CORE_BASE_URL}`);
    await page.getByRole("button", { name: "Repositories", exact: true }).click();
    const pane = page.locator('[data-testid="module-settings-canvas"][data-module="repositories"]');
    await expect(pane).toBeVisible({ timeout: 30_000 });
    return pane.locator("iframe").contentFrame().frameLocator("iframe");
  };
  let inner = await openPane();

  // 置き場を試験の一時フォルダに（人の ~/banto に clone しない）
  await inner.getByTestId("repo-home-input").fill(repoHome);
  await inner.getByTestId("repo-home-save").click();
  await expect(inner.getByTestId("repo-list-lead")).toContainText(`${repoHome} に置きます`);

  // ---- 1. 公開のリポジトリ：アカウント無し・「Project も作る」をオフで clone --------------------
  await inner.getByTestId("repo-clone-open").first().click();
  const url = inner.getByTestId("repo-clone-url");
  await url.fill("file:///etc");
  await expect(inner.getByTestId("repo-clone-invalid")).toContainText("file:// の URL は受けません");
  await expect(inner.getByTestId("repo-clone-submit")).toBeDisabled();
  await url.fill(`e2e-octo/${pub}`);
  await expect(inner.getByTestId("repo-band-message")).toHaveText("ここに clone します。");
  await expect(inner.getByTestId("repo-clone-band").locator(".prefix")).toHaveText(`${repoHome}/`);
  await expect(inner.getByTestId("repo-clone-folder")).toHaveValue(pub);
  await expect(inner.getByTestId("repo-clone-no-account")).toContainText("公開のリポジトリだけ clone できます");
  await inner.getByTestId("repo-clone-with-project").uncheck();
  await expect(inner.getByTestId("repo-clone-submit")).toHaveText("clone する");
  await inner.getByTestId("repo-clone-submit").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`e2e-octo/${pub} を ${repoHome}/${pub} に clone しました。一覧に足しました`, { timeout: 60_000 });
  const pubRow = row(inner, `${repoHome}/${pub}`);
  await expect(pubRow.getByTestId("repo-remote")).toContainText(`e2e-octo/${pub}`);
  await expect(pubRow.getByTestId("repo-account-readonly")).toHaveText("読むだけ");
  expect(existsSync(join(repoHome, pub, "README.md")), "clone したフォルダに中身が無い").toBe(true);

  // もう手元にある——clone しない
  await inner.getByTestId("repo-clone-open").first().click();
  await inner.getByTestId("repo-clone-url").fill(`https://github.com/e2e-octo/${pub}`);
  await expect(inner.getByTestId("repo-band-message")).toHaveText(`もう手元にあります（e2e-octo/${pub}）。新しくは clone しません。`);
  await expect(inner.getByTestId("repo-clone-submit")).toHaveCount(0);
  await inner.getByTestId("repo-clone-show").click();

  // ---- 2. 非公開：アカウント無しは読めない（理由と次の手）→ PAT を登録 → そのアカウントで clone ----------
  await inner.getByTestId("repo-clone-open").first().click();
  await inner.getByTestId("repo-clone-url").fill(`${E2E_GITHUB_PAT_LOGIN}/${secret}`);
  await expect(inner.getByTestId("repo-band-message")).toHaveText("ここに clone します。");
  await inner.getByTestId("repo-clone-with-project").uncheck();
  await inner.getByTestId("repo-clone-submit").click();
  await expect(inner.getByTestId("repo-band-message")).toContainText("clone できませんでした：資格情報が通りませんでした", { timeout: 60_000 });
  await expect(inner.getByTestId("repo-clone-band")).toContainText("読めるアカウントを banto 全体の設定の Repositories で登録してから");
  expect(existsSync(join(repoHome, secret)), "失敗した clone のフォルダが残った").toBe(false);
  await inner.getByRole("button", { name: "やめる" }).click();

  // PAT：前の試験が Vault に残した alias があれば選ぶ（外しても PAT は残す決まり）、無ければ貼る
  await inner.getByTestId("gh-account-add").click();
  await inner.getByTestId("gh-method-alias").check();
  const aliasOption = inner.getByTestId("gh-pat-alias").locator("option", { hasText: `$github-${E2E_GITHUB_PAT_LOGIN}-pat` });
  await expect(inner.getByTestId("gh-account-form")).toHaveAttribute("data-choices", "loaded", { timeout: 30_000 });
  if ((await aliasOption.count()) > 0) {
    await inner.getByTestId("gh-pat-alias").selectOption({ label: (await aliasOption.textContent())! });
  } else {
    await inner.getByTestId("gh-method-paste").check();
    await inner.getByTestId("gh-pat-input").fill(E2E_GITHUB_PAT);
  }
  await inner.getByTestId("gh-account-submit").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_PAT_LOGIN} を登録しました`);

  await inner.getByTestId("repo-clone-open").first().click();
  await inner.getByTestId("repo-clone-url").fill(`${E2E_GITHUB_PAT_LOGIN}/${secret}`);
  await expect(inner.getByTestId("repo-clone-account-one")).toContainText(`${E2E_GITHUB_PAT_LOGIN} で clone します`);
  await inner.getByTestId("repo-clone-with-project").uncheck();
  await inner.getByTestId("repo-clone-submit").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`${E2E_GITHUB_PAT_LOGIN}/${secret} を ${repoHome}/${secret} に clone しました`, { timeout: 60_000 });
  const secretRow = row(inner, `${repoHome}/${secret}`);
  await expect(secretRow.getByTestId("repo-account-login")).toHaveText(E2E_GITHUB_PAT_LOGIN);
  // トークンは clone 先の設定にも画面にも無い
  expect(readFileSync(join(repoHome, secret, ".git", "config"), "utf8").includes(E2E_GITHUB_PAT)).toBe(false);
  for (const frame of page.frames()) expect((await frame.content().catch(() => "")).includes(E2E_GITHUB_PAT)).toBe(false);

  // ---- 3. フォルダが消えた——一覧の「clone し直す」で元の場所へ ----------------------------------
  rmSync(join(repoHome, pub), { recursive: true, force: true });
  inner = await openPane();
  const gone = row(inner, `${repoHome}/${pub}`);
  await expect(gone).toHaveAttribute("data-state", "missing", { timeout: 60_000 });
  await gone.getByTestId("repo-reclone").click();
  await expect(inner.getByTestId("repo-band-message")).toHaveText("ここに clone し直します——一覧にありますが、フォルダが見つかりません。");
  await expect(inner.getByTestId("repo-clone-band-path")).toHaveText(`${repoHome}/${pub}`);
  await inner.getByTestId("repo-clone-with-project").uncheck();
  await expect(inner.getByTestId("repo-clone-submit")).toHaveText("clone し直す");
  await inner.getByTestId("repo-clone-submit").click();
  await expect(inner.getByTestId("repo-flash")).toContainText(`e2e-octo/${pub} を ${repoHome}/${pub} に clone し直しました`, { timeout: 60_000 });
  await expect(row(inner, `${repoHome}/${pub}`)).toHaveAttribute("data-state", "ok");
  await expect(inner.locator(`[data-testid="repo-item"][data-repo-path="${repoHome}/${pub}"]`)).toHaveCount(1);

  // ---- 4. 新しいリポジトリ：ぶつかれば断って -2、GitHub に同じ名前があれば言う（作るのは止めない） ----------
  await inner.getByTestId("repo-create-open").first().click();
  await inner.getByTestId("repo-create-name").fill(pub);
  await expect(inner.getByTestId("repo-band-message")).toContainText("上書きしないので、作成できません。");
  await expect(inner.getByTestId("repo-create-submit")).toBeDisabled();
  await inner.getByTestId("repo-band-rename").click();
  await expect(inner.getByTestId("repo-create-name")).toHaveValue(`${pub}-2`);
  await inner.getByTestId("repo-create-name").fill(secret);
  await expect(inner.getByTestId("repo-band-message")).toContainText("上書きしないので");
  const fresh = `fresh-${suffix}`;
  await inner.getByTestId("repo-create-name").fill(fresh);
  await expect(inner.getByTestId("repo-band-message")).toHaveText("ここに空のリポジトリを作ります（git init）。GitHub には、まだ作りません。");

  // ---- 5. 「Project も作る」（既定オン）：作ったあと core の新しい Project の画面がフォルダ入りで開き、作れる ----
  await expect(inner.getByTestId("repo-create-with-project")).toBeChecked();
  await expect(inner.getByTestId("repo-create-submit")).toHaveText("作って Project の作成へ");
  await inner.getByTestId("repo-create-submit").click();
  const dialog = page.getByRole("dialog", { name: "新しい Project" });
  await expect(dialog, "core の新しい Project の画面が開かない").toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByLabel("Project 名")).toHaveValue(fresh);
  await expect(dialog.locator("#new-project-path")).toHaveValue(`${repoHome}/${fresh}`);
  expect(existsSync(join(repoHome, fresh, ".git")), "作ったフォルダに .git が無い").toBe(true);
  await dialog.getByRole("button", { name: "作成する" }).click();
  await expectProjectOpen(page, fresh, "作った Project が開かない");

  inner = await openPane();
  const freshRow = row(inner, `${repoHome}/${fresh}`);
  await expect(freshRow.getByTestId("repo-local-only")).toHaveText("このマシンにだけ", { timeout: 60_000 });
  await expect(freshRow.getByTestId("repo-project")).toHaveText(fresh);

  // 片づけ：アカウントを外し、置き場を戻す
  await inner.locator(`[data-testid="gh-account"][data-login="${E2E_GITHUB_PAT_LOGIN}"]`).getByTestId("gh-account-remove").click();
  await inner.getByTestId("gh-account-remove-confirm").click();
  await expect(inner.getByTestId("gh-accounts-empty")).toBeVisible();
  await inner.getByTestId("repo-home-reset").click();
  await expect(inner.getByTestId("repo-home-input")).toHaveValue("~/banto");
  rmSync(repoHome, { recursive: true, force: true });
  expect(pageErrors).toEqual([]);
});
