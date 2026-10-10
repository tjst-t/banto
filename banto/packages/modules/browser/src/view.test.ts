// **人の画面の流れ**（view-stream.ts）：中身の約束の読み書き（ブラウザ無しで）と、本物のブラウザで
// 受け取りの印による絞り・映す画面が居なくなったら screencast を止める・人の入力がページに届く・AI の操作が帯の
// 知らせになる・画面の HTML が組み立てられること。ブラウザ（chromium-headless-shell）がこの機械に無ければ後半は飛ばす。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StreamStamp, WebSocket } from "@banto/stream-server";
import { createTestPageServer } from "./test-page.js";
import { createBrowserContextFromDataDir } from "./server.js";
import { TOOLS, callTool, type ToolContext } from "./tools.js";
import { BROWSER_VIEW_URI, browserViewHtml } from "./view-app.js";
import {
  BrowserView,
  decodeFrame,
  encodeFrame,
  normalizeUrl,
  parseViewMessage,
  screencastLimits,
  type FrameHeader,
} from "./view-stream.js";

// ---- ブラウザ無しで ----------------------------------------------------------------------------

test("絵の1通：頭（番号・タブ・大きさ）と JPEG を分けて読める", () => {
  const header: FrameHeader = { seq: 7, tab: "t3", width: 1280, height: 800 };
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const decoded = decodeFrame(encodeFrame(header, jpeg));
  assert.deepEqual(decoded.header, header);
  assert.deepEqual([...decoded.jpeg], [...jpeg]);
});

test("画面からの1通：入力と制御を読み、形の違うものは理由つきで断る", () => {
  assert.deepEqual(parseViewMessage('{"type":"ack","seq":3}'), { type: "ack", seq: 3 });
  assert.deepEqual(parseViewMessage('{"type":"size","width":390,"height":600,"dpr":3}'), {
    type: "size",
    size: { width: 390, height: 600, devicePixelRatio: 3 },
  });
  assert.deepEqual(parseViewMessage('{"type":"mouse","event":"down","x":10.5,"y":20,"button":"left","buttons":1,"clickCount":2}'), {
    type: "mouse",
    event: "down",
    x: 10.5,
    y: 20,
    button: "left",
    buttons: 1,
    clickCount: 2,
    modifiers: 0,
    deltaX: 0,
    deltaY: 0,
  });
  assert.deepEqual(parseViewMessage('{"type":"key","event":"down","key":"a","code":"KeyA","keyCode":65,"text":"a","modifiers":8}'), {
    type: "key",
    event: "down",
    key: "a",
    code: "KeyA",
    keyCode: 65,
    text: "a",
    modifiers: 8,
  });
  assert.deepEqual(parseViewMessage('{"type":"touch","event":"start","points":[{"x":1,"y":2,"id":5}]}'), {
    type: "touch",
    event: "start",
    points: [{ x: 1, y: 2, id: 5 }],
    modifiers: 0,
  });
  assert.deepEqual(parseViewMessage('{"type":"insertText","text":"ばんと"}'), { type: "insertText", text: "ばんと" });
  assert.deepEqual(parseViewMessage('{"type":"navigate","url":"localhost:3000/a"}'), { type: "navigate", url: "http://localhost:3000/a" });
  assert.deepEqual(parseViewMessage('{"type":"tab","action":"select","tab":"t2"}'), { type: "tab", action: "select", tab: "t2" });
  assert.deepEqual(parseViewMessage('{"type":"fit","on":true}'), { type: "fit", on: true });

  assert.match((parseViewMessage("not json") as { error: string }).error, /JSON/);
  assert.match((parseViewMessage('{"type":"ack"}') as { error: string }).error, /seq/);
  assert.match((parseViewMessage('{"type":"size","width":0,"height":10}') as { error: string }).error, /範囲/);
  assert.match((parseViewMessage('{"type":"mouse","event":"down"}') as { error: string }).error, /x・y/);
  assert.match((parseViewMessage('{"type":"history","action":"home"}') as { error: string }).error, /back/);
  assert.match((parseViewMessage('{"type":"eval"}') as { error: string }).error, /知らない/);
});

