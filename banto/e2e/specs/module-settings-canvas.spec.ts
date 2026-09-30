// Module 自身の設定画面（MCP Apps の設定 Canvas、§6.2、決定・2026-09-07）。
//
// **iOS でアプリの設定が OS の設定アプリに出てくるのと同じ形。**
// banto は値を持たない——読み書きはその Module 自身の tool で、banto は
// 「どこに出すか」を決めるだけ。だから確かめるのは：
//   1. 名乗った Module の設定画面が、設定の中に出る（中身まで）
//   2. **変えた値が Module 側に残る**（開き直しても戻らない）
//   3. **その値が実際に効く**（一覧の中身が変わる）
//
// **承認は求めない**（改訂・2026-09-07、ユーザー指示）——設定画面がその Module
// 自身の設定を読み書きするのは、画面が仕事をしているだけ。ここでは
// **承認が出ないこと**も確かめる（出ると、設定を見るたびに人を待たせる）。
import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProject,
  expectProjectOpen,
  installInfisical,
  openApp,
  openNav,
  openProjectSettings,
  fakeTurn,
} from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Module Settings";

test("Module の設定画面が出て、変えた値が Module に残り、実際に効く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-settings-"));
  // 隠しファイル（設定で出す／出さないが切り替わる対象）と、普通のファイル
  const hidden = `.hidden-${Date.now()}.txt`;
  const plain = `plain-${Date.now()}.txt`;
  writeFileSync(join(projectRoot, hidden), "隠し\n");
  writeFileSync(join(projectRoot, plain), "普通\n");

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  // 既定では隠しファイルも一覧に出る（あとで「出さない」に変える）
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("この Project の直下の一覧を取ってください。" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }] }));
  await composer.press("Enter");
  const inner = page
    .frameLocator('[data-testid="module-canvas-frame"]')
    .frameLocator("iframe");
  await expect(inner.getByText(hidden), "既定では隠しファイルが出るはず").toBeVisible({ timeout: 120_000 });

  // ---- 1. 設定の中に、Module の設定画面が出る -----------------------------
  const canvas = await openModuleSettings(page);

  const settingsInner = canvas.locator("iframe").contentFrame().frameLocator("iframe");
  const checkbox = settingsInner.getByRole("checkbox");
  // **承認は出ない**——開いた瞬間に読めている
  await expect(page.locator('[data-testid="canvas-approval"]')).toHaveCount(0);
  await expect(checkbox, "いまの設定を読めていない").toBeChecked({ timeout: 30_000 });

  // ---- 2. 変えると、Module 側に残る ---------------------------------------
  await checkbox.uncheck();
  await settingsInner.getByRole("button", { name: "保存する" }).click();
  await expect(settingsInner.getByText(/保存しました/)).toBeVisible({ timeout: 30_000 });

  // 設定を開き直しても戻らない（＝banto が覚えているのではなく Module が持っている）。
  // **リロードしても設定の面のまま**（開いているものは URL が持つ、§6.16）
  await page.reload();
  await page.waitForURL(/[?&]settings=1|\/settings/, { timeout: 30_000 });
  const reopenedCanvas = await openModuleSettings(page);
  const reopened = reopenedCanvas.locator("iframe").contentFrame().frameLocator("iframe");
  await expect(reopened.getByRole("checkbox"), "開き直したら設定が戻ってしまった").not.toBeChecked({
    timeout: 30_000,
  });

  // ---- 3. その値が実際に効く ----------------------------------------------
  // **設定は面**（§6.16、2026-09-11——ダイアログをやめた）。会話へは、
  // サイドバーでその Project を押して戻る（**節の行き来は履歴に残る**ので、
  // 「戻る」1回では設定の中を1つ戻るだけ——2026-09-11 の改訂）
  await openNav(page);
  await page.getByTestId("sidebar-project-name").filter({ hasText: PROJECT_NAME }).first().click();
  await expectProjectOpen(page, PROJECT_NAME);
  const composer2 = page.getByPlaceholder(/に送る/);
  await composer2.fill("もう一度、いまの直下の一覧を見せて。" + fakeTurn({ tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }] }));
  await composer2.press("Enter");
  // **いちばん新しい一覧が、変えた設定どおりになるまで待つ**。
  // 数で待つと脆い（会話の組み直しで前の画面が消えることがある）ので、
  // **見たい中身そのもの**を待つ（規則14）
  await expect(async () => {
    const f = page.locator('[data-testid="module-canvas-frame"]').last().contentFrame().frameLocator("iframe");
    await expect(f.getByText(plain), "一覧が出ていない").toBeVisible({ timeout: 5_000 });
    await expect(f.getByText(hidden), "**設定を変えたのに隠しファイルが出たまま**").toHaveCount(0);
  }).toPass({ timeout: 120_000 });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

