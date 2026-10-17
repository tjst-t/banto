// **AI が自動化を作る tool と、必ず人に聞くカード**（アーキ仕様 §4.3「人と AI の作り方」・v4-frontend.md §6.42
// 「AI が作るときのカード」、Backlog #319。消す remove_automation は Backlog #378）。
//
// 見ること（画面と host の記録で）：
//   1. Project の「承認をすべて自動で許可する」がオンでも、AI が create_automation を呼ぶと会話に確認のカードが出る
//      （「この自動化を作ってよいですか」・名前・いつ・指示・何が起きるか、「作る」「作らない」）
//   2. 「作る」を押すとでき（作った人は AI と頼まれた会話）、専用の Fork が立つ。カードは「回答：作る」
//   3. 「作らない」を押すとできない（台帳は増えない）。AI には断られたと返る
//   4. 一覧・一時停止は聞かない（カードが増えない）。一時停止は台帳に効く
//   5. 自動許可がオンのまま remove_automation を呼ぶとカードが出る（「この自動化を消してよいですか」・名前・きっかけ・届け先・
//      「専用の Fork とその会話は残ります」、「消す」「消さない」）。「消さない」で残り、「消す」で台帳から消える。専用の Fork は残る
//   6. ほかの Project の id・無い id は、カードを出さずに理由つきで断る（ほかの Project の自動化は残る）
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

  // ---- 5. 消す：自動許可がオンでもカードで聞く。「消さない」で残り、「消す」で消える（専用の Fork は残る） ---------------
  const removeTurn = (text: string, then: string) =>
    text + fakeTurn({ tools: [{ server: "banto-thread", name: "remove_automation", args: { id: created.id } }], then });
  await composer.fill(removeTurn("毎朝のまとめを消して。", "消す件（1回目）、お返事をいただきました。"));
  await composer.press("Enter");
  const keepCard = cards.filter({ hasText: "この自動化を消してよいですか" });
  await expect(keepCard, "自動で許可がオンなのに、消すときのカードが出ない").toHaveCount(1, { timeout: 60_000 });
  // カードが提示している中身（規則14）
  await expect(keepCard).toContainText("毎朝のまとめ");
  await expect(keepCard).toContainText("平日 9:00（Asia/Tokyo）");
  await expect(keepCard).toContainText("専用の Fork で、毎回まっさらから");
  await expect(keepCard).toContainText("専用の Fork とその会話は残ります（要らなければ Fork を閉じてください）");
  await expect(keepCard.getByRole("button", { name: "消す", exact: true })).toBeVisible();
  await expect(keepCard.getByRole("button", { name: "消さない", exact: true })).toBeVisible();
  await keepCard.getByRole("button", { name: "消さない", exact: true }).click();
  await expect(keepCard).toContainText("回答：消さない", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 4, 60_000);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "消す件（1回目）、お返事をいただきました。" })).toBeVisible({ timeout: 30_000 });
  expect((await automations()).map((a) => a.id), "消さないと答えたのに消えた").toEqual([created.id]);

  await composer.fill(removeTurn("やっぱり毎朝のまとめを消して。", "消す件（2回目）、お返事をいただきました。"));
  await composer.press("Enter");
  const removeCards = cards.filter({ hasText: "この自動化を消してよいですか" });
  await expect(removeCards, "2回目の消すときのカードが出ない").toHaveCount(2, { timeout: 60_000 });
  const removeCard = removeCards.nth(1);
  await expect(removeCard).toContainText("毎朝のまとめ");
  await removeCard.getByRole("button", { name: "消す", exact: true }).click();
  await expect(removeCard).toContainText("回答：消す", { timeout: 30_000 });
  await waitTurnEnded(page, baseId, 5, 60_000);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "消す件（2回目）、お返事をいただきました。" })).toBeVisible({ timeout: 30_000 });
  expect(await automations(), "消すと答えたのに台帳に残っている").toEqual([]);
  const forkAfter = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${created.target.threadId}`, { headers })).json()) as {
    kind: string;
    status: string;
  };
  expect(forkAfter, "消したら専用の Fork まで閉じた").toMatchObject({ kind: "fork", status: "active" });

  // ---- 6. ほかの Project の id・無い id は、カードを出さずに断る -----------------------------------------------------
  const otherProject = (await (
    await page.request.post(`${CORE_BASE_URL}/api/projects`, {
      headers,
      data: { name: `${PROJECT_NAME} (other)`, root: mkdtempSync(join(tmpdir(), "banto-e2e-automation-ai-other-")) },
    })
  ).json()) as { id: string };
  // 自動化は専用の Fork を Base Thread から立てる——API で作った Project には Base Thread がまだ無い
  await page.request.post(`${CORE_BASE_URL}/api/projects/${otherProject.id}/threads`, { headers });
  const otherApi = `${CORE_BASE_URL}/api/projects/${otherProject.id}/automations`;
  const otherCreated = await page.request.post(otherApi, { headers, data: { name: "よその自動化", instruction: "何かする", source: SOURCE } });
  expect(otherCreated.status(), await otherCreated.text()).toBe(201);
  const otherId = ((await otherCreated.json()) as Automation).id;
  let turn = 5;
  for (const id of [otherId, "no-such-automation"]) {
    // then を置かない——偽 Runner は最後の tool の結果をそのまま発言にするので、AI に返った断りの文が画面に出る
    await composer.fill(`${id} を消して。` + fakeTurn({ tools: [{ server: "banto-thread", name: "remove_automation", args: { id } }] }));
    await composer.press("Enter");
    turn += 1;
    await waitTurnEnded(page, baseId, turn, 60_000);
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: `この Project に自動化 ${id} はありません（list_automations で id が分かります）` }),
      `${id} の断りが AI に返っていない`,
    ).toBeVisible({ timeout: 30_000 });
  }
  await expect(cards, "断るはずの id でカードが出た").toHaveCount(4);
  const otherList = ((await (await page.request.get(otherApi, { headers })).json()) as { automations: Automation[] }).automations;
  expect(otherList.map((a) => a.id), "ほかの Project の自動化が消えた").toEqual([otherId]);
  await page.request.delete(`${otherApi}/${otherId}`, { headers });
  await page.request.post(`${CORE_BASE_URL}/api/projects/${otherProject.id}/close`, { headers });

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
});
