// **自動化の届け方**（アーキ仕様 §4.3「判断は届ける口の手前に置く」「専用の Fork」、Backlog #315）。
//
// 見ること（画面と host の記録で。自動化の画面は automation-canvas で作るので、作る・動かすは HTTP の口から）：
//   1. 作ると、自動化の名前の専用の Fork が立つ（会話を引き継がない）。動かすとサイドバーにその名前で出る
//   2. 「今すぐ動かす」で Clear してから届き、専用の Fork でターンが走る。会話には「自動化「…」」の届いたものと
//      AI の返事が出て、台帳の回は done
//   3. 人がその Fork で送ったターンが走っている間は「今すぐ動かす」を断る（Clear しない）。人の発言は会話に残る
//      ——次の回まで Clear されない（人のターンの前に Clear を挟まない）
//   4. 人が専用の Fork を閉じると、自動化は一時停止し、受信箱のお知らせは1件だけ。閉じた Fork に何回動かしても
//      届けず（skipped）、お知らせは積もらない
import { test, expect } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, AUTH_TOKEN } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, projectInbox, waitTurnEnded } from "../helpers.js";

test.setTimeout(180_000);

const PROJECT_NAME = "E2E Automation Deliver";
const AUTOMATION_NAME = "毎朝のまとめ";
const headers = { authorization: `Bearer ${AUTH_TOKEN}` };

type Run = { runId: string; result: string; reason?: string; threadId?: string; cause: string };
type Automation = { id: string; paused: boolean; pausedReason?: string; target: { kind: string; threadId?: string }; runs: Run[] };
type ThreadDetail = {
  id: string;
  kind: string;
  title?: string;
  status: string;
  resumePoint?: string;
  markers: Array<{ seq: number; kind: string }>;
  messages: Array<{ seq: number; role: string; text: string; origin?: { from: string; title: string; automation?: { id: string; runId: string } } }>;
};

