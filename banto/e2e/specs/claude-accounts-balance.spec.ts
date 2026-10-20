// **Claude のアカウントを均す**（Backlog #417 `balance-core`、`docs/specs/v4-security.md` §2「均す」）。
//
// 本物の CLI（会話の本体）を偽の上流（`fake-anthropic.ts`——トークンごとに使用率の見出しを付け、要求のセッションの印を
// とっておく）に当てる。アカウントを足すので自前の host（`own-host.ts`）。使い方は既定（均す）のまま。
//
// 見るもの（規則14——どのアカウントがどのセッションに答えたか・記録・口の中身まで）：
//   1. 2つの会話が別のアカウントに固定される：host が重くなったあとに始めた会話は余裕のある B へ
//   2. 同じ会話は同じアカウント：host が B より重くなっても、host に固定した会話のセッションの要求は全部 host
//   3. 閾値越えで移る：host が 97% と返したら、その会話の次の要求から B。切り替えはその会話に1件
//   4. 切り替えの1行は選び直しでは出ない：最初の選び（2つ目の会話が B を選んだ）では1行も出ない
//   5. 口：その会話の固定先（`GET /api/threads/:id/claude-account`）・Project の使い方と固定先・設定の「いま使っている Project」
//
// 2つ目の試験は画面（Backlog #418 `balance-ui`、v4-frontend.md §6.46「使い方」「右上の文脈のメーター」）：
//   6. 使い方の2択の保存（banto 全体・Project）と、説明文の切り替わり（上の一言・既定の並び・Project の上の一言）
//   7. 均すとき、2つの会話の右上のメーターがそれぞれの固定先を出す。まだ固定の無い会話には何も足さない
//   8. 設定の「直近1時間に使った Project」
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic, type FakeAnthropic } from "../fake-anthropic.js";
import { openApp, openProjectSettings } from "../helpers.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

/** 試験を流している側の Claude Code の環境（本物の CLI に持ち込まない） */
const OUTER_CLAUDE_ENV = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|ANTHROPIC_.*)$/.test(k));
/** E2E の core と同じ最初の1つの置き場のトークン（`start-core.ts`） */
const HOST_TOKEN = "e2e-not-a-token";

