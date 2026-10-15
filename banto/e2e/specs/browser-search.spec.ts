// **Browser の新しいタブと URL 欄の検索**（v4-modules.md §4.1「新しいタブと URL 欄の検索」、決定・2026-10-15。Backlog #326）——
// 人の新しいタブ（＋）は検索エンジンのトップで開き、URL 欄に URL でない言葉を打つと検索エンジンで調べ、URL らしいものは今どおり開く。
// 検索エンジンは Project の設定の Browser の画面で選ぶ。
//
// 本番と同じ経路で見る：目録から入れ、Project のコンテナの中で試験用のページ（test-page.js——/search が試験用の検索エンジン）を
// localhost で立てる。**試験で外に出ない**よう、設定の画面で「任意の URL の型」にその /search を指す。見ること（規則14）：
//   1. 設定の画面：既定は DuckDuckGo。選べるのは DuckDuckGo・Startpage・Brave Search・任意の URL の型。型を書かずに任意を選ぶと
//      理由が出て保存されない。型を書くと保存され、getSettings もその型になる
//   2. ＋：新しいタブが選ばれ、検索のトップ（試験の検索）を開き、URL 欄・絵のタブもそれになる
//   3. URL 欄に言葉（空白を含む・ドットの無い1語）→ 検索の URL に行き、タブの題・URL 欄・通信の記録（文書の要求）がそれになる
//   4. URL 欄に URL らしいもの（scheme の無い 127.0.0.1:番号/道）→ 今どおり http:// を足して開く
//   5. AI の browserOpen が url を省くと、新しいタブで検索のトップを開き、会話のカードは「ブラウザで開いた：検索のページ」
import { test, expect, type Page } from "../test-base.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, openProjectSettings, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

/** 繰り返し（`--repeat-each`）で前の回の Project を引かないように、回ごとに名前を変える（名前で id を引くため） */
const projectName = () => `E2E Browser Search ${test.info().repeatEachIndex + 1}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEST_PAGE = join(REPO, "packages/modules/browser/dist/test-page.js");
const PORT = 18769;
const BASE = `http://127.0.0.1:${PORT}`;
const TEMPLATE = `${BASE}/search?q=%s`;

let projectId = "";
let turns = 0;
let testPage: ChildProcess | undefined;

interface HostThread {
  messages: { seq: number; role: string; text: string }[];
  lastTurn?: { outcome?: string };
}

async function uiCall(page: Page, tool: string, args: Record<string, unknown> = {}) {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, { headers, data: { server: "browser", tool, arguments: args } });
  expect(res.ok(), `browser.${tool} が呼べない：${await res.text()}`).toBe(true);
  const body = (await res.json()) as { content?: { text: string }[]; isError?: boolean };
  expect(body.isError, `browser.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
  return JSON.parse(body.content?.[0]?.text ?? "null") as Record<string, unknown>;
}

/** その会話の AI にその tool を呼ばせ、ターンが終わるまで待つ（browser-tabs.spec.ts と同じ）。返すのは AI の発言 */
async function ai(page: Page, threadId: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const marker = `呼び出し ${++turns}：`;
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: `${marker}ブラウザを開いて。` + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: "browser", name, args }] }) }),
  });
  expect(res.ok, `送れない：${res.status}`).toBe(true);
  await res.text(); // ターンの終わりまで読み切る
  let reply: string | undefined;
  await expect(async () => {
    const t = (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as HostThread;
    const mine = t.messages.find((m) => m.role === "user" && m.text.includes(marker));
    expect(mine, "送った発言がまだ記録に無い").toBeTruthy();
    const answer = t.messages.filter((m) => m.seq > mine!.seq && m.role === "assistant" && m.text.trim() !== "");
    expect(answer.length, "返事がまだ無い").toBeGreaterThan(0);
    expect(t.lastTurn?.outcome, "ターンがまだ終わっていない").toBe("completed");
    reply = answer.map((m) => m.text).join("\n");
  }).toPass({ timeout: 420_000, intervals: [500] });
  return reply!;
}

const canvasFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/browser`, { headers, data: { name: "browser" } });
  const body = res.ok() ? "" : await res.text();
  if (!res.ok() && !body.includes("その名前はもう使われています")) throw new Error(`Browser を目録から入れられませんでした: ${res.status()} ${body}`);
});

