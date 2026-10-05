// サブエージェントの設定画面（決定・2026-09-24、ユーザー——「Claude は本体のログインを共有」
// 「OpenCode の Secret は設定から入れられるといい」「鍵の設定は Project ではなく Global に」）。
//
// 偽物（start-core.ts）：本体の Claude ログイン＝契約 max の資格情報ファイル、取り込み元＝
// `{ fake: { type: "api", key: SUBAGENT_IMPORTED_KEY } }`。エージェントは偽の2つ
// （fake＝鍵を使う・OpenCode と同じ形、fake-host＝本体のログインを使う・Claude Code と同じ形）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身と、その操作が効く先まで）：
//   1. **banto 全体の設定**の「Module ごとの設定」に「サブエージェント」が出て、本体のログインの状態が読める
//   2. 貼り付けて保存すると「設定済み」になり、値は画面のどこにも出ない。banto 全体の Vault の一覧にも出る
//   3. 会話で envSecrets を書かずに頼むと、**貼った値そのもの**がエージェントに届く（sha256 で突き合わせ）
//   4. 取り込むと置き換わり、次の仕事には**取り込んだ値**が届く（Vault の書き換えが、この画面から通る）
//   5. 消すと「未設定」に戻る
//   6. Project 設定には出ない（前の置き場）
import { test, expect, type Page } from "../test-base.js";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN, SUBAGENT_IMPORTED_KEY } from "../config.js";
import { createProject, openApp, openProjectSettings, fakeTurn, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Settings";
const PASTED = `e2e-pasted-${Date.now()}`;
const ALIAS = "subagent.fake.FAKE_AGENT_TOKEN";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

async function openSubagentSettings(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "サブエージェント", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="subagent-settings"]');
  await expect(canvas, "サブエージェントの設定画面が出ていない").toBeVisible({ timeout: 30_000 });
  return canvas.locator("iframe").contentFrame().frameLocator("iframe");
}

