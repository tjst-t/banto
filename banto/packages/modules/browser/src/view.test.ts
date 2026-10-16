// **人の画面の流れ**（view-stream.ts）：中身の約束の読み書き（ブラウザ無しで）と、本物のブラウザで
// 受け取りの印による絞り・映す画面が居なくなったら screencast を止める・人の入力がページに届く・AI の操作が帯の
// 知らせになる・画面の HTML が組み立てられること。ブラウザがこの機械に無ければ後半は飛ばす。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { StreamStamp, WebSocket } from "@banto/stream-server";
import { CORNER, FRAME_BOX, FRAME_COLORS, TONE_HZ, createTestPageServer } from "./test-page.js";
import { spawn, spawnSync } from "node:child_process";
import { VideoPipeline, type VideoHeader } from "./video.js";
import type { AudioHeader } from "./audio.js";
import { createBrowserContextFromDataDir } from "./server.js";
import { browserOpts, installed, skipReason } from "./test-browser.js";
import { TOOLS, callTool, type ToolContext } from "./tools.js";
import { BROWSER_VIEW_URI, browserViewHtml } from "./view-app.js";
import {
  BrowserView,
  MAX_FRAME_PIXELS,
  decodeFrame,
  frameScale,
  framePixels,
  initialQuality,
  jpegSize as readJpegSize,
  sameAspect,
  MAX_HIDPI_FRAME_PIXELS,
  maxFramePixels,
  encodeFrame,
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
  assert.deepEqual(parseViewMessage('{"type":"navigate","url":" localhost:3000/a "}'), { type: "navigate", url: "localhost:3000/a" });
  assert.deepEqual(parseViewMessage('{"type":"tab","action":"select","tab":"t2"}'), { type: "tab", action: "select", tab: "t2" });
  assert.deepEqual(parseViewMessage('{"type":"fit","on":true}'), { type: "fit", on: true });
  assert.deepEqual(parseViewMessage('{"type":"audio","on":true}'), { type: "audio", on: true });
  assert.match((parseViewMessage('{"type":"audio","on":"yes"}') as { error: string }).error, /audio の on/);

  assert.match((parseViewMessage("not json") as { error: string }).error, /JSON/);
  assert.match((parseViewMessage('{"type":"ack"}') as { error: string }).error, /seq/);
  assert.match((parseViewMessage('{"type":"size","width":0,"height":10}') as { error: string }).error, /範囲/);
  assert.match((parseViewMessage('{"type":"mouse","event":"down"}') as { error: string }).error, /x・y/);
  assert.match((parseViewMessage('{"type":"history","action":"home"}') as { error: string }).error, /back/);
  assert.match((parseViewMessage('{"type":"eval"}') as { error: string }).error, /知らない/);
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

test("高精細の画面：倍率で描いたブラウザでは、絵の上限はページ×倍率。画素数の上限は倍率の2乗で上がり、2560×1600 で頭を押さえる", () => {
  const viewport = { width: 1280, height: 800 };
  // 倍率2で描いて、倍率2の画面（1440×900）で見る：ページの2倍の絵（2560×1600＝4.1 メガ画素）
  assert.deepEqual(screencastLimits([{ width: 1440, height: 900, devicePixelRatio: 2 }], viewport, 2), { maxWidth: 2560, maxHeight: 1600 });
  // 倍率が 0.25 刻みの端数（1.25 等）でも、上限は整数（Page.startScreencast は端数を断る——実機で「Invalid parameters」）
  for (const sc of [1.25, 1.5, 1.75]) {
    const l = screencastLimits([{ width: 833, height: 605, devicePixelRatio: sc }], { width: 833, height: 605 }, sc);
    assert.ok(Number.isInteger(l.maxWidth) && Number.isInteger(l.maxHeight), `倍率 ${sc} で ${JSON.stringify(l)}`);
  }
  assert.equal(maxFramePixels(1), MAX_FRAME_PIXELS);
  assert.equal(maxFramePixels(1.25), MAX_FRAME_PIXELS * 1.5625);
  assert.equal(maxFramePixels(2), MAX_HIDPI_FRAME_PIXELS);
  assert.equal(maxFramePixels(3), MAX_HIDPI_FRAME_PIXELS);
  // 大きなページ（1920×1080）を倍率2で描いても 2560×1600 の画素数を越えない（1 MiB に収まらない）
  const large = { width: 1920, height: 1080 };
  const big = screencastLimits([{ ...large, devicePixelRatio: 2 }], large, 2);
  assert.ok(framePixels(big, large, 2) <= MAX_HIDPI_FRAME_PIXELS, JSON.stringify(big));
  // 携帯（390×844・3倍）に合わせたページを倍率2で描く：ページの2倍の絵（3倍の画面には引き伸ばして映す）
  const phone = { width: 390, height: 844 };
  assert.deepEqual(screencastLimits([{ ...phone, devicePixelRatio: 3 }], phone, 2), { maxWidth: 780, maxHeight: 1688 });
  // 倍率1の画面が倍率2のブラウザを見ると、その画面の大きさまで縮める
  const one = screencastLimits([{ width: 1280, height: 800, devicePixelRatio: 1 }], viewport, 2);
  assert.deepEqual(one, { maxWidth: 1280, maxHeight: 832 });
  assert.equal(frameScale(one, viewport, 2), 0.5);
  assert.equal(framePixels(one, viewport, 2), 1280 * 800);
  // 画質：1倍の上限までは70、越えたら60
  assert.equal(initialQuality(1280 * 800), 70);
  assert.equal(initialQuality(2560 * 1600), 60);
});

test("比の違う絵（起こした直後の窓の素の大きさ）を見分ける：丸めの分は同じ比", () => {
  assert.equal(sameAspect({ width: 2560, height: 1488 }, { width: 1280, height: 800 }), false);
  assert.equal(sameAspect({ width: 2560, height: 1600 }, { width: 1280, height: 800 }), true);
  assert.equal(sameAspect({ width: 1685, height: 948 }, { width: 2560, height: 1440 }), true);
  assert.equal(sameAspect({ width: 1170, height: 2532 }, { width: 390, height: 844 }), true);
});

test("絵の画素数の上限：大きなページ（AI の resize で 7680×4320 まで）でも、絵は MAX_FRAME_PIXELS に収まるよう縮める", () => {
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
    { width: 7680, height: 4320 },
  ]) {
    const limits = screencastLimits([{ width: viewport.width, height: viewport.height, devicePixelRatio: 2 }], viewport);
    const k = frameScale(limits, viewport);
    const pixels = Math.round(viewport.width * k) * Math.round(viewport.height * k);
    assert.ok(pixels <= MAX_FRAME_PIXELS, `${viewport.width}×${viewport.height} の絵が ${pixels} 画素`);
    assert.ok(pixels > MAX_FRAME_PIXELS * 0.95, `${viewport.width}×${viewport.height} で縮めすぎ（${pixels} 画素）`);
  }
  // 上限より小さいものは縮めない（1280×800 は 1.02 メガ画素）
  assert.deepEqual(screencastLimits([{ width: 1280, height: 800, devicePixelRatio: 1 }], { width: 1280, height: 800 }), { maxWidth: 1280, maxHeight: 800 });
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
  // CAPTCHA は人が解く（AI は解かない）・Web の検索は WebSearch、と道具の説明で AI に伝える
  for (const name of ["browserOpen", "browserAct"]) assert.match(TOOLS.find((t) => t.name === name)!.description, /CAPTCHA（ロボット確認[^]*AI は解かない[^]*人に解いてもらう/);
  assert.match(TOOLS.find((t) => t.name === "browserOpen")!.description, /Web の検索には WebSearch を使い/);
});

