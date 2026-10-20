// **見回り**（アーキ仕様 §4.4「見回り」・v4-frontend.md §6.47・§6.41、Backlog #423）。
//
// 1つの Project で、見ること（画面と host の記録で、規則14）：
//   1. 自動化の画面で種類「見回り」を選ぶと、届け先は「専用の Fork・毎回まっさら」に決まり、「終わったら受信箱に出す」は出ず、
//      1日の気づきの上限の欄が出る。作ると「見回り」の札・専用の Fork は読むだけの印つき
//   2. 「今すぐ動かす」で見回りの回が notify で気づきを出す。その回で読むだけでない tool（Shell の runCommand）は断られ、
//      何も変えない。見回りの回そのものは受信箱に出ない。見回りの Fork を開くと帯が出る
//   3. 受信箱の「気づき」：見出し・急ぎ・題・気づいたこと・根拠（banto の場所だけリンク、ほかは文字のまま）・やるならこう・注記。
//      バッジには数えない
//   4. もう一度動かしても、同じ key は出し直さない（手帳の最後に見た時刻だけ進む）。手帳は自動化の画面に出る
//   5. 「やって」：新しい Fork（名前は気づきの題）に、人の文と「見回り〈名前〉の気づきの引用」が届き、気づきは受信箱から外れる
//   6. 「任務にする」：新しい Fork で任務が始まる（枠はカードの欄の値）
//   7. 「今後知らせない」「片づけた」は手帳に残り、次の回では出さない。手帳の「外す」で「知らせない」を外せる
//   8. 見回りを消したあと、その Fork に人が打っても読むだけで動く（帯も残る）
import { test, expect, type Page } from "../test-base.js";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, openPaletteEntry, openToolCards, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.setTimeout(420_000);

const PROJECT_NAME = "E2E Patrol";
const PATROL_NAME = "CI の見回り";
const REFUSAL = "見回りの回では使えません（読むだけの tool だけ使えます）";
const FIRST = { key: "ci-red", title: "main の CI が2回続けて落ちています", finding: "lint のジョブが2回続けて落ちています。", suggestion: "lint の設定を見直す" };
const SECOND = { key: "pr-stale", title: "PR #12 が3日動いていません", finding: "レビュー待ちのまま3日経っています。" };
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Note = { key: string; title: string; status: string; lastSeenAt: string; notifiedAt?: string };
type Automation = {
  id: string;
  name: string;
  mode?: string;
  reviewOnDone: boolean;
  dailyFindingLimit?: number;
  target: { kind: string; mode?: string; threadId?: string };
  runs: Array<{ runId: string; result: string; cause: string }>;
  notebook?: Note[];
};
type Finding = { id: string; kind: "finding"; key: string; title: string; threadId: string; patrol: { id: string; name: string } };
type InboxItem = { id: string; kind: string; threadId?: string } | Finding;

/** その会話の tool のカード（畳まれた「N tool calls」を開き、カードも開いてから中身を見る） */
async function toolCard(page: Page, toolName: string) {
  const groups = page.getByRole("button", { name: /tool calls?$/, expanded: false });
  for (let i = 0; i < 10 && (await groups.count()) > 0; i++) await groups.first().click();
  await openToolCards(page, toolName);
  return page.locator('[data-slot="tool-fallback-root"]').filter({ has: page.getByRole("button", { name: `Used tool: ${toolName}` }) });
}