test.afterAll(() => {
  testPage?.kill();
});

test("新しいタブは設定の検索エンジンで開き、URL 欄の言葉は検索され、URL らしいものは今どおり開く。検索エンジンは設定の画面で選べる", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  const PROJECT_NAME = projectName();
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-browser-search-")));
  await waitForProjectModule(page, PROJECT_NAME, "browser");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  const threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const set = await page.request.post(`${CORE_BASE_URL}/api/threads/${threadId}/permission-mode`, { headers, data: { mode: "bypassPermissions" } });
  expect(set.status(), await set.text()).toBe(204);

  // ---- 試験用のページ（と検索エンジン）を、Project のコンテナの中で立てる ------------------------------------
  testPage = spawn(
    "incus",
    ["exec", `banto-${projectId}`, "--user", String(process.getuid!()), "--group", String(process.getgid!()), "--", "/usr/local/bin/node", TEST_PAGE, String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pageOut = "";
  testPage.stdout!.on("data", (c: Buffer) => (pageOut += c.toString()));
  testPage.stderr!.on("data", (c: Buffer) => (pageOut += c.toString()));
  await expect.poll(() => pageOut, { timeout: 30_000, message: "試験用のページが立たない" }).toContain(`listening ${PORT}`);

  // ---- 1. 設定の画面で検索エンジンを選ぶ ---------------------------------------------------------------
  await openProjectSettings(page);
  await page.getByRole("button", { name: "ブラウザ", exact: true }).click();
  const canvas = page.locator('[data-testid="module-settings-canvas"][data-module="browser"]');
  await expect(canvas, "Browser の設定の画面が出ない").toBeVisible({ timeout: 30_000 });
  const config = canvas.locator("iframe").contentFrame().frameLocator("iframe");
  const engine = config.getByTestId("browser-config-engine");
  await expect(engine, "既定が DuckDuckGo でない").toHaveValue("duckduckgo", { timeout: 30_000 });
  await expect(engine.locator("option")).toHaveText([
    "DuckDuckGo（https://duckduckgo.com/）",
    "Startpage（https://www.startpage.com/）",
    "Brave Search（https://search.brave.com/）",
    "任意の URL の型",
  ]);
  await expect(config.getByTestId("browser-config-template"), "任意を選ぶ前から型の欄が出ている").toBeHidden();
  await engine.selectOption("custom");
  const template = config.getByTestId("browser-config-template");
  await expect(template).toBeVisible();
  // 型を書かずに保存：理由が出て、保存されない
  await config.getByTestId("browser-config-save").click();
  await expect(config.getByTestId("browser-config-error")).toContainText("任意の URL の型（searchTemplate）を書いてから custom を選びます", { timeout: 30_000 });
  expect((await uiCall(page, "getSettings")).searchEngine, "型が無いのに任意が保存された").toBe("duckduckgo");
  await template.fill(TEMPLATE);
  await config.getByTestId("browser-config-save").click();
  await expect(config.getByTestId("browser-config-note")).toHaveText(`保存しました（${TEMPLATE}）`, { timeout: 30_000 });
  await expect(config.getByTestId("browser-config-error")).toBeHidden();
  expect(await uiCall(page, "getSettings")).toMatchObject({ searchEngine: "custom", searchTemplate: TEMPLATE });

  // ---- 2. 人の画面を入口から開き、＋ ---------------------------------------------------------------------
  await page.goto(`/p/${projectId}`);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:browser:"]');
  await expect(entry, "Browser の入口が出ない").toContainText("ブラウザ", { timeout: 60_000 });
  await entry.click();
  const f = canvasFrame(page);
  await expect(f.locator(".tab[data-tab]"), "ブラウザが起きない").toHaveCount(1, { timeout: 420_000 });
  const first = (await f.locator(".tab[data-tab]").getAttribute("data-tab"))!;
  await f.getByRole("button", { name: "新しいタブ" }).click();
  await expect(f.locator(".tab[data-tab]"), "＋でタブができない").toHaveCount(2);
  const added = f.locator(`.tab[data-tab]:not([data-tab="${first}"])`);
  const tab = (await added.getAttribute("data-tab"))!;
  await expect(added, "＋のタブが選ばれない").toHaveAttribute("aria-selected", "true");
  await expect(added, "＋のタブが検索のトップで開かない").toContainText("試験の検索", { timeout: 30_000 });
  const urlBar = f.getByRole("textbox", { name: "URL" });
  await expect(urlBar).toHaveValue(`${BASE}/search?q=`);
  await expect(urlBar).toHaveAttribute("placeholder", "URL か検索する言葉（例 localhost:3000）");
  await expect(f.getByTestId("browser-screen"), "＋のタブの絵が映らない").toHaveAttribute("data-tab", tab, { timeout: 60_000 });

  // ---- 3. URL 欄に言葉 → 検索の URL ----------------------------------------------------------------------
  const documents = async (urlContains: string) =>
    ((await uiCall(page, "listNetworkRecords", { urlContains, type: "document" })) as { records: { url: string; tab: string }[] }).records;
  await urlBar.fill("東京 天気");
  await urlBar.press("Enter");
  await expect(added, "言葉が検索されない").toContainText("検索：東京 天気", { timeout: 30_000 });
  const searched = `${BASE}/search?q=%E6%9D%B1%E4%BA%AC%20%E5%A4%A9%E6%B0%97`;
  await expect(urlBar).toHaveValue(searched);
  expect((await documents("/search?q=%E6")).map((r) => [r.url, r.tab])).toEqual([[searched, tab]]);
  await urlBar.fill("typescript");
  await urlBar.press("Enter");
  await expect(added, "ドットの無い1語が検索されない").toContainText("検索：typescript", { timeout: 30_000 });
  await expect(urlBar).toHaveValue(`${BASE}/search?q=typescript`);

  // ---- 4. URL らしいもの → 今どおり開く --------------------------------------------------------------------
  await urlBar.fill(`127.0.0.1:${PORT}/second`);
  await urlBar.press("Enter");
  await expect(added, "URL らしいものが開かない").toContainText("2ページ目", { timeout: 30_000 });
  await expect(urlBar).toHaveValue(`${BASE}/second`);
  expect(await documents("/search?q=127"), "URL らしいものを検索した").toEqual([]);

  // ---- 5. AI が url を省いて開く → 新しいタブで検索のトップ。カードは「検索のページ」 -------------------------------
  const reply = await ai(page, threadId, "browserOpen", {});
  const opened = /タブ (t\d+) で開きました/.exec(reply)?.[1];
  expect(opened, `開いたタブが読めない：${reply}`).toBeTruthy();
  expect([first, tab]).not.toContain(opened);
  expect(reply).toContain(`最終の URL: ${BASE}/search?q=\n`);
  expect(reply).toContain("タイトル: 試験の検索");
  await expect(f.locator(`.tab[data-tab="${opened}"]`), "AI のタブが並びに出ない").toContainText("試験の検索");
  // 人の画面の表示は替わらない（AI のタブは裏に開く）
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", tab);
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId("tool-entry-card").filter({ hasText: "ブラウザで開いた：検索のページ" }), "url を省いた browserOpen のカードの題").toHaveCount(1, {
    timeout: 30_000,
  });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