interface Switch {
  from: string;
  to: string;
  reason: { kind: string; window?: string; utilization?: number };
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
async function human<T>(page: Page, host: OwnHost, method: "GET" | "POST" | "PUT", path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await page.context().request.fetch(`${host.url}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** ターンを1本最後まで。SSE の終わりまで読む */
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
}

const secondsFromNow = (s: number) => Math.floor(Date.now() / 1000) + s;

/** 本物の CLI を偽の API に当てる環境（会話の本体は中継を通る。偽の API は中継の上流・取り直しの口・プロフィールの口・使用率の口） */
function realCliEnv(fakeApi: FakeAnthropic, securestorage: string) {
  return {
    unsetEnv: OUTER_CLAUDE_ENV,
    env: {
      BANTO_FAKE_RUNNER: "",
      BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
      BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
      BANTO_CLAUDE_PROFILE_URL: `${fakeApi.url}/api/oauth/profile`,
      BANTO_CLAUDE_USAGE_URL: `${fakeApi.url}/api/oauth/usage`,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: securestorage,
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  };
}

/** アカウント B を足す（画面と同じ口）。B の id を返す */
async function addAccountB(page: Page, own: OwnHost, fakeApi: FakeAnthropic): Promise<string> {
  fakeApi.addLogin("code-b", { accessToken: "tok-b", email: "b@example.com" });
  const started = await human<{ loginId: string; url: string }>(page, own, "POST", "/api/claude-accounts/login");
  const state = new URL(started.body.url).searchParams.get("state");
  const finished = await human<{ account: { id: string } }>(page, own, "POST", `/api/claude-accounts/login/${started.body.loginId}`, { pasted: `code-b#${state}` });
  expect(finished.status, JSON.stringify(finished.body)).toBe(200);
  return finished.body.account.id;
}

test("均す：2つの会話が別のアカウントに固定され、同じ会話は同じアカウント、閾値越えで移る。最初の選びは切り替えの1行にならない", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-balance-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-balance-root-"));
  try {
    await withOwnHost(
      async (own) => {
        await login(page, own);
        // ---- アカウント B を足す（画面と同じ口） ----------------------------------------------------------------
        const bId = await addAccountB(page, own, fakeApi);
        const nameOf = (id: string) => (id === bId ? "b" : id);
        const tokenName: Record<string, string> = { [HOST_TOKEN]: "host", "tok-b": "b" };
        // 既定は均す
        const listed = await human<{ mode: string; defaultOrder: string[] }>(page, own, "GET", "/api/claude-accounts");
        expect(listed.body).toMatchObject({ mode: "balance", defaultOrder: ["host", bId] });

        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: "E2E 均す", root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const projectView = await human<{ mode: string | null; effectiveMode: string }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(projectView.body).toMatchObject({ mode: null, effectiveMode: "balance" });
        const newThread = async () => (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const t1 = await newThread();
        const t2 = await newThread();
        const pinnedOf = async (threadId: string) => (await api<{ accountId?: string }>(own, `/api/threads/${threadId}/claude-account`)).body.accountId;
        const switchesOf = async (threadId: string) =>
          ((await api<{ accountSwitches?: Switch[] }>(own, `/api/threads/${threadId}`)).body.accountSwitches ?? []).map(
            (s) => `${nameOf(s.from)}→${nameOf(s.to)} ${s.reason.kind}${s.reason.window ? ` ${s.reason.window} ${s.reason.utilization}` : ""}`,
          );
        /** その文を最後の user の発言に持つ要求（会話の要求） */
        const requestOf = (said: string) => fakeApi.requests.filter((r) => [...r.messages].reverse().find((m) => m.role === "user")?.text.includes(said)).at(-1);
        expect(await pinnedOf(t1), "まだ送っていない会話に固定先がある").toBeUndefined();

        // 使用率：host 20%・B 25%（選ぶ前の読み直しでも同じ値が返る）
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.2, resetsAt: secondsFromNow(4 * 3600) } });
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.25, resetsAt: secondsFromNow(4 * 3600) } });