/** Project 設定 →「Module の設定」を開いて、filesystem の設定画面が出るまで待つ。
 *  **開き切ってから次へ進む**——途中で押すと、押した先が無い（実測・2026-09-07）。 */
async function openModuleSettings(page: import("@playwright/test").Page) {
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="filesystem"]');
  // **開いているかは URL で見る**（§6.16、2026-09-11——開いている節は URL が持つ）。
  // 「画面に出ているか」で見ると、**まだ描かれていないだけ**の一瞬に引っかかり、
  // 開いているのにもう一度開こうとする——狭い画面では節を開いている間は左メニュー
  // 自体が出ないので、そこで詰む（実測・2026-09-11）
  const alreadyOpen = decodeURIComponent(page.url()).includes("section=project-module:filesystem");
  if (!alreadyOpen) {
    await openProjectSettings(page);
    // **左メニューに Module ごとに並ぶ**（モックが決めた形、決定・2026-09-07）
    await page.getByRole("button", { name: "FileSystem", exact: true }).click();
  }
  await expect(canvas, "Module の設定画面が出ていない").toBeVisible({ timeout: 30_000 });
  return canvas;
}


test("設定の置き場は Module の scope が決める——Vault は全体、FileSystem は Project", async ({ page }) => {
  // instance に1本の Module（Vault）の設定を Project ごとに出すのはおかしい
  // （ユーザー指摘・2026-09-07）。置き場の判断を別に持たず、**既にある scope から
  // 導く**（規則3）ので、ここでは「どちらにどれが出るか」を直接見る。
  await openApp(page);

  // banto 全体の設定には Vault が出て、FileSystem は出ない
  await page.goto("/settings");
  // 左メニューには Vault が並び、Project ごとの Module（FileSystem）は並ばない
  const vaultNav = page.getByRole("button", { name: "Vault（ローカル）", exact: true });
  await expect(vaultNav, "全体の設定の左メニューに Vault が出ていない").toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("button", { name: "FileSystem", exact: true }),
    "Project ごとの Module が全体の設定の左メニューに出ている",
  ).toHaveCount(0);
  await vaultNav.click();
  await expect(
    page.locator('[data-testid="module-settings-canvas"][data-module="vault-local"]'),
    "全体の設定に Vault が出ていない",
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-testid="module-settings-canvas"][data-module="filesystem"]'),
    "Project ごとの Module が全体の設定に出ている",
  ).toHaveCount(0);

  // 中身も本物（Vault が名乗った画面が描かれている）
  const vaultInner = page
    .locator('[data-testid="module-settings-canvas"][data-module="vault-local"] iframe')
    .contentFrame()
    .frameLocator("iframe");
  await expect(vaultInner.getByText(/alias|件/)).toBeVisible({ timeout: 60_000 });
});

// **Infisical の繋ぎ方を、全体の設定から入れられる**（追加・2026-09-13、
// ユーザー要望「接続先と API Token を Global の Module 設定で」）。
//
// ここで見たいのは2つで、**1つ目のほうが大事**：
//   1. **未設定でも Module が立ち、設定画面に辿り着ける**
//      （以前は未設定だと立たず、設定画面にも行けない堂々巡りだった）
//   2. 接続先を選ぶと、聞くことが変わる（自前なら URL を聞く）
test("Infisical の繋ぎ方を、全体の設定画面から入れられる", async ({ page }) => {
  await openApp(page);
  // **既定には入っていない**（2026-09-20）——要る人が目録から入れる
  await installInfisical(page);
  await page.goto("/settings");

  const nav = page.getByRole("button", { name: "Vault（Infisical）", exact: true });
  await expect(nav, "全体の設定に Infisical が出ていない").toBeVisible({ timeout: 30_000 });
  await nav.click();

  const pane = page.locator('[data-testid="module-settings-canvas"][data-module="vault-infisical"]');
  await expect(pane).toBeVisible({ timeout: 30_000 });
  const inner = pane.locator("iframe").contentFrame().frameLocator("iframe");

  // **いまの状態を、推測ではなく Module に聞いて出している**
  await expect(inner.getByText("Infisical への繋ぎ方")).toBeVisible({ timeout: 60_000 });
  await expect(inner.locator("#state"), "繋がっているかどうかを言っていない").not.toBeEmpty();

  // **秘密は画面に返っていない**（入っているかどうかだけ）
  expect(await inner.locator("#clientSecret").inputValue(), "Client Secret が画面に返っている").toBe("");

  // 接続先で聞くことが変わる——Cloud なら URL を聞かない
  await inner.locator("#target").selectOption("us");
  await expect(inner.locator("#site-field"), "Cloud なのに URL を聞いている").toBeHidden();
  await inner.locator("#target").selectOption("self");
  await expect(inner.locator("#site-field"), "自前なのに URL を聞いていない").toBeVisible();

  // **繋がらない設定は保存しない**（規則1——繋いでから保存する）
  await inner.locator("#siteUrl").fill("http://127.0.0.1:9");
  await inner.locator("#clientId").fill("nope");
  await inner.locator("#clientSecret").fill("nope");
  await inner.locator("#projectId").fill("nope");
  await inner.getByRole("button", { name: "繋いで保存する" }).click();
  await expect(inner.locator("#error"), "繋がらないのに黙って保存している").toBeVisible({ timeout: 60_000 });
});