// ---- 本物のブラウザで ---------------------------------------------------------------------------


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
  /** 描き終えた画面のふり：絵を受けたらすぐ印を返す（いま印を待っている絵にも返す） */
  autoAck(): void {
    const send = this.send.bind(this);
    this.send = (data: Buffer | string) => {
      send(data);
      if (typeof data !== "string") setImmediate(() => this.post({ type: "ack", seq: decodeFrame(data).header.seq }));
    };
    const pending = this.lastFrame();
    if (pending) this.post({ type: "ack", seq: pending.seq });
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
  ctx = await createBrowserContextFromDataDir(dataDir, browserOpts);
  // 新しいタブ（＋）と URL 欄の検索は試験用の検索エンジン（test-page の /search）に向ける——試験で外に出ない
  ctx.state.set({ searchEngine: "custom", searchTemplate: `${base}/search?q=%s` });
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

test("流れ：開くとブラウザを起こして映し、印が返るまで次の絵を送らず、閉じると screencast を止める。入力はページに届き、AI の操作は帯で知らせる", { skip: skipReason }, async () => {
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

  // **AI の操作は帯で知らせる**：どの Thread の AI か・押した要素の名前と枠。人の画面が開いたタブ（人のタブ）を tab で指して
  // 触る——会話の AI がタブを省くと、その会話のタブに効く（タブは会話ごと）
  const tree = (await callTool(ctx, "browserSnapshot", {})).content[0] as { text: string };
  const ref = /button "送る"[^\n]*\[ref=(e\d+)\]/.exec(tree.text)?.[1];
  assert.ok(ref, tree.text);
  const acted = await callTool(ctx, "browserAct", { action: "click", ref, tab: "t1" }, undefined, {
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
  // 見ている画面が変わると大きさの上限が変わり、張り直す——張り直しの間（止めてから張るまで）を読まないよう、張られるまで待つ
  await until("映し続ける", () => view.status().screencasting);
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

function jpegSize(b: Buffer): { width: number; height: number } {
  const size = readJpegSize(b);
  if (!size) throw new Error("JPEG の大きさが読めません");
  return size;
}

/** 文字の多いページ（絵が大きくなる） */
const DENSE_PAGE =
  '<body style="font:12px sans-serif;margin:0">' +
  Array.from({ length: 6000 }, (_, i) => `<span style="color:hsl(${(i * 37) % 360},70%,40%)">項目${i} lorem ${(i * 7919) % 10007}</span>`).join(" ") +
  "</body>";

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

test("大きなページ：AI が 2560×1440 にしても、screencast の絵も最初の1枚（撮った絵）も画素数の上限と 1 MiB に収まる", { skip: skipReason }, async () => {
  const page = (await ctx.session.currentOrNew()).page;
  await page.setContent(DENSE_PAGE);
  await callTool(ctx, "browserAct", { action: "resize", width: 2560, height: 1440 });
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 2560, height: 1440, dpr: 1, visible: true }));
  try {
    // 静かなページなので、最初の1枚は captureScreenshot で撮ったもの
    const first = await until("最初の絵", () => pc.frames[0]);
    const check = (data: Buffer) => {
      const { header, jpeg } = decodeFrame(data);
      const size = jpegSize(jpeg);
      assert.deepEqual([header.width, header.height], [2560, 1440], "頭はページの大きさ（CSS ピクセル）");
      assert.ok(size.width * size.height <= MAX_FRAME_PIXELS, `絵が ${size.width}×${size.height}`);
      assert.ok(Math.abs(size.width / size.height - 2560 / 1440) < 0.01, `比が違う ${size.width}×${size.height}`);
      assert.ok(data.length < 1024 * 1024, `${data.length} バイト`);
    };
    check(first);
    // ページを動かして screencast の絵も見る
    pc.post({ type: "ack", seq: decodeFrame(first).header.seq });
    await page.evaluate(() => document.body.prepend("動いた"));
    const next = await until("screencast の絵", () => pc.frames[1]);
    check(next);
  } finally {
    pc.close(1000);
    await callTool(ctx, "browserAct", { action: "resize", width: 1280, height: 800 });
  }
});

test("1 MiB（ここでは小さくした上限）を越えた絵は送らず、越え始めたときに1度だけ理由を言う", { skip: skipReason }, async () => {
  const small = new BrowserView({ session: ctx.session, state: ctx.state, log: ctx.log, logLine: () => undefined, maxMessageBytes: 2_000 });
  const pc = new FakeSocket();
  small.handler()(pc as unknown as WebSocket, stamp({ width: 800, height: 600, dpr: 1, visible: true }));
  try {
    const page = ctx.session.page().page;
    await until("越えた理由", () => pc.texts.find((t) => t.type === "error" && /1 MiB/.test(String(t.message))));
    for (let i = 0; i < 5; i++) await page.evaluate((n) => document.body.prepend(`更新${n}`), i);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(pc.frames.length, 0, "上限を越えた絵を送った");
    assert.equal(pc.texts.filter((t) => t.type === "error").length, 1, "理由を何度も言った");
  } finally {
    pc.close(1000);
    await small.close();
  }
});

test("指で入力欄を押してすぐ打った文字も届く：入力は投げた順にページへ渡る（読み込んだばかりのページで初めての指でも）", { skip: skipReason }, async () => {
  // 入力を前の応答を待たずに流すと、タッチの後の insertText が追い越して入力欄に焦点が来る前に入り、消えた
  // （実測・2026-10-11、Backlog #260：この形で20回中20回）
  const page = (await ctx.session.currentOrNew()).page;
  await page.goto(`${base}/`);
  const phone = new FakeSocket();
  view.handler()(phone as unknown as WebSocket, stamp({ width: 390, height: 640, dpr: 3, visible: true }));
  try {
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await until("映っている", () => view.status().screencasting);
      const name = (await page.locator("#name").boundingBox())!;
      const point = { x: name.x + name.width / 2, y: name.y + name.height / 2, id: 1 };
      phone.post({ type: "touch", event: "start", points: [point] });
      phone.post({ type: "touch", event: "end", points: [] });
      phone.post({ type: "insertText", text: "けいたい" });
      assert.equal(await waitValue(() => page.inputValue("#name"), "けいたい"), "けいたい", `${i + 1} 回目`);
    }
  } finally {
    phone.close(1000);
  }
});

test("新しいタブ（＋）は設定の検索エンジンのトップで開き、URL 欄の言葉は検索の URL に、URL らしいものはそのまま開く", { skip: skipReason }, async () => {
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1000, height: 700, dpr: 1, visible: true }));
  pc.autoAck();
  try {
    await until("ブラウザが起きた", () => ctx.session.running);
    const before = new Set((await ctx.session.listTabs()).map((t) => t.id));
    pc.post({ type: "tab", action: "new" });
    // 選ばれ（人の画面が映す）、検索のトップを開いている
    const state = await until("＋のタブが選ばれ、検索のトップを開く", () =>
      lastText(pc, (t) => t.type === "state" && !before.has(t.current as string) &&
        (t.tabs as Array<{ id: string; url: string }>).some((x) => x.id === t.current && x.url === `${base}/search?q=`)),
    );
    const added = state.current as string;
    const { page } = ctx.session.page(added);
    await page.waitForLoadState("load");
    assert.equal(await page.title(), "試験の検索");
    // 言葉（空白を含む）→ 検索の URL
    pc.post({ type: "navigate", url: " 東京 天気 " });
    await page.waitForURL(`${base}/search?q=%E6%9D%B1%E4%BA%AC%20%E5%A4%A9%E6%B0%97`);
    assert.equal(await waitValue(() => page.title(), "検索：東京 天気"), "検索：東京 天気");
    // ドットの無い1語も言葉
    pc.post({ type: "navigate", url: "typescript" });
    await page.waitForURL(`${base}/search?q=typescript`);
    // URL らしいもの（scheme の無い 127.0.0.1:番号）は今どおり http:// を足して開く
    pc.post({ type: "navigate", url: base.replace("http://", "") + "/second" });
    await page.waitForURL(`${base}/second`);
    assert.equal(await waitValue(() => page.title(), "2ページ目"), "2ページ目");
    await ctx.session.close(added);
  } finally {
    pc.close(1000);
  }
});

