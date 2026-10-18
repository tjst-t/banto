// **Browser の人の画面**（v4-modules.md §4.1「人の画面」「人と AI の同時操作」、2026-10-10。Backlog #242）——
// 同じブラウザを人が Canvas で映して触り、AI の操作は帯つきで映る。
//
// 本番と同じ経路で見る：目録から入れ、Project のコンテナの中で試験用のページ（test-page.js）を localhost で立て、
// 偽 Runner の AI に道具を呼ばせる。画面は流れの口（アーキ仕様 §5.8）で絵を受け、人の入力を送り返す。見ること（規則14）：
//   1. AI の browserOpen が会話にカードを出し、押すと画面が Canvas で開く。タブの並び・URL 欄・絵（タブ t1・ページの大きさ）
//   2. 人がページを押して文字を打つ（日本語は insertText、英数字はキー）と、ページに届く——「送る」の要求の本文で確かめる
//   3. 通信の欄：送った要求・500・届かなかった要求が出て、1件の詳細に本文がある。コンソールの欄に console.error
//   4. AI の browserAct の click が、どの Thread の AI か・『送る』を押した、の帯と枠つきで映る。絵が新しくなる
//   5. HAR で保存：ダウンロードした HAR に送った要求がある（人の画面なので Authorization は伏せない）
//   6. 「AI に触らせない」を画面で入れると browserAct が断る。切ると戻る
//   7. 画面の操作を一度ずつ：URL 欄で開く・戻る/進む/読み直し・タブの ＋/切り替え/×（AI の「いまのタブ」は会話ごとで、
//      人の切り替えでは変わらない——v4-modules.md §4.1「タブは会話ごと」）。
//      どれも成功したときにだけ現れるもの（タブの並びの題・URL 欄・絵の data-tab・通信の件数）で待つ
//   8. 画面を閉じると screencast が止まる（getBrowserStatus の view）。入口からも開ける
//   9. 携帯：「画面に合わせる」でページが携帯の幅になり、指で押してキーボードの欄から打てる。閉じるとページの大きさが戻る
//  10. 「ブラウザの記録を消す」（2回押す）：通信とコンソールの件数が 0 になり、前のタブが消えて起こし直す
//  11. 人のブラウザと同じ：要求とページから見て Headless を名乗らない Chrome・webdriver は false・プラグインあり・言語は ja-JP から
//      （Backlog #257・#259——名乗りの上書きも JS の上書きもせず、画面ありの普通のブラウザの本物の値で）
//  12. 別オリジンの iframe：人の画面の絵に iframe の中身（静かになる直前の描画も）が映り、絵の上で押すと iframe に届く——
//      絵の画素の色で確かめる（Backlog #257——google.com/sorry の reCAPTCHA の枠が映らなかった）
//  13. 高精細の画面（devicePixelRatio 2）：開くと倍率を覚え、起こし直したブラウザは倍率2で描く——host を通って届く絵が
//      絵を出す場所の物理ピクセルの大きさ（CSS の大きさ×2、ページの2倍まで）で、流れが切れない（1通 1 MiB を越えない）。
//      ページからも倍率2に見える（Backlog #266）
//  14. 狭い Canvas（会話の横、幅 約390px）：上の帯は2段とも1行のまま、幅を変えても高さが変わらない。しまった
//      「ブラウザの記録を消す」は「…」（もっと見る）から2回押しで使え、「…」はキーボードでも開け閉めできる（Backlog #384）
import { test, expect, loginContext, type FrameLocator, type Page } from "../test-base.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { clearBrowserData, createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(1_500_000);

/** 繰り返し（`--repeat-each`）で前の回の Project を引かないように、回ごとに名前を変える（名前で id を引くため） */
const projectName = () => `E2E Browser View ${test.info().repeatEachIndex + 1}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEST_PAGE = join(REPO, "packages/modules/browser/dist/test-page.js");
const PORT = 18766;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_VALUE = "token-secret-value-456";

let projectId = "";
let threadId = "";
/** 会話の画面の URL（後の試験が同じ会話を開く） */
let threadUrl = "";
let turns = 0;
let testPage: ChildProcess | undefined;

interface HostMessage {
  seq: number;
  role: string;
  text: string;
}

async function hostThread(page: Page) {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: HostMessage[];
    lastTurn?: { outcome?: string };
  };
}

async function uiCall(page: Page, tool: string, args: Record<string, unknown> = {}) {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, { headers, data: { server: "browser", tool, arguments: args } });
  expect(res.ok(), `browser.${tool} が呼べない：${await res.text()}`).toBe(true);
  const body = (await res.json()) as { content?: { text: string }[]; isError?: boolean };
  expect(body.isError, `browser.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
  return JSON.parse(body.content?.[0]?.text ?? "null") as Record<string, unknown>;
}