        // ---- 1. 会話1は余裕のある host に固定 -----------------------------------------------------------------------
        await sendTurn(own, t1, "会話1の1回目。合言葉は one-1");
        const s1 = requestOf("合言葉は one-1")?.session;
        expect(s1, "会話の要求にセッションの印が無い").toBeTruthy();
        expect(requestOf("合言葉は one-1")?.auth).toBe(`Bearer ${HOST_TOKEN}`);
        expect(await pinnedOf(t1)).toBe("host");
        // host が人の claude で 50% まで使われた（会話1の次の要求の見出しで分かる）
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.5, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, t1, "会話1の2回目。合言葉は two-2");
        expect(requestOf("合言葉は two-2")?.auth, "同じ会話なのに host から動いた").toBe(`Bearer ${HOST_TOKEN}`);

        // ---- 2. 会話2は余裕のある B に固定 ------------------------------------------------------------------------
        await sendTurn(own, t2, "会話2の1回目。合言葉は three-3");
        const s2 = requestOf("合言葉は three-3")?.session;
        expect(s2).toBeTruthy();
        expect(s2, "2つの会話が同じセッションの印").not.toBe(s1);
        expect(requestOf("合言葉は three-3")?.auth, "host が 50% なのに会話2が B（25%）に固定されていない").toBe("Bearer tok-b");
        expect(await pinnedOf(t2)).toBe(bId);
        // ---- 同じ会話は同じアカウント：host のほうが重くても会話1は host のまま（キャッシュを崩さない） --------------------
        await sendTurn(own, t1, "会話1の3回目。合言葉は four-4");
        expect(requestOf("合言葉は four-4")?.auth, "会話1が固定先の host から動いた").toBe(`Bearer ${HOST_TOKEN}`);
        // 会話1のセッションの要求は全部 host、会話2のは全部 B（count_tokens も）
        const servedFor = (session: string | null | undefined) => [...new Set(fakeApi.replies.filter((r) => r.session === session).map((r) => tokenName[r.token] ?? r.token))];
        expect(servedFor(s1)).toEqual(["host"]);
        expect(servedFor(s2)).toEqual(["b"]);

        // ---- 4. 最初の選びは切り替えの1行にならない ---------------------------------------------------------------
        expect(await switchesOf(t1)).toEqual([]);
        expect(await switchesOf(t2)).toEqual([]);

        // 口：Project の固定先は両方・設定の「いま使っている Project」は両方のアカウントの下
        const pinnedView = await human<{ effectiveMode: string; pinnedAccounts?: string[]; currentAccount?: string }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(pinnedView.body.pinnedAccounts).toEqual(["host", bId]);
        expect(pinnedView.body.currentAccount).toBeUndefined();
        const usedBy = await human<{ accounts: Array<{ id: string; usedBy: Array<{ projectId: string; name: string }> }> }>(page, own, "GET", "/api/claude-accounts");
        expect(usedBy.body.accounts.map((a) => [nameOf(a.id), a.usedBy.map((u) => u.name)])).toEqual([
          ["host", ["E2E 均す"]],
          ["b", ["E2E 均す"]],
        ]);

        // ---- 3. 閾値越えで移る -----------------------------------------------------------------------------------
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.97, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, t1, "会話1の4回目。合言葉は five-5"); // host が 97% と返す
        await sendTurn(own, t1, "会話1の5回目。合言葉は six-6");
        expect(requestOf("合言葉は six-6")?.auth, "host が 97% と返したのに会話1が B へ移っていない").toBe("Bearer tok-b");
        expect(requestOf("合言葉は six-6")?.session, "移ってもセッションは同じ").toBe(s1);
        expect(await pinnedOf(t1)).toBe(bId);
        await expect.poll(() => switchesOf(t1), { timeout: 15_000 }).toEqual(["host→b threshold 5h 0.97"]);
        // 会話2は何も変わらない（記録は固定の鍵ごと）
        await sendTurn(own, t2, "会話2の2回目。合言葉は seven-7");
        expect(requestOf("合言葉は seven-7")?.auth).toBe("Bearer tok-b");
        expect(await switchesOf(t2)).toEqual([]);
        // 上流には Thread の印を流さない
        expect(fakeApi.requests.filter((r) => r.threadHeader !== null)).toEqual([]);
      },
      realCliEnv(fakeApi, securestorage),
    );
  } finally {
    await fakeApi.close();
    rmSync(securestorage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const PROJECT_UI = "E2E 均すの画面";

/** 設定の左の一覧の「Claude のアカウント」——banto 全体が先、Project の層が後（同じ名前が2つ並ぶ） */
async function openSection(page: Page, layer: "global" | "project"): Promise<void> {
  await openProjectSettings(page);
  const buttons = page.getByRole("button", { name: "Claude のアカウント", exact: true });
  await expect(buttons).toHaveCount(2);
  await (layer === "global" ? buttons.first() : buttons.last()).click();
  await expect(page.getByTestId(layer === "global" ? "claude-accounts-panel" : "project-claude-accounts-panel")).toBeVisible({ timeout: 20_000 });
}

test("画面：使い方の2択の保存（banto 全体・Project）と説明文の切り替わり・右上のメーターはその会話の固定先・直近1時間に使った Project", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-balance-ui-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-balance-ui-root-"));
  try {
    await withOwnHost(
      async (own) => {
        await login(page, own);
        const bId = await addAccountB(page, own, fakeApi);
        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: PROJECT_UI, root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const base = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        // 2つ目の会話は、まっさらな Fork（親の固定を継がない——会話を引き継がないので）
        const fork = await api<{ id: string }>(own, `/api/threads/${base}/fork`, { method: "POST", body: { fresh: true, title: "二つ目" } });
        expect(fork.status, JSON.stringify(fork.body)).toBe(201);
        const forkId = fork.body.id;

        // ---- 7. 2つの会話をそれぞれ host と B に固定する（host 20%・B 25% で base が host、host 50% になってから Fork が B） ----
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.2, resetsAt: secondsFromNow(4 * 3600) } });
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.25, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, base, "base の1回目");
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.5, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, base, "base の2回目"); // host が 50% と分かる
        const pinnedOf = async (threadId: string) => (await api<{ accountId?: string }>(own, `/api/threads/${threadId}/claude-account`)).body.accountId;
        expect(await pinnedOf(base)).toBe("host");
        expect(await pinnedOf(forkId), "まだ送っていない Fork に固定先がある").toBeUndefined();

        await openApp(page, own.url);
        const meter = page.getByRole("button", { name: /^文脈使用量/ }).first();
        const chip = page.locator('[data-testid="claude-account-chip"]:visible');
        // まだ固定の無い会話（Fork）には何も足さない——隣の会話の host を出さない
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&fork=${forkId}`);
        await expect(page.locator("textarea[placeholder*=\"に送る\"]:visible").first()).toBeVisible({ timeout: 30_000 });
        await expect(meter).toBeVisible();
        await page.waitForTimeout(1_500); // 最初の取り直し（時計の 0ms）が済むのを待ってから「無い」を見る
        await expect(chip).toHaveCount(0);

        await sendTurn(own, forkId, "Fork の1回目");
        expect(await pinnedOf(forkId), "host が 50% なのに Fork が B（25%）に固定されていない").toBe(bId);

        // base の画面：host（~/.claude・5時間 50%・週 —）
        await page.goto(`/p/${projectId}?bantoHost=${own.url}`);
        await expect(page.locator("textarea[placeholder*=\"に送る\"]:visible").first()).toBeVisible({ timeout: 30_000 });
        await expect(chip.getByTestId("claude-account-chip-name")).toHaveText("~/.claude", { timeout: 15_000 });
        await expect(chip.getByTestId("claude-account-chip-usage")).toHaveText("50%/—");
        await chip.click();
        await expect(page.getByTestId("claude-account-section")).toContainText("このマシンの Claude Code のログイン");
        await page.keyboard.press("Escape");
        // Fork の画面：B（b・5時間 25%・週 —）
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&fork=${forkId}`);
        await expect(page.locator("textarea[placeholder*=\"に送る\"]:visible").first()).toBeVisible({ timeout: 30_000 });
        await expect(chip.getByTestId("claude-account-chip-name")).toHaveText("b", { timeout: 15_000 });
        await expect(chip.getByTestId("claude-account-chip-usage")).toHaveText("25%/—");
        await chip.click();
        await expect(page.getByTestId("claude-account-section")).toContainText("b@example.com");
        await page.keyboard.press("Escape");

        // ---- 6. banto 全体の使い方：既定は均す、説明文も均すの文 --------------------------------------------------
        await openSection(page, "global");
        const panel = page.getByTestId("claude-accounts-panel");
        const lead = panel.getByTestId("claude-accounts-lead");
        const orderNote = panel.getByTestId("claude-accounts-default-order-note");
        await expect(panel.getByTestId("claude-accounts-mode-balance").getByRole("radio")).toBeChecked();
        await expect(panel.getByTestId("claude-accounts-mode-ordered").getByRole("radio")).not.toBeChecked();
        await expect(panel.getByTestId("claude-accounts-mode-balance")).toHaveText("均す新しい会話ごとに、並びの中で余裕のあるアカウントを選ぶ（既定）");
        await expect(panel.getByTestId("claude-accounts-mode-ordered")).toHaveText("上から順に並びの先頭から、閾値まで使う");
        await expect(lead).toContainText("会話ごとに余裕のあるアカウントを選び、閾値を越えたら移ります。");
        await expect(lead).not.toContainText("並びの次のアカウントに切り替えます");
        await expect(orderNote).toHaveText(
          "Project で並びを決めていなければ、この中から、新しい会話ごとに余裕のあるものを選びます。同じ余裕なら上を先に使います。",
        );
        // ---- 8. 直近1時間に使った Project（両方のアカウントの下に同じ Project） ----------------------------------------
        const usedBy = (id: string) => panel.locator(`[data-testid="claude-account-row"][data-account-id="${id}"]`).getByTestId("claude-account-used-by");
        await expect(usedBy("host")).toHaveText(`人の claude コマンドと共有しています。直近1時間に使った Project：${PROJECT_UI}`);
        await expect(usedBy(bId)).toHaveText(`直近1時間に使った Project：${PROJECT_UI}`);

        // 上から順にへ：保存され、説明文が上から順にの文に変わる
        await panel.getByTestId("claude-accounts-mode-ordered").click();
        await expect(panel.getByTestId("claude-accounts-mode-ordered").getByRole("radio")).toBeChecked();
        await expect.poll(async () => (await human<{ mode: string }>(page, own, "GET", "/api/claude-accounts")).body.mode).toBe("ordered");
        await expect(lead).toContainText("使用量が閾値を越えると、並びの次のアカウントに切り替えます。");
        await expect(lead).not.toContainText("会話ごとに余裕のあるアカウントを選び");
        await expect(orderNote).toHaveText("Project で並びを決めていなければ、この順で使います。上ほど先に使います。");
        // 開き直しても上から順に（host の台帳から描く）
        await page.reload();
        await expect(page.getByTestId("claude-accounts-mode-ordered").getByRole("radio")).toBeChecked({ timeout: 20_000 });
        await expect(page.getByTestId("claude-accounts-lead")).toContainText("並びの次のアカウントに切り替えます");
        // 均すへ戻す
        await page.getByTestId("claude-accounts-mode-balance").click();
        await expect.poll(async () => (await human<{ mode: string }>(page, own, "GET", "/api/claude-accounts")).body.mode).toBe("balance");
        await expect(page.getByTestId("claude-accounts-lead")).toContainText("会話ごとに余裕のあるアカウントを選び");

        // ---- 6. Project の使い方：banto 全体と同じ（いまは均す）／均す／上から順に --------------------------------------
        await openSection(page, "project");
        const pp = page.getByTestId("project-claude-accounts-panel");
        const projectView = async () => (await human<{ mode: string | null; effectiveMode: string }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`)).body;
        const inherit = pp.getByTestId("project-claude-accounts-use-inherit");
        await expect(inherit).toHaveText("banto 全体と同じ（いまは均す）");
        await expect(inherit.getByRole("radio")).toBeChecked();
        await expect(pp.getByTestId("project-claude-accounts-use-balance")).toHaveText("均す");
        await expect(pp.getByTestId("project-claude-accounts-use-ordered")).toHaveText("上から順に");
        await expect(pp.locator("header")).toContainText("新しい会話ごとに、閾値の下で余裕のあるものを選びます。");
        // 均すの Project は、直近1時間の固定先を出す（並びは既定のまま——1行で）
        await expect(pp.getByTestId("project-claude-accounts-current-line")).toHaveText("直近1時間に使ったアカウント：このマシンの Claude Code のログイン、b@example.com");

        await pp.getByTestId("project-claude-accounts-use-ordered").click();
        await expect(pp.getByTestId("project-claude-accounts-use-ordered").getByRole("radio")).toBeChecked();
        await expect.poll(projectView).toMatchObject({ mode: "ordered", effectiveMode: "ordered" });
        await expect(pp.locator("header")).toContainText("上から順に、閾値の下のものを使います。");
        // banto 全体はそのまま均す
        expect((await human<{ mode: string }>(page, own, "GET", "/api/claude-accounts")).body.mode).toBe("balance");

        await pp.getByTestId("project-claude-accounts-use-balance").click();
        await expect.poll(projectView).toMatchObject({ mode: "balance", effectiveMode: "balance" });
        await expect(pp.locator("header")).toContainText("新しい会話ごとに、閾値の下で余裕のあるものを選びます。");

        await inherit.click();
        await expect(inherit.getByRole("radio")).toBeChecked();
        await expect.poll(projectView).toMatchObject({ mode: null, effectiveMode: "balance" });
      },
      realCliEnv(fakeApi, securestorage),
    );
  } finally {
    await fakeApi.close();
    rmSync(securestorage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
