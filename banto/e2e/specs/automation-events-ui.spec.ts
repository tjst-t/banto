// **段2の画面**（v4-frontend.md §6.42「段2（出来事）の画面」「判断役と受信箱」、アーキ仕様 §4.3「段2」、Backlog #349）。
//
// 1. 作るフォームの「出来事」：同梱の Service を入れた Project（自前の host）で、出どころ → 出来事 → 条件 と選んで service.crashed の
//    自動化を作る。名乗りの説明・「起こしたままにします」・型の合わない条件の断り・「自分の回が起こした出来事では動かない」（既定オン）を
//    見て、作ったものが一覧に「Service が落ちたとき（条件）」で出て、host の台帳の条件と一致する。直すフォームで自分の回の
//    スイッチを切ると台帳と詳しいところが変わる
// 2. 受信箱の「決めることがある」カードが判断役の状態で替わる（共有の host）。判断役は画面のフォームから作り、まとめがオフの案内を
//    見る。そのあと：
//    - 判断役の会話が承認で止まっている間は「判断役が見ています」
//    - 判断役が選んだら「判断役が決めました：選択肢——理由」と選択肢の印。別の選択肢を押すと「もう進めています。変えますか」を
//      確かめ、やめれば何も入らず、変えれば返信の欄に入る。元の会話が進んで次のカードになると「選んで進めました」を引き継ぐ
//    - 人に任せたら「人に任せました：理由」
//    - 2問のうち1問だけ答えて終わったら「2 問中 1 問しか答えずに終わりました」
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_TOKEN, CORE_BASE_URL, FRONTEND_BASE_URL } from "../config.js";
import { createProject, currentProjectId, fakeReplyTurn, fakeTurn, openApp, openPaletteEntry } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.setTimeout(420_000);

type Automation = {
  id: string;
  name: string;
  source: Record<string, unknown>;
  target: { kind: string; mode?: string; threadId?: string };
  runs: Array<{ runId: string; result: string; cause: string }>;
};

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** Radix の Select で選ぶ（開いて、名前の合う選択肢を押す） */
async function choose(page: Page, trigger: ReturnType<Page["getByTestId"]>, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
}

