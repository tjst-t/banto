// **画面：設定「Claude のアカウント」・アカウントを足す・Project の設定**（Backlog #403 `mca-ui-settings`、
// `docs/specs/v4-frontend.md` §6.46・`docs/specs/v4-security.md` §2「Claude のアカウントを複数持つ」）。
//
// アカウントを足して既定の並びを変えるので、E2E の共有の core ではなく自前の host（`own-host.ts`）を使う。上流・token の口・
// profile の口・使用率の口は偽の API（`fake-anthropic.ts`）1つ。会話の本体は本物の CLI で、中継を通って偽の API に当たる
// ——「いま使っている Project」「最近の切り替え」は本物の切り替えから出す。
//
// 見るもの（規則14——押せたかでなく、画面が出している値を1つずつ。host の台帳とも照らす）：
//   1. 一覧とメーター：開いたら使用率を読み直す（偽の口に来る）。率・リセットの時刻・閾値越えの印
//   2. 足すダイアログ：1段目のリンクが認可の URL・押すと2段目が使える・state 違いの文・足せた文。一覧に増える
//   3. 名前を変える・閾値のスライダー（動かしたら保存、読み込み直しても残る、閾値越えの印が変わる）
//   4. 既定の並びの入れ替え（下へ・外す・最後の1つは外せない・並びに足す）。host の台帳と一致
//   5. 本物の切り替えのあと：一覧の「いま使っている Project」、Project の設定の「いま使っています」と最近の切り替え
//   6. Project の並びの選択（決める・外す・既定に戻す）。host と一致
//   7. ログインし直す：違うアカウントが返ったら断る・同じなら置き換え
//   8. 携帯の幅：横にはみ出さない・メーターが名前の下に積まれる
//   9. 外す：確かめのダイアログに並びから消える Project。外すと一覧と Project の並びから消える
import { test, expect, type Page, type Locator } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic } from "../fake-anthropic.js";
import { createProject, currentProjectId, openApp, openProjectSettings } from "../helpers.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

/** 試験を流している側の Claude Code の環境（本物の CLI に持ち込まない） */
const OUTER_CLAUDE_ENV = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|ANTHROPIC_.*)$/.test(k));
/** E2E の最初の1つの置き場のトークン（`start-core.ts`。契約は max） */
const HOST_TOKEN = "e2e-not-a-token";
const HOST_LABEL = "このマシンの Claude Code のログイン";
const PROJECT = "E2E アカウントの設定";

