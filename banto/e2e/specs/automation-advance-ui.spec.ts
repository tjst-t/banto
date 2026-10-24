// **判断役の一般化の画面**（アーキ仕様 §4.3「判断役の一般化」、Backlog #547・#548）。
//
// 1. 作るフォーム：判断役のきっかけのときだけ「答えてよい種類で絞る」とチェックリストが出て、専用の Fork に届ける自動化には「止まった会話を
//    進める権限」が出る（見回りには出ない）。作った・直した・外した値が台帳（`delegateKinds`・`canAdvanceProject`）と行の詳しいところに一致する
// 2. 「Project の進行を自動化に任せる」：作るものを並べて人が確かめ、まとめて作る。Factory の出来事を名乗る Module が無い Project では
//    Factory の2つは作らない。作ったものは独立した自動化で、台帳の中身がテンプレートどおり
// 3. 進める自動化（canAdvanceProject）の回が、失敗したターンで止まった会話を list_stalled_threads で見つけ、instruct_thread（retry-turn）で
//    頼むと、その会話が進み、進める自動化の記録に残り、受信箱のカードに「自動化が頼んだ手順で始まりました」が出る（番頭の印は付かない）
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, FRONTEND_BASE_URL } from "../config.js";
import { createProject, currentProjectId, fakeTurn, openApp, openPaletteEntry } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(300_000);

type Automation = {
  id: string;
  name: string;
  source: Record<string, unknown>;
  target: { kind: string; mode?: string; threadId?: string };
  reviewOnDone: boolean;
  delegateKinds?: string[];
  canAdvanceProject?: boolean;
};

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

async function choose(page: Page, trigger: ReturnType<Page["getByTestId"]>, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
}

/** Project の方針の既定で任せる種類（release を除く、表の順） */
const DEFAULT_KINDS = ["continue", "retry-turn", "rerun-tests", "fix-tests", "merge", "push", "backlog", "minor-design"];