/** AI にその tool を呼ばせ、ターンが終わるまで待つ。返すのは AI の最後の発言（偽 Runner は tool の結果をそのまま言う） */
async function ai(page: Page, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const composer = page.getByPlaceholder(/に送る/);
  const marker = `呼び出し ${++turns}：`;
  // 初回はブラウザを入れる（取ってくる・apt）ので長い
  await composer.fill(`${marker}ブラウザで確かめて。` + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: "browser", name, args }] }));
  await composer.press("Enter");
  // **初回はブラウザを入れるのに数分かかる**（改訂・2026-10-15）——字体・GStreamer・音・Chrome・Xvfb を apt と取ってくるので、
  // 別のサーバの VM で2本並べて流すと 420 秒を超えた（1本だけでも約4分20秒、GStreamer だけで 145 秒）。待つのは返事が
  // 来るまでで、早く来ればすぐ進む
  let reply: string | undefined;
  await expect(async () => {
    const allow = page.getByRole("button", { name: "許可する" });
    if ((await allow.count()) > 0) await allow.last().click();
    const t = await hostThread(page);
    const mine = t.messages.find((m) => m.role === "user" && m.text.includes(marker));
    expect(mine, "送った発言がまだ記録に無い").toBeTruthy();
    const answer = t.messages.filter((m) => m.seq > mine!.seq && m.role === "assistant" && m.text.trim() !== "");
    expect(answer.length, "返事がまだ無い").toBeGreaterThan(0);
    expect(t.lastTurn?.outcome, "ターンがまだ終わっていない").toBe("completed");
    reply = answer.map((m) => m.text).join("\n");
  }).toPass({ timeout: 900_000, intervals: [1000] });
  return reply!;
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(tree);
  if (!m) throw new Error(`${role} "${name}" がツリーに無い:\n${tree}`);
  return m[1]!;
}

/** ページの中の要素の位置（CSS ピクセル）を AI に読ませる。tab を省くと AI のいまのタブ（タブは会話ごと） */
async function rects(page: Page, tab?: string): Promise<{ name: number[]; send: number[] }> {
  const reply = await ai(page, "browserEval", {
    ...(tab ? { tab } : {}),
    expression: "'RECT ' + ['#name', '#send'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); }).join(';')",
  });
  const m = /RECT ([-\d.,;]+)/.exec(reply);
  if (!m) throw new Error(`位置が読めない：${reply}`);
  const [name, send] = m[1]!.split(";").map((s) => s.split(",").map(Number));
  return { name: name!, send: send! };
}

const canvasFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/**
 * ページの CSS ピクセルの点を、人の画面の絵の上で押す。**絵の要素からの位置で渡す**——携帯の見え方（visual viewport）が
 * ずれていると、Page の座標（boundingBox）で指で押した点は見えている絵から外れる（2026-10-10 に 19px ずれて落ちた）
 */
async function pressOnScreen(f: FrameLocator, x: number, y: number, how: "click" | "tap"): Promise<void> {
  const screen = f.getByTestId("browser-screen");
  const bb = (await screen.boundingBox())!;
  const w = Number(await screen.getAttribute("data-page-width"));
  const h = Number(await screen.getAttribute("data-page-height"));
  const position = { x: (x / w) * bb.width, y: (y / h) * bb.height };
  if (how === "tap") await screen.tap({ position });
  else await screen.click({ position });
}

const center = (r: number[]) => [r[0]! + r[2]! / 2, r[1]! + r[3]! / 2] as const;

/** 送った「送る」の要求の本文（通信の記録から、人の画面の口で） */
async function lastEchoBody(page: Page): Promise<string> {
  const list = (await uiCall(page, "listNetworkRecords", { urlContains: "/api/echo", limit: 1 })) as { records: { id: string }[] };
  if (list.records.length === 0) return "";
  const rec = (await uiCall(page, "getNetworkRecord", { id: list.records[0]!.id })) as { requestBody?: string };
  return rec.requestBody ?? "";
}