test("URL 欄：scheme が無ければ http:// を足し、あるものはそのまま", () => {
  assert.equal(normalizeUrl(" localhost:3000 "), "http://localhost:3000");
  assert.equal(normalizeUrl("https://example.com/x"), "https://example.com/x");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
});

test("screencast の大きさ：一番大きい画面（デバイスピクセル）に合わせ、ページの大きさで頭を押さえる", () => {
  const viewport = { width: 1280, height: 800 };
  // 携帯（390×600・3倍）だけ：横は 1170 → 1216 に丸める。縦は 1800 だがページは 800
  assert.deepEqual(screencastLimits([{ width: 390, height: 600, devicePixelRatio: 3 }], viewport), { maxWidth: 1216, maxHeight: 800 });
  // 小さい画面だけなら縮める
  assert.deepEqual(screencastLimits([{ width: 300, height: 200, devicePixelRatio: 1 }], viewport), { maxWidth: 320, maxHeight: 256 });
  // パソコンと携帯：大きいほうに合わせる
  assert.deepEqual(
    screencastLimits(
      [
        { width: 300, height: 200, devicePixelRatio: 1 },
        { width: 1600, height: 900, devicePixelRatio: 2 },
      ],
      viewport,
    ),
    { maxWidth: 1280, maxHeight: 800 },
  );
});

