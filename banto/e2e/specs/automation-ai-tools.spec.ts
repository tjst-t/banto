// **AI が自動化を作る tool と、必ず人に聞くカード**（アーキ仕様 §4.3「人と AI の作り方」・v4-frontend.md §6.42
// 「AI が作るときのカード」、Backlog #319）。
//
// 見ること（画面と host の記録で）：
//   1. Project の「承認をすべて自動で許可する」がオンでも、AI が create_automation を呼ぶと会話に確認のカードが出る
//      （「この自動化を作ってよいですか」・名前・いつ・指示・何が起きるか、「作る」「作らない」）
//   2. 「作る」を押すとでき（作った人は AI と頼まれた会話）、専用の Fork が立つ。カードは「回答：作る」
//   3. 「作らない」を押すとできない（台帳は増えない）。AI には断られたと返る
//   4. 一覧・一時停止は聞かない（カードが増えない）。一時停止は台帳に効く
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const PROJECT_NAME = "E2E Automation AI Tools";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Automation = {
  id: string;
  name: string;
  paused: boolean;
  createdBy: { kind: string; threadId?: string };
  target: { kind: string; threadId?: string };
};

const SOURCE = { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" };

test("「すべて自動で許可」がオンでも AI の create_automation はカードで聞き、許すとでき、断るとできない。一覧・一時停止は聞かない", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-automation-ai-")));
  const projectId = currentProjectId(page);
  const api = `${CORE_BASE_URL}/api/projects/${projectId}/automations`;
  const automations = async () => ((await (await page.request.get(api, { headers })).json()) as { automations: Automation[] }).automations;
  const baseId = (
    (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as Array<{ id: string; kind: string }>
  ).find((t) => t.kind === "base")!.id;

  // 「承認をすべて自動で許可する」をオンにする（真実は host）
  const on = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } });
  expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId("composer-auto-approve-badge")).toHaveText("自動で許可中", { timeout: 30_000 });

  const composer = page.getByPlaceholder(/に送る/);
  const cards = page.locator('[data-role="judgment-card"]');

  // ---- 1・2. 作る：カードが出て、「作る」でできる ----------------------------------------------------------------
  await composer.fill(
    "平日の朝にコミットをまとめる自動化を作って。" +
      fakeTurn({
        tools: [
          {
            server: "banto-thread",
            name: "create_automation",
            args: { name: "毎朝のまとめ", instruction: "昨日からのコミットをまとめてください。", source: SOURCE },
          },
        ],
        then: "作る件、お返事をいただきました。",
      }),
  );
  await composer.press("Enter");
  const createCard = cards.filter({ hasText: "この自動化を作ってよいですか" });
  await expect(createCard, "自動で許可がオンなのに、作るときのカードが出ない").toHaveCount(1, { timeout: 60_000 });
  // カードが提示している中身（規則14）
  await expect(createCard).toContainText("毎朝のまとめ");
  await expect(createCard).toContainText("平日 9:00（Asia/Tokyo）");
  await expect(createCard).toContainText("昨日からのコミットをまとめてください。");
  await expect(createCard).toContainText("「毎朝のまとめ」という名前の Fork が立ち");
  await expect(createCard.getByRole("button", { name: "作る", exact: true })).toBeVisible();
  await expect(createCard.getByRole("button", { name: "作らない", exact: true })).toBeVisible();
  // 答える前には無い
  expect(await automations(), "人が答える前に作っている").toEqual([]);

  await createCard.getByRole("button", { name: "作る", exact: true }).click();
  await expect(createCard).toContainText("回答：作る", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 1, 60_000);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "作る件、お返事をいただきました。" })).toBeVisible({ timeout: 30_000 });
  const afterCreate = await automations();
  expect(afterCreate.map((a) => a.name)).toEqual(["毎朝のまとめ"]);
  const created = afterCreate[0]!;
  expect(created.createdBy).toEqual({ kind: "ai", threadId: baseId });
  expect(created.target.kind).toBe("dedicated");
  expect(created.target.threadId, "作ったのに専用の Fork が立っていない").toBeTruthy();
  const fork = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${created.target.threadId}`, { headers })).json()) as {
    kind: string;
    title?: string;
  };
  expect(fork).toMatchObject({ kind: "fork", title: "毎朝のまとめ" });

  // ---- 3. 作らない：できない ----------------------------------------------------------------------------------
  await composer.fill(
    "夕方にもまとめる自動化を作って。" +
      fakeTurn({
        tools: [
          {
            server: "banto-thread",
            name: "create_automation",
            args: { name: "夕方のまとめ", instruction: "今日のコミットをまとめてください。", source: SOURCE },
          },
        ],
        then: "夕方の件、お返事をいただきました。",
      }),
  );
  await composer.press("Enter");
  const denyCard = cards.filter({ hasText: "夕方のまとめ" });
  await expect(denyCard, "2回目の作るときのカードが出ない").toHaveCount(1, { timeout: 60_000 });
  await expect(denyCard).toContainText("この自動化を作ってよいですか");
  await denyCard.getByRole("button", { name: "作らない", exact: true }).click();
  await expect(denyCard).toContainText("回答：作らない", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 2, 60_000);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "夕方の件、お返事をいただきました。" })).toBeVisible({ timeout: 30_000 });
  expect((await automations()).map((a) => a.name), "断ったのに作った").toEqual(["毎朝のまとめ"]);

  // ---- 4. 一覧・一時停止は聞かない ---------------------------------------------------------------------------
  await composer.fill(
    "自動化を確かめて止めて。" +
      fakeTurn({
        tools: [
          { server: "banto-thread", name: "list_automations" },
          { server: "banto-thread", name: "pause_automation", args: { id: created.id } },
        ],
        then: "一覧を見て、止めました。",
      }),
  );
  await composer.press("Enter");
  await waitTurnEnded(page, baseId, 3, 60_000);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "一覧を見て、止めました。" })).toBeVisible({ timeout: 30_000 });
  await expect(cards, "一覧・一時停止でカードが出た").toHaveCount(2);
  expect((await automations()).find((a) => a.id === created.id)?.paused, "一時停止が台帳に効いていない").toBe(true);

  // 受信箱に未解決の判断待ちは残らない
  const open = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ id: string; kind: string }>;
  expect(open.filter((i) => i.kind === "judgment"), "受信箱に未解決の判断待ちが残っている").toHaveLength(0);
  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);

  // 後の spec に受信箱を持ち越さない
  for (const item of open) {
    if (item.kind === "notice" || item.kind === "review") {
      await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
    }
  }
  await page.request.delete(`${api}/${created.id}`, { headers });
});
