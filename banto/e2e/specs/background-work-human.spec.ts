// **人の答えを待っているものは、「バックグラウンド」と分けて人の番の色で出す**（決定・2026-10-04、ユーザー。v4-frontend.md §6.33）。
//
// 公開の承認と同じ形の試験用 Module（`fixtures/ask-human-module`）を banto 全体に足し、AI にその tool を呼ばせる。
// 見るもの（規則14）：
//   1. Thread の行の名前の下に、人の番の行（手のアイコン）で Module が名乗った題「試験の承認：A」。人の番の色
//   2. 同時にサブエージェントにも待たずに頼むと、裏の仕事の行（「fake に頼んだ仕事」）も別の行で出る——片方がもう片方を隠さない
//   3. もう1つ人を待つと「あなたの答えを待っています（2 件）」。一覧は「あなたの答えを待っているもの（2）」と
//      「バックグラウンドで動いているもの（1）」に分かれ、人を待つほうが先
//   4. 別の Project を開くと、元の Project の行の数は人の番の色（data-human）で、数は全部（3）
//   5. Module を外すと host が「途中で終わりました」を届け、人の番の行が消える（裏の仕事の行は残り、終われば消える）
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

const STAMP = Date.now();
const MODULE = `e2e-ask-${STAMP}`;
const PROJECT_NAME = "E2E Waiting Human";
const OTHER_NAME = "E2E Waiting Human Other";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ask-human-module/server.js");

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
});

test("人の答えを待っているものは、バックグラウンドと分けて人の番の色で出る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: { mcpServers: { [MODULE]: { command: "${nodeExec}", args: [SERVER] } } },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-waiting-human-")));
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const assistantCount = async () =>
    ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { messages: { role: string }[] }).messages.filter(
      (m) => m.role === "assistant",
    ).length;

  const sidebar = page.locator('[data-sidebar="sidebar"]');
  const humanLine = sidebar.getByTestId("thread-waiting-human");
  const workLine = sidebar.getByTestId("thread-background");
  const list = page.getByTestId("background-list");
  const composer = page.getByPlaceholder(/に送る/);

  // ---- 1・2. 人を待つものと、裏の仕事を1つずつ ------------------------------------------------------------
  await composer.fill(
    "承認を頼んで、サブエージェントにも待たずに頼んで。" +
      fakeTurn({
        tools: [
          { server: MODULE, name: "askHuman", args: { what: "A" } },
          { server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 150] 長い仕事", runInBackground: true } },
        ],
      }),
  );
  await composer.press("Enter");
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
    }
    await expect(page.getByText(/待たずに頼みました/)).toHaveCount(1, { timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await expect.poll(assistantCount, { timeout: 60_000, message: "最初のターンが終わらない" }).toBe(1);

  await expect(humanLine, "人を待つ行が出ない").toHaveText("試験の承認：A", { timeout: 30_000 });
  await expect(workLine, "裏の仕事の行が、人を待つ行に隠れた").toHaveText("fake に頼んだ仕事");
  // 人の番の色（受信箱のバッジと同じ役色）——裏の仕事の行とは違う色
  const colorOf = (l: typeof humanLine) => l.evaluate((el) => getComputedStyle(el).color);
  const turnColor = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "text-turn";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(await colorOf(humanLine), "人を待つ行が人の番の色でない").toBe(turnColor);
  expect(await colorOf(workLine)).not.toBe(turnColor);

  // ---- 3. もう1つ人を待つ ----------------------------------------------------------------------------
  await composer.fill("もう1つ承認を頼んで。" + fakeTurn({ tools: [{ server: MODULE, name: "askHuman", args: { what: "B" } }] }));
  await composer.press("Enter");
  await expect.poll(assistantCount, { timeout: 60_000 }).toBe(2);
  await expect(humanLine).toHaveText("あなたの答えを待っています（2 件）", { timeout: 30_000 });
  await expect(workLine).toHaveText("fake に頼んだ仕事");
  await humanLine.click();
  const sections = list.locator("section");
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).toHaveAttribute("data-kind", "human");
  await expect(sections.nth(0)).toContainText("あなたの答えを待っているもの（2）");
  await expect(sections.nth(0).getByTestId("background-item")).toHaveCount(2);
  await expect(sections.nth(0)).toContainText("試験の承認：A");
  await expect(sections.nth(0)).toContainText("試験の承認：B");
  await expect(sections.nth(0)).toContainText(new RegExp(`${MODULE}・(いま|\\d+分前)から待っています`));
  await expect(sections.nth(1)).toHaveAttribute("data-kind", "work");
  await expect(sections.nth(1)).toContainText("バックグラウンドで動いているもの（1）");
  await expect(sections.nth(1)).toContainText("[slow 150] 長い仕事");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();

  // ---- 4. 別の Project から見る ----------------------------------------------------------------------
  await createProject(page, OTHER_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-waiting-other-")));
  const badge = sidebar.getByTestId("project-background");
  await expect(badge).toHaveCount(1, { timeout: 30_000 });
  await expect(badge).toHaveText("3");
  await expect(badge, "人を待つものがあるのに、人の番の色でない").toHaveAttribute("data-human", "");
  await badge.click();
  await expect(list.locator("section")).toHaveCount(2);
  await expect(list).toContainText("あなたの答えを待っているもの（2）");
  await expect(list).toContainText("Base Thread");
  // 1件を押すと、その Thread へ移る（画面を持たない tool なので Canvas は開かない）
  await list.locator('section[data-kind="human"]').getByTestId("background-item").first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${project.id}$`));
  await expect(humanLine).toHaveText("あなたの答えを待っています（2 件）");

  // ---- 5. Module を外すと、人を待つ行が消える（裏の仕事は残る） ------------------------------------------------
  const removed = await page.request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
  expect(removed.status()).toBeLessThan(400);
  await expect(humanLine, "Module を外しても人を待つ行が残っている").toHaveCount(0, { timeout: 60_000 });
  await expect(workLine).toHaveText("fake に頼んだ仕事");

  // 裏の仕事も終われば消える。そのあと、この試験が出させたお知らせを片づける（後の spec の受信箱の数を狂わせない）
  await expect(workLine, "裏の仕事が終わったのに行が残っている").toHaveCount(0, { timeout: 180_000 });
  type InboxItem = { id: string; kind: string; projectId?: string; threadId?: string };
  const inbox = async () => (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as InboxItem[];
  for (const item of (await inbox()).filter((i) => i.kind === "notice" && (i.projectId === project.id || i.threadId === threadId))) {
    await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
  }

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});
