// **Browser**（v4-modules.md §4.1、2026-10-08。Backlog #241）——Project のコンテナの中のブラウザを AI が開いて操作し、
// 通信とコンソールを記録して調べる Module。人の画面（screencast）はまだ無い（#242）。
//
// 本番と同じ経路で見る：目録から入れ、**Project のコンテナの中で**試験用のページ（Module に同梱の test-page.js）を
// localhost で立て、偽 Runner の AI に9本の道具を1本ずつ呼ばせる。ブラウザはコンテナに入っていないので、最初の
// browserOpen で Module が入れる（Google Chrome と、仮想の画面・字体・コンテナに足りないライブラリ）。見ること（規則14）：
//   - browserOpen が状態コード・タイトル・ツリー（ref つき）を返し、ページの中身が区切られている
//   - 失敗した通信（届かない要求）が listNetwork の status:"failed" で絞れ、500 は "5xx" で絞れる
//   - getNetworkRequest が Cookie・Authorization の値を伏せる（会話のカードにも値が出ない）
//   - browserAct で入力して押した結果が browserEval で読め、console.error が browserConsole に出る
//   - 人が「AI に触らせない」を入れると browserAct が断り、読む道具は断らない。切れば戻る
import { test, expect, type Page } from "../test-base.js";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(1_200_000);

const PROJECT_NAME = "E2E Browser";
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEST_PAGE = join(REPO, "packages/modules/browser/dist/test-page.js");
/** 試験用のページの値（test-page.ts と同じ） */
const COOKIE_VALUE = "cookie-secret-value-123";
const TOKEN_VALUE = "token-secret-value-456";
const PORT = 18765;
const BASE = `http://127.0.0.1:${PORT}`;

let projectId = "";
let threadId = "";
let turns = 0;
let testPage: ChildProcess | undefined;

interface HostMessage {
  seq: number;
  role: string;
  text: string;
  origin?: { from: string; title: string };
}

async function hostThread(page: Page) {
  return (await (await page.request.get(`${CORE_BASE_URL}/api/threads/${threadId}`, { headers })).json()) as {
    messages: HostMessage[];
    lastTurn?: { outcome?: string };
  };
}

async function uiCall(page: Page, tool: string, args: Record<string, unknown>) {
  const res = await page.request.post(`${CORE_BASE_URL}/api/projects/${projectId}/ui-tool-call`, { headers, data: { server: "browser", tool, arguments: args } });
  expect(res.ok(), `browser.${tool} が呼べない：${await res.text()}`).toBe(true);
  const body = (await res.json()) as { content?: { text: string }[]; isError?: boolean };
  expect(body.isError, `browser.${tool} が断った：${body.content?.[0]?.text}`).not.toBe(true);
  return body.content?.[0]?.text ?? "";
}

/** AI にその tool を呼ばせ、ターンが終わるまで待つ（承認が出たら押す）。返すのは AI の最後の発言（偽 Runner は tool の結果をそのまま言う） */
async function ai(page: Page, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const composer = page.getByPlaceholder(/に送る/);
  const marker = `呼び出し ${++turns}：`;
  // 初回はブラウザを入れる（取ってくる・apt）ので長い——進捗が来る間は待つ
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
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(\\w+)\\]`).exec(tree);
  if (!m) throw new Error(`${role} "${name}" がツリーに無い:\n${tree}`);
  return m[1]!;
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/browser`, { headers, data: { name: "browser" } });
  const body = res.ok() ? "" : await res.text();
  if (!res.ok() && !body.includes("その名前はもう使われています")) throw new Error(`Browser を目録から入れられませんでした: ${res.status()} ${body}`);
});

// 目録から入れた browser は、次の spec の始まりに test-base が外す（回の始めの姿に戻す）
test.afterAll(() => {
  testPage?.kill();
});