test("作るフォームで出どころ→出来事→条件と選んで service.crashed の自動化を作ると、一覧に条件つきで出て台帳と一致し、直せる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await withOwnHost(async (host) => {
    const headers = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`${host.apiUrl}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
    };
    const installed = await call("/api/modules/catalog/service", { method: "POST", body: { name: "service" } });
    expect(installed.status, JSON.stringify(installed.body)).toBeLessThan(300);
    await login(page, host);
    await openApp(page, host.url);
    await createProject(page, "E2E 出来事のフォーム", mkdtempSync(join(tmpdir(), "banto-e2e-events-ui-form-")));
    const projectId = currentProjectId(page);
    const automations = async () => ((await call(`/api/projects/${projectId}/automations`)).body.automations as Automation[]) ?? [];

    await openPaletteEntry(page, /^自動化/);
    const view = page.getByTestId("automations");
    await expect(view).toBeVisible({ timeout: 30_000 });
    await expect(view.getByTestId("automations-empty")).toBeVisible();
    await view.getByTestId("automation-add").click();
    const form = view.getByTestId("automation-form");
    await form.getByTestId("automation-source-event").click();

    // ---- 出どころ → 出来事 ---------------------------------------------------------------------------------
    const eventForm = form.getByTestId("automation-event-form");
    await eventForm.getByTestId("automation-event-origin").click();
    // 出どころは banto 自身と、出来事を名乗る Module（Service）だけ
    await expect(page.getByRole("option")).toHaveText(["banto 自身", "service"]);
    await page.getByRole("option", { name: "service" }).click();
    await eventForm.getByTestId("automation-event-name").click();
    await expect(page.getByRole("option")).toHaveText(["Service が落ちた（service.crashed）"]);
    await page.getByRole("option", { name: "Service が落ちた（service.crashed）" }).click();
    await expect(eventForm.getByTestId("automation-event-description")).toHaveText(
      "startService で起こしたサービスが落ちた（止められた・終了コード 0 で終わったは含まない）。落ちるたびに1件。本文はログの末尾。systemd が起こし直すので、続けて落ちれば続けて起きる",
    );
    await expect(eventForm.getByTestId("automation-event-keep-awake")).toHaveText("待つ間、service を起こしたままにします。スリープしても止めません。");

    // ---- 条件：属性ごとの欄。数の属性に数でないものは断る ---------------------------------------------------------
    const where = eventForm.getByTestId("automation-event-where");
    await expect(where.getByTestId("automation-where-field")).toHaveCount(3);
    await expect(where.locator("label")).toContainText(["サービスの名前service", "終了コードexitCode", "終わらせた信号signal"]);
    await form.getByLabel("毎回届ける指示").fill("落ちた Service のログを読み、原因を調べて");
    await form.getByLabel("名前", { exact: true }).fill("Service が落ちたら");
    await where.locator('[data-field="exitCode"]').fill("abc");
    await expect(where.getByTestId("automation-event-where-error")).toHaveText("終了コードは数で書いてください");
    await expect(form.getByTestId("automation-submit")).toBeDisabled();
    await where.locator('[data-field="exitCode"]').fill("");
    await expect(where.getByTestId("automation-event-where-error")).toHaveCount(0);
    await where.locator('[data-field="service"]').fill("web, api");
    // 自分の回が起こした出来事では動かない（既定オン）
    await expect(eventForm.getByTestId("automation-ignore-self")).toHaveAttribute("aria-checked", "true");
    await expect(form.getByTestId("automation-submit")).toBeEnabled();
    await form.getByTestId("automation-submit").click();

    // ---- 一覧に出て、台帳と一致する --------------------------------------------------------------------------
    const row = view.getByTestId("automation-row").filter({ hasText: "Service が落ちたら" });
    await expect(row, "作った自動化が一覧に出ない").toHaveCount(1, { timeout: 30_000 });
    await expect(row.getByTestId("automation-summary")).toContainText("Service が落ちたとき（サービスの名前が「web」・「api」のどれか）");
    await expect(row.getByTestId("automation-summary")).toContainText("毎回まっさら");
    const [created] = await automations();
    expect(created?.source).toEqual({ kind: "event", event: "service.crashed", where: { service: ["web", "api"] }, batchSeconds: 30, allowSelfTriggered: false });
    expect(created?.target.kind).toBe("dedicated");
    await row.getByRole("button", { name: /Service が落ちたら/ }).click();
    const details = row.getByTestId("event-details");
    await expect(details.getByTestId("event-details-where")).toHaveText("サービスの名前が「web」・「api」のどれか");
    await expect(details.getByTestId("event-details-self")).toHaveText("この自動化自身の回が起こした出来事では動きません。");
    await expect(details).toContainText("Service が落ちた（service.crashed）");
    await expect(details).toContainText("30 秒の間に続けて起きたものは1回にまとめます。待つ間、service を起こしたままにします。スリープしても止めません。");

    // ---- 直す：種類は出来事のまま、条件と自分の回のスイッチを変えられる ------------------------------------------------------
    await row.getByTestId("automation-edit").click();
    const editForm = view.getByTestId("automation-form");
    await expect(editForm.getByTestId("automation-source-fixed")).toContainText("出来事");
    await expect(editForm.getByTestId("automation-event-name")).toContainText("Service が落ちた（service.crashed）");
    await expect(editForm.locator('[data-field="service"]')).toHaveValue("web, api");
    await editForm.locator('[data-field="exitCode"]').fill("1");
    await editForm.getByTestId("automation-ignore-self").click();
    await editForm.getByTestId("automation-submit").click();
    await expect(editForm).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await automations())[0]?.source).toEqual({
      kind: "event",
      event: "service.crashed",
      where: { service: ["web", "api"], exitCode: 1 },
      batchSeconds: 30,
      allowSelfTriggered: true,
    });
    await expect(row.getByTestId("automation-summary")).toContainText("Service が落ちたとき（サービスの名前が「web」・「api」のどれか、終了コードが「1」）");
    await row.getByRole("button", { name: /Service が落ちたら/ }).click();
    await expect(row.getByTestId("event-details-self")).toHaveText("この自動化自身の回が起こした出来事でも動きます。");
  });
  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});

// ---- 受信箱の判断役 ---------------------------------------------------------------------------------------------

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const JUDGE = "判断役";
const PROJECT_NAME = "E2E 判断役の受信箱";

type Judge = { kind: string; answers?: Array<{ label: string }>; reason?: string; answered?: number; total?: number };
type InboxItem = { kind: string; id: string; threadId: string; liveness?: string; judge?: Judge; carriedJudge?: Judge; judgeWatching?: { name: string } };
type Thread = { lastTurn?: { turnId: string; outcome?: string } };

/** 決めることのあるまとめ。`questions` 個の問い、どれも 案A／案B */
const summary = (n: number, questions = 1, replyB = "案B で進めて。") => ({
  request: `並びを決める（${n}）`,
  outcome: { status: "partial", headline: `案を2つ作った（${n}）`, points: [] },
  decisions: Array.from({ length: questions }, (_, q) => ({
    question: `どちらの並びにしますか（${n}-${q + 1}）`,
    options: [
      { label: "案A", reply: "案A で進めて。", recommended: true },
      { label: "案B", reply: replyB },
    ],
  })),
});

test("受信箱の「決めることがある」カードが判断役の状態で替わる：見ています→決めました（変えるときは確かめる）→次のカードに引き継ぐ、人に任せました、n 問中 m 問", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${CORE_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> };
  };

  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-events-ui-judge-")));
  const projectId = currentProjectId(page);
  const threads = (await call(`/api/projects/${projectId}/threads`)).body as unknown as Array<{ id: string; kind: string }>;
  const base = threads.find((t) => t.kind === "base");
  expect(base, "Base Thread が無い").toBeTruthy();
  const baseId = base!.id;
  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  const inbox = async () => (await call("/api/inbox")).body as unknown as InboxItem[];
  const baseCard = async () => (await inbox()).find((i) => i.kind === "review" && i.threadId === baseId);
  const api = `/api/projects/${projectId}/automations`;

  // ---- 判断役を画面のフォームから作る（まとめがオフなので案内が出る） -----------------------------------------------------
  await openPaletteEntry(page, /^自動化/);
  const view = page.getByTestId("automations");
  await expect(view).toBeVisible({ timeout: 30_000 });
  await view.getByTestId("automation-add").click();
  const form = view.getByTestId("automation-form");
  await form.getByTestId("automation-source-event").click();
  await choose(page, form.getByTestId("automation-event-origin"), "banto 自身");
  await choose(page, form.getByTestId("automation-event-name"), "決めることのあるターンが終わった（banto.turn-decisions）");
  // banto 自身の出来事は Module を起こさない。判断役の届け先は専用の Fork だけで、前の回を引き継ぐに寄る
  await expect(form.getByTestId("automation-event-keep-awake")).toHaveCount(0);
  await expect(form.getByTestId("automation-judge-target")).toBeVisible();
  await expect(form.getByRole("radio")).toHaveCount(2);
  await expect(form.getByRole("radio", { name: /専用の Fork で、前の回を引き継ぐ/ })).toHaveAttribute("aria-checked", "true");
  await form.getByLabel("毎回届ける指示").fill("届いた決めることに答えて。");
  await form.getByLabel("名前", { exact: true }).fill(JUDGE);
  await form.getByTestId("automation-submit").click();
  await expect(view.getByTestId("automation-created-notice")).toHaveText([
    "この Project はターンの終わりのまとめがオフなので、出来事 banto.turn-decisions が出ません。Project の設定の「一般」で「ターンの終わりのまとめ」をオンにしてください",
  ]);
  await expect(view.getByTestId("automation-row").filter({ hasText: JUDGE }).getByTestId("automation-summary")).toContainText(
    "決めることのあるターンが終わったとき",
  );
  const judge = ((await call(api)).body.automations as Automation[]).find((a) => a.name === JUDGE)!;
  expect(judge.target).toEqual(expect.objectContaining({ kind: "dedicated", mode: "continue" }));
  const judgeFork = judge.target.threadId!;
  expect(judgeFork, "専用の Fork が立っていない").toBeTruthy();
  expect((await call(`/api/projects/${projectId}/turn-summary`, { method: "PUT", body: { enabled: true } })).status).toBe(200);

  const judgeRuns = async () => ((await call(`${api}/${judge.id}`)).body as unknown as Automation).runs.filter((r) => r.cause === "event");
  const setPlan = async (plan: Parameters<typeof fakeTurn>[0]) => {
    const res = await call(`${api}/${judge.id}`, { method: "PATCH", body: { instruction: "届いた決めることに答えて。" + fakeTurn(plan) } });
    expect(res.status, res.text).toBe(200);
  };
  const answer = (args: Record<string, unknown>) => ({
    server: "banto-thread",
    name: "answer_decision",
    args: { thread: "$eventField:thread", turnId: "$eventField:turnId", question: 1, ...args },
  });
  const decide = async (n: number, questions = 1, replyB?: string) => {
    const res = await call(`/api/threads/${baseId}/messages`, {
      method: "POST",
      body: {
        prompt: `並びを決めて（${n}）` + fakeTurn({ say: `案を作りました（${n}）`, tools: [{ server: "banto-thread", name: "report_turn", args: summary(n, questions, replyB) }] }),
      },
    });
    expect(res.status, res.text).toBe(200);
    expect((await thread(baseId)).lastTurn?.outcome).toBe("completed");
  };

  // 受信箱を開く（host の記録が変わると画面は取り直す）。この Project の Base Thread のカードだけを見る。下は別の Project の画面に
  // しておく——この Project の画面は Fork を開いていても Base Thread を描くので、届いたカードがその場で「見た」になる
  const elsewhere = await call("/api/projects", {
    method: "POST",
    body: { name: `${PROJECT_NAME}（見る場所）`, root: mkdtempSync(join(tmpdir(), "banto-e2e-events-ui-elsewhere-")) },
  });
  expect(elsewhere.status, elsewhere.text).toBe(201);
  // 画面から作るときと同じく Base Thread を持たせる——無いと画面の一覧に入らず、同じ core で後に流れる並べ替えの試験
  // （sidebar-reorder-rename）が送る並びからこの Project が漏れる（Backlog #371）
  const elsewhereBase = await call(`/api/projects/${(elsewhere.body as { id: string }).id}/threads`, { method: "POST" });
  expect(elsewhereBase.status, elsewhereBase.text).toBe(201);
  await page.goto(`/p/${(elsewhere.body as { id: string }).id}`);
  await page.getByRole("button", { name: /^受信箱/ }).first().click();
  const box = page.getByRole("dialog", { name: "受信箱" });
  await expect(box).toBeVisible();
  // 判断役の Fork の回のカードも並ぶので、会話の名前でも絞る
  const card = box
    .getByTestId("inbox-review")
    .filter({ has: page.getByTestId("inbox-card-project").getByText(PROJECT_NAME, { exact: true }) })
    .filter({ has: page.getByTestId("inbox-card-thread").getByText("Base Thread", { exact: true }) });

  // ---- 1. 判断役が見ている間 → 決めた → 変えるときは確かめる → 次のカードに引き継ぐ ----------------------------------------
  // 判断役は承認の要る tool を先に呼ぶ（判断役の会話の承認は必ず聞く）——聞かれている間が「見ています」。元の会話は判断役の答えが
  // 届いたら考え込む（止めるまで次のカードにならない）——その間が「決めました」
  await setPlan({ tools: [{ server: "banto-thread", name: "list_threads", args: {} }, answer({ choice: 2, reason: "案B のほうが今の画面に近い" })] });
  await decide(1, 1, "案B で進めて。" + fakeReplyTurn({ thinkMs: 240_000 }));
  let approval: InboxItem | undefined;
  await expect
    .poll(async () => (approval = (await inbox()).find((i) => i.kind === "judgment" && i.threadId === judgeFork))?.liveness, {
      timeout: 60_000,
      message: "判断役の会話で承認が聞かれない",
    })
    .toBe("live");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card.getByTestId("inbox-turn-headline")).toHaveText("案を2つ作った（1）");
  await expect(card.getByTestId("inbox-judge-watching")).toHaveText(`判断役が見ています（自動化「${JUDGE}」）`);
  await expect(card.getByTestId("inbox-judge")).toHaveCount(0);

  expect((await call(`/api/inbox/${approval!.id}/answer`, { method: "POST", body: { answer: { behavior: "allow" } } })).status).toBe(200);
  await expect.poll(async () => (await baseCard())?.judge?.kind, { timeout: 60_000, message: "判断役が決めない" }).toBe("decided-by-automation");
  const decided = card.getByTestId("inbox-judge");
  await expect(decided).toHaveAttribute("data-kind", "decided-by-automation");
  await expect(decided).toContainText(`判断役（自動化「${JUDGE}」）が決めました`);
  await expect(decided.getByTestId("inbox-judge-answer")).toHaveText(["「案B」——案B のほうが今の画面に近い"]);
  await expect(card.getByTestId("inbox-judge-watching")).toHaveCount(0);
  await expect(card.getByTestId("inbox-turn-option")).toHaveText(["案Aおすすめ", "案B判断役が選択"]);
  // 別の選択肢を押す → 確かめる。やめれば何も入らない
  const reply = card.getByTestId("inbox-reply-input");
  await card.getByTestId("inbox-turn-option").filter({ hasText: "案A" }).click();
  await expect(card.getByTestId("inbox-judge-confirm-text")).toHaveText("判断役は「案B」を選び、AI はもう進めています。「案A」に変えますか");
  await card.getByTestId("inbox-judge-confirm-cancel").click();
  await expect(card.getByTestId("inbox-judge-confirm")).toHaveCount(0);
  await expect(reply).toHaveValue("");
  // 変えるなら返信の欄に入る（送るのは人）
  await card.getByTestId("inbox-turn-option").filter({ hasText: "案A" }).click();
  await card.getByTestId("inbox-judge-confirm-change").click();
  await expect(reply).toHaveValue("案A で進めて。");
  await expect(card.getByTestId("inbox-turn-option").filter({ hasText: "案A" })).toHaveAttribute("aria-pressed", "true");
  // 判断役の選んだものを押すのは確かめない
  await card.getByTestId("inbox-turn-option").filter({ hasText: "案B" }).click();
  await expect(card.getByTestId("inbox-judge-confirm")).toHaveCount(0);
  await expect(reply).toHaveValue(/^案B で進めて。/);

  // 元の会話を止める → 次のカード（止めたターン）が前のカードを置き換え、判断役の決めを引き継ぐ
  expect((await call(`/api/threads/${baseId}/stop`, { method: "POST", body: {} })).status).toBe(200);
  await expect.poll(async () => (await baseCard())?.carriedJudge?.kind, { timeout: 60_000, message: "次のカードが判断役の決めを引き継がない" }).toBe(
    "decided-by-automation",
  );
  await expect(card.getByTestId("inbox-judge-carried")).toHaveText(
    `前のターンで、判断役（自動化「${JUDGE}」）が「案B」を選んで進めました（案B のほうが今の画面に近い）`,
    { timeout: 30_000 },
  );
  await expect(card.getByTestId("inbox-turn-cut")).toHaveText("止めたので、途中で終わりました");
  await expect(card.getByTestId("inbox-judge")).toHaveCount(0);
  await expect(card.getByTestId("inbox-turn-decision")).toHaveCount(0);

  // ---- 2. 人に任せた ---------------------------------------------------------------------------------------
  await setPlan({ tools: [answer({ defer: true, reason: "設計の向きを変える" })] });
  await decide(2);
  await expect.poll(async () => (await baseCard())?.judge?.kind, { timeout: 60_000, message: "判断役が人に任せない" }).toBe("deferred");
  await expect(card.getByTestId("inbox-turn-headline")).toHaveText("案を2つ作った（2）");
  await expect(card.getByTestId("inbox-judge")).toHaveAttribute("data-kind", "deferred");
  await expect(card.getByTestId("inbox-judge")).toHaveText(`判断役（自動化「${JUDGE}」）は人に任せました：設計の向きを変える`);
  await expect(card.getByTestId("inbox-judge-carried")).toHaveCount(0);
  await expect(card.getByTestId("inbox-turn-option-judge")).toHaveCount(0);
  // 人に任せたので、選択肢は確かめずにそのまま入る
  await card.getByTestId("inbox-turn-option").filter({ hasText: "案A" }).click();
  await expect(card.getByTestId("inbox-judge-confirm")).toHaveCount(0);
  await expect(card.getByTestId("inbox-reply-input")).toHaveValue("案A で進めて。");

  // ---- 3. 2問のうち1問だけ答えて終わった ----------------------------------------------------------------------------
  await setPlan({ tools: [answer({ choice: 1, reason: "おすすめに異論が無い" })] });
  await decide(3, 2);
  await expect.poll(async () => (await baseCard())?.judge?.kind, { timeout: 60_000, message: "揃わなかったことがカードに付かない" }).toBe("incomplete");
  await expect(card.getByTestId("inbox-turn-headline")).toHaveText("案を2つ作った（3）");
  await expect(card.getByTestId("inbox-judge")).toHaveAttribute("data-kind", "incomplete");
  await expect(card.getByTestId("inbox-judge")).toHaveText(`判断役（自動化「${JUDGE}」）は 2 問中 1 問しか答えずに終わりました。あなたが決めてください`);
  await expect(card.getByTestId("inbox-turn-decision")).toHaveCount(2);
  expect((await judgeRuns()).map((r) => r.result)).toEqual(["done", "done", "done"]);

  expect(pageErrors, "画面で例外が起きた").toEqual([]);
});
