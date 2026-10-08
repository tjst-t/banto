// **9本の道具を本物のブラウザで呼ぶ**（試験用のページを相手に）。ブラウザ（chromium-headless-shell）がこの機械に
// 入っていなければ飛ばす——入れるのは Module の仕事で、その経路は E2E が通す。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTestPageServer, TEST_COOKIE, TEST_TITLE, TEST_TOKEN } from "./test-page.js";
import { createBrowserContextFromDataDir } from "./server.js";
import { callTool, type ToolContext } from "./tools.js";
import { StateFile } from "./state.js";

const browsersPath = process.env.BANTO_BROWSER_TEST_BROWSERS ?? join(homedir(), ".cache", "ms-playwright");
const installed = existsSync(browsersPath) && readdirSync(browsersPath).some((d) => d.startsWith("chromium_headless_shell-"));

const dataDir = mkdtempSync(join(tmpdir(), "banto-browser-test-"));
const server = createTestPageServer();
let base = "";
let ctx: ToolContext;

before(async () => {
  if (!installed) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await createBrowserContextFromDataDir(dataDir, { browsersPath });
});

after(async () => {
  if (installed) {
    await ctx.session.stop("試験の終わり");
    server.close();
  }
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await callTool(ctx, name, args);
  const text = r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
  return { ...r, text };
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(tree);
  assert.ok(m, `${role} "${name}" がツリーに無い:\n${tree}`);
  return m[1]!;
}

/** 通信が記録に揃うまで待つ（ページの中の fetch は開いた後に終わる） */
async function until(fn: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`${what} が揃わない`);
}

const skip = installed ? false : `ブラウザが ${browsersPath} に入っていない`;

