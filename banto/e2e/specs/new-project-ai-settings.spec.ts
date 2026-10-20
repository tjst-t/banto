// **新しい Project の画面の3つのスイッチ**（決定・2026-10-20、ユーザー。v4-frontend.md §6.51）。
//
// 見ること（画面と host の記録で）：
//   1. 新しい Project の画面の「作成する」の上に、見出し「この Project の AI」と3行（まとめ・自動で許可・空いた会話の要約）。
//      初めの位置はどれもオンで、自動で許可がオンの間は警告色の注意が出る（切ると消える）
//   2. 切って作った Project は、host の設定がどれもオフ。設定の「一般」も同じ並び・同じ文でオフを出す。最初のターンの
//      tool の確認は人に聞く（自動で許可していない）・まとめは出ない
//   3. 初めの位置のまま作った Project は、host の設定がどれもオン。**最初のターンから**自動で許可が効き（permissionMode が
//      default でも tool の確認を人に聞かずに通す）、まとめも出る
import type { Page } from "@playwright/test";
import { test, expect } from "../test-base.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import {
  clickNewProject,
  createProject,
  expectProjectOpen,
  fakeTurn,
  openNav,
  openApp,
  openToolCards,
  setNewProjectAi,
  waitForProjectModule,
  waitTurnEnded,
} from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const OFF_NAME = "E2E AI Switches Off";
const ON_NAME = "E2E AI Switches On";
const AUTO_ANSWER = "回答：自動で許可しました（承認をすべて自動で許可する がオン）";
const LABELS = ["ターンの終わりのまとめ", "承認をすべて自動で許可する", "空いた会話を冷める前に要約する"];
const DESCRIPTIONS = [
  "作業したターンの最後に、頼んだこと・結果・決めることをまとめて受信箱にも出す",
  "この Project の AI が頼むものは、Vault の秘密の取り出し・公開も含めて人に聞かずに通す",
  "4時間空いた会話は、続きの費用を抑えるために要約する（それまではキャッシュを温め直す）",
];
const SUMMARY = {
  request: "one.txt を読む",
  outcome: { status: "done", headline: "one.txt を読みました。", points: [] },
  decisions: [],
  nextSuggestions: [{ label: "続ける", reply: "続けて。" }],
};

