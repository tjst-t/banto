// **人のログイン**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// 2026-09-18 からの約束はそのまま：ログインしていないときに「Project がありません」と言わない（規則2・13）。
// そのうえで、入り方3つ（host のリンク・パスキー・端末を追加）と、締め出し・本人確認を本物のブラウザで見る。
// パスキーは Chromium の仮想認証器（CDP の WebAuthn）——本人の確認は自動で通る。
import { test, expect, loginContext } from "../test-base.js";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";
import { CORE_BROWSER_URL, DATA_DIR, FRONTEND_BASE_URL } from "../config.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.use({ loggedIn: false });

/** host のコマンドと同じリンク（`scripts/login-link.mjs`） */
async function hostLink(): Promise<string> {
  const { code } = await writeLoginLink(DATA_DIR);
  return `${FRONTEND_BASE_URL}/?bantoHost=${encodeURIComponent(CORE_BROWSER_URL)}#banto-login=${code}`;
}

async function addAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  return { cdp, authenticatorId };
}

async function expectInside(page: Page): Promise<void> {
  await expect(page.getByTestId("connect-gate"), "ログインしたのに門が残っている").toHaveCount(0, { timeout: 30_000 });
  await Promise.race([
    page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 30_000 }),
    page.getByText("まだ Project がありません").waitFor({ state: "visible", timeout: 30_000 }),
  ]);
}

async function openLoginSettings(page: Page): Promise<void> {
  await page.goto(`/settings?section=login&bantoHost=${encodeURIComponent(CORE_BROWSER_URL)}`);
  await expect(page.getByTestId("login-panel")).toBeVisible({ timeout: 30_000 });
}

test("ログインしていないときは、ログインの面が出る——「Project がありません」とは言わない", async ({ page }) => {
  await page.goto(`/?bantoHost=${encodeURIComponent(CORE_BROWSER_URL)}`);
  const gate = page.getByTestId("connect-gate");
  await expect(gate, "ログインの面が出ない").toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).not.toContainText("まだ Project がありません");
  await expect(gate).toContainText("この端末はまだ banto にログインしていません");
  // 入り方の案内（ほかの端末から・host のコマンド）。localhost は名前の住所なのでパスキーの入口も出る
  await expect(gate).toContainText("端末を追加");
  await expect(gate).toContainText("node scripts/login-link.mjs");
  await expect(gate.getByTestId("login-passkey")).toBeVisible();
  // 合言葉を打つ欄はもう無い（機械の口なので人には打たせない）
  await expect(page.getByLabel("アクセストークン")).toHaveCount(0);
});

test("host のリンクで入れる。札は URL から消え、同じリンクは2回使えない", async ({ page, browser }) => {
  const link = await hostLink();
  await page.goto(link);
  await expectInside(page);
  expect(page.url(), "札が URL に残っている").not.toContain("banto-login");
  // 覚えている——読み込み直しても門は出ない
  await page.reload();
  await expectInside(page);

  // 同じリンクを別の端末（文脈）で開いても入れない。理由を言う
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await otherPage.goto(link);
    await expect(otherPage.getByTestId("connect-error")).toContainText("このリンクは使えません", { timeout: 30_000 });
    await expect(otherPage.getByTestId("connect-gate")).toBeVisible();
  } finally {
    await other.close();
  }
});

/** 前のテストで登録したパスキー（仮想認証器から取り出したもの）。次のテストの端末に写す */
let registered: unknown;

test("パスキーを登録し、ログアウトしてから、パスキーで入り直せる", async ({ page }) => {
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await page.goto(await hostLink());
  await expectInside(page);
  await openLoginSettings(page);

  const panel = page.getByTestId("login-panel");
  await expect(panel.getByTestId("login-no-passkeys")).toBeVisible();
  // ログイン中の端末に、この端末が「host のリンク」で入ったと出る
  await expect(panel.getByTestId("login-session-row").filter({ hasText: "（この端末）" })).toContainText("host のリンクで入りました");

  // パスキーがまだ無いので、登録の前の本人確認は求められない
  await panel.getByTestId("login-register-passkey").click();
  await expect(panel.getByTestId("login-passkeys").locator("li")).toHaveCount(1, { timeout: 30_000 });
  await expect(panel.getByTestId("login-no-passkeys")).toHaveCount(0);
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials, "認証器にパスキーができていない").toHaveLength(1);
  registered = credentials[0];

  await panel.getByTestId("login-logout").click();
  const gate = page.getByTestId("connect-gate");
  await expect(gate).toBeVisible({ timeout: 30_000 });
  // パスキーで入る——ログアウトした場所（設定）にそのまま戻る
  await gate.getByTestId("login-passkey").click();
  await expect(page.getByTestId("connect-gate"), "パスキーで入れない").toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("login-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("login-session-row").filter({ hasText: "（この端末）" })).toContainText(
    "パスキーで入りました",
  );
});

