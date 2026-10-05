// **サブエージェントに待たずに頼み、終わったら会話に届いて AI が起きる**（決定・2026-09-25、アーキ仕様 §4.1・§4.2）。
//
// 見るもの（規則14——押せたで終わらせず、画面に出る中身まで）：
//   1. 待たずに頼むと、最初のターンはすぐ終わる（仕事はまだ走っている）
//   2. 仕事が終わると、**開いたままの画面に**届いたものが出る（リロードしない）——人の吹き出しではなく
//      「subagent から届きました」の札で、題と返答が読める。AI が起きて、届いたものを読んで続きを返す
//   3. host の記録では、届いたものは送り手の印（origin）つきで、ホップ 1
//   4. 受信箱に「終わりました」の知らせが出る
//   5. リロードしても、届いたものは札で出る（人の発言は1件のまま）。中身を開ける
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, openApp, fakeTurn, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const PROJECT_NAME = "E2E Subagent Background";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };
const TITLE = "Fake Agent（試験用） の仕事が終わりました";

interface HostMessage {
  role: string;
  text: string;
  origin?: { from: string; title: string; hop: number; deliveryId: string };
}

async function hostMessages(page: Page, threadId: string): Promise<HostMessage[]> {
  return ((await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { messages: HostMessage[] })
    .messages;
}

test("待たずに頼んだ仕事は、終わると開いたままの会話に届き、AI が起きて続きをやる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-bg-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  await waitForProjectModule(page, PROJECT_NAME, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === PROJECT_NAME)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const assistantCount = async () => (await hostMessages(page, threadId)).filter((m) => m.role === "assistant").length;

  // ---- 1. 待たずに頼む ----------------------------------------------------------------------------
  // サブエージェントへの頼みに「〜と返して」を入れておく——届いた結果を読んだ AI（偽 Runner）がその語で返す
  // ＝**届いたものが AI に渡った**ことが、返事の中身で分かる
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "サブエージェントに待たずに頼んで。" +
      fakeTurn({
        tools: [
          {
            server: "subagent",
            name: "runSubagent",
            args: { agent: "fake", prompt: "[slow 4] 「届いた結果を読みました」と返して", runInBackground: true },
          },
        ],
      }),
  );
  await composer.press("Enter");
  // 鍵を使うエージェントは初回に Vault の在りかを聞く（Project ごとに1回）——**呼び出しの中で**聞かれる
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
    }
    await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await expect.poll(assistantCount, { timeout: 60_000, message: "最初のターンが終わらない" }).toBe(1);
  // 最初のターンが終わった時点では、まだ何も届いていない（仕事は走っている）
  expect((await hostMessages(page, threadId)).some((m) => m.origin), "待たずに頼んだのに、もう届いている").toBe(false);

  // ---- 2. 届いて、開いたままの画面に出る（リロードしない）----------------------------------------------
  const card = page.getByTestId("delivered-message");
  await expect(card, "届いたものが、開いたままの画面に出ない").toBeVisible({ timeout: 90_000 });
  await expect(card).toHaveAttribute("data-from", "subagent");
  await expect(card).toContainText("subagent から届きました");
  await expect(card.getByTestId("delivered-title")).toHaveText(TITLE);
  await expect(card.getByTestId("delivered-summary")).toContainText("受け取った：[slow 4] 「届いた結果を読みました」と返して");
  // AI が起きて、届いたものを読んで返した（2ターン目）
  await expect.poll(assistantCount, { timeout: 90_000, message: "届いたのに AI が起きない" }).toBe(2);
  // 2ターン目の返事は、届いた中身から語を拾っている（偽 Runner は「〜と返して」の語を返す）
  const replies = (await hostMessages(page, threadId)).filter((m) => m.role === "assistant");
  expect(replies[1]!.text, "AI が届いたものを読んでいない").toContain("届いた結果を読みました");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("届いた結果を読みました", { timeout: 30_000 });

  // ---- 3. host の記録：送り手の印つき・ホップ 1・人の発言は1件 --------------------------------------------
  const messages = await hostMessages(page, threadId);
  const delivered = messages.filter((m) => m.origin);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.role).toBe("user");
  expect(delivered[0]!.origin).toMatchObject({ from: "subagent", title: TITLE, hop: 1 });
  const body = JSON.parse(delivered[0]!.text) as { runId: string; stopReason: string };
  expect(body.stopReason).toBe("end_turn");
  expect(body.runId).toMatch(/.+/);
  expect(messages.filter((m) => m.role === "user" && !m.origin), "人の発言が増えている").toHaveLength(1);
  // 順番：人の発言 → 1ターン目の返事 → 届いたもの → 2ターン目の返事
  expect(messages.map((m) => (m.origin ? "delivered" : m.role))).toEqual(["user", "assistant", "delivered", "assistant"]);

  // ---- 4. 受信箱に知らせ ---------------------------------------------------------------------------
  await page.getByRole("button", { name: "受信箱" }).click();
  const notice = page.getByTestId("inbox-notice").filter({ hasText: TITLE });
  await expect(notice, "終わったことが受信箱に出ない").toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("AI が続きをやります");
  // 閉じたことを確かめてから先へ（開いたままだと会話の側が隠れて押せない）
  const inboxDialog = page.getByRole("dialog", { name: "受信箱" });
  await inboxDialog.getByRole("button", { name: "Close" }).click();
  await expect(inboxDialog).toBeHidden();

  // ---- 5. リロードしても札のまま。中身を開ける ------------------------------------------------------------
  await page.reload();
  const again = page.getByTestId("delivered-message");
  await expect(again).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-role="user"]'), "届いたものが人の吹き出しで出ている").toHaveCount(1);
  await expect(again.getByTestId("delivered-body")).toHaveCount(0);
  await again.getByRole("button", { name: "届いた中身をすべて見る" }).click();
  await expect(again.getByTestId("delivered-body")).toContainText(body.runId);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
});

