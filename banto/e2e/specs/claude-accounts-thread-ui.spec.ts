// **会話の中の Claude のアカウントの印——画面**（Backlog #404 `mca-ui-thread`、`docs/specs/v4-frontend.md` §6.46「会話の中」
// 「受信箱」）。仕組み（選ぶ・切り替える・自動で続ける）は claude-accounts-switch.spec.ts・rate-limit-continue.spec.ts が
// HTTP と記録で見ている。ここは人が見る画面。
//
// 偽の Runner（`relayRequests`）が会話の本体と同じ道で中継に `/v1/messages` を送り、中継の上流は偽の API
// （`fake-anthropic.ts`——トークンごとに使用率の見出しを付ける）。本物の CLI は起こさない。アカウントを足すので自前の host。
//
// 見るもの（規則14——画面が出している文・時刻・数まで、その操作が影響するところ全部）：
//   1. 切り替えの1行：host が 5時間 97% と返したら次の要求は B。会話に薄い1行（前のアカウント名と率）
//   2. warn の形：B も 98% と分かったら、一番早くリセットされる host へ戻る——warn の色の1行
//   3. 全部越えの受信箱のカード：題・並びと続けているもの・リセットの時刻・アカウントごとのメーター（率と越えた印）・
//      自動で閉じる一言・Project の設定への道
//   4. 上限で止まったターン：会話の終わりの帯・入力欄の上の待ちの帯（時刻・残り）・サイドバーの1行。残りは1分ごとに描き直す。
//      「待つのをやめる」で帯もサイドバーの1行も消える（host も待たない）。次の待ちで「今すぐ続ける」→帯が消え、続きのターンが
//      走って終わる（会話の終わりの帯も消える）
//   5. host のリセットを過ぎたら、全部越えのカードが（人が押さなくても）受信箱から消える
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn, openApp } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic } from "../fake-anthropic.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

/** E2E の core と同じ最初の1つの置き場のトークン（`start-core.ts`） */
const HOST_TOKEN = "e2e-not-a-token";
const HOST_LABEL = "このマシンの Claude Code のログイン";
const B_LABEL = "b@example.com";
const CARD_TITLE = "Claude のアカウントが全部、閾値を越えました";