test("「画面に合わせる」を入れてからタブを開く（URL 欄・＋）と、できたタブがその画面の大きさになる（幅 500 未満は上書きを併せる）。切ると全部戻る", { skip: skipReason }, async () => {
  // タブが1つも無い（携帯で開いた最初の姿）
  for (const t of await ctx.session.listTabs()) await ctx.session.close(t.id);
  await until("タブが無い", () => ctx.session.current === undefined);
  const phone = new FakeSocket();
  view.handler()(phone as unknown as WebSocket, stamp({ width: 390, height: 640, dpr: 3, visible: true }));
  // 描き終えた画面のふり：タブができた直後の絵（合わせる前の既定の大きさ）の後にも、合わせた大きさの絵が届く
  phone.autoAck();
  try {
    phone.post({ type: "fit", on: true });
    await until("切り替えが入った", () => lastText(phone, (t) => t.type === "state")?.fit === true);
    phone.post({ type: "navigate", url: base.replace("http://", "") + "/" });
    const opened = await until("URL 欄で開いたタブ", () => lastText(phone, (t) => t.type === "state" && typeof t.current === "string" && (t.viewport as { width: number } | null)?.width === 390));
    const first = opened.current as string;
    assert.deepEqual(ctx.session.viewport(), { width: 390, height: 640 });
    // 窓より狭い（幅 500 未満）——窓は 500 で、ページの大きさの上書きを併せる。ページから見える大きさは画面の大きさ
    // （様子はタブができた時点で届く——開き終えるのを待ってから見る）
    await ctx.session.page(first).page.waitForURL(`${base}/`);
    assert.equal(await waitValue(() => ctx.session.page(first).page.evaluate(() => `${innerWidth}x${innerHeight}`), "390x640"), "390x640");
    await until("絵もその大きさ", () => phone.lastFrame()?.width === 390);
    // ＋で新しいタブ
    phone.post({ type: "tab", action: "new" });
    const added = await until("＋のタブ", () => lastText(phone, (t) => t.type === "state" && t.current !== first && (t.viewport as { width: number } | null)?.width === 390));
    const second = added.current as string;
    // 切ると、合わせたタブは全部既定に戻る
    phone.post({ type: "fit", on: false });
    await until("戻る", () => ctx.session.viewport().width === 1280);
    // 上書きも外れ、どちらのタブも窓の大きさ（ページの大きさはブラウザに1つ）
    // （session.viewport() は変え始めに新しい値になる——ページが変わり終えるまで待つ）
    assert.equal(await waitValue(() => ctx.session.page(second).page.evaluate(() => `${innerWidth}x${innerHeight}`), "1280x800"), "1280x800");
    ctx.session.select(first);
    assert.deepEqual(await waitValue(() => ctx.session.page(first).page.evaluate(() => `${innerWidth}x${innerHeight}`), "1280x800"), "1280x800");
    await ctx.session.close(second);
  } finally {
    phone.close(1000);
  }
});

test("別オリジンの iframe：静かになる直前の iframe の描画も、人の画面に絵として届き、押した入力は iframe に届く", { skip: skipReason }, async () => {
  const pc = new FakeSocket();
  // 描き終えた画面のふり：絵を受けたらすぐ印を返し、受けた時刻を残す
  const arrived: number[] = [];
  const send = pc.send.bind(pc);
  pc.send = (data: Buffer | string) => {
    send(data);
    if (typeof data === "string") return;
    arrived.push(Date.now());
    setImmediate(() => pc.post({ type: "ack", seq: decodeFrame(data).header.seq }));
  };
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1280, height: 800, dpr: 1, visible: true }));
  try {
    pc.post({ type: "navigate", url: `${base}/frame` });
    const inner = await until("iframe が読めた", () => (ctx.session.running && ctx.session.current !== undefined ? ctx.session.page().page.frames().find((f) => f.url().includes("/frame-inner")) : undefined));
    assert.match(inner.url(), /^http:\/\/localhost:/, "iframe が別オリジンではない");
    const changedAt = () => inner.evaluate(() => (window as unknown as { changedAt?: number }).changedAt ?? 0);
    const center = { x: FRAME_BOX.x + FRAME_BOX.width / 2, y: FRAME_BOX.y + FRAME_BOX.height / 2 };
    // 読み終えて少し後の1回と、押すたびの1回——どれも iframe の中だけの1度きりの描画で、そのあとページは静かになる
    for (let step = 1; step < FRAME_COLORS.length; step++) {
      const before = await changedAt();
      if (step > 1) for (const event of ["down", "up"]) pc.post({ type: "mouse", event, ...center, button: "left", buttons: event === "down" ? 1 : 0, clickCount: 1 });
      const at = await waitChange(changedAt, before);
      await until(`${step} 番目の色に変わったあとの絵`, () => arrived.some((t) => t > at), 3_000);
    }
    // 押した数がページのサーバに届いた（iframe の中の fetch）
    const clicks = await ctx.session.page().page.evaluate(() => fetch("/api/frame-clicks").then((r) => r.json() as Promise<{ clicks: number }>));
    assert.ok(clicks.clicks >= FRAME_COLORS.length - 2, `iframe に届いた押下が ${clicks.clicks} 回`);
  } finally {
    pc.close(1000);
  }
});