// **返事待ちのまま Module が止まったら、host が代わりに知らせる**（決定・2026-09-25、アーキ仕様 §4.2「返事待ちの札は
// 失くさない」）。AI は来ない返事を待ち続けない。Module を止める引き金は「中で Docker を使う」の切り替え
// （その Project の Module を立て直す）——人の操作で Module が止まる、ふつうの場面
test("返事を待っているうちに Module が止まったら、「途中で終わりました」が届いて AI が起きる", async ({ page }) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-subagent-bg-lost-"));
  const name = "E2E Subagent Background Lost";
  await openApp(page);
  await createProject(page, name, projectRoot);
  await waitForProjectModule(page, name, "subagent");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  const project = projects.find((p) => p.name === name)!;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${project.id}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const assistantCount = async () => (await hostMessages(page, threadId)).filter((m) => m.role === "assistant").length;

  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill(
    "長い仕事を待たずに頼んで。" +
      fakeTurn({ tools: [{ server: "subagent", name: "runSubagent", args: { agent: "fake", prompt: "[slow 120] 終わらない仕事", runInBackground: true } }] }),
  );
  await composer.press("Enter");
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) {
      await allow.last().click();
    }
    await expect(page.getByText(/待たずに頼みました/).first()).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 120_000 });
  await waitTurnEnded(page, threadId, 1);

  // Module を止める（その Project の Module を立て直す操作）
  const res = await page.request.put(`${CORE_BASE_URL}/api/projects/${project.id}/container`, { headers, data: { nesting: true } });
  expect(res.ok()).toBe(true);

  // host が代わりに届け、AI が起きる
  await expect(page.getByTestId("delivered-message"), "Module が止まったのに、何も届かない").toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("delivered-title")).toHaveText("subagent の仕事は途中で終わりました");
  await expect(page.getByTestId("delivered-summary")).toContainText("Module が止まったため");
  await expect.poll(assistantCount, { timeout: 90_000, message: "届いたのに AI が起きない" }).toBe(2);
  const delivered = (await hostMessages(page, threadId)).filter((m) => m.origin);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.origin).toMatchObject({ from: "subagent", hop: 1 });
  // 返事待ちは済んだ（二重に届けない）
  const thread = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as { awaitingReplies?: unknown[] };
  expect(thread.awaitingReplies ?? []).toEqual([]);
});