test("サブエージェントの設定（banto 全体）：本体のログインの状態が読め、鍵を貼る・取り込む・消すと会話に効く", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-settings-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const threadUrl = page.url();
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[];
  const threadId = threads[0]!.id;
  const lastAssistant = async () => {
    const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
      messages: { role: string; text: string }[];
    };
    const mine = thread.messages.filter((m) => m.role === "assistant");
    return { count: mine.length, text: mine[mine.length - 1]?.text ?? "" };
  };

  // ---- 1. 設定画面が出て、本体のログインの状態が読める ----------------------------------
  let inner = await openSubagentSettings(page);
  await expect(inner.locator('[data-role="host-login"][data-agent="fake-host"]')).toHaveText(
    "banto 本体の Claude ログインを使います（契約：max）。入れるものはありません。",
    { timeout: 30_000 },
  );
  let row = inner.locator('[data-role="credential"][data-agent="fake"][data-env="FAKE_AGENT_TOKEN"]');
  await expect(row.locator('[data-role="state"]')).toHaveText("未設定");
  await expect(row.getByRole("button", { name: "試験用の設定ファイルから取り込む" })).toBeVisible();
  // 本体のログインを使うほうには、鍵の欄が無い
  await expect(inner.locator('[data-role="credential"][data-agent="fake-host"]')).toHaveCount(0);
  // 開いた瞬間の読み取りで人を止めない
  await expect(page.locator('[data-testid="canvas-approval"]')).toHaveCount(0);

  // カードの見出し：鍵を使うほうは件数、本体のログインを使うほうは使えるかどうか
  await expect(inner.locator('section.card[data-agent="fake"] .card-head .pill')).toHaveText("鍵なし");
  await expect(inner.locator('section.card[data-agent="fake-host"] .card-head .pill')).toHaveText("使える");

  // ---- 2. 貼り付けて保存する ----------------------------------------------------------
  // 入力欄は「鍵を貼る」を押してから出る（値は画面に出さない——password）
  await expect(row.getByLabel("FAKE_AGENT_TOKEN の鍵")).toHaveCount(0);
  await row.getByRole("button", { name: "鍵を貼る" }).click();
  await expect(row.getByLabel("FAKE_AGENT_TOKEN の鍵")).toHaveAttribute("type", "password");
  await row.getByLabel("FAKE_AGENT_TOKEN の鍵").fill(PASTED);
  await row.getByRole("button", { name: "貼り付けて保存" }).click();
  await expect(inner.getByText("FAKE_AGENT_TOKEN を保存しました")).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('[data-role="state"]')).toHaveText("設定済み");
  await expect(inner.locator('section.card[data-agent="fake"] .card-head .pill')).toHaveText("鍵 1件");
  // 設定済みは、取り込み直す・置き換える・消すができる。保存したら入力欄は閉じる
  await expect(row.getByRole("button", { name: "取り込み直す" })).toBeVisible();
  await expect(row.getByRole("button", { name: "置き換える" })).toBeVisible();
  await expect(row.getByRole("button", { name: "消す" })).toBeVisible();
  await expect(row.getByLabel("FAKE_AGENT_TOKEN の鍵"), "保存したあとも入力欄が開いている").toHaveCount(0);
  await expect(inner.getByText(PASTED), "設定画面に鍵の値が出ている").toHaveCount(0);

  // banto 全体の Vault の一覧にも出る（置き場は Vault——Module は持たない）
  await page.getByRole("button", { name: "Vault（ローカル）", exact: true }).click();
  const vaultInner = page
    .locator('[data-testid="module-settings-canvas"][data-module="vault-local"] iframe')
    .contentFrame()
    .frameLocator("iframe");
  await expect(vaultInner.getByText(ALIAS).first(), "Vault の一覧に既定の鍵が出ていない").toBeVisible({ timeout: 60_000 });
  await expect(vaultInner.getByText(PASTED), "Vault の一覧に値が出ている").toHaveCount(0);

  // ---- 3. envSecrets を書かずに頼むと、貼った値そのものが届く ----------------------------------
  await page.goto(threadUrl);
  const composer = page.getByPlaceholder(/に送る/);
  const askSha = async (lead: string) => {
    await composer.fill(
      lead + fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[sha FAKE_AGENT_TOKEN]" } }] }),
    );
    await composer.press("Enter");
  };
  await askSha("サブエージェントに鍵が届くか確かめて。");
  // 初回は Vault の中継を人に聞く（Shell の envSecrets と同じ——在りかと値の2枚）
  const approveOnePending = async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) === 0) return;
    await allow.last().click();
  };
  await expect(async () => {
    await approveOnePending();
    await expect(page.getByText(`FAKE_AGENT_TOKEN の sha256：${sha(PASTED)}`).first()).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 240_000 });
  await waitTurnEnded(page, threadId, 1, 120_000);
  expect((await lastAssistant()).text).toContain(sha(PASTED));
  await expect(page.getByText(PASTED), "会話に鍵の値が出ている").toHaveCount(0);

  // ---- 6. Project 設定には出ない（前の置き場）——banto 全体の側に1つだけ ---------------------------
  await openProjectSettings(page);
  await expect(page.getByRole("button", { name: "サブエージェント", exact: true })).toHaveCount(1);
  await expect(page.locator('[data-testid="module-settings-canvas"][data-module="subagent"]')).toHaveCount(0);

  // ---- 4. 取り込むと置き換わり、取り込んだ値が届く --------------------------------------------
  inner = await openSubagentSettings(page);
  row = inner.locator('[data-role="credential"][data-agent="fake"][data-env="FAKE_AGENT_TOKEN"]');
  await expect(row.locator('[data-role="state"]')).toHaveText("設定済み", { timeout: 30_000 });
  await row.getByRole("button", { name: "取り込み直す" }).click();
  await expect(inner.getByText("FAKE_AGENT_TOKEN を取り込みました")).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('[data-role="state"]')).toHaveText("設定済み");
  await expect(inner.getByText(SUBAGENT_IMPORTED_KEY), "設定画面に鍵の値が出ている").toHaveCount(0);

  await page.goto(threadUrl);
  await askSha("もう一度確かめて。");
  // 2回目は聞かれない（同じ Project の中継は許可済み）——取り込んだ値の sha が出るまで待つ
  await expect(page.getByText(`FAKE_AGENT_TOKEN の sha256：${sha(SUBAGENT_IMPORTED_KEY)}`).first()).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await lastAssistant()).count, { timeout: 120_000 }).toBe(2);
  await expect(page.getByText(SUBAGENT_IMPORTED_KEY), "会話に鍵の値が出ている").toHaveCount(0);

  // ---- 5. 消すと未設定に戻る（この画面から Vault の削除が通る）-------------------------------
  inner = await openSubagentSettings(page);
  row = inner.locator('[data-role="credential"][data-agent="fake"][data-env="FAKE_AGENT_TOKEN"]');
  await row.getByRole("button", { name: "消す" }).click();
  await expect(inner.getByText("FAKE_AGENT_TOKEN を消しました")).toBeVisible({ timeout: 30_000 });
  await expect(row.locator('[data-role="state"]')).toHaveText("未設定");
  await expect(row.getByRole("button", { name: "消す" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "鍵を貼る" })).toBeVisible();
  await expect(row.getByRole("button", { name: "試験用の設定ファイルから取り込む" })).toBeVisible();
  await expect(inner.locator('section.card[data-agent="fake"] .card-head .pill')).toHaveText("鍵なし");

  expect(pageErrors).toEqual([]);
});