interface Accounts {
  accounts: Array<{ id: string; label: string; email?: string }>;
  defaultOrder: string[];
  thresholds: { fiveHour: number; sevenDay: number };
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

/** 人のセッションで読む（Claude のアカウントの口は人だけ） */
async function human<T>(page: Page, host: OwnHost, path: string): Promise<T> {
  const res = await page.context().request.get(`${host.url}${path}`, { headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as T;
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
const pad = (n: number) => String(n).padStart(2, "0");
/** 画面の「HH:MM」（近いリセット） */
const hhmm = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** 画面の「10月22日（水）9:00」（遠いリセット） */
const farDate = (unix: number) => {
  const d = new Date(unix * 1000);
  return `${d.getMonth() + 1}月${d.getDate()}日（${"日月火水木金土"[d.getDay()]}）${d.getHours()}:${pad(d.getMinutes())}`;
};

/** 設定の左の一覧の「Claude のアカウント」——banto 全体が先、Project の層が後（同じ名前が2つ並ぶ） */
async function openSection(page: Page, layer: "global" | "project"): Promise<void> {
  await openProjectSettings(page);
  const buttons = page.getByRole("button", { name: "Claude のアカウント", exact: true });
  await expect(buttons).toHaveCount(2);
  await (layer === "global" ? buttons.first() : buttons.last()).click();
  await expect(page.getByTestId(layer === "global" ? "claude-accounts-panel" : "project-claude-accounts-panel")).toBeVisible({ timeout: 20_000 });
}

const row = (page: Page, id: string) => page.locator(`[data-testid="claude-account-row"][data-account-id="${id}"]`);

/** 足すダイアログで1段目を押す（新しいタブは偽の claude.ai が受ける）。認可の URL の state を返す */
async function openLoginPage(page: Page, dialog: Locator): Promise<string> {
  const link = dialog.getByTestId("claude-account-login-open");
  await expect(link).toBeVisible({ timeout: 15_000 });
  const href = (await link.getAttribute("href"))!;
  expect(href.startsWith("https://claude.com/cai/oauth/authorize?"), href).toBe(true);
  expect(new URL(href).searchParams.get("scope")).toBe("user:inference user:profile");
  await expect(dialog.getByTestId("claude-account-login-step-1")).toHaveAttribute("data-done", "false");
  await expect(dialog.getByTestId("claude-account-login-code")).toBeDisabled();
  const [tab] = await Promise.all([page.context().waitForEvent("page"), link.click()]);
  await tab.close();
  await expect(dialog.getByTestId("claude-account-login-step-1")).toHaveAttribute("data-done", "true");
  await expect(dialog.getByTestId("claude-account-login-code")).toBeEnabled();
  return new URL(href).searchParams.get("state")!;
}

test("設定「Claude のアカウント」：一覧とメーター・足す・名前・閾値・既定の並び・Project の並び・ログインし直す・携帯の幅・外す", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-mca-ui-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-mca-ui-root-"));
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // 1段目のリンクの先（本物の claude.ai へは出ない）
  await page.context().route("https://claude.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>fake claude.ai</p>" }));
  try {
    await withOwnHost(
      async (own) => {
        const accounts = () => human<Accounts>(page, own, "/api/claude-accounts");
        // 使用率（偽の口が見出しと /api/oauth/usage の両方で返す）。host は近いリセットと遠いリセット
        const hostFive = secondsFromNow(3 * 3600 + 120);
        const hostWeek = secondsFromNow(3 * 86400);
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.41, resetsAt: hostFive }, sevenDay: { utilization: 0.58, resetsAt: hostWeek } });
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.97, resetsAt: secondsFromNow(3600) } });

        await login(page, own);
        await openApp(page, own.url);
        await createProject(page, PROJECT, root);
        const projectId = currentProjectId(page);

        // ---- 1. 一覧とメーター（開いたら使用率を読み直す） -------------------------------------------------------
        await openSection(page, "global");
        const panel = page.getByTestId("claude-accounts-panel");
        await expect(panel.getByTestId("claude-account-row")).toHaveCount(1);
        const hostRow = row(page, "host");
        await expect(hostRow.getByTestId("claude-account-label")).toHaveText(HOST_LABEL);
        await expect(hostRow.getByTestId("claude-account-identity")).toHaveText("~/.claude（Max）");
        await expect(hostRow.getByTestId("claude-account-used-by")).toHaveText("人の claude コマンドと共有しています。いま使っている Project はありません");
        // ~/.claude は外せない・banto からログインし直さない
        await expect(hostRow.getByTestId("claude-account-remove")).toHaveCount(0);
        await expect(hostRow.getByTestId("claude-account-relogin")).toHaveCount(0);
        await expect(hostRow.getByTestId("claude-account-meter-5h-value")).toHaveText("41%", { timeout: 20_000 });
        await expect(hostRow.getByTestId("claude-account-meter-5h-reset")).toHaveText(new RegExp(`^リセット：あと 3時間[0-9]+分（${hhmm(hostFive)}）$`));
        await expect(hostRow.getByTestId("claude-account-meter-5h")).toHaveAttribute("data-over", "false");
        await expect(hostRow.getByTestId("claude-account-meter-7d-value")).toHaveText("58%");
        await expect(hostRow.getByTestId("claude-account-meter-7d-reset")).toHaveText(`リセット：${farDate(hostWeek)}`);
        expect(fakeApi.usageReads, "開いても使用率を読み直していない").toContain(HOST_TOKEN);
        await expect(panel.getByTestId("claude-accounts-read-usage")).toHaveText("使用率を読み直す（いま読みました）");
        // 取り直せる banto なので、本体が今のログインだけを使う帯は出ない
        await expect(panel.getByTestId("claude-accounts-no-refresh")).toHaveCount(0);
        await expect(panel.getByTestId("claude-accounts-threshold-5h-value")).toHaveText("95%");
        await expect(panel.getByTestId("claude-accounts-threshold-7d-value")).toHaveText("95%");

        // ---- 2. 足すダイアログ ------------------------------------------------------------------------------
        fakeApi.addLogin("code-b", { accessToken: "tok-b", email: "b@example.com" });
        await panel.getByTestId("claude-accounts-add").click();
        const dialog = page.getByTestId("claude-account-login-dialog");
        await expect(dialog.getByRole("heading", { name: "Claude のアカウントを足す" })).toBeVisible();
        const state = await openLoginPage(page, dialog);
        // state が合わない（別のタブの写し）：交換に行かず、手続きは残る
        await dialog.getByTestId("claude-account-login-code").fill("code-b#not-this-state");
        await dialog.getByTestId("claude-account-login-submit").click();
        await expect(dialog.getByTestId("claude-account-login-error")).toHaveText(
          "このコードは、いま開いたログインの画面のものではありません。もう一度「ログインの画面を開く」からやり直してください。",
        );
        await dialog.getByTestId("claude-account-login-code").fill(`code-b#${state}`);
        // 足せた直後の文が揺れない——「並びにはまだ入っていません」が一瞬でも出たら覚えておく（待つ側の検査では見逃す）
        await page.evaluate(() => {
          const w = window as unknown as { __notInOrderSeen?: boolean };
          w.__notInOrderSeen = false;
          new MutationObserver(() => {
            if (document.body.textContent?.includes("並びにはまだ入っていません")) w.__notInOrderSeen = true;
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await dialog.getByTestId("claude-account-login-submit").click();
        const done = dialog.getByTestId("claude-account-login-done");
        await expect(done).toContainText("b@example.com（Max）を足しました。");
        await expect(done).toContainText("既定の並びの最後に入りました。順番は「既定の並び」で入れ替えられます。");
        expect(
          await page.evaluate(() => (window as unknown as { __notInOrderSeen?: boolean }).__notInOrderSeen),
          "足せた直後に「並びにはまだ入っていません」が出てから替わった",
        ).toBe(false);
        await expect(done.getByRole("button", { name: "既定の並びの最後に足す" })).toHaveCount(0);
        await done.getByRole("button", { name: "閉じる" }).click();
        await expect(dialog).toHaveCount(0);
        await expect(panel.getByTestId("claude-account-row")).toHaveCount(2);
        const bId = (await accounts()).accounts.find((a) => a.email === "b@example.com")!.id;
        const bRow = row(page, bId);
        await expect(bRow.getByTestId("claude-account-label")).toHaveText("b@example.com");
        await expect(bRow.getByTestId("claude-account-identity")).toHaveText("b@example.com（Max）");
        await expect(bRow.getByTestId("claude-account-used-by")).toHaveText("いま使っている Project はありません");
        // 足したあとも読み直す——閾値（95%）を越えた 97% は warn の印
        await expect(bRow.getByTestId("claude-account-meter-5h-value")).toHaveText("97%", { timeout: 20_000 });
        await expect(bRow.getByTestId("claude-account-meter-5h")).toHaveAttribute("data-over", "true");
        await expect(bRow.getByTestId("claude-account-meter-7d-value")).toHaveText("—");
        await expect(bRow.getByTestId("claude-account-meter-7d-reset")).toHaveText("分かりません（リセットを過ぎたか、まだ使っていません）");

        // ---- 3. 名前・閾値 ---------------------------------------------------------------------------------
        await bRow.getByRole("button", { name: "名前を変える" }).click();
        await bRow.getByTestId("claude-account-label-input").fill("仕事用");
        await bRow.getByTestId("claude-account-label-input").press("Enter");
        await expect(bRow.getByTestId("claude-account-label")).toHaveText("仕事用");
        await expect.poll(async () => (await accounts()).accounts.find((a) => a.id === bId)?.label).toBe("仕事用");

        await panel.getByTestId("claude-accounts-threshold-5h").fill("98");
        await expect(panel.getByTestId("claude-accounts-threshold-5h-value")).toHaveText("98%");
        await expect.poll(async () => (await accounts()).thresholds, { message: "閾値を動かしても保存されない" }).toEqual({ fiveHour: 0.98, sevenDay: 0.95 });
        // 97% は 98% の下——warn の印が外れる
        await expect(bRow.getByTestId("claude-account-meter-5h")).toHaveAttribute("data-over", "false");
        await page.reload();
        await expect(page.getByTestId("claude-accounts-threshold-5h-value")).toHaveText("98%", { timeout: 20_000 });
        await expect(page.getByTestId("claude-accounts-threshold-7d-value")).toHaveText("95%");

        // ---- 4. 既定の並び ---------------------------------------------------------------------------------
        const order = page.getByTestId("claude-accounts-default-order");
        const orderLabels = order.getByTestId("claude-accounts-default-order-label");
        await expect(orderLabels).toHaveText([HOST_LABEL, "仕事用"]);
        await order.getByTestId("claude-accounts-default-order-row").first().getByRole("button", { name: "下へ" }).click();
        await expect(orderLabels).toHaveText(["仕事用", HOST_LABEL]);
        await expect.poll(async () => (await accounts()).defaultOrder).toEqual([bId, "host"]);
        // 外す → 並びに足すボタン。最後の1つは外せない
        await order.locator(`[data-account-id="${bId}"]`).getByRole("button", { name: "並びから外す" }).click();
        await expect(orderLabels).toHaveText([HOST_LABEL]);
        await expect.poll(async () => (await accounts()).defaultOrder).toEqual(["host"]);
        await expect(order.getByRole("button", { name: "並びから外す" })).toBeDisabled();
        await page.getByRole("button", { name: "仕事用を並びに足す" }).click();
        await expect(orderLabels).toHaveText([HOST_LABEL, "仕事用"]);
        await expect.poll(async () => (await accounts()).defaultOrder).toEqual(["host", bId]);
        await expect(page.getByRole("button", { name: "仕事用を並びに足す" })).toHaveCount(0);

        // ---- 5. 本物の切り替え（host が閾値 98% を越える → 仕事用へ） ---------------------------------------------
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.3, resetsAt: secondsFromNow(3600) } });
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        await sendTurn(own, threadId, "はじめまして");
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.99, resetsAt: hostFive }, sevenDay: { utilization: 0.58, resetsAt: hostWeek } });
        await sendTurn(own, threadId, "host が 99% と返す回");
        await sendTurn(own, threadId, "仕事用に替わる回");
        await expect
          .poll(async () => (await human<{ currentAccount?: string; recentSwitches?: unknown[] }>(page, own, `/api/projects/${projectId}/claude-accounts`)).recentSwitches?.length ?? 0, {
            timeout: 15_000,
            message: "host が閾値を越えても切り替えが記録されない",
          })
          .toBeGreaterThan(0);
        await page.reload();
        const panel2 = page.getByTestId("claude-accounts-panel");
        await expect(row(page, bId).getByTestId("claude-account-used-by")).toHaveText(`いま使っている Project：${PROJECT}`, { timeout: 20_000 });
        await expect(row(page, "host").getByTestId("claude-account-used-by")).toHaveText("人の claude コマンドと共有しています。いま使っている Project はありません");
        await expect(row(page, "host").getByTestId("claude-account-meter-5h-value")).toHaveText("99%");
        await expect(row(page, "host").getByTestId("claude-account-meter-5h")).toHaveAttribute("data-over", "true");
        await expect(panel2.getByTestId("claude-account-row")).toHaveCount(2);

        // ---- 6. Project の並び ------------------------------------------------------------------------------
        await openSection(page, "project");
        const pp = page.getByTestId("project-claude-accounts-panel");
        await expect(pp.getByTestId("project-claude-accounts-mode-default").getByRole("radio")).toBeChecked();
        await expect(pp.getByTestId("project-claude-accounts-mode-default-note")).toHaveText(`${HOST_LABEL} → 仕事用`);
        await expect(pp.getByTestId("project-claude-accounts-current-line")).toHaveText("いま使っているアカウント：仕事用");
        const switchLines = pp.getByTestId("project-claude-accounts-switch");
        await expect(switchLines).toHaveCount(1);
        await expect(switchLines.first()).toHaveText(new RegExp(`^今日 \\d+:\\d\\d　${HOST_LABEL} → 仕事用（${HOST_LABEL}の5時間 99%）$`));
        await expect(pp.getByTestId("project-claude-accounts-mixed-plans")).toHaveCount(0);

        await pp.getByTestId("project-claude-accounts-mode-own").click();
        const projectOrder = pp.getByTestId("project-claude-accounts-order");
        await expect(projectOrder.getByTestId("project-claude-accounts-order-label")).toHaveText([HOST_LABEL, "仕事用"]);
        const projectAccounts = () => human<{ order: string[] | null; effectiveOrder: string[] }>(page, own, `/api/projects/${projectId}/claude-accounts`);
        await expect.poll(async () => (await projectAccounts()).order).toEqual(["host", bId]);
        // 行に使用率、いま使っているものに印
        await expect(projectOrder.locator(`[data-account-id="host"]`)).toContainText("5時間 99%、週 58%");
        await expect(projectOrder.locator(`[data-account-id="${bId}"]`)).toContainText("5時間 30%、週 —");
        await expect(projectOrder.locator(`[data-account-id="${bId}"]`).getByTestId("project-claude-accounts-current")).toHaveText("いま使っています");
        await expect(projectOrder.getByTestId("project-claude-accounts-current")).toHaveCount(1);
        // 1つだけ（仕事用で固定）
        await projectOrder.locator(`[data-account-id="host"]`).getByRole("button", { name: "並びから外す" }).click();
        await expect(projectOrder.getByTestId("project-claude-accounts-order-label")).toHaveText(["仕事用"]);
        await expect.poll(async () => (await projectAccounts()).order).toEqual([bId]);
        await expect(pp.getByRole("button", { name: `${HOST_LABEL}を並びに足す` })).toBeVisible();
        // 既定に戻す → 戻して、また「仕事用だけ」にする（9. で外すときに並びから消える Project を見るため）
        await pp.getByTestId("project-claude-accounts-mode-default").click();
        await expect.poll(async () => (await projectAccounts()).order).toBeNull();
        await expect(projectOrder).toHaveCount(0);
        await pp.getByTestId("project-claude-accounts-mode-own").click();
        await expect.poll(async () => (await projectAccounts()).order).toEqual(["host", bId]);
        await projectOrder.locator(`[data-account-id="host"]`).getByRole("button", { name: "並びから外す" }).click();
        await expect.poll(async () => (await projectAccounts()).order).toEqual([bId]);

        // ---- 7. ログインし直す -------------------------------------------------------------------------------
        await openSection(page, "global");
        fakeApi.addLogin("code-c", { accessToken: "tok-c", email: "c@example.com" });
        fakeApi.addLogin("code-b2", { accessToken: "tok-b2", email: "b@example.com" });
        await row(page, bId).getByTestId("claude-account-relogin").click();
        const relogin = page.getByTestId("claude-account-login-dialog");
        await expect(relogin.getByRole("heading", { name: "仕事用にログインし直す" })).toBeVisible();
        const wrongState = await openLoginPage(page, relogin);
        await relogin.getByTestId("claude-account-login-code").fill(`code-c#${wrongState}`);
        await relogin.getByTestId("claude-account-login-submit").click();
        await expect(relogin.getByTestId("claude-account-login-error")).toHaveText(
          "返ってきたのは c@example.com で、b@example.com ではありません。開いたタブで claude.ai をいったんログアウトしてから、もう一度始めてください",
        );
        // 違うアカウントは足さない
        expect((await accounts()).accounts.map((a) => a.email ?? a.id)).toEqual(["host", "b@example.com"]);
        // 手続きは使い切ったので、1段目からやり直す
        const rightState = await openLoginPage(page, relogin);
        await relogin.getByTestId("claude-account-login-code").fill(`code-b2#${rightState}`);
        await relogin.getByTestId("claude-account-login-submit").click();
        await expect(relogin.getByTestId("claude-account-login-done")).toContainText("b@example.com（Max）にログインし直しました。並びはそのままです。");
        await relogin.getByRole("button", { name: "閉じる" }).click();
        expect((await accounts()).defaultOrder).toEqual(["host", bId]);
        await expect(row(page, bId).getByTestId("claude-account-label")).toHaveText("仕事用");

        // ---- 8. 携帯の幅 -----------------------------------------------------------------------------------
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload();
        const mobilePanel = page.getByTestId("claude-accounts-panel");
        await expect(mobilePanel.getByTestId("claude-account-row")).toHaveCount(2, { timeout: 20_000 });
        const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(await overflow(), "携帯の幅で横にはみ出している").toBeLessThanOrEqual(0);
        for (const id of ["host", bId]) {
          const r = row(page, id);
          const name = (await r.getByTestId("claude-account-label").boundingBox())!;
          const five = (await r.getByTestId("claude-account-meter-5h").boundingBox())!;
          const week = (await r.getByTestId("claude-account-meter-7d").boundingBox())!;
          const rowBox = (await r.boundingBox())!;
          expect(five.y, `${id}：5時間のメーターが名前の下に積まれていない`).toBeGreaterThanOrEqual(name.y + name.height);
          expect(week.y, `${id}：週のメーターが5時間の下に積まれていない`).toBeGreaterThanOrEqual(five.y + five.height);
          expect(five.x + five.width, `${id}：メーターが行からはみ出している`).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
        }
        await expect(mobilePanel.getByTestId("claude-accounts-threshold-5h")).toBeVisible();
        await expect(mobilePanel.getByTestId("claude-accounts-default-order-row")).toHaveCount(2);
        const orderButtons = mobilePanel.getByTestId("claude-accounts-default-order-row").first().getByRole("button");
        for (const b of await orderButtons.all()) {
          const box = (await b.boundingBox())!;
          expect(box.x + box.width, "並びのボタンが画面の外").toBeLessThanOrEqual(390);
        }
        // Project の設定も（携帯では節を開くと左の一覧が隠れるので、開いている節を URL で替える——節は URL が持つ、§6.16）
        const projectSection = new URL(page.url());
        projectSection.searchParams.set("section", "project-claude-accounts");
        await page.goto(projectSection.toString());
        await expect(page.getByTestId("project-claude-accounts-panel")).toBeVisible({ timeout: 20_000 });
        expect(await overflow(), "携帯の幅で Project の設定が横にはみ出している").toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1280, height: 800 });

        // ---- 9. 外す ---------------------------------------------------------------------------------------
        await page.reload();
        await openSection(page, "global");
        await row(page, bId).getByTestId("claude-account-remove").click();
        const confirm = page.getByTestId("claude-accounts-remove-dialog");
        await expect(confirm.getByRole("heading", { name: "仕事用を外しますか" })).toBeVisible();
        await expect(confirm).toContainText("claude.ai の設定からもこのログインを取り消してください。");
        await expect(confirm.getByTestId("claude-accounts-remove-projects")).toHaveText(
          `並びから消える Project：${PROJECT}（このアカウントだけを使っていた Project は既定の並びに戻ります）`,
        );
        await confirm.getByTestId("claude-accounts-remove-confirm").click();
        await expect(page.getByTestId("claude-account-row")).toHaveCount(1);
        expect((await accounts()).defaultOrder).toEqual(["host"]);
        expect((await projectAccounts()).order).toBeNull();
        expect(pageErrors, "画面で例外が出た").toEqual([]);
      },
      {
        // **本物の CLI を偽の API に当てる**（会話の本体は中継を通る。偽の API は中継の上流・取り直しの口・プロフィールの口・使用率の口）
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
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(securestorage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