test("見回り：notify で気づきを出し、同じ key は出し直さず、読むだけでない tool は断られ、受信箱の「やって」「任務にする」でつなぐ", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const get = async <T,>(path: string) => (await (await page.request.get(`${CORE_BASE_URL}${path}`, { headers })).json()) as T;

  const root = mkdtempSync(join(tmpdir(), "banto-e2e-patrol-"));
  writeFileSync(join(root, "README.md"), "見回りの試験\n");
  await openApp(page);
  await createProject(page, PROJECT_NAME, root);
  const projectId = currentProjectId(page);
  await waitForProjectModule(page, PROJECT_NAME, "shell");
  const origin = new URL(page.url()).origin;
  const automations = async () => (await get<{ automations: Automation[] }>(`/api/projects/${projectId}/automations`)).automations;
  const patrol = async () => (await automations()).find((a) => a.name === PATROL_NAME)!;
  const findings = async () => (await get<InboxItem[]>("/api/inbox")).filter((i): i is Finding => i.kind === "finding");
  const runsDone = async (n: number) =>
    expect
      .poll(async () => (await patrol()).runs.filter((r) => r.result !== "running").map((r) => r.result), {
        timeout: 90_000,
        message: `見回りの ${n} 回目が終わらない`,
      })
      .toHaveLength(n);
  // 見回りの指示（偽の Runner への指示を入れる）。根拠には banto の場所と外の URL を混ぜる
  const firstPlan = fakeTurn({
    tools: [
      {
        server: "banto-thread",
        name: "notify",
        args: { ...FIRST, evidence: `https://evil.example.com/ci?leak=secret と ${origin}/p/${projectId}?fork=x#y`, urgent: true },
      },
      { server: "shell", name: "runCommand", args: { command: "touch patrol-marker.txt" } },
    ],
    then: "見回りおわり。",
  });

  // ---- 1. 自動化の画面で見回りを作る ----------------------------------------------------------------------------
  await openPaletteEntry(page, /^自動化/);
  await expect(page.getByTestId("automations")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("automation-add").click();
  const form = page.getByTestId("automation-form");
  await form.getByTestId("automation-mode-patrol").click();
  await expect(form.getByTestId("automation-patrol-target")).toContainText("専用の Fork・毎回まっさら");
  await expect(form.getByLabel("終わったら受信箱に出す"), "見回りに「終わったら受信箱に出す」が出ている").toHaveCount(0);
  await expect(form.getByTestId("automation-daily-limit")).toHaveValue("10");
  await expect(form.getByLabel("毎回届ける指示")).toHaveAttribute("placeholder", /何を見るか/);
  // 時計がこの試験の間に動かない時刻（12時間後、UTC）
  const at = new Date(Date.now() + 12 * 3_600_000);
  await form.getByTestId("automation-when-daily").click();
  await form.getByTestId("automation-time").fill(`${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`);
  await form.getByRole("combobox", { name: "タイムゾーン" }).click();
  await page.getByRole("option", { name: /（UTC）$/ }).click();
  await form.getByTestId("automation-daily-limit").fill("8");
  await form.getByLabel("毎回届ける指示").fill("main の CI を見て、落ちていたら知らせて。" + firstPlan);
  await form.getByLabel("名前").fill(PATROL_NAME);
  await form.getByTestId("automation-submit").click();
  await expect(form, "足したのにフォームが閉じない").toBeHidden({ timeout: 15_000 });

  const created = await patrol();
  expect(created).toMatchObject({ mode: "patrol", reviewOnDone: false, dailyFindingLimit: 8, target: { kind: "dedicated", mode: "fresh" } });
  const forkId = created.target.threadId!;
  expect((await get<{ restriction?: string }>(`/api/threads/${forkId}`)).restriction, "見回りの Fork に読むだけの印が無い").toBe("read-only");
  const row = page.getByTestId("automation-row").filter({ hasText: PATROL_NAME });
  await expect(row.getByTestId("automation-patrol-badge")).toHaveText("見回り");

  // ---- 2. 今すぐ動かす：気づきが出て、runCommand は断られる ------------------------------------------------------
  await row.getByRole("button", { name: PATROL_NAME }).click();
  const details = row.getByTestId("automation-details");
  await expect(details.getByTestId("automation-review-policy")).toContainText("見回りの回は出しません");
  await expect(details.getByTestId("patrol-notebook-empty")).toBeVisible();
  await details.getByTestId("automation-run-now").click();
  await runsDone(1);
  expect((await patrol()).runs[0]!.result).toBe("done");
  await expect.poll(async () => (await findings()).map((f) => f.key), { message: "気づきが受信箱に出ない" }).toEqual([FIRST.key]);
  expect(existsSync(join(root, "patrol-marker.txt")), "見回りの回で runCommand が走った").toBe(false);
  const inbox = await get<InboxItem[]>("/api/inbox");
  expect(inbox.filter((i) => i.kind === "review" && i.threadId === forkId), "見回りの回が返ってきた会話として出た").toEqual([]);
  expect(inbox.filter((i) => i.kind === "judgment"), "見回りの回で判断待ちが出た").toEqual([]);

  // 見回りの Fork を開く：帯と、断った tool のカード
  await page.goto(`/p/${projectId}?fork=${forkId}`);
  await expect(page.getByTestId("patrol-thread-band")).toHaveText("見回りの会話です。ここで頼んだことも読むだけで動きます", { timeout: 30_000 });
  await expect(page.getByTestId("automation-band")).toContainText(`見回り「${PATROL_NAME}」で動く会話です`);
  await expect(await toolCard(page, "mcp__shell__runCommand")).toContainText(REFUSAL);
  await expect(await toolCard(page, "mcp__banto-thread__notify")).toContainText("受信箱に気づき");

  // ---- 3. 受信箱の気づきのカード ------------------------------------------------------------------------------
  await page.goto(`/p/${projectId}?overlay=inbox`);
  // バッジには数えない（ほかに人の番のものは無い）
  await expect(page.getByRole("button", { name: /^受信箱（/ })).toHaveCount(0);
  const section = page.getByTestId("inbox-section-finding");
  await expect(section.locator("h2")).toContainText("見回りの気づき", { timeout: 30_000 });
  const card = section.getByTestId("inbox-finding");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("inbox-finding-heading")).toHaveText(`気づき · 見回り〈${PATROL_NAME}〉`);
  await expect(card.getByTestId("inbox-finding-urgent")).toHaveText("急ぎ");
  await expect(card.getByTestId("inbox-finding-title")).toHaveText(FIRST.title);
  await expect(card.getByTestId("inbox-finding-finding")).toHaveText(FIRST.finding);
  await expect(card.getByTestId("inbox-finding-suggestion")).toHaveText(FIRST.suggestion);
  await expect(card.getByTestId("inbox-finding-caution")).toContainText("外から来た文を読んだ見回りが書いたものです");
  // 根拠：banto の場所だけリンク（クエリと # は落とす）、外の URL は文字のまま
  const evidence = card.getByTestId("inbox-finding-evidence");
  await expect(evidence.getByTestId("finding-link")).toHaveCount(1);
  await expect(evidence.getByTestId("finding-link")).toHaveAttribute("href", `${origin}/p/${projectId}`);
  await expect(evidence.getByTestId("finding-unlinked-url")).toHaveText("https://evil.example.com/ci?leak=secret");
  await expect(evidence.locator("a")).toHaveCount(1);
  await expect(card.getByTestId("inbox-card-thread")).toHaveText(PATROL_NAME);

  // ---- 4. もう一度動かす：同じ key は出し直さない -----------------------------------------------------------------
  const noted = (await patrol()).notebook!.find((n) => n.key === FIRST.key)!;
  expect(noted).toMatchObject({ title: FIRST.title, status: "notified" });
  const run2 = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}/run`, { headers });
  expect(run2.status(), await run2.text()).toBe(202);
  await runsDone(2);
  const renoted = (await patrol()).notebook!.find((n) => n.key === FIRST.key)!;
  expect(renoted.lastSeenAt > noted.lastSeenAt, "同じ key を見たのに最後に見た時刻が進まない").toBe(true);
  expect(renoted.notifiedAt).toBe(noted.notifiedAt);
  expect((await findings()).map((f) => f.key), "同じ key を出し直した").toEqual([FIRST.key]);
  await expect(card).toHaveCount(1);

  // ---- 5. 「やって」：新しい Fork に引用つきで届く ---------------------------------------------------------------
  const DO_REPLY = "気づきを読みました。直します。";
  await card.getByTestId("inbox-finding-do").click();
  const compose = card.getByTestId("inbox-finding-compose");
  await expect(compose.getByTestId("inbox-finding-dest-fork")).toBeChecked();
  await expect(compose.getByTestId("inbox-finding-prompt")).toHaveValue(`見回り〈${PATROL_NAME}〉の気づきについて、対応してください。`);
  await compose.getByTestId("inbox-finding-prompt").fill("CI を直して。" + fakeTurn({ say: DO_REPLY }));
  await compose.getByTestId("inbox-finding-send").click();
  await expect(card.getByTestId("inbox-sent"), "送ったあとの表示が出ない").toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await findings()).length, { message: "送った気づきが受信箱に残っている" }).toBe(0);
  type Thread = { id: string; kind: string; title?: string; restriction?: string };
  const threads = async () => get<Thread[]>(`/api/projects/${projectId}/threads`);
  const doFork = (await threads()).find((t) => t.title === FIRST.title)!;
  expect(doFork, "気づきの題の Fork が立っていない").toBeTruthy();
  expect(doFork.restriction, "「やって」の Fork が読むだけになっている").toBeUndefined();
  const done = await waitTurnEnded(page, doFork.id, 1, 60_000);
  const asked = (done.messages as Array<{ role: string; text: string; quotes?: Array<{ patrol?: string; text: string; thirdParty: boolean }> }>).find(
    (m) => m.role === "user",
  )!;
  expect(asked.text).toContain("CI を直して。");
  expect(asked.quotes).toHaveLength(1);
  expect(asked.quotes![0]).toMatchObject({ patrol: PATROL_NAME, thirdParty: true });
  expect(asked.quotes![0]!.text).toContain(`題：${FIRST.title}`);
  expect(asked.quotes![0]!.text).toContain(`気づいたこと：${FIRST.finding}`);
  expect(done.messages.some((m) => m.role === "assistant" && m.text === DO_REPLY)).toBe(true);
  // 会話の画面にも出所つきの引用として出る
  await page.goto(`/p/${projectId}?fork=${doFork.id}`);
  await expect(page.getByTestId("canvas-quote-source")).toHaveText(`見回り〈${PATROL_NAME}〉の気づきの引用`, { timeout: 30_000 });
  await expect(page.getByTestId("patrol-thread-band")).toHaveCount(0);

  // ---- 6. 「任務にする」：新しい Fork で任務が始まる -------------------------------------------------------------
  const secondPlan = fakeTurn({ tools: [{ server: "banto-thread", name: "notify", args: SECOND }], then: "見回りおわり。" });
  const patched = await page.request.patch(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}`, {
    headers,
    data: { instruction: "開いている PR を見て。" + secondPlan },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  expect((await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}/run`, { headers })).status()).toBe(202);
  await runsDone(3);
  await expect.poll(async () => (await findings()).map((f) => f.key)).toEqual([SECOND.key]);
  await page.goto(`/p/${projectId}?overlay=inbox`);
  const card2 = page.getByTestId("inbox-section-finding").getByTestId("inbox-finding");
  await expect(card2.getByTestId("inbox-finding-title")).toHaveText(SECOND.title, { timeout: 30_000 });
  await expect(card2.getByTestId("inbox-finding-urgent")).toHaveCount(0);
  await card2.getByTestId("inbox-finding-mission").click();
  const compose2 = card2.getByTestId("inbox-finding-compose");
  await expect(compose2.getByTestId("inbox-finding-frame-maxWakes")).toHaveValue("20");
  await expect(compose2.getByTestId("inbox-finding-frame-untilDays")).toHaveValue("3");
  await expect(compose2.getByTestId("inbox-finding-frame-minInterval")).toHaveValue("15");
  await compose2.getByTestId("inbox-finding-frame-maxWakes").fill("5");
  await compose2
    .getByTestId("inbox-finding-prompt")
    .fill(
      "PR を見ていて。" +
        fakeTurn({ say: "任務として見ていきます。", tools: [{ server: "banto-thread", name: "schedule_followup", args: { after: 60, note: "PR を見直す" } }] }),
    );
  await compose2.getByTestId("inbox-finding-send").click();
  await expect(card2.getByTestId("inbox-sent")).toBeVisible({ timeout: 30_000 });
  const missionFork = (await threads()).find((t) => t.title === SECOND.title)!;
  expect(missionFork, "「任務にする」の Fork が立っていない").toBeTruthy();
  await waitTurnEnded(page, missionFork.id, 1, 60_000);
  type Mission = { status: string; goal: string; frame: { maxWakes: number }; followup?: { note: string } };
  const mission = (await get<{ mission: Mission | null }>(`/api/threads/${missionFork.id}/mission`)).mission;
  expect(mission, "任務が始まっていない").toMatchObject({ status: "active", goal: SECOND.title, frame: { maxWakes: 5 }, followup: { note: "PR を見直す" } });
  expect((await findings()).length).toBe(0);
  // 後の spec に任務を持ち越さない
  await page.request.patch(`${CORE_BASE_URL}/api/threads/${missionFork.id}/mission`, { headers, data: { stop: true } });

  // ---- 7. 「今後知らせない」「片づけた」は手帳に残り、次の回では出さない -----------------------------------------
  const third = fakeTurn({
    tools: [
      { server: "banto-thread", name: "notify", args: { key: "mute-me", title: "知らせなくてよいもの", finding: "毎回同じです。" } },
      { server: "banto-thread", name: "notify", args: { key: "done-me", title: "片づけたもの", finding: "直しました。" } },
    ],
    then: "見回りおわり。",
  });
  await page.request.patch(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}`, { headers, data: { instruction: "ほかも見て。" + third } });
  await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}/run`, { headers });
  await runsDone(4);
  await expect.poll(async () => (await findings()).map((f) => f.key).sort()).toEqual(["done-me", "mute-me"]);
  await page.goto(`/p/${projectId}?overlay=inbox`);
  const cards = page.getByTestId("inbox-section-finding").getByTestId("inbox-finding");
  await cards.filter({ hasText: "知らせなくてよいもの" }).getByTestId("inbox-finding-mute").click();
  await cards.filter({ hasText: "片づけたもの" }).getByTestId("inbox-finding-dismiss").click();
  await expect.poll(async () => (await findings()).length, { message: "押した気づきが受信箱に残っている" }).toBe(0);
  const statuses = async () => Object.fromEntries((await patrol()).notebook!.map((n) => [n.key, n.status]));
  expect(await statuses()).toEqual({ [FIRST.key]: "notified", [SECOND.key]: "notified", "mute-me": "muted", "done-me": "dismissed" });
  await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/automations/${created.id}/run`, { headers });
  await runsDone(5);
  expect((await findings()).length, "知らせない・片づけた key をまた出した").toBe(0);
  // 自動化の画面の手帳：状態と「外す」
  await page.goto(`/p/${projectId}`);
  await openPaletteEntry(page, /^自動化/);
  const row2 = page.getByTestId("automation-row").filter({ hasText: PATROL_NAME });
  await row2.getByRole("button", { name: PATROL_NAME }).click();
  const notes = row2.getByTestId("patrol-note");
  await expect(notes).toHaveCount(4, { timeout: 15_000 });
  await expect(notes.filter({ hasText: "mute-me" }).getByTestId("patrol-note-status")).toHaveText("知らせない");
  await expect(notes.filter({ hasText: "done-me" }).getByTestId("patrol-note-status")).toHaveText("片づけた");
  await expect(notes.filter({ hasText: FIRST.key }).getByTestId("patrol-note-status")).toHaveText("知らせた");
  await expect(notes.filter({ hasText: FIRST.key })).toContainText(FIRST.title);
  await expect(row2.getByTestId("patrol-note-unmute")).toHaveCount(1);
  await notes.filter({ hasText: "mute-me" }).getByTestId("patrol-note-unmute").click();
  await expect(notes.filter({ hasText: "mute-me" }).getByTestId("patrol-note-status")).toHaveText("知らせた");
  expect((await statuses())["mute-me"]).toBe("notified");

  // ---- 8. 見回りを消したあとも、その Fork は読むだけで動く ---------------------------------------------------------
  await row2.getByTestId("automation-remove").click();
  await row2.getByTestId("automation-remove-confirm").click();
  await expect.poll(async () => (await automations()).length, { message: "見回りが消えない" }).toBe(0);
  await page.goto(`/p/${projectId}?fork=${forkId}`);
  await expect(page.getByTestId("patrol-thread-band")).toBeVisible({ timeout: 30_000 });
  const composer = page.getByPlaceholder("この Fork Thread に送る");
  const before = (await get<{ messages: Array<{ role: string }> }>(`/api/threads/${forkId}`)).messages.filter((m) => m.role === "assistant").length;
  await composer.fill(
    "ファイルを作って。" + fakeTurn({ tools: [{ server: "shell", name: "runCommand", args: { command: "touch after-removed.txt" } }], then: "人の頼みもおわり。" }),
  );
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "人の頼みもおわり。" })).toBeVisible({ timeout: 60_000 });
  await waitTurnEnded(page, forkId, before + 1, 30_000);
  expect(existsSync(join(root, "after-removed.txt")), "見回りを消したあとの Fork で runCommand が走った").toBe(false);
  const refused = await toolCard(page, "mcp__shell__runCommand");
  await expect(refused.last()).toContainText(REFUSAL);
  expect((await get<{ restriction?: string }>(`/api/threads/${forkId}`)).restriction).toBe("read-only");
  await expect(page.locator('[data-role="judgment-card"]')).toHaveCount(0);

  expect(pageErrors, `ページ例外: ${pageErrors.join(" / ")}`).toEqual([]);
  // 後の spec に受信箱を持ち越さない
  for (const item of await get<InboxItem[]>("/api/inbox")) {
    if (item.kind === "notice" || item.kind === "review") await page.request.post(`${CORE_BASE_URL}/api/inbox/${item.id}/acknowledge`, { headers });
  }
});