async function waitChange(read: () => Promise<number>, before: number, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (v > before) return v;
    if (Date.now() > deadline) throw new Error("iframe の色が変わらない");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("倍率2の画面で開くと、ブラウザを倍率2で起こし、届く絵は画面の物理ピクセルの大きさ（ページ×2）で 1 MiB を越えない。ページからも倍率2に見え、AI の絵は CSS の大きさのまま", { skip: skipReason }, async () => {
  // 別の置き場で起こす（上の試験のブラウザは倍率1で起きている——倍率は起こすときにしか決まらない）
  const dir = mkdtempSync(join(tmpdir(), "banto-browser-hidpi-test-"));
  const hi = await createBrowserContextFromDataDir(dir, browserOpts);
  hi.state.set({ searchEngine: "custom", searchTemplate: `${base}/search?q=%s` });
  const hiView = new BrowserView({ session: hi.session, state: hi.state, log: hi.log, logLine: () => undefined });
  hi.view = hiView;
  const pc = new FakeSocket();
  try {
    hiView.handler()(pc as unknown as WebSocket, stamp({ width: 1440, height: 900, dpr: 2, visible: true }));
    await until("ブラウザが起きた", () => hi.session.running);
    assert.equal(hi.session.scale, 2, "人の画面の倍率で起こしていない");
    assert.equal(hi.state.get().viewScale, 2, "次に起こすときの倍率を覚えていない");
    pc.post({ type: "navigate", url: base.replace("http://", "") + "/" });
    const page = await until("開いたタブ", () => (hi.session.current !== undefined && hi.session.page().page.url() === `${base}/` ? hi.session.page().page : undefined));
    await page.waitForLoadState("load");
    assert.equal(await page.evaluate(() => window.devicePixelRatio), 2, "ページから見える倍率が本物（2）でない");
    assert.deepEqual(await page.evaluate(() => [window.innerWidth, window.innerHeight, screen.width, screen.height]), [1280, 800, 1920, 1080]);

    // 届く絵は、ページ×2 の大きさ・頭は CSS の大きさ・1 MiB 以下
    const check = (data: Buffer, what: string) => {
      const { header, jpeg } = decodeFrame(data);
      assert.deepEqual([header.width, header.height], [1280, 800], `${what}：頭はページの大きさ（CSS ピクセル）`);
      assert.deepEqual(jpegSize(jpeg), { width: 2560, height: 1600 }, `${what}：絵が物理ピクセルの大きさでない`);
      assert.ok(data.length <= 1024 * 1024, `${what}：${data.length} バイト`);
    };
    // 描き終えた画面のふり（起こした直後の絵は数えない——下で開いたページの絵から見る）
    pc.autoAck();
    // 文字の多いページ（画質70・2560×1600 では 1 MiB を越える——実測 1060 KiB）を動かし続けて screencast の絵を見る
    const from = pc.frames.length;
    await page.setContent(DENSE_PAGE);
    for (let i = 0; i < 5; i++) {
      await page.evaluate((n) => document.body.prepend(`動いた${n}`), i);
      await new Promise((r) => setTimeout(r, 100));
    }
    await until("文字の多いページの絵", () => pc.frames.length >= from + 3);
    pc.frames.slice(from).forEach((f, i) => check(f, `文字の多いページの絵 ${i + 1}`));
    // 静かなページの最初の1枚（screencast が来ないので撮ったもの——clip の scale）も同じ大きさ：＋で開いた空のタブ
    pc.post({ type: "tab", action: "new" });
    const blank = await until("新しいタブの絵", () => pc.frames.find((f) => decodeFrame(f).header.tab === "t2"));
    check(blank, "撮った1枚");
    assert.equal(pc.texts.filter((t) => t.type === "error").length, 0, JSON.stringify(pc.texts.filter((t) => t.type === "error")));

    // AI の絵（browserScreenshot）は CSS の大きさのまま——倍率の2乗の絵を AI に読ませない
    const shot = await callTool(hi, "browserScreenshot", {});
    const png = Buffer.from((shot.content[1] as { data: string }).data, "base64");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 800]);
    // ページの大きさを変えても（AI の resize）倍率は本物のまま
    await callTool(hi, "browserAct", { action: "resize", width: 1000, height: 700 });
    assert.equal(await page.evaluate(() => window.devicePixelRatio), 2);
    const status = JSON.parse(((await callTool(hi, "getBrowserStatus", {})).content[0] as { text: string }).text) as { scale?: number };
    assert.equal(status.scale, 2);
  } finally {
    pc.close(1000);
    await hiView.close();
    await hi.session.stop("試験の終わり");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1 MiB を越えた絵は捨てて、画質を下げて張り直す（ここでは小さくした上限）", { skip: skipReason }, async () => {
  const page = (await ctx.session.currentOrNew()).page;
  await page.setContent(DENSE_PAGE);
  // 画質70の絵の大きさを測り、その 0.8 倍を上限にする（画質60で約0.84倍・50で約0.73倍——実測・2026-10-11）
  const probe = new FakeSocket();
  view.handler()(probe as unknown as WebSocket, stamp({ width: 1280, height: 800, dpr: 1, visible: true }));
  // 開く前の絵を避ける：1枚目に印を返し、ページを動かしてから来た絵を測る
  probe.post({ type: "ack", seq: decodeFrame(await until("1枚目", () => probe.frames[0])).header.seq });
  await page.evaluate(() => document.body.prepend("測る"));
  const q70 = (await until("画質70の絵", () => probe.frames[1])).length;
  probe.close(1000);
  const limit = Math.round(q70 * 0.8);
  const lines: string[] = [];
  const small = new BrowserView({ session: ctx.session, state: ctx.state, log: ctx.log, logLine: (l) => lines.push(l), maxMessageBytes: limit });
  const pc = new FakeSocket();
  small.handler()(pc as unknown as WebSocket, stamp({ width: 1280, height: 800, dpr: 1, visible: true }));
  try {
    const first = await until("下げた画質の絵", () => pc.frames[0], 15_000).catch((err: Error) => {
      throw new Error(`${err.message}（画質70で ${q70}・上限 ${limit}・倍率 ${ctx.session.scale}）\n${lines.join("\n")}\n${JSON.stringify(pc.texts.filter((t) => t.type === "error"))}`);
    });
    assert.ok(first.length <= limit, `${first.length} バイト`);
    assert.ok(lines.some((l) => /画質 (60|50|40)/.test(l)), `画質70で ${q70}・上限 ${limit}・届いた ${first.length}\n${lines.join("\n")}`);
    assert.equal(pc.texts.filter((t) => t.type === "error").length, 0, "下げれば収まるのに映せないと言った");
  } finally {
    pc.close(1000);
    await small.close();
  }
});

// ---- 動画（v4-modules.md §4.1「動画で流す」） -------------------------------------------------------

/** H.264 を復号して絵を見る道具（ffmpeg）。無ければ動画の試験は飛ばす */
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const videoSkip = skipReason || (ffmpeg ? false : "ffmpeg が無い（動画の絵を復号して確かめられない）");

/** 受けた1通（動画）の頭と中身 */
function videoUnit(data: Buffer): { header: VideoHeader; au: Buffer } {
  const { header, jpeg } = decodeFrame(data);
  return { header: header as unknown as VideoHeader, au: jpeg };
}

/**
 * キーフレームから並べたアクセスユニットを復号し、最後の1枚（RGB）を返す。大きさはページ（CSS ピクセル）×いまの倍率
 * （絵はページを倍率で描いた大きさ——前の試験の画面の倍率でブラウザが起き直していることがある）
 */
function decodeLast(aus: Buffer[], cssWidth: number, cssHeight: number, scale = ctx.session.scale ?? 1): Promise<Buffer> {
  const width = cssWidth * scale;
  const height = cssHeight * scale;
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-loglevel", "error", "-f", "h264", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("close", (code) => {
      const all = Buffer.concat(out);
      const size = width * height * 3;
      if (code !== 0 || all.length < size || all.length % size !== 0) reject(new Error(`ffmpeg ${code}：${all.length} バイト（1枚 ${size}）${err}`));
      else resolve(all.subarray(all.length - size));
    });
    child.stdin.end(Buffer.concat(aus));
  });
}

/** 復号した絵の1画素を色の名前で（圧縮でにじむので、いちばん強い成分で分ける） */
function colorAt(rgb: Buffer, width: number, x: number, y: number): string {
  const i = (y * width + x) * 3;
  const [r, g, b] = [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!];
  const hi = (v: number) => v > 160;
  const lo = (v: number) => v < 120;
  if (hi(r) && hi(g) && lo(b)) return "yellow";
  if (hi(r) && lo(g) && lo(b)) return "red";
  if (lo(r) && hi(g) && lo(b)) return "green";
  if (lo(r) && lo(g) && hi(b)) return "blue";
  return `rgb(${r},${g},${b})`;
}

