// **9本の道具を本物のブラウザで呼ぶ**（試験用のページを相手に）。ブラウザがこの機械に
// 入っていなければ飛ばす——入れるのは Module の仕事で、その経路は E2E が通す。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTestPageServer, TEST_COOKIE, TEST_TITLE, TEST_TOKEN } from "./test-page.js";
import { createBrowserContextFromDataDir } from "./server.js";
import { browserOpts, installed, skipReason } from "./test-browser.js";
import { callTool, type ToolContext } from "./tools.js";
import { StateFile } from "./state.js";

const dataDir = mkdtempSync(join(tmpdir(), "banto-browser-test-"));
const server = createTestPageServer();
let base = "";
let ctx: ToolContext;

before(async () => {
  if (!installed) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await createBrowserContextFromDataDir(dataDir, browserOpts);
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

/** ページの中で JSON の文字を返す式を評価して読む（browserEval は値を JSON で、区切りの中に返す） */
async function evalJson<T>(expression: string): Promise<T> {
  const r = await call("browserEval", { expression });
  const m = /^(".*")$/m.exec(r.text);
  assert.ok(m, `browserEval の答えが読めない:\n${r.text}`);
  return JSON.parse(JSON.parse(m[1]!) as string) as T;
}

const skip = skipReason;

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

  // ---- 止めて起こし直しても、ログイン状態（Cookie）は残る。タブの id は振り直さず続きから ----
  const tabNumber = (id: string) => Number(id.slice(1));
  const lastTab = Math.max(...(await ctx.session.listTabs()).map((t) => tabNumber(t.id)), ctx.log.maxTabNumber());
  await ctx.session.stop("試験");
  assert.equal(ctx.session.running, false);
  const reopened = await call("browserOpen", { url: `${base}/second` });
  const reopenedTab = /タブ (t\d+) で開きました/.exec(reopened.text)?.[1];
  assert.ok(reopenedTab && tabNumber(reopenedTab) > lastTab, `起こし直したタブ ${reopenedTab} が前のタブ（t${lastTab} まで）と重なる`);
  // Module ごと起こし直しても（記録だけが置き場に残る）、記録にあるタブの続きから
  await ctx.session.stop("試験");
  ctx.log.saveNow();
  ctx = await createBrowserContextFromDataDir(dataDir, browserOpts);
  const restarted = /タブ (t\d+) で開きました/.exec((await call("browserOpen", { url: `${base}/second` })).text)?.[1];
  assert.ok(restarted && tabNumber(restarted) > tabNumber(reopenedTab), `Module を起こし直したタブ ${restarted} が ${reopenedTab} と重なる`);
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

/** ページの要素を描いた字体（CDP の CSS.getPlatformFontsForNode——ページの中から見えない、実際に描いた字体） */
async function platformFonts(url: string, ids: string[]): Promise<Record<string, string[]>> {
  const port = Number(readFileSync(join(dataDir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]);
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((t) => t.type === "page" && t.url === url);
  assert.ok(target, `${url} のタブが無い`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 1;
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (m.id) waiting.get(m.id)?.(m);
  };
  const send = <T>(method: string, params: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await send("DOM.enable");
    await send("CSS.enable");
    const { root } = await send<{ root: { nodeId: number } }>("DOM.getDocument");
    const out: Record<string, string[]> = {};
    for (const id of ids) {
      const { nodeId } = await send<{ nodeId: number }>("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
      const { fonts } = await send<{ fonts: { familyName: string; glyphCount: number }[] }>("CSS.getPlatformFontsForNode", { nodeId });
      out[id] = fonts.sort((a, b) => b.glyphCount - a.glyphCount).map((f) => f.familyName);
    }
    return out;
  } finally {
    ws.close();
  }
}

test("browserOpen の url を省くと、新しいタブで設定の検索エンジンのトップを開く。設定は getSettings・setSettings で選べ、custom は型が要る", { skip }, async () => {
  const settings = JSON.parse((await call("getSettings")).text) as { searchEngine: string; searchEngines: Record<string, { home: string }> };
  assert.equal(settings.searchEngine, "duckduckgo", "既定は DuckDuckGo");
  assert.equal(settings.searchEngines.duckduckgo!.home, "https://duckduckgo.com/");
  const refused = await call("setSettings", { searchEngine: "custom" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /任意の URL の型（searchTemplate）を書いてから custom を選びます/);
  // 試験で外に出ないよう、試験用の検索エンジン（test-page の /search）を指す
  const set = await call("setSettings", { searchEngine: "custom", searchTemplate: `${base}/search?q=%s` });
  assert.equal(set.isError, undefined, set.text);
  try {
    const before = await call("browserTabs", { action: "list" });
    const opened = await call("browserOpen", {});
    assert.equal(opened.isError, undefined, opened.text);
    const tab = /タブ (t\d+) で開きました/.exec(opened.text)?.[1];
    assert.ok(tab && !new RegExp(`\\b${tab}\\b`).test(before.text), `新しいタブで開いていない：${opened.text}`);
    assert.match(opened.text, new RegExp(`最終の URL: ${base.replace(/[.]/g, "\\.")}/search\\?q=\n`));
    assert.match(opened.text, /タイトル: 試験の検索/);
    await call("browserTabs", { action: "close", tab });
  } finally {
    await call("setSettings", { searchEngine: "duckduckgo" });
  }
});

test("字体：日本語は日本の字形（Noto Sans CJK JP）で描き、韓国語は KR・言語の指定の無い文字（system-ui も）は locale（ja-JP）の字形", { skip }, async () => {
  const url = `${base}/fonts`;
  const opened = await call("browserOpen", { url, newTab: true });
  assert.equal(opened.isError, undefined, opened.text);
  const fonts = await platformFonts(url, ["ja", "ja-serif", "ja-mono", "ko", "plain", "system"]);
  // 一番多くの字を描いた字体（英数字の無い文は1つだけになる）
  assert.equal(fonts.ja![0], "Noto Sans CJK JP", JSON.stringify(fonts));
  assert.equal(fonts["ja-serif"]![0], "Noto Serif CJK JP", JSON.stringify(fonts));
  assert.equal(fonts["ja-mono"]![0], "Noto Sans Mono CJK JP", JSON.stringify(fonts));
  assert.equal(fonts.ko![0], "Noto Sans CJK KR", JSON.stringify(fonts));
  assert.equal(fonts.plain![0], "Noto Sans CJK JP", JSON.stringify(fonts));
  assert.equal(fonts.system![0], "Noto Sans CJK JP", JSON.stringify(fonts));
  for (const f of Object.values(fonts).flat()) assert.doesNotMatch(f, /WenQuanYi/, JSON.stringify(fonts));
  assert.equal(ctx.session.notice, undefined, "字体は入っている");
  await call("browserTabs", { action: "close" });
});

test("人のブラウザと同じ：画面ありで、自動操作の起動の印も JS の上書きも無いまま、webdriver は false・Headless を名乗らない・プラグインあり・言語は ja-JP から・時刻は Asia/Tokyo", { skip }, async () => {
  const version = ctx.session.browserVersion;
  assert.match(version ?? "", /^\d+\.\d+\.\d+\.\d+$/);
  const major = version!.split(".")[0];
  // 要求のヘッダ（サーバが受けたもの）
  // 新しいタブで（前の試験が resize したタブではなく、起こしたときの窓の大きさのまま）
  const opened = await call("browserOpen", { url: `${base}/whoami`, newTab: true });
  assert.equal(opened.isError, undefined, opened.text);
  const seen = await evalJson<{ userAgent: string; acceptLanguage: string; secChUa: string }>("document.body.innerText");
  assert.doesNotMatch(seen.userAgent, /Headless/);
  // 本物の Chrome は版を縮めて名乗る（`Chrome/155.0.0.0`——User-Agent Reduction）
  assert.match(seen.userAgent, new RegExp(`^Mozilla/5\\.0 \\(X11; Linux x86_64\\) AppleWebKit/537\\.36 \\(KHTML, like Gecko\\) Chrome/${major}\\.0\\.0\\.0 Safari/537\\.36$`));
  assert.match(seen.acceptLanguage, /^ja-JP,ja;q=0\.9,en-US;q=0\.8,en;q=0\.7$/);
  assert.doesNotMatch(seen.secChUa, /Headless/);
  assert.match(seen.secChUa, new RegExp(`"Chromium";v="${major}"`));
  // ページから見たもの
  const nav = await evalJson<{ ua: string; langs: string[]; tz: string; brands: string[]; webdriver: boolean; plugins: number; mimeTypes: number; outer: number[]; inner: number[] }>(
    "JSON.stringify({ ua: navigator.userAgent, langs: navigator.languages, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, " +
      "brands: navigator.userAgentData.brands.map((b) => b.brand), webdriver: navigator.webdriver, plugins: navigator.plugins.length, " +
      "mimeTypes: navigator.mimeTypes.length, outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight] })",
  );
  assert.equal(nav.ua, seen.userAgent);
  assert.equal(nav.webdriver, false);
  assert.ok(nav.plugins > 0, `プラグインが ${nav.plugins} 個`);
  assert.ok(nav.mimeTypes > 0);
  assert.deepEqual(nav.langs, ["ja-JP", "ja", "en-US", "en"]);
  assert.equal(nav.tz, "Asia/Tokyo");
  assert.ok(!nav.brands.some((b) => /Headless/.test(b)), nav.brands.join(","));
  // 中身は既定の大きさ。**窓はキオスク形の全画面**（人の画面を動画で流すため——v4-modules.md §4.1「動画で流す」(a)）なので、
  // 外と中は同じ大きさ（全画面にした人のブラウザと同じ。headless の印の outerWidth 0 ではない）
  assert.deepEqual(nav.inner, [1280, 800]);
  assert.deepEqual(nav.outer, nav.inner, `キオスク形の全画面になっていない：外 ${nav.outer.join("×")}・中 ${nav.inner.join("×")}`);

  // 起こしたブラウザの引数に、自動操作の起動の印が無い（プロセスを見る）
  const port = Number(readFileSync(join(dataDir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]);
  const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
  assert.ok(webSocketDebuggerUrl);
  const pid = Number(/-(\d+)$/.exec(readlinkSync(join(dataDir, "profile", "SingletonLock")))?.[1]);
  const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  for (const mark of ["--enable-automation", "--headless", "--user-agent"]) assert.ok(!cmd.some((a) => a.startsWith(mark)), `${mark} が付いている`);
});

test("タブは会話ごと：2つの会話がそれぞれ裏の自分のタブで同時に作業し、タブを省くと自分の最後のタブに効き、ほかの会話のタブへの操作は断られ、人の画面の表示は替わらない", { skip }, async () => {
  const A = "thread-aaaaaaaa-1111";
  const B = "thread-bbbbbbbb-2222";
  const as = async (thread: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(ctx, name, args, undefined, { "dev.banto/thread": { projectId: "p1", threadId: thread } });
    return { ...r, text: r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n") };
  };
  // 人のタブ（会話の印の無い呼び出し＝今どおり）を人の画面に映しておく
  const human = await call("browserOpen", { url: `${base}/second`, newTab: true });
  const humanTab = /タブ (t\d+) で開きました/.exec(human.text)![1]!;
  assert.equal(ctx.session.current, humanTab);
  const humanFront = ctx.session.front;

  // **2つの会話が同時に開く**——それぞれ自分のタブ（裏）。人の画面の表示は替わらない
  const [oa, ob] = await Promise.all([as(A, "browserOpen", { url: `${base}/` }), as(B, "browserOpen", { url: `${base}/corners` })]);
  assert.equal(oa.isError, undefined, oa.text);
  assert.equal(ob.isError, undefined, ob.text);
  const tabA = /タブ (t\d+) で開きました/.exec(oa.text)![1]!;
  const tabB = /タブ (t\d+) で開きました/.exec(ob.text)![1]!;
  assert.notEqual(tabA, tabB);
  assert.ok(tabA !== humanTab && tabB !== humanTab);
  assert.equal(ctx.session.ownerOf(tabA), A);
  assert.equal(ctx.session.ownerOf(tabB), B);
  assert.equal(ctx.session.ownerOf(humanTab), undefined);
  assert.equal(ctx.session.current, humanTab, "AI が開いたら人の画面の選んでいるタブが替わった");
  assert.equal(ctx.session.front, humanFront, "AI が開いたら人の画面に映るタブが替わった");

  // **タブを省くと自分の最後のタブ**：A は打って押す、B は読む——同時に。裏のタブでも押す・打つが効く（Playwright が
  // 繋いだタブはどれも focus emulation で見えている扱い——v4-modules.md §4.1「タブは会話ごと」の測ったこと）
  const treeA = (await as(A, "browserSnapshot")).text;
  assert.match(treeA, new RegExp(`^タブ ${tabA}　`));
  const [typed, readB] = await Promise.all([
    as(A, "browserAct", { action: "type", ref: refOf(treeA, "textbox", "名前"), text: "かいわA" }),
    as(B, "browserSnapshot"),
  ]);
  assert.equal(typed.isError, undefined, typed.text);
  assert.match(typed.text, new RegExp(`（タブ ${tabA}）`));
  assert.match(readB.text, new RegExp(`^タブ ${tabB}　URL: ${base}/corners`));
  const clicked = await as(A, "browserAct", { action: "click", ref: refOf(treeA, "button", "送る") });
  assert.equal(clicked.isError, undefined, clicked.text);
  assert.match(clicked.text, /送った:かいわA/);
  // 裏のタブでもタイマーと描画が動く
  const frame = await as(A, "browserEval", { expression: "new Promise(r => requestAnimationFrame(() => r(document.visibilityState)))" });
  assert.match(frame.text, /^"visible"$/m, frame.text);
  assert.equal(ctx.session.current, humanTab);

  // **ほかの会話のタブへの操作は断る**（理由と持ち主）。読む道具は通す
  for (const [name, args] of [
    ["browserAct", { action: "reload", tab: tabA }],
    ["browserEval", { expression: "1", tab: tabA }],
    ["browserTabs", { action: "select", tab: tabA }],
    ["browserTabs", { action: "close", tab: tabA }],
  ] as const) {
    const r = await as(B, name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)} が断られない: ${r.text}`);
    assert.match(r.text, new RegExp(`タブ ${tabA} はほかの会話（Thread ${A.slice(0, 8)}）のタブなので`));
  }
  const peek = await as(B, "browserSnapshot", { tab: tabA });
  assert.equal(peek.isError, undefined, peek.text);
  assert.match(peek.text, /送った:かいわA/);
  const shotA = await as(B, "browserScreenshot", { tab: tabA });
  assert.equal(shotA.isError, undefined, shotA.text);
  // 読んでも B のいまのタブは替わらない
  assert.equal(ctx.session.threadTab(B), tabB);

  // **人のタブ（持ち主なし）は操作できる**。select は B のいまのタブを替えるだけで、人の画面は替えない
  const sel = await as(B, "browserTabs", { action: "select", tab: humanTab });
  assert.equal(sel.isError, undefined, sel.text);
  assert.match(sel.text, /人の画面の表示は替えていません/);
  assert.equal(ctx.session.threadTab(B), humanTab);
  const back = await as(B, "browserTabs", { action: "select", tab: tabB });
  assert.equal(back.isError, undefined, back.text);

  // **一覧**：全部のタブと持ち主。* はこの会話のいまのタブ
  const list = (await as(B, "browserTabs", { action: "list" })).text;
  assert.match(list, new RegExp(`^\\* ${tabB} \\[この会話\\]`, "m"));
  assert.match(list, new RegExp(`^  ${tabA} \\[会話 ${A.slice(0, 8)}\\]`, "m"));
  assert.match(list, new RegExp(`^  ${humanTab} \\[人\\]（人の画面）`, "m"));

  // **ページから開いたタブ・ポップアップは開いた元の持ち主**。開いても B のいまのタブ・人の画面は替わらない
  const treeB = (await as(B, "browserSnapshot")).text;
  const before = new Set((await ctx.session.listTabs()).map((t) => t.id));
  await as(B, "browserAct", { action: "click", ref: refOf(treeB, "button", "ポップアップ") });
  await as(B, "browserAct", { action: "click", ref: refOf(treeB, "link", "新しいタブ") });
  await until(async () => (await ctx.session.listTabs()).filter((t) => !before.has(t.id)).length === 2, "ポップアップと _blank のタブ");
  for (const t of (await ctx.session.listTabs()).filter((t) => !before.has(t.id))) assert.equal(t.owner, B, `${t.id}（${t.url}）の持ち主`);
  assert.equal(ctx.session.threadTab(B), tabB);
  assert.equal(ctx.session.current, humanTab);

  // **裏のタブの写しは、いまの絵**：_blank は開いた元（tabB）と同じ窓に入り tabB は窓の裏に回る——裏のタブは Chrome が描かず、
  // 写しが返らないか古い絵になる（実測）。色を替えるたびに撮って、その色が写る
  for (const color of ["rgb(255, 0, 0)", "rgb(0, 255, 0)", "rgb(0, 0, 255)"]) {
    await as(B, "browserEval", { expression: `document.body.replaceChildren(), document.body.style.background = "${color}"` });
    const shot = await as(B, "browserScreenshot");
    assert.equal(shot.isError, undefined, shot.text);
    const image = shot.content.find((c) => c.type === "image") as { data: string };
    assert.equal(firstPixel(image.data), color.replace(/^rgb\(|\)$/g, "").replaceAll(" ", ""), `${color} にした tabB の写し`);
  }
  // A のタブ（窓を分けて表にある）も
  await as(A, "browserEval", { expression: `document.body.replaceChildren(), document.body.style.background = "rgb(255, 0, 255)"` });
  assert.equal(firstPixel(((await as(A, "browserScreenshot")).content.find((c) => c.type === "image") as { data: string }).data), "255,0,255");
  assert.equal(ctx.session.current, humanTab);
  assert.equal(ctx.session.front, humanFront, "写すために表に出したあと、人の画面のタブが前に戻っていない");

  // **newTab で開くとそのタブが会話のいまのタブ**になり、省いた操作はそちらに効く
  const second = await as(A, "browserOpen", { url: `${base}/second`, newTab: true });
  const tabA2 = /タブ (t\d+) で開きました/.exec(second.text)![1]!;
  assert.match((await as(A, "browserSnapshot")).text, new RegExp(`^タブ ${tabA2}　`));
  // 閉じると、その会話のほかの自分のタブに戻る
  assert.equal((await as(A, "browserTabs", { action: "close", tab: tabA2 })).isError, undefined);
  assert.match((await as(A, "browserSnapshot")).text, new RegExp(`^タブ ${tabA}　`));

  // **会話の印の無い呼び出しは今どおり**：どのタブも触れる（人の画面の選んでいるタブが既定）
  assert.equal((await call("browserEval", { expression: "1", tab: tabA })).isError, undefined);
  assert.equal(ctx.session.current, humanTab);
  assert.equal(ctx.session.front, humanFront);
});

/** PNG の左上の画素（R,G,B）。Chrome の写しは RGB か RGBA で、最初の行の filter は左上に効かない */
function firstPixel(base64: string): string {
  const png = Buffer.from(base64, "base64");
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    if (png.toString("ascii", o + 4, o + 8) === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return `${raw[1]},${raw[2]},${raw[3]}`;
}
