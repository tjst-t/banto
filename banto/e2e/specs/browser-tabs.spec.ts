// **Browser のタブは会話ごと**（v4-modules.md §4.1「タブは会話ごと」、決定・2026-10-14。Backlog #297）——人が見ている
// タブの裏で、2つの会話の AI がそれぞれ自分のタブで同時に作業する。
//
// 本番と同じ経路で見る：目録から入れ、Project のコンテナの中で試験用のページ（test-page.js）を localhost で立て、
// 人の画面を入口から開いて人のタブを映し、偽 Runner の2つの会話（Base と Fork）に道具を**同時に**呼ばせる。見ること（規則14）：
//   1. 2つの会話の browserOpen は、それぞれ自分の新しいタブに開く。人の画面の表示（映しているタブ・選んでいるタブ・URL 欄）は替わらない
//   2. タブを省いた操作は、その会話の最後のタブに効く——A と B が同時にそれぞれ入力して送り、送った要求の本文が
//      それぞれのタブから出ている（人の画面の口の通信の記録で、タブと本文を見る）
//   3. ほかの会話のタブへの操作（browserAct・browserEval・browserTabs の select/close）は理由と持ち主つきで断られ、
//      読む道具（browserSnapshot）は通る
//   4. 人の画面のタブの並びに持ち主（Thread の頭8字）が出て、人のタブには出ない。押すとその会話（Fork）が開く
//   5. AI の帯は、人が見ているタブの操作だけ出る（裏のタブの操作では出ず、人がそのタブに切り替えると出る）
//   6. browserTabs の list は全部のタブと持ち主を返し、この会話のいまのタブに * が付く。select は人の画面を替えない
import { test, expect, type FrameLocator, type Page } from "../test-base.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

/** 繰り返し（`--repeat-each`）で前の回の Project を引かないように、回ごとに名前を変える（名前で id を引くため） */
const projectName = () => `E2E Browser Tabs ${test.info().repeatEachIndex + 1}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEST_PAGE = join(REPO, "packages/modules/browser/dist/test-page.js");
const PORT = 18768;
const BASE = `http://127.0.0.1:${PORT}`;

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

/**
 * その会話の AI にその tool を呼ばせ、ターンが終わるまで待つ。**口を直に叩く**——2つの会話を同時に走らせるため（画面の
 * 入力欄は開いている会話の1つだけ）。承認は会話を bypassPermissions にして要らなくしてある。返すのは AI の発言（偽 Runner
 * は tool の結果をそのまま言う）
 */
async function ai(page: Page, threadId: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const marker = `呼び出し ${++turns}：`;
  const res = await fetch(`${CORE_BASE_URL}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers,
    // 初回はブラウザを入れる（取ってくる・apt）ので長い
    body: JSON.stringify({ prompt: `${marker}ブラウザで確かめて。` + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: "browser", name, args }] }) }),
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

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(tree);
  if (!m) throw new Error(`${role} "${name}" がツリーに無い:\n${tree}`);
  return m[1]!;
}

const canvasFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/** 画面が繋がり、そのタブの絵が描かれるまで待つ */
async function expectShowing(f: FrameLocator, tab: string): Promise<void> {
  await expect(f.getByTestId("browser-state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 180_000 });
  await expect(f.getByTestId("browser-screen"), "絵が描かれない").toBeVisible({ timeout: 60_000 });
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", tab);
}

const opened = (reply: string) => {
  const m = /タブ (t\d+) で開きました/.exec(reply);
  if (!m) throw new Error(`開いたタブが読めない：${reply}`);
  return m[1]!;
};

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/browser`, { headers, data: { name: "browser" } });
  const body = res.ok() ? "" : await res.text();
  if (!res.ok() && !body.includes("その名前はもう使われています")) throw new Error(`Browser を目録から入れられませんでした: ${res.status()} ${body}`);
});

test.afterAll(() => {
  testPage?.kill();
});