// **別の Module を選んだら、中身も切り替わる**（回帰・2026-09-14、ユーザー報告
// 「先に vault-local を開いたら、Infisical を開いても中の表示が変わらない」）。
//
// Module の HTML は**サンドボックスの iframe が立ち上がったと言ってきたときに
// だけ**流し込まれる。React は位置で照合するので `server` が変わっても iframe は
// 同じものが残り、**その合図はもう来ない**——見出しだけ新しい名前になるので、
// **違う Module の設定を見ていることに気づけない**（規則13）。
test("設定画面を切り替えると、中身も入れ替わる", async ({ page }) => {
  await openApp(page);
  await page.goto("/settings");

  const inner = (module: string) =>
    page
      .locator(`[data-testid="module-settings-canvas"][data-module="${module}"] iframe`)
      .contentFrame()
      .frameLocator("iframe");

  // **狭い配置ではメニューが隠れる**（選ぶと詳細だけになる）。戻ってから選ぶ
  const pick = async (name: string) => {
    const back = page.getByRole("button", { name: "設定メニューに戻る" });
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.getByRole("button", { name, exact: true }).click();
  };

  // 先に組み込みの Vault を開く
  await pick("Vault（ローカル）");
  await expect(inner("vault-local").getByText(/alias|件/)).toBeVisible({ timeout: 60_000 });

  // そのまま Infisical へ切り替える
  await pick("Vault（Infisical）");
  await expect(
    inner("vault-infisical").getByText("Infisical への繋ぎ方"),
    "切り替えたのに中身が前のまま",
  ).toBeVisible({ timeout: 60_000 });

  // **戻しても入れ替わる**（片道だけ直っていないこと）
  await pick("Vault（ローカル）");
  await expect(
    inner("vault-local").getByText(/alias|件/),
    "戻したのに Infisical の画面が残っている",
  ).toBeVisible({ timeout: 60_000 });
});

// **共通の置き場は設定画面で決める**（決定・2026-09-14、ユーザー指摘
// 「こういうのは Canvas よりも設定画面でやったほうがいい」）。
test("Vault の置き場を、全体の設定画面から決められる", async ({ page }) => {
  await openApp(page);
  await page.goto("/settings");

  const nav = page.getByRole("button", { name: "Vault の置き場", exact: true });
  await expect(nav, "全体の設定に置き場の面が出ていない").toBeVisible({ timeout: 30_000 });
  await nav.click();

  const inner = page
    .locator('[data-testid="module-settings-canvas"][data-module="vault-directory"] iframe')
    .contentFrame()
    .frameLocator("iframe");
  await expect(inner.getByText("Global の秘密の置き場")).toBeVisible({ timeout: 60_000 });

  // **Vault とグループを一緒に選ぶ**（backend ごとに聞かない）
  await expect(inner.locator("#vault")).toContainText("vault-local");
  await expect(inner.locator("#vault")).toContainText("vault-infisical");
  await expect(inner.locator("#group"), "グループの選択肢が空").not.toBeDisabled();

  // **いまどこかを言っている**（推測ではなく Module に聞いた値）
  await expect(inner.locator("#state")).toContainText("いまは");

  // **Project の置き場はここで決めない**と書いてある（事前設定をやめた）
  await expect(inner.getByText(/Project ごとの秘密は、ここでは決めません/)).toBeVisible();

  // 保存できる
  await inner.locator("#vault").selectOption("vault-local");
  await inner.locator("#group").selectOption("instance");
  await inner.getByRole("button", { name: "置き場を保存する" }).click();
  await expect(inner.locator("#error"), "保存でエラーが出た").toBeHidden();
  await expect(inner.locator("#state")).toContainText("vault-local / instance");
});
