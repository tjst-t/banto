// **AI が tool から Fork を立てる**（決定・2026-09-27、ユーザー。アーキ仕様 §2.2「AI が Fork を立てる」）と、
// **ターンが終わったら受信箱にレビュー待ち**（同日、§2.4）。
//
// 見ること（画面で）：
// - AI が `start_forks` を呼ぶと、親のターンが終わってから Fork が立ち、**再読み込みしなくても**付けた名前で
//   親の会話に入口が出る
// - Fork は最初の指示で自動で走る（届いたものとして、人の発言ではない印つき）
// - 受信箱に、ターンが終わった Fork が出る。**開いて見ている Base Thread のものは出ない**
// - 受信箱から開くと、その Fork の分は消える
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, fakeTurn, openApp } from "../helpers.js";

// ≥md では Base/Fork が横に重なって同じ要素が2つ出る（project-thread-fork.spec.ts と同じ理由）
test.use({ viewport: { width: 390, height: 844 } });

const PROJECT_NAME = "E2E AI Forks";

test("AI が Fork を2つ立てる→名前つきで出て、最初の指示で走る→終わった Fork が受信箱に出る", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-ai-forks-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "課題を2つに分けて並行で進めてください。" +
      fakeTurn({
        say: "2つの Fork に分けます。",
        tools: [
          {
            server: "banto-thread",
            name: "start_forks",
            args: {
              forks: [
                { title: "認証の修正", instruction: "ログインの不具合を調べて直す" },
                { title: "画面の修正", instruction: "一覧の並びを直す" },
              ],
            },
          },
        ],
        then: "Fork を立てました。",
      }),
  );
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "Fork を立てました。" })).toBeVisible({
    timeout: 60_000,
  });

  // **再読み込みせずに**、付けた名前で親の会話に入口が出る
  const cards = page.locator('[data-testid="fork-open-card"]');
  await expect(cards.filter({ hasText: "認証の修正" }), "AI が立てた Fork の入口が出ない").toBeVisible({ timeout: 30_000 });
  await expect(cards.filter({ hasText: "画面の修正" })).toBeVisible({ timeout: 30_000 });

  // host の記録：Fork は最初の指示で走り、届いたものの印が付いている（人の発言ではない）
  const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
  const projects = await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json();
  const project = projects.find((p: { name: string }) => p.name === PROJECT_NAME);
  type Summary = { id: string; kind: string; title?: string };
  const threads: Summary[] = await (
    await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })
  ).json();
  const auth = threads.find((t) => t.kind === "fork" && t.title === "認証の修正");
  expect(auth, "名前つきの Fork が host に無い").toBeTruthy();
  await expect
    .poll(
      async () => {
        const t = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${auth!.id}`, { headers })).json()) as {
          messages: Array<{ role: string; text: string; origin?: { from: string } }>;
        };
        const delivered = t.messages.find((m) => m.origin && m.text.includes("ログインの不具合を調べて直す"));
        const answered = t.messages.at(-1)?.role === "assistant";
        return delivered && answered ? delivered.origin!.from : undefined;
      },
      { timeout: 60_000, message: "Fork が最初の指示で走り終わるまで" },
    )
    .toBe("Base Thread");

  // 受信箱：ターンが終わった Fork が2件。**見ている Base Thread のものは出ない**
  await page.getByRole("button", { name: "受信箱" }).click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  const reviews = inbox.locator('[data-testid="inbox-review"]');
  await expect(reviews, "ターンが終わった Fork が受信箱に出ない").toHaveCount(2, { timeout: 30_000 });
  await expect(reviews.filter({ hasText: "認証の修正" })).toBeVisible();
  await expect(reviews.filter({ hasText: "画面の修正" })).toBeVisible();

  // 受信箱から開くと、その Fork が開き、その分は消える
  await reviews.filter({ hasText: "認証の修正" }).click();
  await expect(page.getByRole("button", { name: /Base Thread に戻る$/ })).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const items = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{
          kind: string;
          threadId?: string;
        }>;
        return items.filter((i) => i.kind === "review").map((i) => i.threadId);
      },
      { timeout: 15_000, message: "開いた Fork のレビュー待ちが消えるまで" },
    )
    .not.toContain(auth!.id);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