interface HostThread {
  messages: Array<{ role: string; text: string }>;
  accountSwitches?: Array<{ from: string; to: string; allOver?: true }>;
  lastTurn?: { outcome?: string; continuesReason?: string; rateLimit?: { continueAt?: string }; continuationCancelled?: string };
}

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** 人のセッションで（アカウントを足すのは人だけ） */
async function human<T>(page: Page, host: OwnHost, path: string, data?: unknown): Promise<T> {
  const res = await page.context().request.fetch(`${host.url}${path}`, {
    method: "POST",
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  expect(res.status(), text).toBe(200);
  return JSON.parse(text) as T;
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** ターンを1本最後まで（流れの中に error が無いことも見る） */
async function send(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(200);
  expect(text, "ターンが error で終わった").not.toContain('"type":"error"');
}

const secondsFromNow = (s: number) => Math.floor(Date.now() / 1000) + s;

/** 画面と同じ書き方の時刻（ブラウザの時間帯で） */
const clockIn = (page: Page, iso: string) =>
  page.evaluate((v) => new Date(v).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false }), iso);

test("切り替えの1行（warn の形も）・全部越えのカードと自動で閉じる・待ちの帯の残り時間と2つのボタン・サイドバーの1行", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-mca-ui-"));
  try {
    await withOwnHost(
      async (own) => {
        await login(page, own);
        // ---- アカウント B を足す（画面と同じ口） -------------------------------------------------------------
        fakeApi.addLogin("code-b", { accessToken: "tok-b", email: B_LABEL });
        const started = await human<{ loginId: string; url: string }>(page, own, "/api/claude-accounts/login");
        const state = new URL(started.url).searchParams.get("state");
        await human(page, own, `/api/claude-accounts/login/${started.loginId}`, { pasted: `code-b#${state}` });

        const projectName = "E2E アカウントの画面";
        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: projectName, root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const threadOf = async () => (await api<HostThread>(own, `/api/threads/${threadId}`)).body;
        // 最初のターンは Project の用意（コンテナ・Module）を含んで遅い——リセットの時刻を決める前に済ませておく（中継は呼ばない）
        await send(own, threadId, "はじめまして");

        await openApp(page, own.url);
        await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
        await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
        const lines = page.getByTestId("thread-account-switch");
        /** 開き直して、記録から組んだ会話を出す（繋いだときの hello も読み直す） */
        const reopen = async () => {
          await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
          await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
        };

        // ---- 1. 切り替えの1行 ------------------------------------------------------------------------------
        // host は 5時間 97%。リセットは少し先——全部越えのカードが閉じるところ（5.）まで、待ちの帯の場面（4.）を挟む
        const hostReset = secondsFromNow(320);
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.97, resetsAt: hostReset } });
        await send(own, threadId, `1回目。${fakeTurn({ relayRequests: 1, say: "はい" })}`);
        // 切り替えるターンは tool も呼ぶ——画面が流れを最後まで読んだターンに印を足しても、組み直さない（tool のカードを消さない）
        await send(
          own,
          threadId,
          `2回目。${fakeTurn({ relayRequests: 1, tools: [{ server: "filesystem", name: "listDirectory", args: { path: "." } }], say: "はい" })}`,
        );
        await expect.poll(async () => (await threadOf()).accountSwitches?.length ?? 0, { timeout: 15_000 }).toBe(1);
        await expect(lines).toHaveCount(1, { timeout: 15_000 });
        await expect(lines.first()).toHaveText(`Claude のアカウントを「${B_LABEL}」に切り替えました（${HOST_LABEL}の5時間 97%）`);
        await expect(lines.first()).not.toHaveAttribute("data-all-over");
        await expect(lines.first()).toHaveClass(/text-ink-3/);
        // 流れた tool のカードは残っている（印を足すために組み直していない）
        await expect(page.getByRole("button", { name: /tool calls?$/ })).toHaveCount(1);

        // ---- 2. warn の形：B も越えた → 一番早くリセットされる host で続ける ------------------------------------------
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.98, resetsAt: secondsFromNow(7200) } });
        await send(own, threadId, `3回目。${fakeTurn({ relayRequests: 1, say: "はい" })}`); // B が 98% と分かる
        await send(own, threadId, `4回目。${fakeTurn({ relayRequests: 1, say: "はい" })}`); // 全部越え：host へ
        await expect.poll(async () => (await threadOf()).accountSwitches?.map((s) => !!s.allOver), { timeout: 15_000 }).toEqual([false, true]);
        await expect(lines).toHaveCount(2, { timeout: 15_000 });
        await expect(lines.nth(1)).toHaveText(`並びのアカウントがどれも閾値を越えています。一番早くリセットされる「${HOST_LABEL}」で続けます`);
        await expect(lines.nth(1)).toHaveAttribute("data-all-over", "");
        await expect(lines.nth(1)).toHaveClass(/text-warn/);
        // 置き場所：切り替えた要求を出したターンの人の発言のすぐ後（2回目のあとに1行目、4回目のあとに2行目）
        const order = await page.evaluate(() => {
          const text = document.body.innerText;
          return ["1回目。", "2回目。", "に切り替えました", "3回目。", "4回目。", "どれも閾値を越えています"].map((t) => text.indexOf(t));
        });
        expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
        expect([...order].sort((a, b) => a - b), "切り替えの1行が起きた場所に出ていない").toEqual(order);
        // どちらの1行も、切り替えたターンの人の発言のすぐ後（AI の返事より前）。組み直さずに足した画面でも、開き直した画面でも
        // 同じ場所（記録の置き場所と同じ）
        const placement = () =>
          page.evaluate(() => {
            const text = document.body.innerText;
            const rightAfter = (user: string, line: string) => {
              const u = text.indexOf(user);
              const l = text.indexOf(line);
              return u >= 0 && l > u && !/\nはい(\n|$)/.test(text.slice(u, l));
            };
            return { line1: rightAfter("2回目。", "に切り替えました"), line2: rightAfter("4回目。", "どれも閾値を越えています") };
          });
        expect(await placement(), "流れを読んだ画面で、切り替えの1行が人の発言のすぐ後に無い").toEqual({ line1: true, line2: true });
        await reopen();
        await expect(lines).toHaveCount(2, { timeout: 15_000 });
        expect(await placement(), "開き直したら切り替えの1行の場所が動いた").toEqual({ line1: true, line2: true });
        // 右上の文脈のメーターに、いま使っているアカウント（全部越えで戻った host）と5時間・週の率（§6.46）。越えた率は warn
        const chip = page.getByTestId("claude-account-chip").first();
        await expect(chip.getByTestId("claude-account-chip-name")).toHaveText("~/.claude", { timeout: 15_000 });
        const fiveHour = chip.getByTestId("claude-account-chip-usage").locator("span").first();
        await expect(fiveHour).toHaveText("97%");
        await expect(fiveHour).toHaveClass(/text-warn/);
        // 開くと名前と2本のメーター
        await chip.click();
        const section = page.getByTestId("claude-account-section");
        await expect(section).toContainText("このマシンの Claude Code のログイン");
        await expect(section).toContainText("97%");
        await page.keyboard.press("Escape");
        await expect(lines.first()).toHaveText(`Claude のアカウントを「${B_LABEL}」に切り替えました（${HOST_LABEL}の5時間 97%）`);
        // AI の文脈には入れない（画面だけの印）——会話の記録の発言は人とAIの分だけ
        expect((await threadOf()).messages.map((m) => m.role)).toEqual(Array.from({ length: 5 }, () => ["user", "assistant"]).flat());

        // ---- 3. 全部越えの受信箱のカード ------------------------------------------------------------------------
        const hostResetClock = await clockIn(page, new Date(hostReset * 1000).toISOString());
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&overlay=inbox`);
        const inbox = page.getByRole("dialog", { name: "受信箱" });
        const card = inbox.getByTestId("inbox-notice").filter({ has: page.getByTestId("inbox-claude-accounts") });
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        await expect(card.getByTestId("inbox-notice-title")).toHaveText(CARD_TITLE);
        await expect(card.getByTestId("inbox-card-project")).toHaveText(projectName);
        await expect(card).toHaveClass(/border-l-warn/);
        await expect(card.getByTestId("inbox-claude-accounts-detail")).toHaveText(
          `Project ${projectName} の並び（${HOST_LABEL}・${B_LABEL}）はどれも閾値を越えています。` +
            `一番早く ${hostResetClock} にリセットされる「${HOST_LABEL}」で続けています。上限に当たると会話は止まり、リセットのあと自動で続けます。`,
        );
        const meters = card.getByTestId("inbox-claude-accounts-meter");
        await expect(meters).toHaveCount(4);
        await expect(meters.nth(0)).toContainText(`${HOST_LABEL}　5時間97%リセット：${hostResetClock}`);
        await expect(meters.nth(0)).toHaveAttribute("data-over", "");
        await expect(meters.nth(1)).toContainText(`${HOST_LABEL}　週—分かりません`);
        await expect(meters.nth(1)).not.toHaveAttribute("data-over");
        await expect(meters.nth(2)).toContainText(`${B_LABEL}　5時間98%`);
        await expect(meters.nth(2)).toHaveAttribute("data-over", "");
        await expect(meters.nth(3)).toContainText(`${B_LABEL}　週—`);
        await expect(card).toContainText("どれかが閾値の下に戻ったら、このカードは自動で閉じます。");
        // 並びを直す入口：Project 設定の「Claude のアカウント」と、banto 全体の設定の「アカウントを足す」
        const projectSettings = card.getByTestId("inbox-claude-accounts-project-settings");
        const addAccount = card.getByTestId("inbox-claude-accounts-add");
        await expect(projectSettings).toHaveText("Project の設定を開く");
        await expect(projectSettings).toHaveAttribute("href", `/settings?project=${projectId}&section=project-claude-accounts`);
        await expect(addAccount).toHaveText("アカウントを足す");
        await expect(addAccount).toHaveAttribute("href", "/settings?section=claude-accounts&add=1");
        // 押した先が、その画面になっている（足すダイアログが開いた banto 全体の設定・Project の並びの画面）
        await addAccount.click();
        const addDialog = page.getByTestId("claude-account-login-dialog");
        await expect(addDialog.getByRole("heading", { name: "Claude のアカウントを足す" }), "「アカウントを足す」で足すダイアログが開かない").toBeVisible({
          timeout: 30_000,
        });
        await expect(addDialog.getByTestId("claude-account-login-open"), "足すダイアログが手続きを始めていない").toBeVisible();
        await expect(page.getByTestId("claude-accounts-panel")).toBeVisible();
        // 閉じたら URL から外れる——読み直しても開き直さない
        await addDialog.getByRole("button", { name: "キャンセル" }).click();
        await expect(addDialog).toHaveCount(0);
        await expect.poll(() => new URL(page.url()).searchParams.has("add"), { message: "閉じても URL に add が残る" }).toBe(false);
        expect(new URL(page.url()).searchParams.get("section")).toBe("claude-accounts");
        await page.reload();
        await expect(page.getByTestId("claude-accounts-panel")).toBeVisible({ timeout: 30_000 });
        await expect(addDialog).toHaveCount(0);
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&overlay=inbox`);
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        await card.getByTestId("inbox-claude-accounts-project-settings").click();
        await expect(page.getByTestId("project-claude-accounts-panel"), "「Project の設定を開く」の先が並びの画面でない").toBeVisible({ timeout: 30_000 });
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&overlay=inbox`);
        await expect(card).toHaveCount(1, { timeout: 30_000 });
        // 本文の文だけを出す形にはしていない（並び・メーターで組んでいる）
        await expect(card.getByText("のどれも、使用率が閾値")).toHaveCount(0);

        // ---- 4. 上限で止まったターン：待ちの帯・サイドバーの1行・2つのボタン ----------------------------------------
        await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
        await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
        const banner = page.getByTestId("thread-rate-limit-wait");
        const when = page.getByTestId("thread-rate-limit-wait-when");
        const sidebarLine = page.getByTestId("thread-rate-limit-waiting");
        const stoppedBand = page.getByTestId("thread-rate-limit-stopped");
        await expect(banner).toHaveCount(0);
        await expect(stoppedBand).toHaveCount(0);

        // 4a. 2分半後に戻る上限——残りが1分ごとに描き直されるのを見て、「待つのをやめる」
        await send(own, threadId, `作って。${fakeTurn({ rateLimit: { resetInMs: 150_000 } })}`);
        let continueAt = (await threadOf()).lastTurn?.rateLimit?.continueAt;
        expect(continueAt, "待ちの時刻が無い").toBeTruthy();
        let clock = await clockIn(page, continueAt!);
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await expect(banner).toHaveAttribute("data-continue-at", continueAt!);
        const remaining = () => Math.ceil((Date.parse(continueAt!) - Date.now()) / 60_000);
        await expect(when).toHaveText(new RegExp(`^${clock} に自動で続けます（あと [${remaining() - 1}-${remaining()}]分）$`));
        await expect(banner).toContainText("上限が戻ったら、止まったところから続けます。何か送ると、待たずにその発言で始めます。");
        await expect(banner.getByTestId("thread-rate-limit-continue")).toHaveText("今すぐ続ける");
        await expect(banner.getByTestId("thread-rate-limit-cancel")).toHaveText("待つのをやめる");
        await expect(stoppedBand).toHaveText("Claude の使用量の上限に当たったので、このターンは途中で止まりました。");
        await expect(sidebarLine).toHaveCount(1);
        await expect(sidebarLine).toHaveText(`上限が戻るのを待っています（${clock}）`);
        // 人の番の色にはしない
        await expect(sidebarLine).toHaveClass(/text-ink-3/);
        // 1分ごとに描き直す：いまの残りから1分減る
        const before = Number((await when.textContent())!.match(/あと (\d+)分/)![1]);
        await expect(when).toHaveText(new RegExp(`あと ${before - 1}分`), { timeout: 70_000 });
        await banner.getByTestId("thread-rate-limit-cancel").click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect(sidebarLine).toHaveCount(0);
        expect((await threadOf()).lastTurn?.continuationCancelled, "押したのに host が待ちをやめていない").toBe("human");
        // 止まったことは残る（待ちはやめた）
        await expect(stoppedBand).toBeVisible();

        // 4b. 1時間後に戻る上限——「今すぐ続ける」で、帯が消えて続きのターンが走る
        await send(own, threadId, `もう一度。${fakeTurn({ rateLimit: { resetInMs: 3_600_000 } })}`);
        continueAt = (await threadOf()).lastTurn?.rateLimit?.continueAt;
        clock = await clockIn(page, continueAt!);
        await expect(banner).toHaveAttribute("data-continue-at", continueAt!, { timeout: 15_000 });
        await expect(when).toHaveText(new RegExp(`^${clock} に自動で続けます（あと (1時間0分|59分)）$`));
        await expect(sidebarLine).toHaveText(`上限が戻るのを待っています（${clock}）`);
        // 開き直しても出る（繋いだときの hello が待ちを渡す）
        await reopen();
        await expect(banner).toHaveAttribute("data-continue-at", continueAt!, { timeout: 15_000 });
        await expect(sidebarLine).toHaveText(`上限が戻るのを待っています（${clock}）`);
        await expect(stoppedBand).toBeVisible();
        await banner.getByTestId("thread-rate-limit-continue").click();
        await expect(banner).toHaveCount(0, { timeout: 15_000 });
        await expect(sidebarLine).toHaveCount(0);
        await expect
          .poll(async () => {
            const t = await threadOf();
            return `${t.lastTurn?.continuesReason}:${t.lastTurn?.outcome ?? "running"}:${t.messages.at(-1)?.text}`;
          }, { timeout: 60_000, message: "今すぐ続けたのに続きのターンが終わらない" })
          .toBe("rate_limit:completed:はい");
        // 続けたら会話の終わりの帯も消える（最後のターンは上限で終わっていない）
        await expect(stoppedBand).toHaveCount(0, { timeout: 15_000 });
        await expect(banner).toHaveCount(0);
        // 切り替えの1行は残っている
        await expect(lines).toHaveCount(2);

        // 4c. 続けて上限に当たり続ける——6回続けたところで、自動で続けるのをやめたと会話に出す（待ちの帯の代わり）
        await send(own, threadId, `まだやって。${fakeTurn({ rateLimit: { resetInMs: 0, times: 7 } })}`);
        await expect
          .poll(async () => (await api<{ rateLimitStop?: string }>(own, `/api/threads/${threadId}`)).body.rateLimitStop, {
            timeout: 90_000,
            message: "6回続けたのに自動で続けるのをやめない",
          })
          .toBe("gave_up");
        await expect(stoppedBand).toHaveAttribute("data-stop", "gave_up", { timeout: 15_000 });
        await expect(stoppedBand.getByTestId("thread-rate-limit-gave-up")).toHaveText(
          "続けて上限に当たったので、自動で続けるのをやめました。続けるなら、受信箱のカードの「続ける」を押すか、この会話で次を送ってください。",
        );
        await expect(banner).toHaveCount(0);
        await expect(sidebarLine).toHaveCount(0);
        // 開き直しても同じ（記録から導く）
        await reopen();
        await expect(stoppedBand.getByTestId("thread-rate-limit-gave-up")).toBeVisible({ timeout: 15_000 });
        await expect(banner).toHaveCount(0);

        // 4d. Clear する——畳んだターンには「止まった」帯も待ちの帯も出さない。切り替えの1行は記録にあるまま残る
        //     （Clear の直後も、開き直したあとも）
        await page.getByRole("button", { name: "Thread の操作" }).last().click();
        await page.getByRole("menuitem", { name: "Clear" }).click();
        const clearMarker = page.locator('[data-testid="thread-marker"][data-kind="clear"]');
        await expect(clearMarker, "Clear の横線が会話に出ていない").toBeVisible({ timeout: 15_000 });
        expect((await api<{ rateLimitStop?: string }>(own, `/api/threads/${threadId}`)).body.rateLimitStop, "畳んだターンに止まった印が残った").toBeUndefined();
        await expect(stoppedBand, "Clear の直後に止まった帯が残った").toHaveCount(0);
        await expect(banner).toHaveCount(0);
        await expect(sidebarLine).toHaveCount(0);
        // 4c で発言が増え、最初の発言は窓の外（最新の 20 件だけ描く）——前を開いてから数える
        const showAllEarlier = async () => {
          const earlier = page.getByTestId("show-earlier-messages");
          while ((await earlier.count()) > 0) await earlier.click();
        };
        await showAllEarlier();
        await expect(lines, "Clear の直後に切り替えの1行が消えた").toHaveCount(2);
        await reopen();
        await expect(clearMarker).toBeVisible({ timeout: 15_000 });
        await showAllEarlier();
        await expect(lines, "開き直したら切り替えの1行が消えた").toHaveCount(2);
        expect(await placement(), "開き直したら切り替えの1行の場所が動いた").toEqual({ line1: true, line2: true });
        await expect(stoppedBand, "開き直したら Clear の横線の下に止まった帯が出た").toHaveCount(0);
        await expect(banner).toHaveCount(0);
        await expect(sidebarLine).toHaveCount(0);

        // ---- 5. host のリセットを過ぎたら、全部越えのカードは自動で閉じる -------------------------------------------
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&overlay=inbox`);
        await expect(inbox).toBeVisible({ timeout: 30_000 });
        expect(Date.now(), "ここまでが遅く、host のリセットを過ぎてしまった（カードが出ていたことを画面で見られていない）").toBeLessThan(hostReset * 1000);
        await expect(card).toHaveCount(1, { timeout: 15_000 });
        await expect(card, "host のリセットを過ぎても全部越えのカードが閉じない").toHaveCount(0, {
          timeout: Math.max(0, hostReset * 1000 - Date.now()) + 30_000,
        });
        expect(JSON.stringify((await api<unknown>(own, "/api/inbox")).body)).not.toContain(CARD_TITLE);
      },
      {
        env: {
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_CLAUDE_PROFILE_URL: `${fakeApi.url}/api/oauth/profile`,
          BANTO_TEST_RATE_LIMIT_MARGIN_MS: "0",
        },
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(root, { recursive: true, force: true });
  }
});