/**
 * 絵が `/corners` のページ（width×height の CSS ピクセルを倍率 scale で描いたもの）と画素単位で合うか：左上の赤い四角は
 * (0,0)〜(15,15)、右下の緑は (w-16,h-16)〜(w-1,h-1)（CSS ピクセル）、その外は青。タブの帯・窓の枠が映っていれば左上が
 * 赤にならず、絵がずれていれば境目が合わない
 */
function assertCorners(rgb: Buffer, cssWidth: number, cssHeight: number, what: string, scale = ctx.session.scale ?? 1): void {
  const width = cssWidth * scale;
  const height = cssHeight * scale;
  const CORNER_PX = CORNER * scale;
  const at = (x: number, y: number) => colorAt(rgb, width, x, y);
  const got = {
    topLeft: at(1, 1),
    // 境目の両側の1画素ずつ
    topLeftInner: at(CORNER_PX - 1, CORNER_PX - 1),
    topLeftOutside: at(CORNER_PX, CORNER_PX),
    bottomRight: at(width - 2, height - 2),
    bottomRightInner: at(width - CORNER_PX, height - CORNER_PX),
    bottomRightOutside: at(width - CORNER_PX - 1, height - CORNER_PX - 1),
    middle: at(width >> 1, height >> 1),
  };
  assert.deepEqual(got, {
    topLeft: "red",
    topLeftInner: "red",
    topLeftOutside: "blue",
    bottomRight: "green",
    bottomRightInner: "green",
    bottomRightOutside: "blue",
    middle: "blue",
  }, what);
}

/**
 * 届いた動画が止まって、最後の絵が pred を満たすまで待つ（Chrome は描き直しを2度に分けることがあり、間で 300ms 止まる
 * ——1度止まったところで見ると前の絵のことがある）
 */