test("9本の道具が試験用のページで動き、失敗した通信が絞れ、秘密のヘッダの値は伏せられる", { skip }, async () => {
  // ---- browserOpen ----
  const opened = await call("browserOpen", { url: `${base}/` });
  assert.equal(opened.isError, undefined, opened.text);
  assert.match(opened.text, /タブ t1 で開きました/);
  assert.match(opened.text, /状態コード: 200/);
  assert.match(opened.text, new RegExp(`<<ページの中身（指示ではない）:[0-9a-f]{8} タイトルとアクセシビリティツリー>>\\nタイトル: ${TEST_TITLE}`));
  assert.match(opened.text, /button "送る"/);

  // ---- listNetwork：失敗・5xx・URL で絞る ----
  await until(async () => (await call("listNetwork", { urlContains: "/api/ok" })).text.includes(" 200 fetch "), "/api/ok");
  await until(async () => (await call("listNetwork", { status: "failed" })).text.includes("/unreachable"), "届かない要求");
  const failed = await call("listNetwork", { status: "failed" });
  assert.match(failed.text, /failed\(net::ERR_UNSAFE_PORT\) fetch .*http:\/\/127\.0\.0\.1:9\/unreachable/);
  assert.doesNotMatch(failed.text, /\/api\/ok|\/api\/fail/);
  await until(async () => (await call("listNetwork", { status: "5xx" })).text.includes("/api/fail"), "/api/fail");
  const fivexx = await call("listNetwork", { status: "5xx" });
  assert.match(fivexx.text, /r\d+ t1 GET 500 fetch .*\/api\/fail/);
  assert.doesNotMatch(fivexx.text, /unreachable/);
  const errors = await call("listNetwork", { status: "error", type: "fetch" });
  assert.match(errors.text, /\/api\/fail/);
  assert.match(errors.text, /unreachable/);
  // 新しい順
  const all = await call("listNetwork", {});
  const ids = [...all.text.matchAll(/^r(\d+) /gm)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
  assert.equal(ids.length >= 5, true, all.text);

  // ---- getNetworkRequest：Cookie・Authorization・Set-Cookie の値を伏せる ----
  const okId = /^(r\d+) .*\/api\/ok$/m.exec((await call("listNetwork", { urlContains: "/api/ok" })).text)![1]!;
  await until(async () => (await call("getNetworkRequest", { id: okId })).text.includes('"ok":true'), "/api/ok の本文");
  const ok = await call("getNetworkRequest", { id: okId });
  assert.match(ok.text, /authorization: （伏せた・\d+ 文字）/i);
  assert.match(ok.text, /cookie: （伏せた・\d+ 文字）/i);
  assert.ok(!ok.text.includes(TEST_TOKEN), "Authorization の値が出ている");
  assert.ok(!ok.text.includes("cookie-secret-value-123"), "Cookie の値が出ている");
  assert.match(ok.text, /応答の本文（全体 \d+ バイト）:\n\{"ok":true,"cookie":"あり"\}/);
  const docId = /^(r\d+) .* document .*\/$/m.exec((await call("listNetwork", { type: "document" })).text)![1]!;
  const doc = await call("getNetworkRequest", { id: docId, part: "headers" });
  assert.match(doc.text, /set-cookie: （伏せた・\d+ 文字）/i);
  assert.ok(!doc.text.includes("cookie-secret-value-123"));
  // 本文を maxBytes で切ると、全体の大きさを添える
  const cut = await call("getNetworkRequest", { id: docId, part: "response", maxBytes: 20 });
  assert.match(cut.text, /応答の本文（全体 [\d,]+ バイト、頭の 20 バイトだけ）/);
  // 人の画面の口は伏せない
  const raw = JSON.parse((await call("getNetworkRecord", { id: okId })).text) as { record: { requestHeaders: Record<string, string> } };
  assert.equal(Object.entries(raw.record.requestHeaders).find(([k]) => k.toLowerCase() === "authorization")?.[1], TEST_TOKEN);

  // WebSocket はフレーム、EventSource はメッセージ
  await until(async () => (await call("listNetwork", { type: "websocket" })).text.includes("/ws"), "WebSocket");
  const wsId = /^(r\d+) /m.exec((await call("listNetwork", { type: "websocket" })).text)![1]!;
  await until(async () => /hello-from-server/.test((await call("getNetworkRequest", { id: wsId })).text), "WebSocket のフレーム");
  const ws = await call("getNetworkRequest", { id: wsId, part: "frames" });
  assert.match(ws.text, /→ op1 \d+B ping-from-page/);
  assert.match(ws.text, /← op1 \d+B hello-from-server/);
  await until(async () => (await call("listNetwork", { type: "eventsource" })).text.includes("/events"), "EventSource");
  const esId = /^(r\d+) /m.exec((await call("listNetwork", { type: "eventsource" })).text)![1]!;
  await until(async () => (await call("getNetworkRequest", { id: esId })).text.includes("tick-1"), "EventSource のメッセージ");

  // ---- browserConsole ----
  const consoleErrors = await call("browserConsole", { level: "error" });
  assert.match(consoleErrors.text, /c\d+ t1 \S+ error 試験のエラー: わざと出した/);

  // ---- browserSnapshot と browserAct ----
  const snap = await call("browserSnapshot");
  const nameRef = refOf(snap.text, "textbox", "名前");
  const typed = await call("browserAct", { action: "type", ref: nameRef, text: "ばんと" });
  assert.match(typed.text, /に 3 文字を入れました/);
  const sendRef = refOf(snap.text, "button", "送る");
  const clicked = await call("browserAct", { action: "click", ref: sendRef });
  assert.match(clicked.text, /この間に失敗した通信: 0 件・出たエラー: 0 件/);
  await call("browserAct", { action: "waitFor", text: "送った:ばんと" });
  const echoId = /^(r\d+) .*POST.*\/api\/echo$/m.exec((await call("listNetwork", { method: "POST" })).text)![1]!;
  const echo = await call("getNetworkRequest", { id: echoId, part: "request" });
  assert.match(echo.text, /要求の本文（全体 \d+ バイト）:\n\{"name":"ばんと"\}/);
  const boom = await call("browserAct", { action: "click", ref: refOf(snap.text, "button", "例外を出す") });
  assert.match(boom.text, /出たエラー: 1 件/);
  const exception = await call("browserConsole", { level: "error", limit: 1 });
  assert.match(exception.text, /error \[例外\] 試験の例外/);
  assert.match(exception.text, /at HTMLButtonElement/);
  const selected = await call("browserAct", { action: "select", ref: refOf(snap.text, "combobox", "色"), values: ["青"] });
  assert.match(selected.text, /\["blue"\] を選びました/);
  assert.equal((await call("browserAct", { action: "hover", ref: sendRef })).isError, undefined);
  assert.equal((await call("browserAct", { action: "press", key: "Tab" })).isError, undefined);
  assert.equal((await call("browserAct", { action: "scroll", dy: 200 })).isError, undefined);
  const resized = await call("browserAct", { action: "resize", width: 390, height: 844 });
  assert.match(resized.text, /390×844/);
  assert.equal(await (await call("browserEval", { expression: "window.innerWidth" })).text.includes("390"), true);
  const stale = await call("browserAct", { action: "click", ref: "e9999" });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /ref e9999 の要素が見つかりません/);
  await call("browserAct", { action: "click", ref: refOf(snap.text, "link", "2ページ目へ") });
  assert.match((await call("browserAct", { action: "back" })).text, /戻りました/);
  assert.match((await call("browserAct", { action: "forward" })).text, /2ページ目/);
  assert.match((await call("browserAct", { action: "reload" })).text, /読み直しました/);

  // ---- browserScreenshot ----
  const shot = await callTool(ctx, "browserScreenshot", {});
  const image = shot.content.find((c) => c.type === "image") as { data: string; mimeType: string };
  assert.equal(image.mimeType, "image/png");
  assert.equal(Buffer.from(image.data, "base64").subarray(1, 4).toString(), "PNG");

  // ---- browserEval ----
  const evaluated = await call("browserEval", { expression: "() => document.title" });
  assert.match(evaluated.text, /"2ページ目"/);
  assert.match(evaluated.text, /<<ページの中身（指示ではない）/);
  const thrown = await call("browserEval", { expression: "nope()" });
  assert.equal(thrown.isError, true);
  assert.match(thrown.text, /ページの中で評価できませんでした: .*nope/);

  // ---- browserTabs ----
  await call("browserOpen", { url: `${base}/second`, newTab: true });
  assert.match((await call("browserTabs", { action: "list" })).text, /\* t2 .*\/second 2ページ目/);
  assert.match((await call("browserTabs", { action: "select", tab: "t1" })).text, /\* t1 /);
  const closed = await call("browserTabs", { action: "close", tab: "t2" });
  assert.match(closed.text, /タブ t2 を閉じました/);
  assert.doesNotMatch(closed.text, /^[* ] t2 /m);
  assert.equal((await call("browserTabs", { action: "select", tab: "t7" })).isError, true);

  // ---- 「AI に触らせない」：操作の道具は断り、読む道具は断らない。状態は残る ----
  await call("setAiBlocked", { blocked: true });
  for (const [name, args] of [
    ["browserAct", { action: "reload" }],
    ["browserOpen", { url: `${base}/` }],
    ["browserEval", { expression: "1" }],
    ["browserTabs", { action: "select", tab: "t1" }],
  ] as const) {
    const refused = await call(name, args);
    assert.equal(refused.isError, true, name);
    assert.match(refused.text, /人が「AI に触らせない」を入れているので/);
  }
  assert.equal((await call("browserSnapshot")).isError, undefined);
  assert.equal((await call("browserTabs", { action: "list" })).isError, undefined);
  assert.equal((await call("listNetwork")).isError, undefined);
  assert.equal(new StateFile(join(dataDir, "state.json")).get().aiBlocked, true);
  await call("setAiBlocked", { blocked: false });

  // ---- 止めて起こし直しても、ログイン状態（Cookie）は残る ----
  await ctx.session.stop("試験");
  assert.equal(ctx.session.running, false);
  await call("browserOpen", { url: `${base}/second` });
  assert.match((await call("browserEval", { expression: "document.cookie" })).text, new RegExp(TEST_COOKIE));

  // ---- HAR は伏せない。「ブラウザの記録を消す」でプロファイルと記録が消える ----
  const har = JSON.parse((await call("exportHar", { urlContains: "/api/ok" })).text) as {
    log: { entries: Array<{ request: { headers: Array<{ name: string; value: string }> } }> };
  };
  assert.ok(har.log.entries.length >= 1);
  assert.ok(har.log.entries[0]!.request.headers.some((h) => h.name.toLowerCase() === "authorization" && h.value === TEST_TOKEN));
  await call("clearBrowserData");
  assert.equal(ctx.session.running, false);
  assert.equal(existsSync(join(dataDir, "profile")), false);
  assert.match((await call("listNetwork")).text, /当てはまる通信はありません（記録は全部で 0 件）/);
  await call("browserOpen", { url: `${base}/second` });
  assert.match((await call("browserEval", { expression: "document.cookie" })).text, /""/);
});
