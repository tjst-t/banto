// **Project ごとの「AI への指示」**（決定・2026-10-09、ユーザー。アーキ仕様 §2.3・v4-frontend.md §6.17）。
//
// 見ること（画面と host の記録と、偽 Runner が受け取った system prompt で）：
//   1. 書く前から在る Thread の system prompt には「# この Project 固有の指示」が無い
//   2. Project の設定「一般」で書いて「保存」すると、保存できたと出て host に残る。読み込み直しても同じ文が出る。
//      Global Memory への入口がある
//   3. その既存の Thread の次のターンで、system prompt の**末尾**に節とその文が入る（会話にも出る）
//   4. 上限を超えたら断られ、入力は残り、host は元のまま
//   5. 空で保存すると無しに戻り、次のターンの system prompt から節が消える
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";
import { SYSTEM_PROMPT_BLOCK_SEPARATOR } from "../fake-runner.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Project Instruction";
const HEADING = "# この Project 固有の指示";
const INSTRUCTION = "人へは日本語で書く。\nコミットのメッセージも日本語で書く。";

test("設定「一般」で書いた AI への指示が、既存の Thread の次のターンから system prompt の末尾に入り、空で保存すると消える", async ({
  page,
}) => {
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-project-instruction-")));
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as Array<{ id: string; name: string }>;
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId: string = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as Array<{ id: string }>
  )[0]!.id;
  const composer = page.getByPlaceholder(/に送る/);
  const instructionUrl = `${CORE_BASE_URL}/api/projects/${project.id}/instruction`;
  const savedText = async () => ((await (await page.request.get(instructionUrl, { headers })).json()) as { text: string }).text;

  /** 偽 Runner に system prompt をそのまま言わせ、そのブロックの並びを返す */
  let replies = 0;
  async function systemPromptOfNextTurn(label: string): Promise<string[]> {
    await composer.fill(`${label}${fakeTurn({ saySystemPrompt: true })}`);
    await composer.press("Enter");
    replies += 1;
    const thread = await waitTurnEnded(page, threadId, replies, 120_000);
    const said = thread.messages.filter((m) => m.role === "assistant").at(-1)!.text;
    return said.split(SYSTEM_PROMPT_BLOCK_SEPARATOR);
  }

  // --- 1. 書く前：節は無い ---
  const before = await systemPromptOfNextTurn("一つ目。");
  expect(before.length, "system prompt が返ってきていない（偽 Runner の saySystemPrompt が効いていない）").toBeGreaterThan(2);
  expect(before.some((b) => b.includes(HEADING))).toBe(false);
  expect(await savedText()).toBe("");

  // --- 2. 設定「一般」で書いて保存 ---
  const settingsUrl = `/p/${project.id}?settings=1&project=${project.id}&section=project-general`;
  await page.goto(settingsUrl);
  const section = page.getByTestId("project-instruction-section");
  const field = page.getByTestId("project-instruction");
  const save = page.getByTestId("project-instruction-save");
  await expect(field).toBeVisible({ timeout: 30_000 });
  await expect(section.getByRole("heading", { name: "AI への指示" })).toBeVisible();
  await expect(section).toContainText("この Project のすべての会話で、AI への土台の指示に入ります。保存すると次のターンから効きます。");
  await expect(section).toContainText("banto 全体の決まり（返事の言語など）は Global Memory に書きます。");
  await expect(page.getByTestId("project-instruction-global-memory")).toHaveAttribute("href", /[?&]section=global-memory(&|$)/);
  // 「Claude のログイン」の下に出る
  const loginBox = await page.getByTestId("project-claude-login-section").boundingBox();
  const sectionBox = await section.boundingBox();
  expect(loginBox && sectionBox && sectionBox.y > loginBox.y, "AI への指示が Claude のログインの下に無い").toBe(true);
  await expect(field).toHaveValue("");
  await expect(save).toBeDisabled();

  await field.fill(INSTRUCTION);
  await expect(save).toBeEnabled();
  await save.click();
  // **成功したときにだけ出るものを待つ**（規則14）
  await expect(page.getByTestId("project-instruction-saved")).toHaveText("保存しました。次のターンから効きます。", { timeout: 10_000 });
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("project-instruction-error")).toHaveCount(0);
  expect(await savedText()).toBe(INSTRUCTION);

  // 読み込み直しても同じ文が出る（真実は host）
  await page.reload();
  await expect(field).toHaveValue(INSTRUCTION, { timeout: 30_000 });
  await expect(page.getByTestId("project-instruction-saved")).toHaveCount(0);
  // Global Memory への入口は、設定を開いたまま Global Memory の節へ移る
  await page.getByTestId("project-instruction-global-memory").click();
  await expect(page.getByPlaceholder("覚えておいてほしいことを足す")).toBeVisible({ timeout: 15_000 });

  // --- 3. 既存の Thread の次のターンで、末尾に入る ---
  await page.goto(`/p/${project.id}`);
  const after = await systemPromptOfNextTurn("二つ目。");
  expect(after.at(-1), "system prompt の末尾に AI への指示が無い").toBe(`${HEADING}\n\n${INSTRUCTION}`);
  expect(after.filter((b) => b.includes(HEADING)).length).toBe(1);
  // 前の部分は変わっていない（末尾に足しただけ）
  expect(after.slice(0, -1)).toEqual(before);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "コミットのメッセージも日本語で書く。" })).toBeVisible({ timeout: 30_000 });

  // --- 4. 上限を超えたら断られ、入力は残る ---
  await page.goto(settingsUrl);
  await expect(field).toHaveValue(INSTRUCTION, { timeout: 30_000 });
  const tooLong = "あ".repeat(8_001);
  await field.fill(tooLong);
  await save.click();
  await expect(page.getByTestId("project-instruction-error")).toContainText("保存できませんでした：AI への指示は 8,000 字までです（8,001 字あります）", {
    timeout: 10_000,
  });
  await expect(field).toHaveValue(tooLong);
  await expect(page.getByTestId("project-instruction-saved")).toHaveCount(0);
  expect(await savedText(), "断ったのに host の値が変わった").toBe(INSTRUCTION);

  // --- 5. 空で保存すると無しに戻る ---
  await field.fill("");
  await save.click();
  await expect(page.getByTestId("project-instruction-saved")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("project-instruction-error")).toHaveCount(0);
  await expect(field).toHaveValue("");
  expect(await savedText()).toBe("");

  await page.goto(`/p/${project.id}`);
  const cleared = await systemPromptOfNextTurn("三つ目。");
  expect(cleared.some((b) => b.includes(HEADING)), "空で保存したのに節が残っている").toBe(false);
  expect(cleared).toEqual(before);

  expect(pageErrors).toEqual([]);
});