async function untilPicture(s: FakeSocket, cssWidth: number, cssHeight: number, what: string, pred: (rgb: Buffer) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    await until("止まる", () => view.status().video?.state === "paused", 10_000);
    const tail = sinceLastKey(s, cssWidth);
    if (tail && pred(await decodeLast(tail.aus, cssWidth, cssHeight))) return;
    if (Date.now() > deadline) throw new Error(`待ちきれませんでした：${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** その画面に届いた動画の1通を、いちばん新しいキーフレームから最後まで（その大きさのものだけ） */
function sinceLastKey(s: FakeSocket, width: number): { aus: Buffer[]; header: VideoHeader } | undefined {
  const units = s.frames.map(videoUnit);
  let k = -1;
  for (let i = units.length - 1; i >= 0; i--) {
    if (units[i]!.header.key && units[i]!.header.width === width) {
      k = i;
      break;
    }
  }
  if (k < 0) return undefined;
  const tail = units.slice(k);
  return { aus: tail.map((u) => u.au), header: tail[0]!.header };
}

test("動画：H.264 を描ける画面には動画で流す——最初はキーフレーム、静かなページで流れが止まり、大きさを変えた後（幅 500 未満も）の絵はページと画素単位で合う。後から開いた画面もキーフレームから", { skip: videoSkip }, async () => {
  await callTool(ctx, "browserAct", { action: "resize", width: 1280, height: 800 });
  const page = (await ctx.session.currentOrNew()).page;
  await page.goto(`${base}/corners`);
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  const other = new FakeSocket();
  try {
    const first = videoUnit(await until("最初の1通", () => pc.frames[0], 15_000));
    assert.equal(first.header.codec, "h264", "H.264 を描ける画面に動画で流していない");
    assert.equal(first.header.key, true, "最初の1通がキーフレームでない");
    assert.deepEqual([first.header.width, first.header.height], [1280, 800]);
    assert.ok(pc.frames.every((f) => f.length <= 1024 * 1024));

    // **静かなページでは流れが止まる**（300ms 変化が無ければ PAUSED）
    await until("流れが止まる", () => view.status().video?.state === "paused", 10_000);
    const stillUnits = pc.frames.length;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(pc.frames.length, stillUnits, "止まっているのに送り続けた");
    let rgb = await decodeLast(sinceLastKey(pc, 1280)!.aus, 1280, 800);
    assertCorners(rgb, 1280, 800, "1280×800 の絵");

    // ページが変わると流れ直す
    await page.evaluate(() => document.body.append("動いた"));
    await until("変化で流れ直す", () => pc.frames.length > stillUnits, 5_000);

    // **大きさを変える**（窓の3手）：変えた後の最初の1通はキーフレームで頭は新しい大きさ。絵はページと画素単位で合う
    for (const [w, h] of [
      [1024, 768],
      [390, 640], // 窓の下限（500）より狭い——窓は 500 で、ページの大きさの上書きを併せる
      [1280, 800],
    ] as const) {
      const from = pc.frames.length;
      await callTool(ctx, "browserAct", { action: "resize", width: w, height: h });
      assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [w, h], "resize が返ったのにページの大きさが変わっていない");
      const fresh = videoUnit(await until(`${w}×${h} の1通`, () => pc.frames.slice(from).find((f) => videoUnit(f).header.width === w), 10_000));
      assert.equal(fresh.header.key, true, `${w}×${h}：大きさを変えた後の最初の1通がキーフレームでない`);
      // 変えた後に来た1通は全部新しい大きさ（変えている間の絵を流していない）
      const after = pc.frames.slice(from).map((f) => videoUnit(f).header);
      const firstNew = after.findIndex((x) => x.width === w);
      assert.ok(after.slice(firstNew).every((x) => x.width === w && x.height === h), JSON.stringify(after.map((x) => `${x.width}x${x.height}${x.key ? "K" : ""}`)));
      await until(`${w}×${h} で止まる`, () => view.status().video?.state === "paused", 10_000);
      rgb = await decodeLast(sinceLastKey(pc, w)!.aus, w, h);
      assertCorners(rgb, w, h, `${w}×${h} の絵`);
    }

    // **後から開いた画面にはキーフレームから**（止まっていても流し直す）
    view.handler()(other as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
    const otherFirst = videoUnit(await until("後から開いた画面の1通", () => other.frames[0], 10_000));
    assert.equal(otherFirst.header.key, true, "後から開いた画面の最初の1通がキーフレームでない");
    await until("止まる", () => view.status().video?.state === "paused", 10_000);
    assertCorners(await decodeLast(sinceLastKey(other, 1280)!.aus, 1280, 800), 1280, 800, "後から開いた画面の絵");
    assert.deepEqual(view.status().video?.viewers, 2);

    // 人の入力は動画の画面からもページに届く（screencast を張っていなくても）
    await page.evaluate(() => {
      (window as unknown as { clicked: number[] }).clicked = [];
      addEventListener("click", (e) => (window as unknown as { clicked: number[] }).clicked.push(e.clientX, e.clientY));
    });
    for (const event of ["down", "up"]) pc.post({ type: "mouse", event, x: 640, y: 400, button: "left", buttons: event === "down" ? 1 : 0, clickCount: 1 });
    assert.equal(await waitValue(() => page.evaluate(() => (window as unknown as { clicked: number[] }).clicked.join(",")), "640,400"), "640,400");

    // **復号に失敗した画面にはキーフレームから送り直す**
    const before = other.frames.length;
    other.post({ type: "keyframe" });
    const again = videoUnit(await until("頼んだキーフレーム", () => other.frames[before], 10_000));
    assert.equal(again.header.key, true);

    // **描けなくなった画面は JPEG に落とす**（codec）。もう1つの画面は動画のまま
    other.post({ type: "codec", codec: "jpeg" });
    const jpegFrom = other.frames.length;
    await page.evaluate(() => document.body.append("JPEG"));
    const jpeg = await until("JPEG の絵", () => other.frames.slice(jpegFrom).find((f) => (decodeFrame(f).header as unknown as VideoHeader).codec === undefined), 10_000);
    assert.ok(readJpegSize(decodeFrame(jpeg).jpeg), "JPEG ではない");
    await until("動画の画面は1つ", () => view.status().video?.viewers === 1);
    assert.equal(view.status().screencasting, true);
  } finally {
    pc.close(1000);
    other.close(1000);
  }
  await until("閉じたら動画を止める", () => view.status().video === undefined && !view.status().screencasting, 10_000);
});

test("動画：ポップアップ（window.open の別の窓）と _blank は新しいタブになり、窓は同じ大きさの全画面に合わせ、いま選んでいるタブの絵を映し続ける。選ぶとその絵になる", { skip: videoSkip }, async () => {
  await callTool(ctx, "browserAct", { action: "resize", width: 1024, height: 768 });
  for (const t of await ctx.session.listTabs()) if (t.id !== ctx.session.current) await ctx.session.close(t.id);
  const page = (await ctx.session.currentOrNew()).page;
  const main = ctx.session.current!;
  await page.goto(`${base}/corners`);
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  try {
    await until("最初の1通", () => pc.frames[0], 15_000);
    for (const how of ["#popup", "#blank"]) {
      const tabs = (await ctx.session.listTabs()).length;
      await page.click(how);
      assert.equal(await waitValue(async () => (await ctx.session.listTabs()).length, tabs + 1), tabs + 1, `${how} のタブができない`);
      const opened = (await ctx.session.listTabs()).at(-1)!;
      const popup = ctx.session.page(opened.id).page;
      await popup.waitForLoadState("load");
      // ブラウザは新しい窓・タブを前に出すが、人が見ているのは選んでいるタブ（main）のまま
      assert.equal(ctx.session.current, main, `${how}：選んでいるタブが替わった`);
      assert.equal(await waitValue(() => popup.evaluate(() => `${innerWidth}x${innerHeight}`), "1024x768"), "1024x768", `${how}：新しい窓の大きさが合っていない`);
      const from = pc.frames.length;
      await page.evaluate(() => document.body.append("."));
      await until("流れ直す", () => pc.frames.length > from, 5_000);
      await until("止まる", () => view.status().video?.state === "paused", 10_000);
      // 映っているのは選んでいるタブ（青いページの角の印）——ポップアップの黄色や URL 帯ではない
      pc.post({ type: "keyframe" });
      const keyFrom = pc.frames.length;
      await until("キーフレーム", () => pc.frames.slice(keyFrom).some((f) => videoUnit(f).header.key), 10_000);
      await until("止まる", () => view.status().video?.state === "paused", 10_000);
      assertCorners(await decodeLast(sinceLastKey(pc, 1024)!.aus, 1024, 768), 1024, 768, `${how} を開いた後の選んでいるタブの絵`);
      // 選ぶとその絵になる（全面が黄）
      ctx.session.select(opened.id);
      await until("ポップアップの絵", () => pc.frames.slice(keyFrom).some((f) => videoUnit(f).header.tab === opened.id), 10_000);
      const k = ctx.session.scale ?? 1;
      await untilPicture(pc, 1024, 768, `${how}：選んだポップアップの絵（全面が黄）`, (rgb) =>
        [colorAt(rgb, 1024 * k, 1, 1), colorAt(rgb, 1024 * k, 1024 * k - 2, 768 * k - 2), colorAt(rgb, 1024 * k, 512 * k, 384 * k)].every((c) => c === "yellow"),
      );
      await ctx.session.close(opened.id);
      ctx.session.select(main);
      await until("元のタブ", () => ctx.session.current === main);
    }
    // ＋（newTab）で開いたタブは前に出て、その絵（空のページ——白）になる
    const added = await ctx.session.newTab();
    const addFrom = pc.frames.length;
    await until("新しいタブの絵", () => pc.frames.slice(addFrom).some((f) => videoUnit(f).header.tab === added.id), 10_000);
    const white = (rgb: Buffer, x: number, y: number) => {
      const i = (y * 1024 * (ctx.session.scale ?? 1) + x) * 3;
      return rgb[i]! > 200 && rgb[i + 1]! > 200 && rgb[i + 2]! > 200;
    };
    await untilPicture(pc, 1024, 768, "＋で開いたタブが前に出る（空のページ——白）", (rgb) => white(rgb, 2, 2) && white(rgb, 500, 300));
    await ctx.session.close(added.id);
  } finally {
    pc.close(1000);
  }
});

test("動画：人の画面で静かなページのタブ（別の窓）に切り替えると、止まっていても切り替えた先の絵がキーフレームからすぐ来る。戻しても同じ", { skip: videoSkip }, async () => {
  await callTool(ctx, "browserAct", { action: "resize", width: 1024, height: 768 });
  for (const t of await ctx.session.listTabs()) if (t.id !== ctx.session.current) await ctx.session.close(t.id);
  const page = (await ctx.session.currentOrNew()).page;
  const main = ctx.session.current!;
  await page.goto(`${base}/corners`);
  // 会話のタブ（別の窓・裏で開く）——全面が黄の静かなページ
  const other = await ctx.session.newTab("thread-quiet", `${base}/popup`);
  await other.page.waitForLoadState("load");
  const pc = new FakeSocket();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  try {
    await until("最初の1通", () => pc.frames[0], 15_000);
    for (const [to, what] of [[other.id, "会話のタブ"], [main, "元のタブ"]] as const) {
      await until("止まる", () => view.status().video?.state === "paused", 10_000);
      const from = pc.frames.length;
      ctx.session.select(to);
      // 切り替えた先の絵が来る。その最初の1通はキーフレーム（人の画面は替えた先をキーフレームから描く）
      const first = videoUnit(await until(`${what}の絵`, () => pc.frames.slice(from).find((f) => videoUnit(f).header.tab === to), 5_000));
      assert.equal(first.header.key, true, `${what}に切り替えた最初の1通がキーフレームでない`);
    }
  } finally {
    pc.close(1000);
    await ctx.session.close(other.id);
  }
});

test("動画：GStreamer が無い（入れられない）ブラウザでは、H.264 を描ける画面にも JPEG で映し、理由を様子で伝える", { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-browser-novideo-test-"));
  const reason = "動画で映すための GStreamer がありません（試験）。JPEG で映します";
  const nv = await createBrowserContextFromDataDir(dir, { ...browserOpts, video: { available: false, reason } });
  const nvView = new BrowserView({ session: nv.session, state: nv.state, log: nv.log, logLine: () => undefined });
  nv.view = nvView;
  const pc = new FakeSocket();
  try {
    nvView.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
    await until("ブラウザが起きた", () => nv.session.running, 60_000);
    pc.post({ type: "navigate", url: base.replace("http://", "") + "/corners" });
    const f = await until("絵", () => pc.frames[0], 15_000);
    assert.equal((decodeFrame(f).header as unknown as VideoHeader).codec, undefined, "動画で流した");
    assert.ok(readJpegSize(decodeFrame(f).jpeg));
    await until("理由", () => pc.texts.find((t) => t.type === "state" && t.videoUnavailable === reason));
    assert.equal(nvView.status().video, undefined);
  } finally {
    pc.close(1000);
    await nvView.close();
    await nv.session.stop("試験の終わり");
    rmSync(dir, { recursive: true, force: true });
  }
});

/** この試験のプロセスが起こした動画の子プロセス（python3 -u -c …）の pid */
function videoChildren(): number[] {
  const out: number[] = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const ppid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      if (ppid === process.pid && cmd.startsWith("python3\0-u\0-c")) out.push(Number(pid));
    } catch {
      // 読む間に終わったプロセス
    }
  }
  return out;
}

test("動画：子プロセスが落ちたら JPEG に替え、ブラウザを起こし直したら（仮想の画面が同じ名前でも）動画に戻る", { skip: videoSkip }, async () => {
  const page = (await ctx.session.currentOrNew()).page;
  await page.goto(`${base}/corners`);
  const pc = new FakeSocket();
  pc.autoAck();
  view.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  try {
    await until("動画の1通", () => pc.frames.some((f) => videoUnit(f).header.codec === "h264"), 15_000);
    const display = ctx.session.display!.name;
    const children = videoChildren();
    assert.equal(children.length, 1, `動画の子プロセス：${children.join(",")}`);
    process.kill(children[0]!, "SIGKILL");
    // 落ちた——JPEG に替え、理由を様子で伝える
    await until("理由", () => pc.texts.find((t) => t.type === "state" && typeof t.videoUnavailable === "string" && /動画で流せなくなりました/.test(t.videoUnavailable)), 10_000);
    const jpegFrom = pc.frames.length;
    await page.evaluate(() => document.body.append("JPEG"));
    await until("JPEG の絵", () => pc.frames.slice(jpegFrom).some((f) => (decodeFrame(f).header as unknown as VideoHeader).codec === undefined), 10_000);
    assert.equal(view.status().video, undefined);
    // ブラウザを起こし直す（人の画面の「ブラウザの記録を消す」・止めて起こす と同じ）——仮想の画面は同じ名前で立つ
    await ctx.session.stop("試験：起こし直す");
    pc.post({ type: "start" });
    await until("起き直した", () => ctx.session.running, 60_000);
    // 仮想の画面はふつう同じ名前で立つ（空いている一番小さい番号）——前は名前で失敗を覚えていたので、ここで JPEG のままだった。
    // ほかの試験の Xvfb が番号を持っていると別の名前になるが、どちらでも動画に戻ること
    const again = ctx.session.display!.name;
    pc.post({ type: "navigate", url: base.replace("http://", "") + "/corners" });
    const videoFrom = pc.frames.length;
    await until("動画に戻る", () => pc.frames.slice(videoFrom).some((f) => videoUnit(f).header.codec === "h264"), 30_000);
    assert.equal(lastText(pc, (t) => t.type === "state")?.videoUnavailable, undefined, `起こし直したのに動画で映せない理由が残っている（仮想の画面 ${display}→${again}）`);
  } finally {
    pc.close(1000);
  }
});

test("動画：流れを止めない子プロセスの知らせ（知らない指示・止める指示の失敗）は失敗として扱わない", { skip: videoSkip }, async () => {
  await ctx.session.ensure();
  const errors: string[] = [];
  const warnings: string[] = [];
  const states: string[] = [];
  const p = new VideoPipeline(ctx.session.display!.name, {
    onUnit: () => undefined,
    onState: (s) => states.push(s),
    onError: (m) => errors.push(m),
    onWarning: (m) => warnings.push(m),
  });
  try {
    // 試験だけが知らない指示を送る（send は外から呼ばない口）
    p["send"]({ cmd: "bogus" });
    await until("知らない指示の知らせ", () => warnings.find((w) => w.includes("知らない指示です: bogus")), 10_000);
    p.start({ w: 640, h: 400, ew: 640, eh: 400 });
    await until("流れた", () => p.units > 0, 10_000);
    assert.equal(errors.length, 0, errors.join(" / "));
    assert.equal(p.alive, true);
    // 流し始められない（範囲の無い start）は止まった失敗
    p["send"]({ cmd: "start" });
    await until("流し始められない失敗", () => errors.find((e) => e.startsWith("流し始められません")), 10_000);
  } finally {
    p.close();
  }
});

test("動画：続けて書いた2行の指示（key→stop・stop→start・start→key）は、次の指示を待たずに両方とも処理する", { skip: videoSkip }, async () => {
  await ctx.session.ensure();
  const states: string[] = [];
  const errors: string[] = [];
  const p = new VideoPipeline(ctx.session.display!.name, {
    onUnit: () => undefined,
    onState: (s) => states.push(s),
    onError: (m) => errors.push(m),
    onWarning: () => undefined,
  }, 60_000); // 静止で止まらないよう長く——ここで見るのは指示の読み方
  const region = { w: 640, h: 400, ew: 640, eh: 400 };
  /** 同じ時に2行書く（子の1回の読みに2行が入る） */
  const twoLines = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    p["send"](a);
    p["send"](b);
  };
  const startCmd = { cmd: "start", ...region, fps: 30, crf: 23, maxKbps: 6000, vbvMs: 1000 };
  try {
    p.start(region);
    await until("流れた", () => p.units > 0, 10_000);
    // key→stop：stop がすぐ効く（前は次の指示が来るまで stop が読まれなかった）
    const n1 = states.length;
    twoLines({ cmd: "key" }, { cmd: "stop" });
    await until("key の後の stop", () => states.slice(n1).includes("stopped"), 2_000);
    // stop→start：start がすぐ効いて流れ直す
    const n2 = states.length;
    const units2 = p.units;
    twoLines({ cmd: "stop" }, startCmd);
    await until("stop の後の start", () => states.slice(n2).includes("playing") && p.units > units2, 2_000);
    // start→key：作り直した直後のキーフレームの要求は x264 が最初の IDR にまとめるので、枚数では見えない。**指示は書いた順に
    // 処理する**ので、続けて1行だけ書いた stop がすぐ効けば、その前の key も読み終えている（前の読み方では1行ずつ遅れたまま
    // ——stop を書いた合図で key を読み、stop はバッファに残った）
    const units3 = p.units;
    twoLines(startCmd, { cmd: "key" });
    await until("start が効いた", () => p.units > units3, 2_000);
    const n3 = states.length;
    p.stop();
    await until("start→key の後に書いた stop", () => states.slice(n3).includes("stopped"), 2_000);
    assert.equal(errors.length, 0, errors.join(" / "));
  } finally {
    p.close();
  }
});

// ---- 音（v4-modules.md §4.1「動画で流す」の段4） -------------------------------------------------

/** Opus を復号して音の高さを見る道具（python3 の gi の opusdec）。PulseAudio と合わせて無ければ音の試験は飛ばす */
const OPUS_DECODE = String.raw`
import sys, struct, gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst
Gst.init(None)
p = Gst.parse_launch('appsrc name=src format=time caps="audio/x-opus,channel-mapping-family=(int)0,channels=(int)2,rate=(int)48000" ! opusdec ! audioconvert ! audio/x-raw,format=S16LE,channels=1,rate=48000 ! appsink name=sink sync=false')
src = p.get_by_name("src")
sink = p.get_by_name("sink")
p.set_state(Gst.State.PLAYING)
data = sys.stdin.buffer.read()
i = 0
t = 0
while i < len(data):
    n = struct.unpack(">I", data[i:i + 4])[0]
    i += 4
    b = Gst.Buffer.new_wrapped(data[i:i + n])
    b.pts = t
    b.duration = 20 * Gst.MSECOND
    t += 20 * Gst.MSECOND
    i += n
    src.emit("push-buffer", b)
src.emit("end-of-stream")
while True:
    s = sink.emit("pull-sample")
    if s is None:
        break
    b = s.get_buffer()
    sys.stdout.buffer.write(b.extract_dup(0, b.get_size()))
p.set_state(Gst.State.NULL)
`;
const opusdec = spawnSync("python3", ["-c", 'import gi; gi.require_version("Gst","1.0"); from gi.repository import Gst; Gst.init(None); assert Gst.ElementFactory.find("opusdec")'], { stdio: "ignore" }).status === 0;
const pulse = spawnSync("pulseaudio", ["--version"], { stdio: "ignore" }).status === 0;
const audioSkip = skipReason || (!pulse ? "pulseaudio が無い" : !opusdec ? "GStreamer の opusdec が無い（音を復号して確かめられない）" : false);

/** 受けた1通（音）の頭と中身 */
function audioPacket(data: Buffer): { header: AudioHeader; packet: Buffer } | undefined {
  const { header, jpeg } = decodeFrame(data);
  return (header as unknown as { codec?: string }).codec === "opus" ? { header: header as unknown as AudioHeader, packet: jpeg } : undefined;
}

/** Opus の包みを復号し、1ch の音（S16LE、48kHz）の高さ（Hz、負から正へ0を跨ぐ数）と大きさ（RMS）を返す */
function toneOf(packets: Buffer[]): { hz: number; rms: number; samples: number } {
  const input = Buffer.concat(
    packets.map((p) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(p.length);
      return Buffer.concat([len, p]);
    }),
  );
  const r = spawnSync("python3", ["-c", OPUS_DECODE], { input, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`opusdec が終了コード ${r.status} で終わりました: ${r.stderr.toString().slice(-500)}`);
  const pcm = r.stdout;
  const n = pcm.length / 2;
  let up = 0;
  let sq = 0;
  // 最初の 100ms は鳴り始め（Opus の前置き・音を足し始めた途中）なので数えない
  const from = Math.min(n, 4800);
  for (let i = from + 1; i < n; i++) {
    const a = pcm.readInt16LE((i - 1) * 2);
    const b = pcm.readInt16LE(i * 2);
    if (a < 0 && b >= 0) up++;
    sq += b * b;
  }
  const len = Math.max(1, n - from - 1);
  return { hz: up / (len / 48000), rms: Math.sqrt(sq / len), samples: n };
}

test("音：「音を出す」を押した画面にだけ、鳴っている間だけ Opus を流す——音の高さが合い、時刻は映像と同じ時計。見えなくなったら止める", { skip: audioSkip }, async () => {
  await ctx.session.ensure();
  assert.equal(ctx.session.display?.audio.available, true, `音を流せない：${JSON.stringify(ctx.session.display?.audio)}`);
  const page = (await ctx.session.currentOrNew()).page;
  await page.goto(`${base}/tone`);
  const loud = new FakeSocket();
  const quiet = new FakeSocket();
  loud.autoAck();
  quiet.autoAck();
  view.handler()(loud as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  view.handler()(quiet as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264" }));
  const packets = (s: FakeSocket) => s.frames.map(audioPacket).filter((p) => p !== undefined);
  try {
    // 押す前は流さない（子も起こさない）——ページが鳴っていても
    await page.click("#play");
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(view.status().audio, undefined, "音を出した画面が無いのに音の子が動いている");
    assert.equal(packets(loud).length, 0);
    // 1つの画面が音を出す
    loud.post({ type: "audio", on: true });
    await until("音の1通", () => packets(loud).length >= 60, 15_000);
    assert.equal(view.status().audio?.sounding, true);
    assert.equal(view.status().audio?.viewers, 1);
    assert.equal(packets(quiet).length, 0, "音を出していない画面に流した");
    const got = packets(loud);
    // 1包みは 20ms（鳴り始めの1包みだけは Opus の前置き（312 サンプル＝6.5ms）を引いた 13.5ms）
    assert.ok(got.slice(1).every((p) => p.header.dur === 20_000), `1包みが 20ms でない：${[...new Set(got.map((p) => p.header.dur))].join(",")}`);
    const tone = toneOf(got.map((p) => p.packet));
    assert.ok(Math.abs(tone.hz - TONE_HZ) / TONE_HZ < 0.02, `音の高さ ${tone.hz.toFixed(1)} Hz（${TONE_HZ} Hz のはず）`);
    assert.ok(tone.rms > 1000, `音が小さい（RMS ${tone.rms.toFixed(0)}）`);
    // 時刻は映像と同じ時計（同じ機械の CLOCK_MONOTONIC）——近い時に取り込んだものは数秒の内
    const videoTs = loud.frames.map((f) => decodeFrame(f).header as unknown as { codec?: string; ts?: number }).filter((h) => h.codec === "h264").map((h) => h.ts!);
    assert.ok(videoTs.length > 0, "動画の1通が無い");
    const gap = Math.abs(got.at(-1)!.header.ts - videoTs.at(-1)!) / 1e6;
    assert.ok(gap < 10, `音と映像の時刻が ${gap.toFixed(1)} 秒離れている（同じ時計でない）`);
    // 止めると、0 だけの音が続いたところで送らなくなる
    await page.click("#stop");
    await until("やんだ", () => view.status().audio?.sounding === false, 5_000);
    const after = packets(loud).length;
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(packets(loud).length, after, "鳴っていないのに送った");
    // 鳴らし直すと、また流れる
    await page.click("#play");
    await until("また鳴った", () => packets(loud).length > after + 10, 10_000);
    // 見えなくなった（裏に回った）——誰も聞いていない音は流さない（子を止める）
    loud.post({ type: "visible", visible: false });
    await until("音の子が止まる", () => view.status().audio === undefined, 5_000);
    loud.post({ type: "visible", visible: true });
    await until("前に戻ると流れる", () => view.status().audio?.viewers === 1, 5_000);
    // 音を止めた
    loud.post({ type: "audio", on: false });
    await until("音を止めたら子も止まる", () => view.status().audio === undefined, 5_000);
  } finally {
    await page.click("#stop").catch(() => undefined);
    loud.close(1000);
    quiet.close(1000);
  }
});

test("音：PulseAudio が無い（入れられない）ブラウザでは音無し——理由を様子で伝え、音を出すと言っても流さない。映像は今どおり", { skip: skipReason }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "banto-browser-noaudio-test-"));
  const reason = "音を流すための PulseAudio がありません（試験）。音無しで映します";
  const na = await createBrowserContextFromDataDir(dir, { ...browserOpts, audio: { available: false, reason } });
  const naView = new BrowserView({ session: na.session, state: na.state, log: na.log, logLine: () => undefined });
  na.view = naView;
  const pc = new FakeSocket();
  pc.autoAck();
  try {
    naView.handler()(pc as unknown as WebSocket, stamp({ width: 1400, height: 900, dpr: 1, visible: true, codec: "h264", audio: true }));
    await until("ブラウザが起きた", () => na.session.running, 60_000);
    pc.post({ type: "navigate", url: base.replace("http://", "") + "/corners" });
    await until("絵", () => pc.frames[0], 15_000);
    await until("理由", () => pc.texts.find((t) => t.type === "state" && t.audioUnavailable === reason));
    assert.equal(naView.status().audio, undefined);
    assert.ok(pc.frames.every((f) => audioPacket(f) === undefined));
    // 映像は今どおり（GStreamer がある機械なら動画、無ければ JPEG——どちらでも絵は来ている）
    assert.equal(lastText(pc, (t) => t.type === "state")?.running, true);
  } finally {
    pc.close(1000);
    await naView.close();
    await na.session.stop("試験の終わり");
    rmSync(dir, { recursive: true, force: true });
  }
});
