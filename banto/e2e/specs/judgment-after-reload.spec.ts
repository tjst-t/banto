// 判断待ちが立っている最中にページを再読み込みしたら、承認カードは戻るか。
// ——ユーザー報告（2026-09-06、実インスタンスで「承認が出なかった」のに
// host側には判断待ちが生きたまま残っていた）の再現を試みる計測用。
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { openApp } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E Reload Judgment";

test("判断待ちの最中にリロードしても、承認カードは戻ってくる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-reload-"));

  await openApp(page);
  await page.getByRole("button", { name: "新しい Project", exact: true }).click();
  await page.getByLabel("Project 名").fill(PROJECT_NAME);
  await page.getByLabel("Base パス").fill(projectRoot);
  await page.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /permissionMode/ }).click();
  await page.getByRole("menuitemradio", { name: /default/ }).click();
  await expect(page.getByRole("menu")).not.toBeVisible({ timeout: 10_000 });

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("filesystem の listDirectory で「.」の中身を一覧してください。");
  await composer.press("Enter");

  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 60_000 });

  // ここでリロード——host側の判断待ちは生きたまま（hold-the-line）
  await page.reload();
  await expect(page.getByText(`Base Thread — ${PROJECT_NAME}`)).toBeVisible({ timeout: 30_000 });

  const open = await (
    await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } })
  ).json();
  expect(open.some((i: { kind: string }) => i.kind === "judgment")).toBe(true);
  const threadId: string = open.find((i: { kind: string }) => i.kind === "judgment").threadId;

  // 会話の画面に、答えられる承認カードが戻っているか
  await expect(page.getByText("があなたの判断を待っています")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("tool呼び出しの承認: mcp__filesystem__listDirectory")).toBeVisible();

  // 実際に答えられて、止まっていたターンが動き出すところまで見る（規則14）
  const target = open.find((i: { kind: string }) => i.kind === "judgment");
  await page.getByRole("button", { name: "許可する" }).click();
  await page.getByRole("button", { name: "この内容で送る" }).click();

  await expect
    .poll(
      async () => {
        const now = await (
          await page.request.get(`${CORE_BASE_URL}/api/inbox`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        return now.some((i: { id: string }) => i.id === target.id);
      },
      { timeout: 30_000 },
    )
    .toBe(false);

  // 答えたあとの続き（このブラウザにはSSEが無い）が、hostの記録から画面に入る。
  // 「何か出た」で済ませず、**hostが記録した最後の返事の本文そのもの**が
  // 画面に出ていることを見る（規則14）
  let lastAssistantText = "";
  await expect
    .poll(
      async () => {
        const t = await (
          await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          })
        ).json();
        const assistant = (t.messages as { role: string; text: string }[]).filter(
          (m) => m.role === "assistant",
        );
        lastAssistantText = assistant.at(-1)?.text ?? "";
        return lastAssistantText.length > 0;
      },
      { timeout: 120_000 },
    )
    .toBe(true);

  await expect(page.getByText(lastAssistantText.slice(0, 30), { exact: false })).toBeVisible({
    timeout: 60_000,
  });
});
