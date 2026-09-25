// Subagent Module（アーキ仕様 §4.1「Subagent Module の形」）を画面から端まで通す。
// エージェントは偽物（`BANTO_SUBAGENT_FAKE_AGENT`、start-core.ts）だが、**閉じ込め・資格情報の
// 受け渡し（Vault の中継と承認）・続きからの再開は本物の経路**を通る。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. Project を作ると subagent が立ち、Project 設定の Module 一覧に出る
//   2. 資格情報：初回は Vault の中継を人に聞き、許可すると値がエージェントの環境に届く
//      ——値はどこにも出ない
//   3. tool のカードに、頼んだ内容（引数）と返り値が出る
//   4. 続きから頼める（前の会話を覚えている）
//   5. 閉じ込め：Project の根には書けて、外には書けない
import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, openProjectSettings, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Project";
const SECRET = `SUBAGENT-SECRET-${Date.now()}`;
const ALIAS = `e2e-subagent-${Date.now()}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

interface RunResult {
  sessionId: string;
  stopReason: string;
  text: string;
  permissions: { title: string; answer: string }[];
}

/** その Thread の assistant の発言（偽 Runner は tool の返り値をそのまま発言にする） */
async function assistantTexts(page: Page, threadId: string): Promise<string[]> {
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: { role: string; text: string }[];
  };
  return thread.messages.filter((m) => m.role === "assistant").map((m) => m.text);
}

test("サブエージェントに頼む——資格情報は Vault から、閉じ込めの中で走り、続きから頼める", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const created = await page.request.post(`${CORE_BASE_URL}/api/ui-tool-call`, {
    headers,
    data: { server: "vault-local", tool: "createAlias", arguments: { name: ALIAS, kind: "secret", value: SECRET } },
  });
  expect(created.ok()).toBe(true);

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  // 1. subagent が立つ
  await waitForProjectModule(page, PROJECT_NAME, "subagent");

  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as {
    id: string;
    name: string;
  }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as {
    id: string;
  }[];
  const threadId = threads[0]!.id;
  const finishedTurns = async () => (await assistantTexts(page, threadId)).length;
  const lastResult = async (): Promise<RunResult> => {
    const texts = await assistantTexts(page, threadId);
    return JSON.parse(texts[texts.length - 1] ?? "") as RunResult;
  };

  const composer = page.getByPlaceholder(/に送る/);

  // 2. 資格情報つきで頼む——初回は Vault の中継を人に聞く
  await composer.fill(
    "サブエージェントに鍵が届くか確かめて。" +
      fakeTurn({
        tools: [
          {
            server: "subagent",
            name: "runSubagent",
            args: { agent: "fake", prompt: "[env FAKE_AGENT_TOKEN]", envSecrets: { FAKE_AGENT_TOKEN: ALIAS } },
          },
        ],
      }),
  );
  await composer.press("Enter");

  const firstCard = page.locator('[data-role="judgment-card"]').first();
  await expect(
    firstCard.getByText(/subagent が vault-directory の lookupAlias を呼ぼうとしています/),
    "最初に聞かれるのは「在りかを聞いてよいか」のはず",
  ).toBeVisible({ timeout: 120_000 });

  const approveOnePending = async (): Promise<boolean> => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) === 0) return false;
    await allow.last().click();
    await page.getByRole("button", { name: "この内容で送る" }).last().click();
    return true;
  };
  // **成功したときにだけ現れるもの**を待つ（規則14）——エージェントが「渡っている」と答えた発言
  await expect(async () => {
    await approveOnePending();
    await expect(page.getByText(/FAKE_AGENT_TOKEN は渡っている/).first()).toBeVisible({ timeout: 20_000 });
  }).toPass({ timeout: 240_000 });
  await expect.poll(finishedTurns, { timeout: 120_000, message: "1ターン目が終わるまで" }).toBe(1);

  const asked = (await page.locator('[data-role="judgment-card"]').allInnerTexts()).join("\n");
  expect(asked).toContain("subagent が vault-directory の lookupAlias");
  // **値を引く口は、どの鍵かごとに聞く**（コンテナの中の呼び手・v4-security.md §3）——鍵の名前がカードに出る
  expect(asked).toContain(`subagent が vault-local の resolveAlias（name: ${ALIAS}`);
  // **値は、どこにも出ない**——承認カードにも、エージェントの返答にも、画面にも
  expect(asked, "承認カードに秘密の値が出ている").not.toContain(SECRET);
  await expect(page.getByText(SECRET)).toHaveCount(0);

  const first = await lastResult();
  expect(first.stopReason).toBe("end_turn");
  expect(first.text).toContain("FAKE_AGENT_TOKEN は渡っている");
  // エージェントの既定モード（main の Runner と揃えて auto）が掛かっている
  expect(first.text).toContain("mode=auto");
  expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);

  // 3. tool のカード：頼んだ内容（引数）と返り値が出る。**開いているかを見てから押す**
  // ——ターンが終わると会話は host の記録から描き直され、まとまりが閉じ直る（押すと逆に閉じる）
  const group = page.locator('[data-slot="tool-group-trigger"]').first();
  const card = page.locator('[data-slot="tool-fallback-trigger"]', { hasText: "runSubagent" }).first();
  const result = page.locator('[data-slot="tool-fallback-result"]').first();
  await expect(async () => {
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
    if ((await card.getAttribute("aria-expanded")) !== "true") await card.click();
    await expect(result).toContainText("FAKE_AGENT_TOKEN は渡っている", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const args = page.locator('[data-slot="tool-fallback-args"]').first();
  await expect(args).toContainText('"agent":"fake"');
  await expect(args).toContainText(ALIAS);
  await expect(result).toContainText(first.sessionId);
  await expect(result, "tool の返り値に秘密の値が出ている").not.toContainText(SECRET);

  // 4. 続きから頼む（前の返り値の sessionId を渡す）。2回目の中継は聞かれない
  await composer.fill(
    "さっきのサブエージェントに続きを頼んで。" +
      fakeTurn({
        tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "前に何を頼んだ？", sessionId: first.sessionId } }],
      }),
  );
  await composer.press("Enter");
  await expect.poll(finishedTurns, { timeout: 120_000, message: "2ターン目が終わるまで" }).toBe(2);
  const resumed = await lastResult();
  expect(resumed.sessionId).toBe(first.sessionId);
  expect(resumed.text).toContain("前に頼まれたこと：[env FAKE_AGENT_TOKEN]");
  await expect(page.getByText(/前に頼まれたこと：\[env FAKE_AGENT_TOKEN\]/).first()).toBeVisible();

  // 5. 閉じ込め：根の中には書けて、外には書けない
  await composer.fill(
    "サブエージェントにファイルを書かせて。" +
      fakeTurn({
        tools: [
          { server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[write made-by-subagent.txt]" } },
          { server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[write ../escaped-by-subagent.txt]" } },
        ],
      }),
  );
  await composer.press("Enter");
  await expect.poll(finishedTurns, { timeout: 120_000, message: "3ターン目が終わるまで" }).toBe(3);
  const escaped = await lastResult();
  expect(escaped.text).toMatch(/書けなかった：.*(EACCES|permission denied)/i);
  expect(existsSync(join(projectRoot, "made-by-subagent.txt")), "根の中に書けていない").toBe(true);
  expect(existsSync(join(projectRoot, "..", "escaped-by-subagent.txt")), "根の外に書けてしまった").toBe(false);

  // 1'. Project 設定の Module 一覧にも出ている（影響しうる別の画面）
  await openProjectSettings(page, "この Project の Module");
  const row = page.locator('[data-testid="module-row"][data-module="subagent"]');
  await expect(row, "Module の一覧に subagent が出ていない").toBeVisible({ timeout: 20_000 });
  await expect(row).toHaveAttribute("data-state", "linked");
  await expect(row.getByText("subagent", { exact: true }).first()).toBeVisible();
  await expect(row.locator("td").nth(2)).toHaveText("Project ごと");
  // Module もそれが起こすエージェントも、その Project のコンテナの中で動く（v4-security.md §1）
  await expect(row.locator("td").nth(3)).toHaveText("Project のコンテナ");

  expect(pageErrors).toEqual([]);
});