async function hostSettings(page: Page, projectId: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const what of ["turn-summary", "auto-approve", "idle-compaction"]) {
    const res = await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/${what}`, { headers });
    expect(res.ok(), `${what} を読めない`).toBe(true);
    out.push(((await res.json()) as { enabled: boolean }).enabled);
  }
  return out;
}

async function projectNamed(page: Page, name: string): Promise<{ id: string; threadId: string }> {
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === name)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as Array<{ id: string }>;
  return { id: project.id, threadId: threads[0]!.id };
}

/** 設定の「一般」の3行が、新しい Project の画面と同じ並び・同じ文で、host の値を出しているか */
async function expectSettingsRows(page: Page, projectId: string, checked: boolean[]): Promise<void> {
  await page.goto(`/p/${projectId}?settings=1&project=${projectId}&section=project-general`);
  const section = page.getByTestId("project-ai-section");
  await expect(section.getByRole("heading", { name: "この Project の AI" })).toBeVisible({ timeout: 30_000 });
  const ids = ["project-turn-summary", "project-auto-approve", "project-idle-compaction"];
  for (const [i, id] of ids.entries()) {
    await expect(section.getByTestId(id)).toHaveAttribute("aria-checked", String(checked[i]), { timeout: 30_000 });
    await expect(section.getByTestId(`${id}-description`)).toHaveText(DESCRIPTIONS[i]!);
  }
  await expect(section.locator("label")).toHaveText(LABELS);
  await expect(section.getByTestId("project-auto-approve-caution")).toHaveCount(checked[1] ? 1 : 0);
}

/** 毎回聞くモードにして、ファイルを1つ読ませる（tool の確認が出るはずのターン） */
async function sendReadTurn(page: Page, projectName: string, then: string): Promise<void> {
  await waitForProjectModule(page, projectName, "filesystem");
  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("button", { name: /permissionMode（現在：default）/ })).toBeVisible({ timeout: 15_000 });
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "one.txt を読んでください。" +
      fakeTurn({ tools: [{ server: "filesystem", name: "readFile", args: { path: "one.txt" } }], then, stopReport: SUMMARY }),
  );
  await composer.press("Enter");
}

test("新しい Project の画面に「この Project の AI」の3行が初めはオンで出る。切って作ると host もオフで、最初のターンは人に聞く", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-ai-off-"));
  writeFileSync(join(root, "one.txt"), "ひとつめ\n");
  await openApp(page);
  await openNav(page);
  await clickNewProject(page);
  const dialog = page.getByRole("dialog", { name: "新しい Project" });
  await dialog.getByLabel("Project 名").fill(OFF_NAME);
  await dialog.getByLabel("Root パス").fill(root);

  // --- 1. 見出しと3行、初めの位置はどれもオン ---
  const ai = dialog.getByTestId("new-project-ai");
  await expect(ai.getByRole("heading", { name: "この Project の AI" })).toBeVisible();
  await expect(ai.locator("label")).toHaveText(LABELS);
  const keys = ["turnSummary", "autoApproveAll", "idleCompaction"];
  for (const [i, key] of keys.entries()) {
    await expect(ai.getByTestId(`new-project-ai-${key}`)).toHaveAttribute("aria-checked", "true");
    await expect(ai.getByTestId(`new-project-ai-${key}-description`)).toHaveText(DESCRIPTIONS[i]!);
  }
  // 自動で許可がオンの間は警告色の注意
  await expect(ai.getByTestId("new-project-ai-autoApproveAll-caution")).toContainText("オンの間は承認のカードで止まりません");
  await expect(ai.getByTestId("new-project-ai-autoApproveAll-row")).toHaveClass(/border-destructive/);
  // 「作成する」の上にある（中身はスクロールする——見えるところまで送ってから比べる）
  await ai.scrollIntoViewIfNeeded();
  await expect(ai.getByTestId("new-project-ai-idleCompaction")).toBeInViewport();
  const aiBox = (await ai.boundingBox())!;
  const submitBox = (await dialog.getByTestId("new-project-submit").boundingBox())!;
  expect(aiBox.y + aiBox.height, "スイッチが「作成する」より下にある").toBeLessThanOrEqual(submitBox.y);

  // --- 2. 全部切って作る ---
  await setNewProjectAi(dialog, { turnSummary: false, autoApproveAll: false, idleCompaction: false });
  await expect(ai.getByTestId("new-project-ai-autoApproveAll-caution")).toHaveCount(0);
  await expect(ai.getByTestId("new-project-ai-autoApproveAll-row")).not.toHaveClass(/border-destructive/);
  await dialog.getByTestId("new-project-submit").click();
  await expectProjectOpen(page, OFF_NAME);
  const project = await projectNamed(page, OFF_NAME);
  expect(await hostSettings(page, project.id)).toEqual([false, false, false]);
  await expectSettingsRows(page, project.id, [false, false, false]);

  // 最初のターン：tool の確認を人に聞く・まとめは出ない
  await page.goto(`/p/${project.id}`);
  await sendReadTurn(page, OFF_NAME, "読みました（オフ）。");
  const card = page.locator('[data-role="judgment-card"]').filter({ hasText: "tool呼び出しの承認: mcp__filesystem__readFile" });
  await card.getByRole("button", { name: "許可する" }).click({ timeout: 60_000 });
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "読みました（オフ）。" })).toBeVisible({ timeout: 60_000 });
  await waitTurnEnded(page, project.threadId, 1);
  await expect(card).not.toContainText(AUTO_ANSWER);
  await expect(page.getByTestId("turn-summary")).toHaveCount(0);
});

test("初めの位置のまま作った Project は host もオンで、自動で許可とまとめが最初のターンから効く", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-ai-on-"));
  writeFileSync(join(root, "one.txt"), "ひとつめ\n");
  await openApp(page);
  await createProject(page, ON_NAME, root, { turnSummary: true, autoApproveAll: true, idleCompaction: true });
  const project = await projectNamed(page, ON_NAME);
  expect(await hostSettings(page, project.id)).toEqual([true, true, true]);

  // 設定を開く前に最初のターンを送る（作るのと同じ要求で書けているか）
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });
  await sendReadTurn(page, ON_NAME, "読みました（オン）。");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "読みました（オン）。" })).toBeVisible({ timeout: 120_000 });
  await waitTurnEnded(page, project.threadId, 1);
  await openToolCards(page, "mcp__filesystem__readFile");
  await expect(page.getByText(/ひとつめ/).first()).toBeVisible({ timeout: 30_000 });
  const card = page.locator('[data-role="judgment-card"]').filter({ hasText: "tool呼び出しの承認: mcp__filesystem__readFile" });
  await expect(card.first()).toContainText(AUTO_ANSWER);
  await expect(page.getByRole("button", { name: "許可する" })).toHaveCount(0);
  // まとめも最初のターンから
  await expect(page.getByTestId("turn-summary")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("turn-summary")).toContainText("one.txt を読みました。");

  await expectSettingsRows(page, project.id, [true, true, true]);
});