/** 画面が繋がり、そのタブの絵が描かれるまで待つ */
async function expectShowing(f: FrameLocator, tab: string): Promise<void> {
  await expect(f.getByTestId("browser-state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 180_000 });
  await expect(f.getByTestId("browser-screen"), "絵が描かれない").toBeVisible({ timeout: 60_000 });
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", tab);
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/browser`, { headers, data: { name: "browser" } });
  const body = res.ok() ? "" : await res.text();
  if (!res.ok() && !body.includes("その名前はもう使われています")) throw new Error(`Browser を目録から入れられませんでした: ${res.status()} ${body}`);
});

test.afterAll(() => {
  testPage?.kill();
});

test("人の画面：カードから開いて映し、人の入力がページに届き、AI の操作は帯つきで映り、HAR を保存でき、「AI に触らせない」で断り、閉じると止まり、携帯でも触れる", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await openApp(page);
  const PROJECT_NAME = projectName();
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-browser-view-")));
  await waitForProjectModule(page, PROJECT_NAME, "browser");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

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

  // ---- 1. AI が開く → 会話のカード → 押すと画面が Canvas で開く ----------------------------------------
  expect(await ai(page, "browserOpen", { url: `${BASE}/` })).toContain("タブ t1 で開きました");
  const card = page.getByTestId("tool-entry-card").filter({ hasText: `ブラウザで開いた：${BASE}/` });
  await expect(card, "browserOpen のカードが出ない").toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: "開く" }).click();
  let f = canvasFrame(page);
  await expectShowing(f, "t1");
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-page-width", "1280");
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-page-height", "800");
  await expect(f.locator('.tab[data-tab="t1"]')).toHaveAttribute("aria-selected", "true");
  await expect(f.locator('.tab[data-tab="t1"]')).toContainText("Browser 試験のページ");
  await expect(f.getByRole("textbox", { name: "URL" })).toHaveValue(`${BASE}/`);
  await expect(f.getByTestId("viewport")).toHaveText("ページ 1280×800");
  await expect(f.getByTestId("ai-blocked")).not.toBeChecked();
  const status = await uiCall(page, "getBrowserStatus");
  expect(status.view).toMatchObject({ viewers: 1, watching: 1, screencasting: true, screencastTab: "t1" });

  // ---- 2. 人がページを押して打つ ---------------------------------------------------------------------
  const r = await rects(page);
  await pressOnScreen(f, ...center(r.name), "click");
  await page.keyboard.type("ばんと"); // 日本語は insertText
  await page.keyboard.type("x1"); // 英数字はキー
  await pressOnScreen(f, ...center(r.send), "click");
  await expect.poll(() => lastEchoBody(page), { timeout: 20_000, message: "人の入力がページに届かない" }).toBe('{"name":"ばんとx1"}');

  // ---- 3. 通信とコンソールの欄 -----------------------------------------------------------------------
  await f.getByRole("button", { name: /^通信/ }).click();
  const net = f.getByTestId("network-panel");
  await expect(net).toBeVisible();
  const echoRow = net.locator("tr.row", { hasText: "/api/echo" }).first();
  await expect(echoRow).toContainText("POST");
  await expect(echoRow).toContainText("200");
  await expect(net.locator("tr.row", { hasText: "/api/fail" }).first()).toContainText("500");
  await expect(net.locator("tr.row", { hasText: "/unreachable" }).first()).toContainText("失敗");
  await echoRow.click();
  await expect(f.getByTestId("network-detail")).toContainText('{"name":"ばんとx1"}');
  // 人の画面ではヘッダを伏せない
  await expect(f.getByTestId("network-detail")).toContainText(`authorization: Bearer ${TOKEN_VALUE}`);
  await expect(f.getByRole("button", { name: /^通信/ })).not.toContainText(/^通信0$/);
  // 絞る：エラーだけ
  await f.getByRole("combobox", { name: "状態で絞る" }).selectOption("error");
  await expect(net.locator("tr.row", { hasText: "/api/echo" })).toHaveCount(0);
  await expect(net.locator("tr.row", { hasText: "/api/fail" }).first()).toBeVisible();
  await f.getByRole("combobox", { name: "状態で絞る" }).selectOption("");
  await f.getByRole("button", { name: /^コンソール/ }).click();
  await expect(f.getByTestId("console-panel")).toContainText("試験のエラー: わざと出した");
  await expect(f.getByTestId("network-panel")).toBeHidden();

  // ---- 4. AI の操作が帯つきで映る --------------------------------------------------------------------
  const tree = await ai(page, "browserSnapshot");
  const seqBefore = Number(await f.getByTestId("browser-screen").getAttribute("data-seq"));
  const banner = f.getByTestId("ai-banner");
  // 帯は一瞬（4秒）で消えるので、AI のターンと並べて待つ。どの Thread の AI かも帯に出る
  await Promise.all([
    ai(page, "browserAct", { action: "click", ref: refOf(tree, "button", "送る") }),
    expect(banner, "AI の操作の帯が出ない").toContainText(new RegExp(`AI が操作中：『送る』を押しました（Thread ${threadId.slice(0, 8)}）`), { timeout: 120_000 }),
    expect(f.getByTestId("ai-box"), "押した要素の枠が出ない").toHaveCount(1, { timeout: 120_000 }),
  ]);
  await expect.poll(async () => Number(await f.getByTestId("browser-screen").getAttribute("data-seq")), { message: "AI の操作のあと絵が新しくならない" }).toBeGreaterThan(seqBefore);

  // ---- 5. HAR で保存 --------------------------------------------------------------------------------
  await f.getByRole("button", { name: /^通信/ }).click();
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await f.getByTestId("save-har").click();
  // 押してから保存までが長いと banto が確かめる（人の操作の直後でないため）——出たら押す
  const confirm = page.getByRole("button", { name: "ダウンロードする" });
  const download = await Promise.race([
    downloading,
    confirm.waitFor({ timeout: 60_000 }).then(async () => {
      await confirm.click();
      return downloading;
    }, () => new Promise<never>(() => undefined)),
  ]);
  expect(download.suggestedFilename()).toMatch(/^browser-\d{8}-\d{6}\.har$/);
  const har = JSON.parse(readFileSync((await download.path())!, "utf8")) as {
    log: { version: string; entries: { request: { url: string; method: string; headers: { name: string; value: string }[]; postData?: { text?: string } } }[] };
  };
  expect(har.log.version).toBe("1.2");
  const echo = har.log.entries.find((e) => e.request.url.endsWith("/api/echo") && e.request.postData?.text === '{"name":"ばんとx1"}');
  expect(echo, "HAR に人が送った要求が無い").toBeTruthy();
  expect(echo!.request.headers.find((h) => h.name.toLowerCase() === "authorization")?.value).toBe(`Bearer ${TOKEN_VALUE}`);
  expect(har.log.entries.some((e) => e.request.url.endsWith("/api/ok"))).toBe(true);

  // ---- 6. 「AI に触らせない」 -----------------------------------------------------------------------
  await f.getByTestId("ai-blocked").check();
  // 注記は隠れたまま（hidden）でも文はあるので、toContainText だけでは切り替えが Module に届くのを待てない（Backlog #386）。
  // 見えるのは setAiBlocked の答えか Module の知らせで aiBlocked が true になってから
  await expect(f.getByTestId("block-note")).toBeVisible();
  await expect(f.getByTestId("block-note")).toContainText("これは境界ではありません");
  expect((await uiCall(page, "getBrowserStatus")).aiBlocked).toBe(true);
  expect(await ai(page, "browserAct", { action: "reload" })).toContain("人が「AI に触らせない」を入れているので、browserAct の reload はできません");
  // 読む道具は断らない
  expect(await ai(page, "browserSnapshot")).toContain('button "送る"');
  await f.getByTestId("ai-blocked").uncheck();
  await expect(f.getByTestId("block-note")).toBeHidden();
  expect((await uiCall(page, "getBrowserStatus")).aiBlocked).toBe(false);
  expect(await ai(page, "browserAct", { action: "reload" })).toContain("読み直しました");

  // ---- 7. 画面の操作を一度ずつ ------------------------------------------------------------------------
  const urlBar = f.getByRole("textbox", { name: "URL" });
  const tab1 = f.locator('.tab[data-tab="t1"]');
  const documents = async (path: string) =>
    ((await uiCall(page, "listNetworkRecords", { urlContains: path, type: "document" })) as { records: unknown[] }).records.length;
  // URL 欄で開く（scheme を書かなくてよい）
  await urlBar.fill(`127.0.0.1:${PORT}/second`);
  await urlBar.press("Enter");
  await expect(tab1, "URL 欄で開いたページの題がタブに出ない").toContainText("2ページ目");
  await expect(urlBar).toHaveValue(`${BASE}/second`);
  // 戻る・進む
  await f.getByRole("button", { name: "戻る" }).click();
  await expect(tab1, "戻るで前のページに戻らない").toContainText("Browser 試験のページ");
  await expect(urlBar).toHaveValue(`${BASE}/`);
  await f.getByRole("button", { name: "進む" }).click();
  await expect(tab1, "進むで次のページへ進まない").toContainText("2ページ目");
  await expect(urlBar).toHaveValue(`${BASE}/second`);
  // 読み直す：そのページの文書の要求がもう1件増える
  const before = await documents("/second");
  await f.getByRole("button", { name: "読み直す" }).click();
  await expect.poll(() => documents("/second"), { message: "読み直すで要求が出ない" }).toBe(before + 1);
  await f.getByRole("button", { name: "戻る" }).click();
  await expect(tab1).toContainText("Browser 試験のページ");
  // ＋：新しいタブ t2 が選ばれ、絵も t2 になる。URL 欄で開くとそのタブに開く。＋は検索エンジンのトップで開く——試験で外に
  // 出ないよう試験用の検索エンジン（test-page の /search）を指す（中身は browser-search.spec.ts で見る）
  await uiCall(page, "setSettings", { searchEngine: "custom", searchTemplate: `${BASE}/search?q=%s` });
  await f.getByRole("button", { name: "新しいタブ" }).click();
  const tab2 = f.locator('.tab[data-tab="t2"]');
  await expect(tab2, "＋でタブができない").toHaveAttribute("aria-selected", "true");
  await expect(tab2, "＋のタブが検索のトップで開かない").toContainText("試験の検索");
  await expect(tab1).toHaveAttribute("aria-selected", "false");
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", "t2");
  await urlBar.fill(`${BASE}/second`);
  await urlBar.press("Enter");
  await expect(tab2).toContainText("2ページ目");
  await expect(tab1).toContainText("Browser 試験のページ");
  // 画面で選んだタブは人のもの（持ち主なし）で、人の画面に映っている。AI の「いまのタブ」は会話ごと——人が切り替えても
  // この会話のタブ（t1）のまま
  const listed = await ai(page, "browserTabs", { action: "list" });
  expect(listed).toMatch(/^  t2 \[人\]（人の画面） \S+\/second 2ページ目$/m);
  expect(listed).toMatch(/^\* t1 \[この会話\] \S+\/ Browser 試験のページ$/m);
  // 人のタブには持ち主の印が無く、AI が開いた t1 には会話の頭8字（押すとその会話を開く）
  await expect(tab2.locator(".tab-owner")).toHaveCount(0);
  await expect(tab1.locator(".tab-owner")).toHaveText(threadId.slice(0, 8));
  // 切り替え
  await tab1.locator(".tab-name").click();
  await expect(tab1, "タブを押しても切り替わらない").toHaveAttribute("aria-selected", "true");
  await expect(f.getByTestId("browser-screen")).toHaveAttribute("data-tab", "t1");
  await expect(urlBar).toHaveValue(`${BASE}/`);
  expect(await ai(page, "browserTabs", { action: "list" })).toMatch(/^\* t1 \[この会話\]（人の画面） \S+\/ Browser 試験のページ$/m);
  // ×：t2 を閉じる
  await f.getByRole("button", { name: "t2 を閉じる" }).click();
  await expect(f.locator(".tab[data-tab]"), "× でタブが閉じない").toHaveCount(1);
  await expect(tab2).toHaveCount(0);
  expect(((await uiCall(page, "getBrowserStatus")).tabs as { id: string }[]).map((t) => t.id)).toEqual(["t1"]);

  // ---- 8. 閉じると screencast が止まる。入口からも開ける --------------------------------------------
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect.poll(async () => (await uiCall(page, "getBrowserStatus")).view, { timeout: 20_000, message: "画面を閉じても screencast が止まらない" }).toEqual({
    viewers: 0,
    watching: 0,
    screencasting: false,
  });
  threadUrl = page.url();
  expect((await uiCall(page, "getBrowserStatus")).running, "画面を閉じただけでブラウザを止めた").toBe(true);
  await page.getByRole("button", { name: "検索（Command Palette）" }).click();
  const entry = page.locator('[role="option"][data-value^="launcher:browser:"]');
  await expect(entry, "Browser の入口が出ない").toContainText("ブラウザ", { timeout: 60_000 });
  await entry.click();
  f = canvasFrame(page);
  await expectShowing(f, "t1");

  // ---- 9. 携帯 ------------------------------------------------------------------------------------
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await loginContext(mobile);
    const m = await mobile.newPage();
    m.on("pageerror", (err) => pageErrors.push(`mobile: ${err.message}`));
    await openApp(m); // 繋ぐ先（core）を画面に渡す
    await m.goto(page.url());
    const mf = canvasFrame(m);
    await expectShowing(mf, "t1");
    expect((await uiCall(page, "getBrowserStatus")).view).toMatchObject({ viewers: 2, screencasting: true });
    await expect(mf.getByRole("button", { name: "キーボード" }), "携帯でキーボードの口が出ない").toBeVisible();
    // 画面に合わせる：ページの幅が携帯の幅になる。パソコンの画面にも出る
    await mf.getByTestId("fit").check();
    // 絵を出す場所の幅（携帯の幅 390 から枠のぶん狭いことがある）
    await expect(mf.getByTestId("viewport")).toHaveText(/^ページ (3[0-8]\d|390)×\d+$/, { timeout: 20_000 });
    const fitWidth = /ページ (\d+)×/.exec((await mf.getByTestId("viewport").textContent())!)![1]!;
    await expect(mf.getByTestId("browser-screen")).toHaveAttribute("data-page-width", fitWidth, { timeout: 20_000 });
    await expect(f.getByTestId("viewport")).toContainText("ほかの画面に合わせています");
    // 指で押して、キーボードの欄から打つ
    const mr = await rects(page);
    const tap = (rect: number[]) => pressOnScreen(mf, ...center(rect), "tap");
    await tap(mr.name);
    await mf.getByRole("button", { name: "キーボード" }).click();
    await m.keyboard.type("けいたい");
    await tap(mr.send);
    await expect.poll(() => lastEchoBody(page), { timeout: 20_000, message: "携帯の入力がページに届かない" }).toBe('{"name":"けいたい"}');
  } finally {
    await mobile.close();
  }
  // 携帯を閉じたら、ページの大きさは元に戻る
  await expect(f.getByTestId("viewport")).toHaveText("ページ 1280×800", { timeout: 20_000 });

  // ---- 10. 「ブラウザの記録を消す」（2回押す）----------------------------------------------------------
  await expect(f.getByRole("button", { name: /^通信/ })).not.toHaveAccessibleName("通信0");
  // 1回目は確かめるだけ（まだ消さない）。帯が狭ければ「…」から
  const viaMenu = await clearBrowserData(f);
  await expect(f.getByRole("button", { name: /^通信/ }), "記録を消しても通信の件数が 0 にならない").toHaveAccessibleName("通信0", { timeout: 30_000 });
  await expect(f.getByRole("button", { name: /^コンソール/ })).toHaveAccessibleName("コンソール0");
  if (viaMenu) {
    await f.getByRole("button", { name: "もっと見る" }).click();
    await expect(f.getByRole("menuitem", { name: "ブラウザの記録を消す" })).toBeVisible();
    await f.getByRole("button", { name: "もっと見る" }).press("Escape");
  } else await expect(f.getByRole("button", { name: "ブラウザの記録を消す" })).toBeVisible();
  // ブラウザは止めて起こし直した：前のタブは無く、記録も無い
  await expect(tab1, "消したのに前のタブが残っている").toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const st = await uiCall(page, "getBrowserStatus");
    return { running: st.running, records: (st.log as { records: number }).records };
  }, { timeout: 30_000 }).toEqual({ running: true, records: 0 });

  // ---- 11. 人のブラウザと同じ（名乗り・webdriver・プラグイン・言語）---------------------------------------
  const whoami = await ai(page, "browserOpen", { url: `${BASE}/whoami` });
  const version = / Chrome\/(\d+)\.0\.0\.0 /.exec(whoami);
  expect(whoami, "要求の User-Agent が Headless を名乗っている").not.toContain("Headless");
  expect(version?.[1], `要求の User-Agent に Chrome/<版>.0.0.0 が無い：${whoami}`).toBeTruthy();
  expect(whoami, "要求の Accept-Language が ja-JP から始まらない").toMatch(/acceptLanguage\W+ja-JP,ja;q=0\.9,/);
  const nav = await ai(page, "browserEval", {
    expression: "'NAV ' + navigator.userAgent + ' | ' + navigator.languages.join(',') + ' | webdriver=' + navigator.webdriver + ' | plugins=' + navigator.plugins.length",
  });
  expect(nav).toContain(`Chrome/${version![1]}.0.0.0 Safari`);
  expect(nav).not.toContain("Headless");
  expect(nav).toContain(" | ja-JP,ja,en-US,en | ");
  expect(nav).toContain(" | webdriver=false | ");
  expect(nav).toMatch(/ \| plugins=[1-9]\d*/);

  // ---- 12. 別オリジンの iframe ------------------------------------------------------------------------
  // iframe の中は全面が1色（試験用のページの FRAME_COLORS）：読み終えて少し後に赤、押すたびに緑・青
  const FRAME = { x: 100, y: 100, width: 400, height: 300 };
  const frameCenter = [FRAME.x + FRAME.width / 2, FRAME.y + FRAME.height / 2] as const;
  /** 人の画面の絵（canvas）の、ページの点に当たる画素の色 */
  const colorOnScreen = () =>
    f.getByTestId("browser-screen").evaluate((canvas: HTMLCanvasElement, [x, y]) => {
      const k = canvas.width / Number(canvas.dataset.pageWidth);
      const d = canvas.getContext("2d")!.getImageData(Math.round(x! * k), Math.round(y! * k), 1, 1).data;
      return d[0]! > 200 && d[1]! < 60 && d[2]! < 60 ? "red" : d[0]! < 60 && d[1]! > 200 && d[2]! < 60 ? "green" : d[0]! < 60 && d[1]! < 60 && d[2]! > 200 ? "blue" : `rgb(${d[0]},${d[1]},${d[2]})`;
    }, frameCenter);
  const urlBarNow = f.getByRole("textbox", { name: "URL" });
  await urlBarNow.fill(`${BASE}/frame`);
  await urlBarNow.press("Enter");
  await expect(f.locator(".tab[aria-selected=true]"), "別オリジンの iframe のページが開かない").toContainText("別オリジンの iframe");
  await expect.poll(colorOnScreen, { timeout: 20_000, message: "人の画面に iframe の中身（読み終えた後の描画）が映らない" }).toBe("red");
  await pressOnScreen(f, ...frameCenter, "click");
  await expect.poll(colorOnScreen, { timeout: 20_000, message: "絵の上で押しても iframe が変わらない（または変わった絵が来ない）" }).toBe("green");
  await pressOnScreen(f, ...frameCenter, "click");
  await expect.poll(colorOnScreen, { timeout: 20_000, message: "2回目の押下の後の絵が来ない" }).toBe("blue");
  // 押した数は iframe の中から試験用のページのサーバに届いている
  expect(await ai(page, "browserEval", { expression: "fetch('/api/frame-clicks').then((r) => r.text()).then((t) => 'CLICKS ' + t)" })).toMatch(/CLICKS \{\W*clicks\W*:2\}/);

  // ---- 13. 高精細の画面 ------------------------------------------------------------------------------
  const hidpi = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  try {
    await loginContext(hidpi);
    const h = await hidpi.newPage();
    h.on("pageerror", (err) => pageErrors.push(`hidpi: ${err.message}`));
    await openApp(h);
    await h.goto(page.url());
    let hf = canvasFrame(h);
    await expectShowing(hf, (await f.getByTestId("browser-screen").getAttribute("data-tab"))!);
    // 開いた画面の倍率を、次に起こすときの倍率として覚える。動いているブラウザは1倍のまま
    await expect.poll(async () => (await uiCall(page, "getSettings")).viewScale, { timeout: 20_000, message: "倍率2の画面を開いたのに倍率を覚えない" }).toBe(2);
    expect((await uiCall(page, "getBrowserStatus")).scale).toBe(1);
    // 起こし直す（「ブラウザの記録を消す」）——倍率2で起きる
    await clearBrowserData(hf);
    await expect.poll(async () => {
      const st = await uiCall(page, "getBrowserStatus");
      return { running: st.running, scale: st.scale };
    }, { timeout: 60_000, message: "倍率2で起き直さない" }).toEqual({ running: true, scale: 2 });
    const urlBar2 = hf.getByRole("textbox", { name: "URL" });
    await urlBar2.fill(`${BASE}/`);
    await urlBar2.press("Enter");
    await expect(hf.locator(".tab[aria-selected=true]")).toContainText("Browser 試験のページ", { timeout: 30_000 });
    hf = canvasFrame(h);
    // 人の画面が起こし直したブラウザのタブは人のもの——AI はそのタブを tab で指して読む（省くと会話のタブ。まだ無い）
    const humanTab = (await hf.locator(".tab[aria-selected=true]").getAttribute("data-tab"))!;
    const screen2 = hf.getByTestId("browser-screen");
    await expect(screen2).toHaveAttribute("data-page-width", "1280");
    await expect(screen2).toHaveAttribute("data-page-height", "800");
    // 絵（canvas はそのままの画素で描く）が、絵を出している場所の物理ピクセル（CSS の大きさ×2）以上——引き伸ばさない。
    // 1倍のページ（1280×800）より大きい（倍率2で描いている）・ページと同じ比。上限はページ×2（2560×1600）
    const shown = () =>
      screen2.evaluate((c: HTMLCanvasElement) => {
        const r = c.getBoundingClientRect();
        return { width: c.width, height: c.height, physical: Math.round(r.width * devicePixelRatio), dpr: devicePixelRatio };
      });
    await expect
      .poll(async () => {
        const v = await shown();
        return v.width >= Math.min(2560, v.physical) - 1 && v.width > 1280 && v.width <= 2560 && Math.abs(v.width / v.height - 1.6) < 0.01;
      }, { timeout: 30_000, message: "倍率2の画面に届く絵が、絵を出す場所の物理ピクセルの大きさでない" })
      .toBe(true);
    const got = await shown();
    expect(got.dpr).toBe(2);
    test.info().annotations.push({ type: "hidpi", description: `絵 ${got.width}×${got.height}・絵を出す場所 ${got.physical} 物理ピクセル` });
    expect(await ai(page, "browserEval", { tab: humanTab, expression: "'DPR ' + devicePixelRatio + ' ' + innerWidth + 'x' + innerHeight + ' screen ' + screen.width + 'x' + screen.height" })).toContain(
      "DPR 2 1280x800 screen 1920x1080",
    );
    // 人の入力は今までどおり CSS ピクセルで届く：押して打つ
    const r2 = await rects(page, humanTab);
    await pressOnScreen(hf, ...center(r2.name), "click");
    await h.keyboard.type("hidpi");
    await pressOnScreen(hf, ...center(r2.send), "click");
    await expect.poll(() => lastEchoBody(page), { timeout: 20_000, message: "倍率2の画面からの入力がページに届かない" }).toBe('{"name":"hidpi"}');
    // 流れは切れていない（1 MiB を越えた1通があれば host が 1009 で閉じる）
    await expect(hf.getByTestId("browser-state")).toHaveAttribute("data-state", "open");
    await expect(f.getByTestId("browser-state")).toHaveAttribute("data-state", "open");
  } finally {
    await hidpi.close();
  }

  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});

test("狭い Canvas（会話の横、幅 約390px）：上の帯は2段とも1行のまま幅を変えても高さが変わらず、しまった「ブラウザの記録を消す」は「…」から2回押しで使える。「…」はキーボードでも開け閉めできる（Backlog #384）", async ({ page }) => {
  expect(threadUrl, "前の試験が会話を開いていない").not.toBe("");
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  await page.setViewportSize({ width: 1100, height: 800 });
  await openApp(page);
  await page.goto(threadUrl);
  // 会話の browserOpen のカードから、会話の横に開く（会話は最新の 20 件だけ描く——無ければ前を出す）
  const card = page.getByTestId("tool-entry-card").filter({ hasText: `ブラウザで開いた：${BASE}/whoami` });
  for (let i = 0; i < 10 && (await card.count()) === 0 && (await page.getByTestId("show-earlier-messages").count()) > 0; i += 1) await page.getByTestId("show-earlier-messages").click();
  await card.getByRole("button", { name: "開く" }).click();
  const f = canvasFrame(page);
  await expect(f.getByTestId("browser-state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 60_000 });
  await expect(f.getByTestId("viewport")).toHaveText(/^ページ \d+×\d+$/, { timeout: 20_000 });

  /** Canvas の幅（人の画面の中から見た幅） */
  const canvasWidth = () => f.locator("body").evaluate(() => window.innerWidth);
  /** 上の帯2段の高さ・中身が1行に収まっているか（どれも帯の中・はみ出しなし） */
  const bars = () =>
    f.locator(".bar").evaluateAll((els) =>
      els.map((bar) => {
        const r = bar.getBoundingClientRect();
        const shown = [...bar.children].filter((e) => e.getClientRects().length > 0);
        const outside = shown.filter((e) => {
          const c = e.getBoundingClientRect();
          return c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5 || c.left < r.left - 0.5 || c.right > r.right + 0.5;
        });
        return { height: r.height, outside: outside.map((e) => e.id || e.className), overflow: bar.scrollWidth - bar.clientWidth };
      }),
    );
  // 広いときの帯の高さ（1行の高さ）
  const wide = await bars();
  expect(wide.map((b) => [b.outside, b.overflow]), "広い Canvas で帯の中身がはみ出している").toEqual([[[], 0], [[], 0]]);

  // 境界を右端（会話が半分）まで寄せ、窓を縮めて Canvas を約390px にする
  const split = page.getByRole("separator", { name: "Base Thread と Canvas の境界" });
  await split.focus();
  for (let i = 0; i < 10; i += 1) await split.press("ArrowRight");
  for (let i = 0; i < 8; i += 1) {
    const w = await canvasWidth();
    if (Math.abs(w - 390) <= 6) break;
    // Canvas は会話の半分の残り（窓の幅の約半分）
    await page.setViewportSize({ width: Math.round(page.viewportSize()!.width + (390 - w) * 2), height: 800 });
    await expect.poll(canvasWidth, { message: "窓を縮めても Canvas の幅が変わらない" }).not.toBe(w);
  }
  const narrowWidth = await canvasWidth();
  expect(Math.abs(narrowWidth - 390), `Canvas の幅が約390px にならない（${narrowWidth}px）`).toBeLessThanOrEqual(6);
  test.info().annotations.push({ type: "canvas", description: `狭い Canvas ${narrowWidth}px` });

  // **帯は2段とも1行**：高さは広いときと同じ、中身は帯の中
  await expect.poll(bars, { message: "狭い Canvas で帯が1行にならない" }).toEqual(wide.map((b) => ({ ...b })));
  // 「AI に触らせない」「画面に合わせる」は出たまま。「ブラウザの記録を消す」は「…」にしまってある
  await expect(f.getByTestId("ai-blocked")).toBeVisible();
  await expect(f.getByTestId("fit")).toBeVisible();
  await expect(f.getByTestId("browser-state")).toHaveText("繋がっています");
  await expect(f.getByRole("textbox", { name: "URL" })).toBeVisible();
  const more = f.getByRole("button", { name: "もっと見る" });
  await expect(more, "狭いのに「…」が出ない").toBeVisible();
  await expect(f.getByRole("button", { name: "ブラウザの記録を消す" }), "狭いのに「ブラウザの記録を消す」が帯に残っている").toHaveCount(0);

  // **幅を変えても帯の高さは変わらない**（境界を少しずつ戻して Canvas を広げる）
  const seen = new Set<number>();
  for (let i = 0; i < 12; i += 1) {
    const w = await canvasWidth();
    seen.add(w);
    await expect.poll(bars, { message: `Canvas の幅 ${w}px で帯の高さが変わった・はみ出した` }).toEqual(wide);
    await split.press("ArrowLeft");
    await expect.poll(canvasWidth).not.toBe(w);
  }
  expect(seen.size, "Canvas の幅が変わっていない").toBeGreaterThan(5);
  // 十分に広げれば帯に戻る（窓を広げる）
  const narrowViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(f.getByRole("button", { name: "ブラウザの記録を消す" }), `広げても（${await canvasWidth()}px）「ブラウザの記録を消す」が帯に戻らない`).toBeVisible();
  await expect(more).toBeHidden();
  expect(await bars(), "広げた帯の高さが変わった").toEqual(wide);
  // 狭く戻す
  await page.setViewportSize(narrowViewport);
  await split.focus();
  for (let i = 0; i < 12; i += 1) await split.press("ArrowRight");
  await expect.poll(canvasWidth).toBe(narrowWidth);
  await expect(more).toBeVisible();

  // **「…」はキーボードで開け閉めできる**：開くと中の1つ目に移り、Escape で閉じて「…」に戻る
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(f.getByRole("menuitem", { name: "ブラウザの記録を消す" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(f.getByRole("menuitem", { name: "ブラウザの記録を消す" })).toBeHidden();
  await expect(more).toBeFocused();
  // 1回押して閉じると、2回目を待つのをやめる（開き直すと元の名前）
  await more.click();
  await f.getByRole("menuitem", { name: "ブラウザの記録を消す" }).click();
  await expect(f.getByRole("menuitem", { name: "もう一度押すと消します" })).toBeVisible();
  // 開いているあいだも帯は1行（「…」の中身は帯の外に重ねて出す）
  expect(await bars()).toEqual(wide);
  await page.keyboard.press("Escape");
  await more.click();
  await expect(f.getByRole("menuitem", { name: "ブラウザの記録を消す" }), "閉じたのに「もう一度押すと消します」のまま").toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // **「…」から記録を消す**：通信を作ってから、2回押しで消す
  const urlBar = f.getByRole("textbox", { name: "URL" });
  await urlBar.fill(`${BASE}/`);
  await urlBar.press("Enter");
  await expect(f.locator(".tab[aria-selected=true]")).toContainText("Browser 試験のページ", { timeout: 30_000 });
  await expect(f.getByRole("button", { name: /^通信/ })).not.toHaveAccessibleName("通信0", { timeout: 20_000 });
  expect(await clearBrowserData(f), "狭いのに「…」から押していない").toBe(true);
  await expect(f.getByRole("button", { name: /^通信/ }), "「…」から消しても通信の件数が 0 にならない").toHaveAccessibleName("通信0", { timeout: 30_000 });
  await expect(f.getByRole("button", { name: /^コンソール/ })).toHaveAccessibleName("コンソール0");
  await expect(f.locator(".tab", { hasText: "Browser 試験のページ" }), "消したのに前のタブが残っている").toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const st = await uiCall(page, "getBrowserStatus");
    return { running: st.running, records: (st.log as { records: number }).records };
  }, { timeout: 30_000 }).toEqual({ running: true, records: 0 });
  // 消したあとも帯は1行で、「ブラウザの記録を消す」は「…」の中
  await expect.poll(bars).toEqual(wide);
  await more.click();
  await expect(f.getByRole("menuitem", { name: "ブラウザの記録を消す" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