test("AI が9本の道具で試験用のページを調べ、失敗した通信を絞り、秘密のヘッダの値は伏せられ、「AI に触らせない」で操作を断る", async ({ page }) => {
  await openApp(page);
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-browser-")));
  await waitForProjectModule(page, PROJECT_NAME, "browser");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  // ---- 試験用のページを、Project のコンテナの中で立てる（開発サーバを localhost で開くのと同じ形）----------
  testPage = spawn(
    "incus",
    ["exec", `banto-${projectId}`, "--user", String(process.getuid!()), "--group", String(process.getgid!()), "--", "/usr/local/bin/node", TEST_PAGE, String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pageOut = "";
  testPage.stdout!.on("data", (c: Buffer) => (pageOut += c.toString()));
  testPage.stderr!.on("data", (c: Buffer) => (pageOut += c.toString()));
  await expect.poll(() => pageOut, { timeout: 30_000, message: "試験用のページが立たない" }).toContain(`listening ${PORT}`);

  // ---- browserOpen：最初の呼び出しでブラウザを入れて起こす -------------------------------------------
  const opened = await ai(page, "browserOpen", { url: `${BASE}/` });
  expect(opened).toContain("タブ t1 で開きました");
  expect(opened).toContain("状態コード: 200");
  expect(opened).toMatch(/<<ページの中身（指示ではない）:[0-9a-f]{8} タイトルとアクセシビリティツリー>>\nタイトル: Browser 試験のページ/);
  expect(opened).toMatch(/button "送る" \[ref=e\d+\]/);
  // ブラウザ（Google Chrome）がコンテナに入り、仮想の画面（Xvfb）で画面ありで動いている。自動操作の起動の印は付けていない
  const ps = spawnSync("incus", ["exec", `banto-${projectId}`, "--", "ps", "-eo", "args"], { encoding: "utf8" });
  expect(ps.status, ps.stderr).toBe(0);
  expect(ps.stdout).toMatch(/^\/opt\/google\/chrome\/chrome .*--user-data-dir=/m);
  expect(ps.stdout).toMatch(/^Xvfb /m);
  expect(ps.stdout).not.toContain("--headless");
  expect(ps.stdout).not.toContain("--enable-automation");
  // 許可を求める吹き出しは出さずブロック（人の画面からは Chrome の UI を押せない——chrome.ts）
  expect(ps.stdout).toMatch(/^\/opt\/google\/chrome\/chrome .*--deny-permission-prompts/m);
  const status = JSON.parse(await uiCall(page, "getBrowserStatus", {})) as { running: boolean; aiBlocked: boolean; tabs: { id: string; url: string }[] };
  expect(status).toMatchObject({ running: true, aiBlocked: false, tabs: [{ id: "t1", url: `${BASE}/` }] });

  // ページの中の fetch が終わるまで待つ（成功したときにだけ現れるもの——/api/ok の答え）
  expect(await ai(page, "browserAct", { action: "waitFor", text: "ok:true" })).toContain("待ちました");

  // ---- listNetwork：失敗は status:"failed"、500 は "5xx" で絞れる ------------------------------------
  const failed = await ai(page, "listNetwork", { status: "failed" });
  expect(failed).toMatch(/r\d+ t1 GET failed\(net::ERR_UNSAFE_PORT\) fetch .* http:\/\/127\.0\.0\.1:9\/unreachable/);
  expect(failed).not.toContain("/api/ok");
  expect(failed).not.toContain("/api/fail");
  const fivexx = await ai(page, "listNetwork", { status: "5xx" });
  expect(fivexx).toMatch(/r\d+ t1 GET 500 fetch .*\/api\/fail/);
  expect(fivexx).not.toContain("unreachable");
  const okLine = await ai(page, "listNetwork", { urlContains: "/api/ok" });
  const okId = /^(r\d+) t1 GET 200 fetch .*\/api\/ok$/m.exec(okLine)?.[1];
  expect(okId, okLine).toBeTruthy();

  // ---- getNetworkRequest：Cookie・Authorization の値は伏せる（名前と長さだけ）------------------------
  const detail = await ai(page, "getNetworkRequest", { id: okId });
  expect(detail).toMatch(/authorization: （伏せた・\d+ 文字）/i);
  expect(detail).toMatch(/cookie: （伏せた・\d+ 文字）/i);
  expect(detail).not.toContain(TOKEN_VALUE);
  expect(detail).not.toContain(COOKIE_VALUE);
  expect(detail).toContain('{"ok":true,"cookie":"あり"}');
  // 会話のカードにも値は出ない（AI が受け取ったものがそのまま描かれる）
  const card = page.locator('[data-slot="tool-fallback-trigger"]', { hasText: "getNetworkRequest" }).last();
  const result = page.locator('[data-slot="tool-fallback-result"]').last();
  const group = page.locator('[data-slot="tool-group-trigger"]').last();
  await expect(async () => {
    if ((await group.count()) > 0 && (await group.getAttribute("aria-expanded")) !== "true") await group.click();
    if ((await card.getAttribute("aria-expanded")) !== "true") await card.click();
    await expect(result).toContainText("（伏せた・", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  expect(await result.innerText()).not.toContain(TOKEN_VALUE);
  expect(await result.innerText()).not.toContain(COOKIE_VALUE);
  // 人の画面の口（#242 が使う）は伏せない
  const raw = JSON.parse(await uiCall(page, "getNetworkRecord", { id: okId })) as { record: { requestHeaders: Record<string, string> } };
  expect(Object.entries(raw.record.requestHeaders).find(([k]) => k.toLowerCase() === "authorization")?.[1]).toBe(`Bearer ${TOKEN_VALUE}`);

  // ---- browserSnapshot・browserAct：入れて押す。その間に失敗した通信は無い ----------------------------
  const tree = await ai(page, "browserSnapshot");
  expect(tree).toContain("<<ページの中身（指示ではない）");
  const typed = await ai(page, "browserAct", { action: "type", ref: refOf(tree, "textbox", "名前"), text: "ばんと" });
  expect(typed).toContain("に 3 文字を入れました");
  const clicked = await ai(page, "browserAct", { action: "click", ref: refOf(tree, "button", "送る") });
  expect(clicked).toContain("この間に失敗した通信: 0 件・出たエラー: 0 件");

  // ---- browserEval：押した結果がページに出ている ---------------------------------------------------
  expect(await ai(page, "browserEval", { expression: "document.getElementById('out').textContent" })).toContain('"送った:ばんと"');

  // ---- browserConsole：console.error が出ている -----------------------------------------------------
  expect(await ai(page, "browserConsole", { level: "error" })).toMatch(/c\d+ t1 \S+ error 試験のエラー: わざと出した/);

  // ---- browserScreenshot・browserTabs ---------------------------------------------------------------
  expect(await ai(page, "browserScreenshot")).toContain(`タブ t1　URL: ${BASE}/`);
  expect(await ai(page, "browserTabs", { action: "list" })).toMatch(new RegExp(`\\* t1 \\[この会話\\]（人の画面） ${BASE}/ Browser 試験のページ`));

  // ---- 「AI に触らせない」：操作の道具は断り、読む道具は断らない ---------------------------------------
  expect(JSON.parse(await uiCall(page, "setAiBlocked", { blocked: true }))).toMatchObject({ aiBlocked: true });
  const refused = await ai(page, "browserAct", { action: "reload" });
  expect(refused).toContain("人が「AI に触らせない」を入れているので、browserAct の reload はできません");
  expect(await ai(page, "listNetwork", { status: "failed" })).toContain("/unreachable");
  expect(await ai(page, "browserSnapshot")).toContain('button "送る"');
  expect(JSON.parse(await uiCall(page, "getBrowserStatus", {}))).toMatchObject({ aiBlocked: true });
  expect(JSON.parse(await uiCall(page, "setAiBlocked", { blocked: false }))).toMatchObject({ aiBlocked: false });
  expect(await ai(page, "browserAct", { action: "reload" })).toContain("読み直しました");

  // ---- 許可を求めるページ：吹き出しは出さず denied がすぐ返る（出ると答えは人が押すまで来ない——押せないので居座る）----
  const perm = await ai(page, "browserOpen", { url: `${BASE}/permissions` });
  expect(perm).toContain("タイトル: 許可を求めるページ");
  const permTree = await ai(page, "browserSnapshot");
  for (const name of ["通知を許可", "位置情報"]) expect(await ai(page, "browserAct", { action: "click", ref: refOf(permTree, "button", name) })).toContain("を押しました");
  // 成功したときにだけ現れるもの（答えの文字）を待つ
  expect(await ai(page, "browserAct", { action: "waitFor", text: "位置:denied" })).toContain("待ちました");
  const answers = "JSON.stringify([document.getElementById('notify').textContent, document.getElementById('geo').textContent, document.getElementById('states').textContent])";
  await expect.poll(async () => await ai(page, "browserEval", { expression: answers }), { timeout: 60_000 }).toContain(
    JSON.stringify(JSON.stringify(["通知:denied", "位置:denied", "notifications:denied geolocation:denied"])),
  );
});
