// サブエージェントの入口（launcher、決定・2026-09-24、ユーザー「launcher から一覧や状態を見られる UI」）。
// Command Palette の「Module の入口」から、AI を介さずに開く。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 入口に「サブエージェント」が名乗った名前と説明で出て、開くと会話の隣に出る
//   2. エージェントごとの資格情報の状態が読める
//   3. 頼んだ仕事が一覧に出て、選ぶと中身（頼んだ文・返答・呼んだツール・session id）が読める
//   4. 走っている仕事は「実行中」と最後の様子が出て、「止める」を押すと取り消しで返る
//      （会話の側にも取り消しとして返る）
//   5. リロードしても記録が残っている
import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Runs";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

test("サブエージェントの入口：仕事の一覧・中身・走っている様子が見え、止められる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-runs-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threads = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[];
  const threadId = threads[0]!.id;
  const assistantTexts = async () =>
    ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
      messages: { role: string; text: string }[];
    }).messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);

  // ---- 仕事を1つ頼んで終わらせておく ------------------------------------------------------
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "メモを書かせて。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[write memo.txt] メモを書いて" } }] }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは、設定の鍵を Vault に探しに行く——Project ごとに初回だけ承認が出る
  // （在りかを聞く口。Shell の envSecrets と同じ）。**成功したときにだけ現れるもの**（返答）を待つ
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
      await page.getByRole("button", { name: "この内容で送る" }).last().click();
    }
    await expect(page.getByText(/書いた：memo\.txt/).first()).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 180_000 });
  await expect.poll(async () => (await assistantTexts()).length, { timeout: 120_000 }).toBe(1);
  const first = JSON.parse((await assistantTexts())[0]!) as { sessionId: string };

  // ---- 1. 入口から開く（AI には頼まない）---------------------------------------------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.getByRole("option", { name: /サブエージェント/ });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await expect(entry).toContainText("この Project でサブエージェントに頼んだ仕事と、その様子を見る");
  await entry.click();
  await expect(page.getByText(/^Canvas — subagent$/), "入口から Canvas が開かなかった").toBeVisible({ timeout: 30_000 });
  const canvas = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

  // ---- 2. エージェントの資格情報の状態 ----------------------------------------------------
  await expect(canvas.locator('[data-role="agent"][data-agent="fake"]')).toHaveText(
    "Fake Agent（試験用）——鍵は banto 全体の設定の「サブエージェント」で入れる",
    { timeout: 60_000 },
  );
  await expect(canvas.locator('[data-role="agent"][data-agent="fake-host"]')).toContainText(
    "banto 本体の Claude ログインを使う（契約：max",
  );

  // ---- 3. 一覧と中身 ---------------------------------------------------------------------
  const rows = canvas.locator('[data-role="run"]');
  await expect(rows).toHaveCount(1);
  const done = rows.first();
  await expect(done.locator('[data-role="status"]')).toHaveText("完了");
  await expect(done.locator('[data-role="prompt"]')).toHaveText("[write memo.txt] メモを書いて");
  await expect(done).toContainText("Fake Agent（試験用）");
  await expect(done).toContainText("ツール 1回");
  await done.click();
  const detail = canvas.locator('[data-role="detail"]');
  await expect(detail.locator('[data-role="detail-prompt"]')).toHaveText("[write memo.txt] メモを書いて");
  await expect(detail.locator('[data-role="detail-reply"]')).toContainText("書いた：memo.txt");
  await expect(detail.locator('[data-role="detail-tools"]')).toHaveText("write memo.txt");
  await expect(detail).toContainText(first.sessionId);

  // ---- 4. 走っている仕事の様子と「止める」 ---------------------------------------------------
  await composer.fill(
    "長い仕事を頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 45] 長い仕事" } }] }),
  );
  await composer.press("Enter");
  const running = canvas.locator('[data-role="run"][data-status="running"]');
  await expect(running, "走っている仕事が一覧に出ない").toHaveCount(1, { timeout: 30_000 });
  await expect(running.locator('[data-role="status"]')).toHaveText("実行中");
  await expect(running.locator('[data-role="prompt"]')).toHaveText("[slow 45] 長い仕事");
  await expect(running.locator('[data-role="progress"]')).toHaveText("ツール：sleep 45", { timeout: 15_000 });
  await running.getByRole("button", { name: "止める" }).click();
  await expect(canvas.locator('[data-role="run"][data-status="cancelled"] [data-role="status"]')).toHaveText("取り消し", {
    timeout: 20_000,
  });
  await expect(running).toHaveCount(0);
  // 会話の側にも、取り消しとして返る
  await expect.poll(async () => (await assistantTexts()).length, { timeout: 60_000 }).toBe(2);
  expect(JSON.parse((await assistantTexts())[1]!).stopReason).toBe("cancelled");

  // ---- 5. リロードしても記録が残る ---------------------------------------------------------
  await page.reload();
  await expect(page.getByText(/^Canvas — subagent$/)).toBeVisible({ timeout: 30_000 });
  const reloaded = page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");
  await expect(reloaded.locator('[data-role="run"] [data-role="status"]')).toHaveText(["取り消し", "完了"], { timeout: 60_000 });

  expect(pageErrors).toEqual([]);
});