test("端末を追加：パスキーを通してから QR とリンクが出る。別の端末がそれで入ると「入りました」と出て、締め出せばその端末は門に戻る", async ({
  page,
  browser,
}) => {
  expect(registered, "前のテストでパスキーを登録できていない").toBeTruthy();
  // 同じパスキーを持つ端末（Google パスワード マネージャー等で同期したのと同じ形）。入るのは host のリンクで
  // ——パスキーで入っていないので、端末を追加の前に本人確認を求められる
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: registered as never });
  await page.goto(await hostLink());
  await expectInside(page);
  await openLoginSettings(page);
  const panel = page.getByTestId("login-panel");
  const sessionsBefore = await panel.getByTestId("login-session-row").count();

  // 本人確認（step-up）が実際に走る——パスキーで入っていないので、先にパスキーを通す
  const stepUp = page.waitForResponse((r) => r.url().endsWith("/api/auth/stepup/verify") && r.status() === 200);
  await panel.getByTestId("login-add-device").click();
  await stepUp;
  const dialog = page.getByTestId("add-device-dialog");
  await expect(dialog.getByTestId("add-device-qr").locator("svg")).toBeVisible({ timeout: 30_000 });
  const link = await dialog.getByTestId("add-device-link").inputValue();
  expect(link).toMatch(new RegExp(`^${FRONTEND_BASE_URL}/\\?bantoHost=.+#banto-login=[A-Za-z0-9_-]{40,}$`));
  await expect(dialog.getByTestId("add-device-remaining")).toContainText(/あと (10:00|9:\d\d)・1回だけ使えます/);

  // 別の端末がリンクで入る
  const other: BrowserContext = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await otherPage.goto(link);
    await expectInside(otherPage);
    // 出した側に知らせが届く
    await expect(dialog.getByTestId("add-device-joined")).toContainText("が入りました", { timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(panel.getByTestId("login-session-row")).toHaveCount(sessionsBefore + 1, { timeout: 30_000 });
    const added = panel.getByTestId("login-session-row").filter({ hasText: "端末を追加で入りました" });
    await expect(added).toHaveCount(1);

    // 締め出す（本人確認はさっき通したので、5分のうちはそのまま）
    page.once("dialog", (d) => void d.accept());
    await added.getByRole("button", { name: "締め出す" }).click();
    await expect(panel.getByTestId("login-session-row")).toHaveCount(sessionsBefore, { timeout: 30_000 });
    // 締め出された端末は、次に開くと門
    await otherPage.reload();
    await expect(otherPage.getByTestId("connect-gate")).toBeVisible({ timeout: 30_000 });
  } finally {
    await other.close();
  }
});

test("端末を追加の札も1回だけ：使った札で別の端末は入れない", async ({ page, browser }) => {
  await loginContext(page.context());
  await openLoginSettings(page);
  // このテストの端末は host のリンク相当で入っていて、パスキーがあるので本人確認を求められる——
  // 認証器に前のパスキーを写して通す
  const { cdp, authenticatorId } = await addAuthenticator(page);
  await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: registered as never });
  await page.getByTestId("login-add-device").click();
  const link = await page.getByTestId("add-device-link").inputValue({ timeout: 30_000 });
  for (const expectIn of [true, false]) {
    const ctx = await browser.newContext();
    try {
      const p = await ctx.newPage();
      await p.goto(link);
      if (expectIn) await expectInside(p);
      else await expect(p.getByTestId("connect-error")).toContainText("このリンクは使えません", { timeout: 30_000 });
    } finally {
      await ctx.close();
    }
  }
});