test("タブは会話ごと：2つの会話の AI がそれぞれ裏の自分のタブで同時に作業し、ほかの会話のタブへの操作は断られ、人の画面の表示は替わらない", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  const PROJECT_NAME = projectName();
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-browser-tabs-")));
  await waitForProjectModule(page, PROJECT_NAME, "browser");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  const A = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;
  const forked = await page.request.post(`${CORE_BASE_URL}/api/threads/${A}/fork`, { headers, data: { fresh: true, title: "会話B" } });
  expect(forked.ok(), await forked.text()).toBe(true);
  const B = ((await forked.json()) as { id: string }).id;
  for (const id of [A, B]) {
    const set = await page.request.post(`${CORE_BASE_URL}/api/threads/${id}/permission-mode`, { headers, data: { mode: "bypassPermissions" } });
    expect(set.status(), await set.text()).toBe(204);
  }

  // ---- 試験用のページを、Project のコンテナの中で立てる -----------------------------------------------
  testPage = spawn(
    "incus",
    ["exec", `banto-${projectId}`, "--user", String(process.getuid!()), "--group", String(process.getgid!()), "--", "/usr/local/bin/node", TEST_PAGE, String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pageOut = "";
  testPage.stdout!.on("data", (c: Buffer) => (pageOut += c.toString()));
  testPage.stderr!.on("data", (c: Buffer) => (pageOut += c.toString()));
  await expect.poll(() => pageOut, { timeout: 30_000, message: "試験用のページが立たない" }).toContain(`listening ${PORT}`);

  // ---- 人の画面を入口から開く（ブラウザを起こす——最初のタブは人のもの）。人のタブで 2ページ目 を開く ------------
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:browser:"]');
  await expect(entry, "Browser の入口が出ない").toContainText("ブラウザ", { timeout: 60_000 });
  await entry.click();
  const f = canvasFrame(page);
  await expect(f.locator(".tab[data-tab]"), "ブラウザが起きない").toHaveCount(1, { timeout: 420_000 });
  const human = (await f.locator(".tab[data-tab]").getAttribute("data-tab"))!;
  const urlBar = f.getByRole("textbox", { name: "URL" });
  await urlBar.fill(`${BASE}/second`);
  await urlBar.press("Enter");
  const humanTab = f.locator(`.tab[data-tab="${human}"]`);
  await expect(humanTab, "人のタブで開けない").toContainText("2ページ目", { timeout: 30_000 });
  await expectShowing(f, human);
  const banner = f.getByTestId("ai-banner");
  /** 人の画面の表示が人のタブのまま（映している絵・選んでいるタブ・URL 欄） */
  const expectHumanView = async (why: string) => {
    await expect(f.getByTestId("browser-screen"), `${why}：人の画面に映るタブが替わった`).toHaveAttribute("data-tab", human);
    await expect(humanTab, `${why}：人の画面で選んでいるタブが替わった`).toHaveAttribute("aria-selected", "true");
    await expect(urlBar, `${why}：URL 欄が替わった`).toHaveValue(`${BASE}/second`);
    expect((await uiCall(page, "getBrowserStatus")).view, `${why}：映しているタブが替わった`).toMatchObject({ screencastTab: human });
  };

  // ---- 1. 2つの会話が同時に開く——それぞれ自分の新しいタブ。人の画面は替わらない ------------------------------
  const [openA, openB] = await Promise.all([ai(page, A, "browserOpen", { url: `${BASE}/` }), ai(page, B, "browserOpen", { url: `${BASE}/` })]);
  const tabA = opened(openA);
  const tabB = opened(openB);
  expect(new Set([human, tabA, tabB]).size, `タブが分かれていない：人 ${human}・A ${tabA}・B ${tabB}`).toBe(3);
  expect(openA).toMatch(/タイトル: Browser 試験のページ/);
  expect(openB).toMatch(/タイトル: Browser 試験のページ/);
  await expect(f.locator(".tab[data-tab]")).toHaveCount(3);
  await expectHumanView("2つの会話が開いた後");

  // ---- 2. タブを省いた操作は自分の最後のタブ——A と B が同時に入れて送る -----------------------------------------
  const [treeA, treeB] = await Promise.all([ai(page, A, "browserSnapshot"), ai(page, B, "browserSnapshot")]);
  expect(treeA).toMatch(new RegExp(`^タブ ${tabA}　URL: ${BASE}/$`, "m"));
  expect(treeB).toMatch(new RegExp(`^タブ ${tabB}　URL: ${BASE}/$`, "m"));
  const [typedA, typedB] = await Promise.all([
    ai(page, A, "browserAct", { action: "type", ref: refOf(treeA, "textbox", "名前"), text: "かいわA" }),
    ai(page, B, "browserAct", { action: "type", ref: refOf(treeB, "textbox", "名前"), text: "かいわB" }),
  ]);
  expect(typedA).toContain(`（タブ ${tabA}）`);
  expect(typedB).toContain(`（タブ ${tabB}）`);
  const [sentA, sentB] = await Promise.all([
    ai(page, A, "browserAct", { action: "click", ref: refOf(treeA, "button", "送る") }),
    ai(page, B, "browserAct", { action: "click", ref: refOf(treeB, "button", "送る") }),
  ]);
  expect(sentA).toContain("送った:かいわA");
  expect(sentB).toContain("送った:かいわB");
  // 送った要求は、それぞれのタブから、それぞれの本文で出ている（人の画面の口の通信の記録）
  const echoes = (await uiCall(page, "listNetworkRecords", { urlContains: "/api/echo" })) as { records: { id: string; tab: string }[] };
  const bodies = new Map<string, string>();
  for (const r of echoes.records) bodies.set(r.tab, String(((await uiCall(page, "getNetworkRecord", { id: r.id })) as { requestBody?: string }).requestBody));
  expect(Object.fromEntries(bodies)).toEqual({ [tabA]: '{"name":"かいわA"}', [tabB]: '{"name":"かいわB"}' });
  // 裏のタブの写し（画像）も撮れる
  expect(await ai(page, A, "browserScreenshot")).toContain(`タブ ${tabA}　URL: ${BASE}/`);
  await expectHumanView("2つの会話が裏のタブで操作した後");
  // 裏のタブの AI の操作は、人の画面の帯に出ない（見ているタブの操作だけ）
  await expect(banner, "裏のタブの操作で AI の帯が出た").not.toHaveAttribute("data-count", /.*/);

  // ---- 3. ほかの会話のタブへの操作は断る（理由と持ち主）。読む道具は通す -------------------------------------
  const refusal = `タブ ${tabA} はほかの会話（Thread ${A.slice(0, 8)}）のタブなので`;
  expect(await ai(page, B, "browserAct", { action: "reload", tab: tabA })).toContain(`${refusal}、browserAct の reload はできません`);
  expect(await ai(page, B, "browserEval", { expression: "document.title", tab: tabA })).toContain(`${refusal}、browserEval はできません`);
  expect(await ai(page, B, "browserTabs", { action: "select", tab: tabA })).toContain(`${refusal}、browserTabs の select はできません`);
  expect(await ai(page, B, "browserTabs", { action: "close", tab: tabA })).toContain(`${refusal}、browserTabs の close はできません`);
  expect(await ai(page, B, "browserSnapshot", { tab: tabA })).toContain("送った:かいわA");
  await expect(f.locator(".tab[data-tab]"), "断ったのにタブが閉じた").toHaveCount(3);

  // ---- 6. 一覧と select：B のいまのタブに *。人のタブを選んでも人の画面は替わらない ---------------------------------
  const listed = await ai(page, B, "browserTabs", { action: "list" });
  expect(listed).toMatch(new RegExp(`^\\* ${tabB} \\[この会話\\] ${BASE}/ Browser 試験のページ$`, "m"));
  expect(listed).toMatch(new RegExp(`^  ${tabA} \\[会話 ${A.slice(0, 8)}\\] ${BASE}/ Browser 試験のページ$`, "m"));
  expect(listed).toMatch(new RegExp(`^  ${human} \\[人\\]（人の画面） ${BASE}/second 2ページ目$`, "m"));
  expect(await ai(page, B, "browserTabs", { action: "select", tab: human })).toContain(`タブ ${human} を選びました（この会話のいまのタブ。人の画面の表示は替えていません）`);
  // 選んだ人のタブに、タブを省いて触れる（人のタブは操作できる）
  expect(await ai(page, B, "browserEval", { expression: "location.pathname" })).toContain(`タブ ${human}　結果:`);
  expect(await ai(page, B, "browserTabs", { action: "select", tab: tabB })).toContain(`タブ ${tabB} を選びました`);
  await expectHumanView("会話が select した後");

  // ---- 4. 人の画面のタブの並びに持ち主（Thread の頭8字）。人のタブには無い ---------------------------------------
  await expect(f.locator(`.tab[data-tab="${tabA}"] .tab-owner`)).toHaveText(A.slice(0, 8));
  await expect(f.locator(`.tab[data-tab="${tabB}"] .tab-owner`)).toHaveText(B.slice(0, 8));
  await expect(humanTab.locator(".tab-owner")).toHaveCount(0);

  // ---- 5. 人が A のタブに切り替えると A の絵が映り、A の操作の帯が出る -------------------------------------------
  await f.locator(`.tab[data-tab="${tabA}"] .tab-name`).click();
  await expectShowing(f, tabA);
  await expect(urlBar).toHaveValue(`${BASE}/`);
  await Promise.all([
    ai(page, A, "browserAct", { action: "click", ref: refOf(treeA, "button", "送る") }),
    expect(banner, "見ているタブの AI の操作で帯が出ない").toContainText(new RegExp(`AI が操作中：『送る』を押しました（Thread ${A.slice(0, 8)}）`), { timeout: 120_000 }),
  ]);
  // AI の会話は A のタブで操作を続けても、人の画面の選択を動かさない——B が自分のタブを開いても A のタブのまま
  expect(opened(await ai(page, B, "browserOpen", { url: `${BASE}/second`, newTab: true }))).not.toBe(tabA);
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", tabA);
  await expect(f.locator(`.tab[data-tab="${tabA}"]`)).toHaveAttribute("aria-selected", "true");

  // ---- 4'. 持ち主の印を押すと、その会話（Fork）が開く ---------------------------------------------------------
  await f.locator(`.tab[data-tab="${tabB}"] .tab-owner`).click();
  await expect(page, "持ち主の印を押しても B の会話が開かない").toHaveURL(new RegExp(`[?&]fork=${B}(&|$)`), { timeout: 30_000 });

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