test("判断役のフォームで答えてよい種類と進める権限を選んで作る・直す・外すと、台帳と行が一致する。テンプレートで進行の自動化をまとめて作れる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async (path: string) => {
      const res = await fetch(`${host.apiUrl}${path}`, { headers });
      return (await res.json()) as Record<string, unknown>;
    };
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, "E2E 進行の自動化", mkdtempSync(join(tmpdir(), "banto-e2e-advance-ui-")));
    const projectId = currentProjectId(page);
    const automations = async () => ((await call(`/api/projects/${projectId}/automations`)).automations as Automation[]) ?? [];
    const byName = async (name: string) => (await automations()).find((a) => a.name === name);

    await openPaletteEntry(page, /^自動化/);
    const view = page.getByTestId("automations");
    await expect(view).toBeVisible({ timeout: 30_000 });

    // ---- 1. 判断役を作る：種類で絞る（merge を外す）・進める権限をオン ---------------------------------------------------------
    await view.getByTestId("automation-add").click();
    const form = view.getByTestId("automation-form");
    // 時刻のきっかけでは「答えてよい種類」は出ず、進める権限は出る
    await expect(form.getByTestId("automation-delegate-kinds")).toHaveCount(0);
    await expect(form.getByTestId("automation-advance")).toHaveAttribute("aria-checked", "false");
    // 見回りには進める権限を出さない（読むだけの回）
    await form.getByTestId("automation-mode-patrol").click();
    await expect(form.getByTestId("automation-advance")).toHaveCount(0);
    await form.getByTestId("automation-mode-normal").click();

    await form.getByTestId("automation-source-event").click();
    await choose(page, form.getByTestId("automation-event-origin"), "banto 自身");
    await choose(page, form.getByTestId("automation-event-name"), "決めることのあるターンが終わった（banto.turn-decisions）");
    const kinds = form.getByTestId("automation-delegate-kinds");
    await expect(kinds).toBeVisible();
    await expect(form.getByTestId("automation-limit-kinds")).toHaveAttribute("aria-checked", "false");
    await expect(kinds).toContainText("切っていると種類では絞りません（指示に書いた方針だけで選びます）。");
    await form.getByTestId("automation-limit-kinds").click();
    // 既定は Project の方針の既定（release は人）。人に回す種類は並ばない
    // （Switch はフォームの中で隠れた checkbox を持つので、印で数える）
    await expect(kinds.locator('input[data-testid^="automation-delegate-"]')).toHaveCount(DEFAULT_KINDS.length + 1);
    for (const k of DEFAULT_KINDS) await expect(form.getByTestId(`automation-delegate-${k}`)).toBeChecked();
    await expect(form.getByTestId("automation-delegate-release")).not.toBeChecked();
    await expect(form.getByTestId("automation-delegate-spec")).toHaveCount(0);
    await expect(kinds).toContainText("小さな設計");
    await expect(kinds).toContainText("今の仕様に収まる小さな設計の判断（画面の文言・tool の引数の形など）");
    await form.getByTestId("automation-delegate-merge").uncheck();
    await form.getByTestId("automation-advance").click();
    await expect(form.getByTestId("automation-advance")).toHaveAttribute("aria-checked", "true");
    await form.getByLabel("毎回届ける指示").fill("届いた決めることに答えて。");
    await form.getByLabel("名前", { exact: true }).fill("判断役（絞る）");
    await form.getByTestId("automation-submit").click();
    // 作るフォームが閉じるまで待つ——閉じるのは台帳を取り直したあと（行はその前に出る）。先に編集を開くと、遅れて閉じる知らせが
    // 編集のフォームまで閉じる（作る流れの既存の競合。docs/notes/2026-10-24-judge-generalization.md）
    await expect(form).toHaveCount(0, { timeout: 30_000 });

    const row = view.getByTestId("automation-row").filter({ hasText: "判断役（絞る）" });
    await expect(row, "作った判断役が一覧に出ない").toHaveCount(1, { timeout: 30_000 });
    const picked = DEFAULT_KINDS.filter((k) => k !== "merge");
    await expect.poll(async () => (await byName("判断役（絞る）"))?.delegateKinds).toEqual(picked);
    expect((await byName("判断役（絞る）"))?.canAdvanceProject).toBe(true);
    await row.getByRole("button", { name: /判断役（絞る）/ }).click();
    await expect(row.getByTestId("automation-delegate-summary")).toHaveText("続ける・やり直す・試験を流し直す・試験を直す・push・Backlog を更新・小さな設計");
    await expect(row.getByTestId("automation-advance-summary")).toHaveText("止まった会話に決まった手順を頼めます（専用の Fork で）。");

    // ---- 直す：今の値が出ていて、絞るのを切る・権限を外すと台帳から消える -------------------------------------------------------
    await row.getByTestId("automation-edit").click();
    const editForm = view.getByTestId("automation-form");
    await expect(editForm.getByTestId("automation-limit-kinds")).toHaveAttribute("aria-checked", "true");
    await expect(editForm.getByTestId("automation-delegate-merge")).not.toBeChecked();
    await expect(editForm.getByTestId("automation-delegate-continue")).toBeChecked();
    await expect(editForm.getByTestId("automation-advance")).toHaveAttribute("aria-checked", "true");
    await editForm.getByTestId("automation-limit-kinds").click();
    await editForm.getByTestId("automation-advance").click();
    await editForm.getByTestId("automation-submit").click();
    await expect(editForm).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await byName("判断役（絞る）"))?.delegateKinds ?? null).toBeNull();
    expect((await byName("判断役（絞る）"))?.canAdvanceProject).toBe(false);
    await row.getByRole("button", { name: /判断役（絞る）/ }).click();
    await expect(row.getByTestId("automation-details")).toBeVisible();
    await expect(row.getByTestId("automation-delegate-summary")).toHaveCount(0);
    await expect(row.getByTestId("automation-advance-summary")).toHaveCount(0);

    // ---- 2. 「Project の進行を自動化に任せる」 ------------------------------------------------------------------------------
    await view.getByTestId("advance-template-open").click();
    const template = view.getByTestId("advance-template");
    await expect(template).toBeVisible();
    // Factory の Module が無い Project では、Factory の2つは並べずに理由を出す
    await expect(template.locator('input[data-testid^="advance-template-item-"]')).toHaveCount(2);
    await expect(template.getByTestId("advance-template-item-decisions")).toBeChecked();
    await expect(template.getByTestId("advance-template-item-patrol")).toBeChecked();
    await expect(template).toContainText("進行：決めること");
    await expect(template).toContainText("進行：止まった会話の見回り");
    await expect(template).toContainText("3 時間ごと：止まっている会話に任された決まった手順を頼み");
    await expect(template.getByTestId("advance-template-missing")).toHaveText(
      "この Project では Factory の出来事を待てないので、「進行：Factory の件が止まった」・「進行：Factory の実行が終わった」は作りません。",
    );
    await expect(template.getByTestId("advance-template-create")).toHaveText("まとめて作る（2 件）");
    await template.getByTestId("advance-template-create").click();
    await expect(view.getByTestId("advance-template-result")).toHaveText("作りました：進行：決めること・進行：止まった会話の見回り。", { timeout: 30_000 });
    await expect(view.getByTestId("advance-template")).toHaveCount(0);

    // 一覧に1件ずつの自動化として出て、台帳の中身がテンプレートどおり
    await expect(view.getByTestId("automation-row").filter({ hasText: "進行：決めること" })).toHaveCount(1, { timeout: 30_000 });
    await expect(view.getByTestId("automation-row").filter({ hasText: "進行：止まった会話の見回り" })).toHaveCount(1);
    const decisions = (await byName("進行：決めること"))!;
    expect(decisions.source).toEqual({ kind: "event", event: "banto.turn-decisions", batchSeconds: 30, allowSelfTriggered: false });
    expect(decisions.delegateKinds).toEqual(DEFAULT_KINDS);
    expect(decisions.canAdvanceProject).toBeUndefined();
    expect(decisions.target.kind).toBe("dedicated");
    const patrol = (await byName("進行：止まった会話の見回り"))!;
    expect(patrol.source).toMatchObject({ kind: "time", repeat: { kind: "interval", hours: 3 } });
    expect(patrol.canAdvanceProject).toBe(true);
    expect(patrol.delegateKinds).toBeUndefined();
    expect(patrol.reviewOnDone).toBe(false);
    // 独立した自動化：それぞれ別の専用の Fork
    await expect.poll(async () => {
      const [d, p] = [await byName("進行：決めること"), await byName("進行：止まった会話の見回り")];
      return Boolean(d?.target.threadId && p?.target.threadId && d.target.threadId !== p.target.threadId);
    }).toBe(true);
    const patrolRow = view.getByTestId("automation-row").filter({ hasText: "進行：止まった会話の見回り" });
    await patrolRow.getByRole("button", { name: /進行：止まった会話の見回り/ }).click();
    await expect(patrolRow.getByTestId("automation-advance-summary")).toHaveText("止まった会話に決まった手順を頼めます（専用の Fork で）。");
    const decisionsRow = view.getByTestId("automation-row").filter({ hasText: "進行：決めること" });
    await decisionsRow.getByRole("button", { name: /進行：決めること/ }).click();
    await expect(decisionsRow.getByTestId("automation-delegate-summary")).toHaveText(
      "続ける・やり直す・試験を流し直す・試験を直す・main に取り込む・push・Backlog を更新・小さな設計",
    );
  });
  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});

