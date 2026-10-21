// **番頭の画面**（v4-frontend.md §6.54、アーキ仕様 §4.5。Backlog #511）。番頭の仕組みは `supervisor.spec.ts` が host の記録で見ている。
// ここは画面から触って、画面に出る中身まで見る（規則14）：
//   1. サイドバーの「番頭」で番頭の画面が開く。番頭のいない Project の行の「番頭を置く」→確かめのカード→置くと、行が「動いています」
//      になり、「承認をすべて自動で許可する」がオフの注記が出る。「全部の Project に番頭を置く」は何が起きるかをカードに並べる（やめる）
//   2. 番頭が手順の問い（rerun-tests）に答えると、受信箱のカードに問いの種類の札「試験を流し直す」と「番頭が決めました：「流し直す」——理由」。
//      「取り消す」で既定の文の欄が開く。仕様の向き（spec）の問いには札「仕様」・「番頭は答えられません：仕様に当たります」・
//      「番頭は答えきれずに人に回しました」
//   3. 失敗したターンで止まった会話を、画面の「今すぐ見回る」で番頭が見つけて頼む（instruct_thread）→その会話の頭に薄い1行
//      「番頭の頼み——〈行いの題〉」、開くと補足と理由。受信箱のカードに「番頭の頼み（〈行いの題〉）で進めました——理由」
//   4. 番頭の画面：今日のまとめの件数、記録（新しい順・したことで絞る・空なら「まだ何もしていません」）。記録の「取り消す」で文を直して
//      送ると、元の会話に人の発言として届き、行に「取り消しました」
//   5. 番頭の会話の上の帯と「番頭の画面を開く」
//   6. 「番頭を全部止める」→確かめ→止まった（行・知らせ・受信箱の見出し）→「再開する」で戻る。Project ごとの一時停止・再開
//   7. 方針：任せる行いのチェックと見回りの間隔を変えて保存→host の方針に入る。Project の足し外し
//   8. 新しい Project の画面の「番頭を置く」（初めはオフ）。オンで作ると番頭がいる
//   9. 携帯の幅で横にはみ出さない。画面の写しを残す（`tmp-shots/supervisor-ui/`）
import type { Page } from "@playwright/test";
import { test, expect } from "../test-base.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_BASE_URL, CORE_BROWSER_URL, AUTH_TOKEN, FRONTEND_BASE_URL } from "../config.js";
import { clickNewProject, expectProjectOpen, fakeReplyTurn, fakeTurn, LEGACY_PROJECT_AI, openApp, openNav, setNewProjectAi } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);
test.use({ viewport: { width: 1280, height: 900 } });

const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const STAMP = Date.now();
const PROJECT_NAME = `E2E 番頭の画面 ${STAMP}`;
const OTHER_NAME = `E2E 番頭の画面 置いていない ${STAMP}`;
const NEW_NAME = `E2E 番頭の画面 新しい ${STAMP}`;
const CONTINUED = "番頭の答えで流し直しました";
const SHOTS = join(import.meta.dirname, "../../../tmp-shots/supervisor-ui");

type Message = { seq: number; role: string; text: string; origin?: { title: string; supervisor?: { actionId: string } } };
type Thread = { messages: Message[]; lastTurn?: { turnId: string; outcome?: string } };
type Judge = { kind: string; by?: string };
type InboxItem = { kind: string; threadId: string; acknowledged?: boolean; judge?: Judge; carriedJudge?: Judge };
type Supervisor = { id: string; threadId?: string; paused: boolean; stoppedAll: boolean; automations: Array<{ source: { kind: string; event?: string }; runs: Array<{ result: string }> }> };

const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${CORE_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : {}) as Record<string, unknown> };
};

