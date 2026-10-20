// **読むだけの回**（決定・2026-10-20、アーキ仕様 §4.4「土台：読むだけの印」「読むだけの回」、v4-frontend.md §6.47「Project の設定」。
// Backlog #420）。見回りはまだ無いので、試験だけの口（config.json の `testOnlyReadOnlyThreads`）で読むだけの印を付けた会話を立てる。
//
// 見ること（画面と host の記録で、規則14）：
//   1. Project の設定の「見回りで使ってよい tool」：同梱の Module の読むだけの tool は確かめた一覧で出る（外せない）。第三者の
//      Module の tool は、名乗り（readOnlyHint）があっても既定でチェックは入らない。チェックすると host の設定に残る
//   2. 読むだけの会話のターンは、「承認をすべて自動で許可する」がオンで、承認モードが「毎回聞く」でも：
//      - 同梱の読むだけの tool（FileSystem の readFile・listDirectory、core の list_threads）は聞かれずに使え、中身まで届く
//      - 人が許した第三者の tool は使える。許して承認済みの中継先（読むだけ）も使える
//      - Shell の runCommand・WebFetch・create_automation・人が許していない第三者の tool（読むだけと名乗っていても）・
//        読むだけでない中継先（writeFile）は断られ、まだ承認していない中継先は人に聞かずに断られる
//      - 判断待ちのカードは1枚も出ず、受信箱にも積まれない。断ったものは何も変えていない（ファイルができていない）
import { test, expect, type Page } from "../test-base.js";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_BASE_URL, AUTH_TOKEN, DATA_DIR } from "../config.js";
import { createProject, fakeTurn, openApp, openToolCards, waitForProjectModule, waitTurnEnded } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

// **名前は短く**——Module の置き場のパスが Incus の装置の名前に入り、長いと「file name too long」でマウントできない
const MODULE = `ro${String(Date.now()).slice(-5)}`;
const PROJECT_NAME = "E2E Read Only Runs";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/read-only-probe-module/server.js");
const REFUSAL = "見回りの回では使えません（読むだけの tool だけ使えます）";
const NO_ASK = "見回りの回では人に聞けないため、断りました";

let projectId = "";
let projectRoot = "";
let baseThreadId = "";

/** Event Store に積まれた中継の記録 */
function relayEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
  return readFileSync(join(DATA_DIR, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.includes('"relay.'))
    .map((line) => JSON.parse(line) as { seq: number; type: string; payload: Record<string, unknown> })
    .filter((e) => e.type.startsWith("relay."));
}

/** その会話の tool のカード（畳まれた「N tool calls」を開き、カードも開いてから中身を見る） */
async function toolCard(page: Page, toolName: string) {
  const groups = page.getByRole("button", { name: /tool calls?$/, expanded: false });
  for (let i = 0; i < 10 && (await groups.count()) > 0; i++) await groups.first().click();
  await expect(groups, "畳まれた tool の呼び出しが開かない").toHaveCount(0);
  await openToolCards(page, toolName);
  return page.locator('[data-slot="tool-fallback-root"]').filter({ has: page.getByRole("button", { name: `Used tool: ${toolName}` }) });
}

test.afterAll(async ({ request }) => {
  await request.delete(`${CORE_BASE_URL}/api/modules/${encodeURIComponent(MODULE)}`, { headers });
});