test("進める自動化の回は、失敗したターンで止まった会話を list_stalled_threads で見つけ、instruct_thread（retry-turn）で進める。受信箱に自動化が頼んだことが出る", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${CORE_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  type Message = { role: string; text: string; origin?: { title?: string; hop?: number; supervisor?: { automationId: string; note?: string } } };
  type Thread = { messages: Message[]; lastTurn?: { turnId: string; outcome?: string } };
  type Act = { kind: string; threadId: string; action?: string; stalledReason?: string; hasNote?: boolean };
  type Card = { kind: string; threadId: string; carriedJudge?: { kind: string; by?: string; automation: { name: string }; instruction?: { action: string } } };
  const PROJECT = "E2E 進める自動化";
  const NAME = "止まった会話を進める";

  await openApp(page);
  await createProject(page, PROJECT, mkdtempSync(join(tmpdir(), "banto-e2e-advance-instruct-")));
  const projectId = currentProjectId(page);
  const base = ((await call(`/api/projects/${projectId}/threads`)).body as unknown as Array<{ id: string; kind: string }>).find((t) => t.kind === "base")!;
  expect(base, "Base Thread が無い").toBeTruthy();
  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  // 先に別の Project の画面へ移る——この Project の画面は Base Thread を描くので、届いたカードがその場で「見た」になる
  const elsewhere = await call("/api/projects", { method: "POST", body: { name: `${PROJECT}（見る場所）`, root: mkdtempSync(join(tmpdir(), "banto-e2e-advance-elsewhere-")) } });
  expect(elsewhere.status, elsewhere.text).toBe(201);
  const elsewhereBase = await call(`/api/projects/${(elsewhere.body as { id: string }).id}/threads`, { method: "POST" });
  expect(elsewhereBase.status, elsewhereBase.text).toBe(201);
  await page.goto(`/p/${(elsewhere.body as { id: string }).id}`);

  // ---- 失敗したターンで止まった会話 ----------------------------------------------------------------------------
  const failed = await call(`/api/threads/${base.id}/messages`, { method: "POST", body: { prompt: `試験を通して${fakeTurn({ say: "試験を流します", fail: "API が途中で落ちた" })}` } });
  expect(failed.status, failed.text).toBe(200);
  await expect.poll(async () => (await thread(base.id)).lastTurn?.outcome, { message: "失敗したターンで終わらない" }).toBe("failed");
  const failedTurn = (await thread(base.id)).lastTurn!.turnId;

  // ---- 進める自動化（時刻のきっかけ・canAdvanceProject）を作り、今すぐ動かす ------------------------------------------------
  // 偽の AI は届いた文の「」の語をそのまま返す——補足（note）に書く
  const tools = [
    { server: "banto-thread", name: "list_stalled_threads", args: {} },
    { server: "banto-thread", name: "instruct_thread", args: { threadId: base.id, action: "retry-turn", note: "「やり直して通しました」と返して", reason: "API が落ちて失敗したのでやり直す" } },
  ];
  const created = await call(`/api/projects/${projectId}/automations`, {
    method: "POST",
    body: {
      name: NAME,
      instruction: `止まった会話を進めて。${fakeTurn({ tools })}`,
      source: { kind: "time", repeat: { kind: "interval", hours: 168 }, timeZone: "UTC" },
      canAdvanceProject: true,
    },
  });
  expect(created.status, created.text).toBe(201);
  const automationId = (created.body as { id: string }).id;
  const ran = await call(`/api/projects/${projectId}/automations/${automationId}/run`, { method: "POST" });
  expect(ran.status, ran.text).toBe(202);

  // ---- その会話が指示で進む ------------------------------------------------------------------------------
  await expect
    .poll(async () => {
      const t = await thread(base.id);
      return t.lastTurn?.turnId !== failedTurn && t.lastTurn?.outcome === "completed" ? t.messages.filter((m) => m.role === "assistant").at(-1)?.text : undefined;
    }, { timeout: 60_000, message: "進める自動化の指示でその会話が進まない" })
    .toBe("やり直して通しました");
  const instruction = (await thread(base.id)).messages.find((m) => m.origin?.title?.startsWith(`自動化「${NAME}」の指示`))!;
  expect(instruction.origin?.title).toBe(`自動化「${NAME}」の指示：失敗した・途中で切れたターンをやり直す`);
  expect(instruction.origin?.hop, "人のターン（0）＋2").toBe(2);
  expect(instruction.text).toContain("同じ頼みをやり直してください");
  expect(instruction.origin?.supervisor?.automationId).toBe(automationId);
  expect(instruction.origin?.supervisor?.note).toBe("「やり直して通しました」と返して");

  // 進める自動化の記録に「頼んだ」（番頭の記録ではない）
  const automation = (await call(`/api/projects/${projectId}/automations/${automationId}`)).body as { advanceActs?: Act[]; supervisorActs?: unknown };
  expect((automation.advanceActs ?? []).map((a) => [a.kind, a.threadId, a.action, a.stalledReason, a.hasNote])).toEqual([["instructed", base.id, "retry-turn", "failed-turn", true]]);
  expect(automation.supervisorActs).toBeUndefined();

  // 受信箱：やり直したターンのカードに「自動化が頼んだ手順で始まりました」を引き継ぐ（番頭の印は付けない）
  await expect
    .poll(async () => {
      const card = ((await call("/api/inbox")).body as unknown as Card[]).find((i) => i.kind === "review" && i.threadId === base.id);
      return card?.carriedJudge ? [card.carriedJudge.kind, card.carriedJudge.by ?? null, card.carriedJudge.instruction?.action] : undefined;
    }, { message: "カードに自動化の指示が付かない" })
    .toEqual(["instructed", null, "retry-turn"]);
  // 画面のカードに出る（別の Project の画面から受信箱を開く）
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const box = page.getByRole("dialog", { name: "受信箱" });
  await expect(box).toBeVisible();
  const card = box
    .getByTestId("inbox-review")
    .filter({ has: page.getByTestId("inbox-card-project").getByText(PROJECT, { exact: true }) })
    .filter({ has: page.getByTestId("inbox-card-thread").getByText("Base Thread", { exact: true }) });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card.getByTestId("inbox-judge-carried")).toHaveText(
    `このターンは、自動化「${NAME}」が頼んだ手順（失敗した・途中で切れたターンをやり直す）で始まりました：API が落ちて失敗したのでやり直す`,
  );
  // 番頭の言い方では出さない
  await expect(card.getByTestId("inbox-supervisor-carried")).toHaveCount(0);
  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