test("専用の Fork に Clear してから届いて走り、人のターンの間は断り、閉じたら一時停止してお知らせは1件", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-automation-")));
  const projectId = currentProjectId(page);
  const api = `${CORE_BASE_URL}/api/projects/${projectId}/automations`;
  const thread = async (id: string) => (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${id}`, { headers })).json()) as ThreadDetail;
  const automation = async (id: string) => (await (await page.request.get(`${api}/${id}`, { headers })).json()) as Automation;

  // ---- 1. 作ると専用の Fork が立つ ----------------------------------------------------------------------
  const createdRes = await page.request.post(api, {
    headers,
    data: {
      name: AUTOMATION_NAME,
      instruction: "昨日からのコミットをまとめてください。" + fakeTurn({ say: "まとめました：コミットは3件です。" }),
      source: { kind: "time", repeat: { kind: "weekdays", time: "9:00" }, timeZone: "Asia/Tokyo" },
    },
  });
  expect(createdRes.status(), await createdRes.text()).toBe(201);
  const created = (await createdRes.json()) as Automation;
  expect(created.target.kind).toBe("dedicated");
  const forkId = created.target.threadId;
  expect(forkId, "作ったのに専用の Fork が立っていない").toBeTruthy();
  const fork = await thread(forkId!);
  expect(fork.kind).toBe("fork");
  expect(fork.title).toBe(AUTOMATION_NAME);
  expect(fork.messages, "専用の Fork に Base の会話が写っている").toEqual([]);

  // ---- 2. 今すぐ動かす：Clear してから届き、専用の Fork でターンが走る ----------------------------------------
  const runRes = await page.request.post(`${api}/${created.id}/run`, { headers });
  expect(runRes.status(), await runRes.text()).toBe(202);
  const first = (await runRes.json()) as Run;
  expect(first.result).toBe("running");
  expect(first.threadId).toBe(forkId);
  const afterFirst = await waitTurnEnded(page, forkId!, 1);
  await expect
    .poll(async () => (await automation(created.id)).runs.find((r) => r.runId === first.runId)?.result, { message: "回の結末が台帳に出ない" })
    .toBe("done");
  const forkAfterFirst = await thread(forkId!);
  expect(forkAfterFirst.markers.map((m) => m.kind), "届ける前に Clear していない").toEqual(["clear"]);
  const delivered = forkAfterFirst.messages.find((m) => m.origin?.automation);
  expect(delivered?.origin).toMatchObject({ from: "banto", title: `自動化「${AUTOMATION_NAME}」`, automation: { id: created.id, runId: first.runId } });
  expect(forkAfterFirst.markers[0]!.seq).toBeLessThan(delivered!.seq);
  expect(afterFirst.messages.filter((m) => m.role === "assistant").at(-1)!.text).toContain("まとめました：コミットは3件です。");
  // 画面：開いているサイドバーに、専用の Fork が自動化の名前で出る（host が立てた Fork は、最初のターンが始まった
  // 知らせで一覧に入る——AI が立てた Fork と同じ）
  const sidebar = page.locator('[data-sidebar="sidebar"]');
  await expect(sidebar.getByTestId("sidebar-fork-name").filter({ hasText: AUTOMATION_NAME }), "サイドバーに専用の Fork が出ない").toHaveCount(1, {
    timeout: 30_000,
  });

  // 画面：専用の Fork を開くと、届いたもの（題・送り手）と AI の返事が出る
  await page.goto(`/p/${projectId}?fork=${forkId}`);
  const deliveredCard = page.locator('[data-testid="delivered-message"]').filter({ hasText: `自動化「${AUTOMATION_NAME}」` });
  await expect(deliveredCard, "届いたものが会話に出ない").toBeVisible({ timeout: 30_000 });
  await expect(deliveredCard.getByTestId("delivered-from")).toHaveText("banto から届きました");
  await expect(deliveredCard.getByTestId("delivered-title")).toHaveText(`自動化「${AUTOMATION_NAME}」`);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "まとめました：コミットは3件です。" })).toBeVisible();

  // ---- 3. 人がその Fork で送ったターンが走っている間は断る。人の発言は Clear されない -------------------------
  const composer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await composer.fill("3件の中身も教えて" + fakeTurn({ say: "中身はこうです。", streamMs: 8_000 }));
  await composer.press("Enter");
  await expect.poll(async () => (await thread(forkId!)).messages.some((m) => m.role === "user" && !m.origin && m.text.startsWith("3件の中身も教えて")), {
    message: "人の発言が記録に入らない",
  }).toBe(true);
  // 走っている間（流し終える前）に動かす
  const busy = await page.request.post(`${api}/${created.id}/run`, { headers });
  expect(busy.status(), "人のターンの間に動かせた").toBe(409);
  expect(((await busy.json()) as { error: string }).error).toMatch(/走っています/);
  await waitTurnEnded(page, forkId!, 2);
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "中身はこうです。" })).toBeVisible({ timeout: 30_000 });
  const afterHuman = await thread(forkId!);
  expect(afterHuman.markers.map((m) => m.kind), "人のターンの前後で Clear した").toEqual(["clear"]);
  // 人のターンは自動化の回の会話の続き（Clear で切っていない）
  const human = afterHuman.messages.find((m) => m.role === "user" && !m.origin)!;
  expect(human.seq).toBeGreaterThan(afterHuman.markers[0]!.seq);
  expect(afterHuman.messages.filter((m) => m.seq > afterHuman.markers[0]!.seq).map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  // 断った回は台帳に増えない（HTTP の口が前で断る）。動いた回は1つ
  expect((await automation(created.id)).runs.map((r) => r.result)).toEqual(["done"]);

  // ---- 4. 人が専用の Fork を閉じる：一時停止・お知らせ1件。閉じた Fork には届けず、お知らせも積もらない ---------
  const closeRes = await page.request.post(`${CORE_BASE_URL}/api/threads/${forkId}/close`, { headers });
  expect(closeRes.status()).toBe(200);
  const paused = await automation(created.id);
  expect(paused.paused, "専用の Fork を閉じても一時停止しない").toBe(true);
  expect(paused.pausedReason).toContain("専用の Fork");
  for (let i = 0; i < 3; i++) {
    const res = await page.request.post(`${api}/${created.id}/run`, { headers });
    expect(res.status()).toBe(202);
    const r = (await res.json()) as Run;
    expect(r.result).toBe("skipped");
    expect(r.reason).toContain("閉じられています");
  }
  const closedFork = await thread(forkId!);
  expect(closedFork.status).toBe("closed");
  expect(closedFork.messages.filter((m) => m.origin?.automation).length, "閉じた Fork に届けた").toBe(1);
  const runs = (await automation(created.id)).runs;
  expect(runs.map((r) => r.result)).toEqual(["skipped", "skipped", "skipped", "done"]);
  const notices = (await projectInbox(PROJECT_NAME)).filter((i) => i.kind === "notice");
  expect(notices.map((n) => n.title), "閉じた Fork に動かした回でお知らせが積もった").toEqual([`自動化「${AUTOMATION_NAME}」を一時停止しました`]);

  // 画面：受信箱にそのお知らせが1件だけ出る
  await openApp(page);
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const inbox = page.getByRole("dialog", { name: "受信箱" });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByTestId("inbox-notice-title").filter({ hasText: AUTOMATION_NAME }), "受信箱に一時停止のお知らせが出ない").toHaveText([
    `自動化「${AUTOMATION_NAME}」を一時停止しました`,
  ]);

  // 開き直しても自動では再開しない
  await page.request.post(`${CORE_BASE_URL}/api/threads/${forkId}/reopen`, { headers });
  expect((await automation(created.id)).paused, "Fork を開き直したら自動で再開した").toBe(true);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