/** 人の口（番頭・方針は人のセッションだけ）——ログインしたブラウザの文脈から呼ぶ */
const humanCall = (page: Page) => async (path: string, method: string, body?: unknown) => {
  const res = await page.context().request.fetch(`${CORE_BROWSER_URL}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(body !== undefined ? { data: body } : {}),
  });
  const text = await res.text();
  return { status: res.status(), text, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

const summary = (n: number, kind: string, reply: string) => ({
  request: `試験を通す（${n}）`,
  outcome: { status: "partial", headline: `試験が1つ落ちた（${n}）`, points: [] },
  decisions: [
    {
      question: `どうしますか（${n}）`,
      kind,
      options: [
        { label: "流し直す", reply, recommended: true },
        { label: "待つ", reply: "待って" },
      ],
    },
  ],
});

test("番頭の画面から置く・方針を変える・全部止める／再開・記録から取り消す。受信箱の種類の札と番頭の決め、会話の1行と帯", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  const human = humanCall(page);
  const thread = async (id: string) => (await call(`/api/threads/${id}`)).body as unknown as Thread;
  const inbox = async () => (await call("/api/inbox")).body as unknown as InboxItem[];
  const openCard = async (threadId: string) => (await inbox()).find((i) => i.kind === "review" && i.threadId === threadId && !i.acknowledged);

  // ---- 用意：Project（まとめをオン）・Base・Fork 2本、番頭を置かない Project ---------------------------------------
  const project = (await call("/api/projects", { method: "POST", body: { name: PROJECT_NAME, root: mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-ui-")) } })).body as { id: string };
  const base = (await call(`/api/projects/${project.id}/threads`, { method: "POST" })).body as { id: string };
  expect(base.id, "Base Thread が立たない").toBeTruthy();
  expect((await call(`/api/projects/${project.id}/turn-summary`, { method: "PUT", body: { enabled: true } })).status).toBe(200);
  const fixFork = (await call(`/api/threads/${base.id}/fork`, { method: "POST", body: { title: "直す" } })).body as { id: string };
  const specFork = (await call(`/api/threads/${base.id}/fork`, { method: "POST", body: { title: "仕様" } })).body as { id: string };
  const other = (await call("/api/projects", { method: "POST", body: { name: OTHER_NAME, root: mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-ui-other-")) } })).body as { id: string };
  expect((await call(`/api/projects/${other.id}/threads`, { method: "POST" })).status).toBeLessThan(300);

  const originalPolicy = (await human("/api/supervisor-policy", "GET")).body as { delegate: string[]; note: string; patrolHours: number; limits: Record<string, number>; timeZone?: string };
  const supervisor = async () => (await call(`/api/projects/${project.id}/supervisor`)).body as unknown as Supervisor;
  const runsOf = async (kind: string) => (await supervisor()).automations.find((a) => (a.source.event ?? a.source.kind) === kind)!.runs;
  const plan = async (tools: Array<{ name: string; args: Record<string, unknown> }>) => {
    const res = await human(`/api/projects/${project.id}/supervisor-policy`, "PUT", {
      note: `番頭の手順。${fakeTurn({ tools: tools.map((t) => ({ server: "banto-thread", ...t })) })}`,
    });
    expect(res.status, res.text).toBe(200);
  };
  let newProjectId: string | undefined;

  try {
    // ---- 1. 番頭の画面を開き、番頭を置く ------------------------------------------------------------------------------
    await openApp(page);
    await page.getByTestId("sidebar-supervisor").click();
    const screen = page.getByTestId("supervisor-page");
    await expect(screen).toBeVisible();
    const row = screen.locator(`[data-testid="supervisor-project-row"][data-project="${project.id}"]`);
    await expect(row).toHaveAttribute("data-supervised", "false");
    await expect(row).toContainText("番頭はいません");
    // 「全部の Project に番頭を置く」：何が起きるかを1枚のカードで聞く（ここでは置かない——同じ core の後の spec に番頭を残さない）
    await screen.getByTestId("supervisor-place-all").click();
    const placeAll = page.getByTestId("supervisor-place-confirm");
    await expect(placeAll).toContainText("に番頭を置きますか");
    await expect(placeAll).toContainText(OTHER_NAME);
    await expect(placeAll).toContainText("Project ごとに番頭の会話（Fork）を1本作り");
    await placeAll.getByRole("button", { name: "やめる" }).click();
    await expect(placeAll).toBeHidden();
    expect((await call(`/api/projects/${other.id}/supervisor`)).status, "やめたのに置いた").toBe(404);

    await row.getByTestId("supervisor-place").click();
    const placeOne = page.getByTestId("supervisor-place-confirm");
    await expect(placeOne).toContainText(`「${PROJECT_NAME}」に番頭を置きますか`);
    await placeOne.getByTestId("supervisor-place-ok").click();
    await expect(row).toHaveAttribute("data-supervised", "true", { timeout: 15_000 });
    await expect(row.getByTestId("supervisor-status")).toHaveText("動いています");
    await expect(row.getByTestId("supervisor-last")).toHaveText("まだ動いていません");
    await expect(row.getByTestId("supervisor-auto-approve-note")).toHaveText("コマンドの承認で止まったものは人に残ります。");
    expect((await call(`/api/projects/${project.id}/supervisor`)).status, "画面で置いたのに host に番頭がいない").toBe(200);
    // 番頭を置いた Project は「置いていない」の側から外れ、置いていない Project は上に寄る
    const rows = screen.getByTestId("supervisor-project-row");
    const order = await rows.evaluateAll((els) => els.map((e) => [e.getAttribute("data-project"), e.getAttribute("data-supervised")]));
    const firstSupervised = order.findIndex(([, s]) => s === "true");
    expect(order.slice(firstSupervised).every(([, s]) => s === "true"), `置いていない Project が上に寄っていない：${JSON.stringify(order)}`).toBe(true);
    await expect(screen.getByTestId("supervisor-log").getByTestId("supervisor-log-empty")).toHaveText("まだ何もしていません");
    await page.screenshot({ path: join(SHOTS, "supervisor-page-placed.png"), fullPage: true });
    await screen.getByTestId("supervisor-close").click();
    await expect(screen).toBeHidden();
    // **見ている会話のカードは「見た」になる**——カードを見る会話は開かない（番頭を置いていない Project へ移っておく）
    const away = async () => {
      await page.goto(`/p/${other.id}`);
      await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
    };
    await away();

    // ---- 2. 手順の問い→番頭が決める（元の会話はしばらく流し続ける——カードの「番頭が決めました」を見る間） --------------------
    await plan([{ name: "answer_decision", args: { thread: "$eventField:thread", turnId: "$eventField:turnId", question: 1, choice: 1, reason: "手順なので流し直す" } }]);
    const decided = await call(`/api/threads/${base.id}/messages`, {
      method: "POST",
      body: {
        prompt: `試験を通して（1）${fakeTurn({
          say: "止まりました（1）",
          tools: [{ server: "banto-thread", name: "report_turn", args: summary(1, "rerun-tests", `試験を流し直して${fakeReplyTurn({ say: CONTINUED, streamMs: 60_000 })}`) }],
        })}`,
      },
    });
    expect(decided.status, decided.text).toBe(200);
    await expect.poll(async () => (await runsOf("banto.turn-decisions")).map((r) => r.result), { timeout: 120_000, message: "番頭が動かない" }).toEqual(["done"]);
    await expect
      .poll(async () => {
        const card = await openCard(base.id);
        return card?.judge ? [card.judge.kind, card.judge.by] : undefined;
      }, { timeout: 60_000, message: "カードに番頭の決めが付かない" })
      .toEqual(["decided-by-automation", "supervisor"]);

    await page.getByRole("button", { name: /^受信箱/ }).first().click();
    const inboxPage = page.getByTestId("inbox-page");
    await expect(inboxPage).toBeVisible();
    // 見出し：番頭が動いている印と「番頭を全部止める」
    await expect(inboxPage.getByTestId("inbox-supervisor-stop-all")).toHaveText("番頭を全部止める");
    await expect(inboxPage.getByTestId("inbox-supervisor-mark")).toContainText("番頭が");
    const decidedCard = inboxPage.getByTestId("inbox-review").filter({ hasText: "どうしますか（1）" });
    await expect(decidedCard.getByTestId("inbox-decision-kind")).toHaveText("試験を流し直す");
    const decidedNote = decidedCard.getByTestId("inbox-supervisor-judge");
    await expect(decidedNote).toContainText("番頭が決めました");
    await expect(decidedNote.getByTestId("inbox-supervisor-answer")).toHaveText("「流し直す」——手順なので流し直す");
    await expect(decidedCard.getByTestId("inbox-turn-option-judge")).toHaveText("番頭が選択");
    // 判断役の言い方は出さない
    await expect(decidedCard.getByTestId("inbox-judge")).toHaveCount(0);
    // 番頭が決めた問いには「答えられません」を出さない
    await expect(decidedCard.getByTestId("inbox-supervisor-cannot")).toHaveCount(0);
    // 「取り消す」：既定の文の欄が開く（ここでは送らない——記録から送る）
    await decidedNote.getByTestId("inbox-supervisor-undo").click();
    await expect(decidedNote.getByTestId("supervisor-undo-text")).toHaveValue("番頭の選んだ「流し直す」は取り消して。その前に戻して");
    await page.screenshot({ path: join(SHOTS, "inbox-supervisor-decided.png"), fullPage: true });
    await decidedNote.getByRole("button", { name: "やめる" }).click();
    await expect(decidedNote.getByTestId("supervisor-undo")).toBeVisible();
    await inboxPage.getByTestId("inbox-close").click();

    // 元の会話が番頭の答えで進み終わる
    await expect
      .poll(async () => (await thread(base.id)).messages.filter((m) => m.role === "assistant").at(-1)?.text, { timeout: 120_000, message: "元の会話が番頭の答えで続かない" })
      .toBe(CONTINUED);
    await expect.poll(async () => (await thread(base.id)).lastTurn?.outcome, { timeout: 60_000 }).toBe("completed");

    // ---- 2'. 仕様の向きの問い→番頭は答えられず、人に回る ----------------------------------------------------------------
    const specTurn = await call(`/api/threads/${specFork.id}/messages`, {
      method: "POST",
      body: { prompt: `向きを決めて（2）${fakeTurn({ say: "止まりました（2）", tools: [{ server: "banto-thread", name: "report_turn", args: summary(2, "spec", "流し直して") }] })}` },
    });
    expect(specTurn.status, specTurn.text).toBe(200);
    await expect.poll(async () => (await runsOf("banto.turn-decisions")).map((r) => r.result), { timeout: 120_000, message: "番頭が2回目に動かない" }).toEqual(["done", "done"]);
    await expect
      .poll(async () => {
        const card = await openCard(specFork.id);
        return card?.judge ? [card.judge.kind, card.judge.by] : undefined;
      }, { timeout: 60_000, message: "仕様の問いのカードに「人に回った」が付かない" })
      .toEqual(["incomplete", "supervisor"]);

    // ---- 3. 失敗したターンで止まった会話を、画面の「今すぐ見回る」で頼む ----------------------------------------------------
    const failed = await call(`/api/threads/${fixFork.id}/messages`, { method: "POST", body: { prompt: `試験を通して${fakeTurn({ say: "試験を流します", fail: "API が途中で落ちた" })}` } });
    expect(failed.status, failed.text).toBe(200);
    await expect.poll(async () => (await thread(fixFork.id)).lastTurn?.outcome, { message: "失敗したターンで終わらない" }).toBe("failed");
    const failedTurn = (await thread(fixFork.id)).lastTurn!.turnId;
    await plan([
      { name: "instruct_thread", args: { threadId: fixFork.id, action: "retry-turn", note: "「やり直して通しました」と返して", reason: "API が落ちて失敗したのでやり直す" } },
    ]);
    await page.getByTestId("sidebar-supervisor").click();
    await expect(screen).toBeVisible();
    await row.getByTestId("supervisor-patrol").click();
    await expect(page.getByText(`「${PROJECT_NAME}」の見回りを始めました`)).toBeVisible();
    await expect
      .poll(async () => {
        const t = await thread(fixFork.id);
        return t.lastTurn?.turnId !== failedTurn && t.lastTurn?.outcome === "completed" ? t.messages.filter((m) => m.role === "assistant").at(-1)?.text : undefined;
      }, { timeout: 90_000, message: "番頭の頼みでその会話が進まない" })
      .toBe("やり直して通しました");

    // ---- 4. 今日のまとめと記録、記録から取り消す --------------------------------------------------------------------------
    // 行は「最後に動いた」を出す
    await expect(row.getByTestId("supervisor-last")).toContainText("最後に動いた：今日");
    const daily = screen.getByTestId("supervisor-daily").locator(`[data-testid="supervisor-daily-row"][data-project="${project.id}"]`);
    await expect(daily.getByTestId("supervisor-daily-counts")).toHaveText(/^選んだ 1・頼んだ 1・流した 0・人に回した \d+$/);
    const log = screen.getByTestId("supervisor-log");
    await log.getByTestId("supervisor-log-project").selectOption(project.id);
    const logRows = log.getByTestId("supervisor-log-row");
    // 新しい順：頼んだ → 断られた（仕様）→ 選んだ
    await expect.poll(async () => logRows.evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")))).toEqual(["instructed", "refused", "answered"]);
    await expect(logRows.nth(0).getByTestId("supervisor-log-what")).toHaveText("「やり直す」を頼んだ（補足つき）");
    await expect(logRows.nth(0).getByTestId("supervisor-log-reason")).toHaveText("API が落ちて失敗したのでやり直す");
    await expect(logRows.nth(0).getByTestId("supervisor-log-thread-link")).toHaveText("直す");
    await expect(logRows.nth(2).getByTestId("supervisor-log-what")).toHaveText("問い 1：「流し直す」を選んだ");
    await expect(logRows.nth(1).getByTestId("supervisor-undo"), "断られたものに「取り消す」を出した").toHaveCount(0);
    // したことで絞る。空なら「まだ何もしていません」
    await log.getByTestId("supervisor-log-kind").selectOption("factory-started");
    await expect(log.getByTestId("supervisor-log-empty")).toHaveText("まだ何もしていません");
    await log.getByTestId("supervisor-log-kind").selectOption("answered");
    await expect(logRows).toHaveCount(1);
    const answeredRow = logRows.first();
    await answeredRow.getByTestId("supervisor-undo").click();
    const undoText = answeredRow.getByTestId("supervisor-undo-text");
    await expect(undoText).toHaveValue("番頭の選んだ「流し直す」は取り消して。その前に戻して");
    const sent = "番頭の選んだ「流し直す」は取り消して。試験はそのままでいい";
    await undoText.fill(sent);
    await answeredRow.getByTestId("supervisor-undo-send").click();
    // 送れたら記録を取り直し、行は「取り消しました」に替わる（もう取り消せない）
    await expect(answeredRow.getByTestId("supervisor-log-undone")).toHaveText("取り消しました", { timeout: 15_000 });
    await expect(answeredRow.getByTestId("supervisor-undo")).toHaveCount(0);
    await expect
      .poll(async () => (await thread(base.id)).messages.some((m) => m.role === "user" && m.text === sent && m.origin === undefined), { timeout: 30_000, message: "取り消しの人の発言が元の会話に届かない" })
      .toBe(true);
    await log.getByTestId("supervisor-log-kind").selectOption("");
    await page.screenshot({ path: join(SHOTS, "supervisor-page-log.png"), fullPage: true });

    // ---- 5. 番頭の会話の帯と「番頭の画面を開く」 ----------------------------------------------------------------------------
    await row.getByTestId("supervisor-open-thread").click();
    await expect(screen).toBeHidden();
    const band = page.getByTestId("supervisor-thread-band");
    await expect(band).toContainText("番頭の会話です。この Project の方針で、決めることに答える・決まった手順を頼む・Factory に流すだけをします");
    await page.screenshot({ path: join(SHOTS, "supervisor-thread-band.png") });
    await band.getByTestId("supervisor-thread-band-open").click();
    await expect(screen).toBeVisible();
    await screen.getByTestId("supervisor-close").click();

    // ---- 3'. 受信箱の「番頭の頼み」と、仕様の問いのカード -------------------------------------------------------------
    await away();
    await expect
      .poll(async () => (await openCard(fixFork.id))?.carriedJudge?.kind, { timeout: 30_000, message: "頼んで進めたカードに番頭の頼みが付かない" })
      .toBe("instructed");
    await page.getByRole("button", { name: /^受信箱/ }).first().click();
    const fixCard = inboxPage.getByTestId("inbox-review").filter({ hasText: "やり直して通しました" });
    await expect(fixCard.getByTestId("inbox-supervisor-carried")).toContainText("番頭の頼み（失敗した・途中で切れたターンをやり直す）で進めました——API が落ちて失敗したのでやり直す");
    // 仕様の問いのカード：札・答えられないわけ・人に回した
    const specCard = inboxPage.getByTestId("inbox-review").filter({ hasText: "どうしますか（2）" });
    await expect(specCard.getByTestId("inbox-decision-kind")).toHaveText("仕様");
    await expect(specCard.getByTestId("inbox-supervisor-cannot")).toHaveText("番頭は答えられません：仕様に当たります");
    await expect(specCard.getByTestId("inbox-supervisor-judge")).toContainText("番頭は答えきれずに人に回しました");
    await specCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, "inbox-supervisor-spec.png"), fullPage: true });

    // ---- 6. 全部止める（受信箱の見出しから）→ 番頭の画面で再開。Project ごとの一時停止・再開 ------------------------------------
    await inboxPage.getByTestId("inbox-supervisor-stop-all").click();
    const confirm = page.getByTestId("supervisor-confirm");
    await expect(confirm).toContainText("番頭を全部止めますか");
    await expect(confirm).toContainText("Factory に流した件は止めません");
    await confirm.getByTestId("supervisor-confirm-ok").click();
    await expect(inboxPage.getByTestId("inbox-supervisor-mark")).toHaveText("番頭を全部止めています");
    await expect(inboxPage.getByTestId("inbox-supervisor-stop-all")).toHaveCount(0);
    expect([(await supervisor()).paused, (await supervisor()).stoppedAll]).toEqual([true, true]);
    await inboxPage.getByTestId("inbox-close").click();
    await page.getByTestId("sidebar-supervisor").click();
    await expect(screen.getByTestId("supervisor-stopped-all")).toContainText("番頭を全部止めています");
    await expect(row.getByTestId("supervisor-status")).toHaveText("全部止めたので止まっています");
    await expect(row.getByTestId("supervisor-status")).toHaveAttribute("data-tone", "attention");
    await expect(row.getByTestId("supervisor-patrol")).toBeDisabled();
    await page.screenshot({ path: join(SHOTS, "supervisor-page-stopped.png"), fullPage: true });
    await screen.getByTestId("supervisor-resume-all").click();
    await expect(confirm).toContainText("番頭を再開しますか");
    await confirm.getByTestId("supervisor-confirm-ok").click();
    await expect(row.getByTestId("supervisor-status")).toHaveText("動いています", { timeout: 15_000 });
    await expect(screen.getByTestId("supervisor-stopped-all")).toHaveCount(0);
    expect([(await supervisor()).paused, (await supervisor()).stoppedAll]).toEqual([false, false]);
    await row.getByTestId("supervisor-pause").click();
    await expect(row.getByTestId("supervisor-status")).toHaveText("一時停止しています（人が一時停止しました）");
    expect((await supervisor()).paused).toBe(true);
    await row.getByTestId("supervisor-pause").click();
    await expect(row.getByTestId("supervisor-status")).toHaveText("動いています");
    expect((await supervisor()).paused).toBe(false);

    // ---- 7. 方針：全体（任せる行い・見回りの間隔）と Project の足し外し ---------------------------------------------------
    const policy = screen.getByTestId("supervisor-policy");
    await expect(policy.getByTestId("supervisor-human-only-spec")).toBeDisabled();
    await expect(policy.getByTestId("supervisor-human-only-spec")).not.toBeChecked();
    await expect(policy.getByTestId("supervisor-delegate-release")).not.toBeChecked();
    await policy.getByTestId("supervisor-delegate-release").check();
    await policy.getByTestId("supervisor-patrol-hours").fill("4");
    await policy.getByTestId("supervisor-policy-save").click();
    await expect(policy.getByTestId("supervisor-policy-saved")).toHaveText("保存しました");
    const saved = (await human("/api/supervisor-policy", "GET")).body as { delegate: string[]; patrolHours: number };
    expect(saved.delegate).toContain("release");
    expect(saved.patrolHours).toBe(4);
    // 正しくない値は理由を出して書かない
    await policy.getByTestId("supervisor-patrol-hours").fill("0");
    await policy.getByTestId("supervisor-policy-save").click();
    await expect(page.getByText("方針を保存できませんでした：見回りの間隔（時間）は 1〜168 の整数で渡してください")).toBeVisible();
    expect(((await human("/api/supervisor-policy", "GET")).body as { patrolHours: number }).patrolHours).toBe(4);
    // Project：merge を外す
    await row.getByRole("button", { name: new RegExp(PROJECT_NAME) }).click();
    const details = row.getByTestId("supervisor-project-details");
    await details.getByTestId("supervisor-project-delegate-merge").uncheck();
    await expect(details.getByTestId("supervisor-project-diff")).toHaveText("main に取り込むは人");
    await details.getByTestId("supervisor-project-policy-save").click();
    await expect
      .poll(async () => ((await human(`/api/projects/${project.id}/supervisor-policy`, "GET")).body as { layer?: { delegate?: { remove: string[] } } }).layer?.delegate?.remove)
      .toEqual(["merge"]);
    await page.screenshot({ path: join(SHOTS, "supervisor-page-policy.png"), fullPage: true });

    // ---- 3''. 頼まれた会話の頭の1行（カードを見終えてから開く） ----------------------------------------------------------
    await page.goto(`/p/${project.id}?fork=${fixFork.id}`);
    const line = page.getByTestId("supervisor-instruction-line");
    await expect(line.getByTestId("supervisor-instruction-text")).toHaveText("番頭の頼み——失敗した・途中で切れたターンをやり直す");
    await line.getByRole("button").first().click();
    await expect(line.getByTestId("supervisor-instruction-note")).toContainText("「やり直して通しました」と返して");
    await expect(line.getByTestId("supervisor-instruction-reason")).toHaveText("理由：API が落ちて失敗したのでやり直す");
    await page.screenshot({ path: join(SHOTS, "thread-instruction-line.png") });
    await page.getByTestId("sidebar-supervisor").click();
    await expect(screen).toBeVisible();

    // ---- 9. 携帯の幅：横にはみ出さない ---------------------------------------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(screen).toBeVisible();
    const overflow = await screen.evaluate((el) => {
      const scroller = el.querySelector(".overflow-auto") as HTMLElement;
      return { page: el.scrollWidth - el.clientWidth, body: scroller.scrollWidth - scroller.clientWidth };
    });
    expect(overflow, "携帯の幅で横にはみ出した").toEqual({ page: 0, body: 0 });
    await page.screenshot({ path: join(SHOTS, "supervisor-page-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await screen.getByTestId("supervisor-close").click();

    // ---- 8. 新しい Project の画面の「番頭を置く」 ----------------------------------------------------------------------
    await openNav(page);
    await clickNewProject(page);
    await page.getByLabel("Project 名").fill(NEW_NAME);
    await page.getByLabel("Root パス").fill(mkdtempSync(join(tmpdir(), "banto-e2e-supervisor-ui-new-")));
    await setNewProjectAi(page, LEGACY_PROJECT_AI);
    const toggle = page.getByTestId("new-project-supervisor");
    await expect(toggle, "「番頭を置く」の初めがオンになっている").toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("new-project-supervisor-row")).toContainText("番頭を置く");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/projects");
    await page.getByRole("button", { name: "作成する" }).click();
    newProjectId = ((await (await created).json()) as { id: string }).id;
    await expectProjectOpen(page, NEW_NAME);
    await expect.poll(async () => (await call(`/api/projects/${newProjectId}/supervisor`)).status, { message: "「番頭を置く」で作ったのに番頭がいない" }).toBe(200);

    expect(pageErrors, "画面で例外が出た").toEqual([]);
  } finally {
    // 同じ core の後の spec に、番頭・全部止めた印・変えた方針を残さない
    await human("/api/supervisors/resume-all", "POST");
    for (const id of [project.id, other.id, ...(newProjectId ? [newProjectId] : [])]) {
      const res = await human(`/api/projects/${id}/supervisor`, "DELETE");
      expect([200, 404], res.text).toContain(res.status);
    }
    const restored = await human("/api/supervisor-policy", "PUT", {
      delegate: originalPolicy.delegate,
      note: originalPolicy.note,
      patrolHours: originalPolicy.patrolHours,
      limits: originalPolicy.limits,
      timeZone: originalPolicy.timeZone ?? null,
    });
    expect(restored.status, restored.text).toBe(200);
  }
});