test("画面の資源：流れの口を埋め込み、受け取りの印を返し、入力欄と通信の欄を持つ", () => {
  const html = browserViewHtml();
  assert.equal(BROWSER_VIEW_URI, "ui://banto-browser/view");
  assert.match(html, /const openStream = /);
  assert.ok(html.includes('type: "ack"'), "受け取りの印を返していない");
  assert.ok(html.includes('"ui/download-file"'), "HAR を host に頼んで保存していない");
  assert.ok(html.includes('call("setAiBlocked"'), "「AI に触らせない」が道具に繋がっていない");
  assert.ok(!html.includes("/*STREAM_CLIENT*/"), "流れの口の埋め込みが残っている");
  // browserOpen だけが会話のカードを出し、押すとこの画面が開く
  const withCard = TOOLS.filter((t) => (t._meta as Record<string, unknown>)["dev.banto/card"] !== undefined).map((t) => t.name);
  assert.deepEqual(withCard, ["browserOpen"]);
  assert.equal((TOOLS[0]!._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri, BROWSER_VIEW_URI);
});

// ---- 本物のブラウザで ---------------------------------------------------------------------------

const browsersPath = process.env.BANTO_BROWSER_TEST_BROWSERS ?? join(homedir(), ".cache", "ms-playwright");
const installed = existsSync(browsersPath) && readdirSync(browsersPath).some((d) => d.startsWith("chromium_headless_shell-"));

/** 流れの相手のふり（host の WebSocket の代わり）。送られたものを溜め、画面からの1通を送れる */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly frames: Buffer[] = [];
  readonly texts: Array<Record<string, unknown>> = [];
  closed: { code?: number; reason?: string } | undefined;
  send(data: Buffer | string): void {
    if (typeof data === "string") this.texts.push(JSON.parse(data) as Record<string, unknown>);
    else this.frames.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this.emit("close", code, Buffer.from(reason ?? ""));
  }
  /** 画面から送る */
  post(message: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  lastFrame(): FrameHeader | undefined {
    const f = this.frames.at(-1);
    return f ? decodeFrame(f).header : undefined;
  }
}

const stamp = (params: Record<string, unknown>): StreamStamp => ({ name: "browser", params, resourceUri: BROWSER_VIEW_URI, human: true, projectId: "p1" });

async function until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`待ちきれませんでした：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "banto-browser-view-test-"));
const server = createTestPageServer();
let base = "";
let ctx: ToolContext;
let view: BrowserView;

before(async () => {
  if (!installed) return;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ctx = await createBrowserContextFromDataDir(dataDir, { browsersPath });
  view = new BrowserView({ session: ctx.session, state: ctx.state, log: ctx.log, logLine: () => undefined });
  ctx.view = view;
});

after(async () => {
  if (installed) {
    await view.close();
    await ctx.session.stop("試験の終わり");
    await new Promise<void>((r) => server.close(() => r()));
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("流れ：開くとブラウザを起こして映し、印が返るまで次の絵を送らず、閉じると screencast を止める。入力はページに届き、AI の操作は帯で知らせる", { skip: !installed && "chromium-headless-shell が入っていない" }, async () => {
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1000, height: 700, dpr: 1, visible: true }));

  // 開いただけでブラウザが起き、様子が届く（タブはまだ無い）
  await until("ブラウザが起きた様子", () => pc.texts.find((t) => t.type === "state" && t.running === true));

  // URL 欄から開く：タブができ、絵が届く（静かなページでも最初の1枚は撮って送る）
  pc.post({ type: "navigate", url: base.replace("http://", "") + "/" });
  const first = await until("最初の絵", () => pc.lastFrame());
  assert.equal(first.tab, "t1");
  assert.deepEqual([first.width, first.height], [1280, 800]);
  assert.equal(view.status().screencasting, true);
  await until("タブの並び", () => pc.texts.find((t) => t.type === "state" && Array.isArray(t.tabs) && (t.tabs as Array<{ url: string }>)[0]?.url === `${base}/`));

  // **印を返すまで次を送らない**：ページを動かし続けても、1枚のまま
  const page = ctx.session.page().page;
  await page.evaluate(() => {
    let n = 0;
    const p = document.createElement("p");
    p.id = "tick";
    document.body.append(p);
    (window as unknown as { tick: number }).tick = window.setInterval(() => (p.textContent = String(n++)), 16) as unknown as number;
  });
  await new Promise((r) => setTimeout(r, 400));
  const sentWithoutAck = pc.frames.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pc.frames.length, sentWithoutAck, "印を返していないのに次の絵が来た");
  // 印を返すと、溜めていた最新の1枚が来る（間の絵は捨てている——番号が飛ぶ）
  const waitingFor = pc.lastFrame()!.seq;
  pc.post({ type: "ack", seq: waitingFor });
  const next = await until("印のあとの絵", () => (pc.frames.length > sentWithoutAck ? pc.lastFrame() : undefined));
  assert.ok(next.seq > waitingFor + 1, `最新の1枚ではない（${waitingFor} の次が ${next.seq}）`);
  await page.evaluate(() => window.clearInterval((window as unknown as { tick: number }).tick));

  // **人の入力がページに届く**：入力欄を押して文字を入れ（insertText）、キーで1文字足し、「送る」を押す
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const name = await box("#name");
  for (const event of ["down", "up"]) pc.post({ type: "mouse", event, x: name.x + 5, y: name.y + name.height / 2, button: "left", buttons: event === "down" ? 1 : 0, clickCount: 1 });
  pc.post({ type: "insertText", text: "ばんと" });
  pc.post({ type: "key", event: "down", key: "x", code: "KeyX", keyCode: 88, text: "x" });
  pc.post({ type: "key", event: "up", key: "x", code: "KeyX", keyCode: 88 });
  assert.equal(await waitValue(() => page.inputValue("#name"), "ばんとx"), "ばんとx");
  const send = await box("#send");
  // 指で押す（携帯）：タッチのまま送っても押せる
  pc.post({ type: "touch", event: "start", points: [{ x: send.x + 5, y: send.y + 5, id: 1 }] });
  pc.post({ type: "touch", event: "end", points: [] });
  assert.equal(await waitValue(() => page.textContent("#out"), "送った:ばんとx"), "送った:ばんとx");

  // **AI の操作は帯で知らせる**：どの Thread の AI か・押した要素の名前と枠
  const tree = (await callTool(ctx, "browserSnapshot", {})).content[0] as { text: string };
  const ref = /button "送る"[^\n]*\[ref=(e\d+)\]/.exec(tree.text)?.[1];
  assert.ok(ref, tree.text);
  const acted = await callTool(ctx, "browserAct", { action: "click", ref }, undefined, {
    "dev.banto/thread": { projectId: "p1", threadId: "th-123" },
  });
  assert.notEqual(acted.isError, true, JSON.stringify(acted.content));
  const ai = await until("AI の帯の知らせ", () => pc.texts.find((t) => t.type === "ai"));
  assert.equal(ai.text, "『送る』を押しました");
  assert.equal(ai.thread, "th-123");
  assert.equal(ai.tab, "t1");
  const aiBox = ai.box as { x: number; y: number; width: number; height: number };
  assert.ok(Math.abs(aiBox.x - send.x) < 1 && Math.abs(aiBox.width - send.width) < 1, `枠が「送る」と合わない：${JSON.stringify(aiBox)}`);

  // 「AI に触らせない」を入れると、開いている画面の様子にも出る
  await callTool(ctx, "setAiBlocked", { blocked: true });
  await until("AI に触らせない が様子に出る", () => lastText(pc, (t) => t.type === "state")?.aiBlocked === true);
  const refused = await callTool(ctx, "browserAct", { action: "reload" });
  assert.equal(refused.isError, true);
  await callTool(ctx, "setAiBlocked", { blocked: false });

  // **2つ目の画面（携帯）**：同時に映せる。「画面に合わせる」でページの大きさが携帯に合う
  const phone = new FakeSocket();
  view.handler()(phone as unknown as WebSocket, stamp({ width: 390, height: 640, dpr: 3, visible: true }));
  await until("携帯にも最新の絵", () => phone.lastFrame());
  phone.post({ type: "fit", on: true });
  await until("ページが携帯の大きさになる", () => lastText(phone, (t) => t.type === "state" && (t.viewport as { width: number } | null)?.width === 390));
  assert.equal(lastText(pc, (t) => t.type === "state")?.fitByOther, true);
  assert.equal(view.status().viewers, 2);

  // 携帯が裏に回っても、パソコンが見ているので映し続ける。携帯を閉じるとページの大きさを戻す
  phone.post({ type: "visible", visible: false });
  await until("見ている画面は1つ", () => view.status().watching === 1);
  assert.equal(view.status().screencasting, true);
  phone.close(1000);
  await until("ページの大きさが戻る", () => lastText(pc, (t) => t.type === "state" && (t.viewport as { width: number } | null)?.width === 1280));

  // **裏に回ったら止める**・前に戻ったら最後の1枚を出して映し直す
  pc.post({ type: "visible", visible: false });
  await until("裏に回ったら screencast を止める", () => !view.status().screencasting);
  pc.post({ type: "ack", seq: pc.lastFrame()!.seq });
  const before = pc.frames.length;
  pc.post({ type: "visible", visible: true });
  await until("前に戻ったら絵が来る", () => pc.frames.length > before);
  assert.equal(view.status().screencasting, true);

  // **閉じたら止める**（流れが0本）
  pc.close(1000);
  await until("閉じたら screencast を止める", () => !view.status().screencasting && view.status().viewers === 0);
  const status = JSON.parse(((await callTool(ctx, "getBrowserStatus", {})).content[0] as { text: string }).text) as { view: unknown; running: boolean };
  assert.deepEqual(status.view, { viewers: 0, watching: 0, screencasting: false });
  // ブラウザは止めない（AI の呼び出しが無いまま決めた時間がたったら止める）
  assert.equal(status.running, true);
});

function lastText(s: FakeSocket, pred: (t: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (let i = s.texts.length - 1; i >= 0; i--) if (pred(s.texts[i]!)) return s.texts[i];
  return undefined;
}

async function waitValue<T>(read: () => Promise<T>, expected: T, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (last !== expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    last = await read();
  }
  return last;
}