test("ふつうの会話で中継の初回を許しておき、設定の「見回りで使ってよい tool」で第三者の tool を許す", async ({ page }) => {
  const added = await page.request.post(`${CORE_BASE_URL}/api/modules`, {
    headers,
    data: {
      name: MODULE,
      launch: {
        command: "${nodeExec}",
        args: [SERVER],
        env: { BANTO_HOST_MCP_URL: "${hostRelayUrl}", BANTO_HOST_MCP_TOKEN: "${hostRelayToken}" },
      },
      meta: { satisfies: ["e2e-read-only-probe"], dependsOn: [{ role: "filesystem", required: true }], isolation: "subprocess", scope: "project" },
    },
  });
  expect(added.status(), `試験用の Module を足せなかった：${await added.text()}`).toBeLessThan(400);

  projectRoot = mkdtempSync(join(tmpdir(), "banto-e2e-read-only-"));
  writeFileSync(join(projectRoot, "one.txt"), "ひとつめ\n");
  await openApp(page);
  await createProject(page, PROJECT_NAME, projectRoot);
  for (const m of ["filesystem", "shell", MODULE]) await waitForProjectModule(page, PROJECT_NAME, m);
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  baseThreadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  // --- 中継の初回（この Module → filesystem の listDirectory）を、ふつうの会話で人が許しておく ---
  const composer = page.getByPlaceholder(/に送る/);
  await composer.fill("一覧を中継で取って。" + fakeTurn({ tools: [{ server: MODULE, name: "relayList", args: { path: "." } }] }));
  await composer.press("Enter");
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    await waitTurnEnded(page, baseThreadId, 1, 1_500);
  }).toPass({ timeout: 120_000, intervals: [1000] });
  const grants = relayEvents().filter((e) => e.type === "relay.grant_created" && e.payload.targetModule !== undefined && e.payload.name === "listDirectory");
  expect(grants.length, "中継の初回を許した記録が無い").toBeGreaterThan(0);

  // --- 設定の「見回りで使ってよい tool」 ---
  await page.goto(`/p/${projectId}?settings=1&project=${projectId}&section=project-general`);
  const section = page.getByTestId("project-patrol-tools-section");
  await expect(section).toBeVisible({ timeout: 30_000 });
  // 同梱の読むだけの tool は確かめた一覧（チェックの欄は無い）
  await expect(section.getByTestId("patrol-tools-bundled-filesystem")).toContainText("readFile", { timeout: 30_000 });
  await expect(section.getByTestId("patrol-tools-bundled-filesystem")).toContainText("listDirectory");
  await expect(section.getByTestId("patrol-tools-bundled-filesystem")).not.toContainText("writeFile");
  await expect(section.getByTestId("patrol-tools-bundled-shell")).toHaveText(/shell：listCommands$/);
  await expect(section.locator('[data-testid^="patrol-tool-filesystem-"]')).toHaveCount(0);
  // 第三者の tool は、名乗っていても既定でチェックは入らない。名乗りは薄く見せる
  const card = section.getByTestId(`patrol-tools-module-${MODULE}`);
  for (const name of ["claimsRead", "peek", "relayList", "relayInfo", "relayWrite", "resources"]) {
    await expect(card.getByTestId(`patrol-tool-${MODULE}-${name}`), `${name} に既定でチェックが入っている`).not.toBeChecked();
  }
  await expect(card.getByTestId(`patrol-tool-hints-${MODULE}-claimsRead`)).toContainText("読むだけと名乗っています");
  // 名乗った claimsRead 以外を許す
  for (const name of ["peek", "relayList", "relayInfo", "relayWrite"]) {
    const box = card.getByTestId(`patrol-tool-${MODULE}-${name}`);
    await box.check();
    await expect(box).toBeChecked();
  }
  // 真実は host（画面の表示だけで確かめない）
  await expect
    .poll(async () => ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/patrol-tools`, { headers })).json()) as { allowed: string[] }).allowed)
    .toEqual([`${MODULE}/peek`, `${MODULE}/relayInfo`, `${MODULE}/relayList`, `${MODULE}/relayWrite`]);
  // 開き直しても残る
  await page.reload();
  await expect(page.getByTestId(`patrol-tool-${MODULE}-peek`)).toBeChecked({ timeout: 30_000 });
  await expect(page.getByTestId(`patrol-tool-${MODULE}-claimsRead`)).not.toBeChecked();
});

test("読むだけの会話のターンは、読むだけの tool だけを使え、ほかは判断待ちを出さずに断る（自動で許可がオンでも）", async ({ page }) => {
  // 「承認をすべて自動で許可する」をオン、承認モードは「毎回聞く」——ふつうの会話ならどれも自動で通るところ
  const auto = await page.request.put(`${CORE_BASE_URL}/api/projects/${projectId}/auto-approve`, { headers, data: { enabled: true } });
  expect(auto.ok()).toBe(true);
  const mode = await page.request.post(`${CORE_BASE_URL}/api/threads/${baseThreadId}/permission-mode`, { headers, data: { mode: "default" } });
  expect(mode.ok()).toBe(true);

  const created = await page.request.post(`${CORE_BASE_URL}/api/test-only/read-only-thread`, {
    headers,
    data: { threadId: baseThreadId, title: "見回り（試験）" },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const fork = (await created.json()) as { id: string; restriction?: string };
  expect(fork.restriction).toBe("read-only");
  const detail = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${fork.id}`, { headers })).json()) as { restriction?: string };
  expect(detail.restriction, "会話に読むだけの印が残っていない").toBe("read-only");

  const relaySince = Math.max(0, ...relayEvents().map((e) => e.seq));
  await openApp(page);
  await page.goto(`/p/${projectId}?fork=${fork.id}`);
  // 開いた Fork の入力欄（Base の入力欄は隠れて残る）
  const composer = page.getByPlaceholder("この Fork Thread に送る");
  await expect(composer, "読むだけの会話が開かない").toBeVisible({ timeout: 30_000 });
  await composer.fill(
    "見回って。" +
      fakeTurn({
        tools: [
          { server: "filesystem", name: "readFile", args: { path: "one.txt" } },
          { server: "filesystem", name: "listDirectory", args: { path: "." } },
          { server: "banto-thread", name: "list_threads", args: {} },
          { server: "shell", name: "runCommand", args: { command: "touch ro-marker.txt" } },
          { server: "builtin", name: "WebFetch", args: { url: "https://example.com/?leak=1", prompt: "読んで" } },
          {
            server: "banto-thread",
            name: "create_automation",
            args: { name: "勝手に", instruction: "x", source: { kind: "schedule", cron: "0 9 * * *", timezone: "Asia/Tokyo" } },
          },
          { server: MODULE, name: "claimsRead", args: {} },
          { server: MODULE, name: "peek", args: {} },
          { server: MODULE, name: "relayList", args: { path: "." } },
          { server: MODULE, name: "relayWrite", args: { path: "ro-written.txt", content: "書いた" } },
          { server: MODULE, name: "relayInfo", args: { path: "one.txt" } },
        ],
        then: "見回りおわり。",
      }),
  );
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "見回りおわり。" })).toBeVisible({ timeout: 120_000 });
  await waitTurnEnded(page, fork.id, 1, 30_000);

  // (1) 同梱の読むだけの tool・人が許した第三者の tool・許して承認済みの読むだけの中継先は使え、中身まで届く
  await expect(await toolCard(page, "mcp__filesystem__readFile")).toContainText("ひとつめ");
  await expect(await toolCard(page, "mcp__filesystem__listDirectory")).toContainText("one.txt");
  await expect(await toolCard(page, "mcp__banto-thread__list_threads")).toContainText(baseThreadId);
  await expect(await toolCard(page, `mcp__${MODULE}__peek`)).toContainText("peek を実行しました");
  const relayList = await toolCard(page, `mcp__${MODULE}__relayList`);
  await expect(relayList).toContainText("中継の結果");
  await expect(relayList).toContainText("one.txt");

  // (2) 読むだけでないもの・許していないものは断る
  await expect(await toolCard(page, "mcp__shell__runCommand")).toContainText(REFUSAL);
  await expect(await toolCard(page, "WebFetch")).toContainText("No such tool available");
  await expect(await toolCard(page, "mcp__banto-thread__create_automation")).toContainText(REFUSAL);
  await expect(await toolCard(page, `mcp__${MODULE}__claimsRead`)).toContainText(REFUSAL);
  const relayWrite = await toolCard(page, `mcp__${MODULE}__relayWrite`);
  await expect(relayWrite).toContainText("中継が断られました");
  await expect(relayWrite).toContainText(REFUSAL);
  const relayInfo = await toolCard(page, `mcp__${MODULE}__relayInfo`);
  await expect(relayInfo).toContainText("中継が断られました");
  await expect(relayInfo).toContainText(NO_ASK);

  // 判断待ちは1枚も出ない（自動で許可の答え済みのカードも出ない）。受信箱にも積まない
  await expect(page.locator('[data-role="judgment-card"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "許可する" })).toHaveCount(0);
  const inbox = (await (await page.request.get(`${CORE_BASE_URL}/api/inbox`, { headers })).json()) as Array<{ kind: string; threadId?: string }>;
  expect(inbox.filter((i) => i.threadId === fork.id), "読むだけの会話の判断待ちが受信箱にある").toEqual([]);

  // 断ったものは何も変えていない
  expect(existsSync(join(projectRoot, "ro-marker.txt")), "runCommand が走った").toBe(false);
  expect(existsSync(join(projectRoot, "ro-written.txt")), "中継の writeFile が走った").toBe(false);
  const automations = (await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/automations`, { headers })).json()) as {
    automations: unknown[];
  };
  expect(automations.automations, "自動化ができている").toEqual([]);

  // 中継の記録：writeFile と getFileInfo は断った記録、新しい承認は残さない
  const mine = relayEvents().filter((e) => e.seq > relaySince);
  const refused = mine.filter((e) => e.type === "relay.call_recorded" && e.payload.allowed === false).map((e) => e.payload.name);
  expect(refused).toContain("writeFile");
  expect(refused).toContain("getFileInfo");
  expect(mine.filter((e) => e.type === "relay.grant_created"), "読むだけの回で承認を覚えた").toEqual([]);
});
