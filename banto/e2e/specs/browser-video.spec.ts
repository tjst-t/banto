// **Browser の人の画面を動画で流す**（v4-modules.md §4.1「動画で流す——H.264 と WebCodecs」、Backlog #281）——
// 仮想の画面を GStreamer で H.264 に圧縮して流れの口で流し、人の画面は WebCodecs の VideoDecoder で canvas に描く。
// 描けない画面は JPEG に落ちる。
//
// 本番と同じ経路で見る：目録から入れ、Project のコンテナの中で試験用のページ（test-page.js の `/corners`——全面が青、左上に
// 赤・右下に緑の 16px の四角）を立て、偽 Runner の AI に道具を呼ばせる。Playwright の Chromium は H.264 を描ける。見ること（規則14）：
//   1. 開いた画面が動画で描く（下の帯「動画（H.264）」・絵の data-codec）。絵の角の印がページと画素単位で合う
//   2. 静かなページでは流れが止まる（getBrowserStatus の view.video の state が paused、アクセスユニットの数が増えない）
//   3. AI がページの大きさを変える（1024×768・幅 500 未満の 390×640）と、絵の大きさと頭が新しい大きさになり、角の印が合う
//   4. ポップアップ（window.open）を開いても、選んでいるタブの絵のまま。タブの並びに出て、選ぶとポップアップの絵（黄）になる
//   5. VideoDecoder の無い画面は JPEG で描く（下の帯「JPEG」と理由）。角の印は合い、動画の画面と同時に映せる。AudioDecoder の
//      無い画面は「音無し」と理由を出し、「音を出す」を出さない
//   6. 音（段4、Backlog #283）：音の出るページ（`/tone`——880Hz の正弦波）を AI が鳴らしても、「音を出す」を押すまでは画面に
//      音を流さない。押すと AudioDecoder が復号した音の高さが 880Hz に合い、WebAudio で鳴らしている。押したことを覚え、
//      「音を消す」で止まる
import { test, expect, loginContext, type FrameLocator, type Page } from "../test-base.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_TOKEN, CORE_BASE_URL } from "../config.js";
import { createProject, fakeTurn, openApp, waitForProjectModule } from "../helpers.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

const projectName = () => `E2E Browser Video ${test.info().repeatEachIndex + 1}`;
const headers = { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" };
const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const TEST_PAGE = join(REPO, "packages/modules/browser/dist/test-page.js");
const PORT = 18767;
const BASE = `http://127.0.0.1:${PORT}`;
/** 角の四角の大きさ（test-page.ts の CORNER） */
const CORNER = 16;

let projectId = "";
let threadId = "";
let turns = 0;
let testPage: ChildProcess | undefined;

interface HostMessage {
  seq: number;
  role: string;
  text: string;
}

interface VideoStatus {
  state: "playing" | "paused" | "stopped";
  units: number;
  keys: number;
  bytes: number;
  viewers: number;
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

const videoStatus = async (page: Page) => ((await uiCall(page, "getBrowserStatus")).view as { video?: VideoStatus }).video;

/** AI にその tool を呼ばせ、ターンが終わるまで待つ。返すのは AI の最後の発言 */
async function ai(page: Page, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const composer = page.getByPlaceholder(/に送る/);
  const marker = `呼び出し ${++turns}：`;
  await composer.fill(`${marker}ブラウザで確かめて。` + fakeTurn({ giveUpToolAfterMs: 300_000, tools: [{ server: "browser", name, args }] }));
  await composer.press("Enter");
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
  }).toPass({ timeout: 420_000, intervals: [1000] });
  return reply!;
}

/** `/tone` が鳴らす音の高さ（test-page.ts の TONE_HZ） */
const TONE_HZ = 880;

/**
 * 画面の AudioDecoder が出した音を覗く（試験だけ。全部の枠に入る）——復号した音の左の通り道を、最後の 0.5 秒ぶん持つ。
 * 画面の作りは変えない（出した音はそのまま画面に渡す）
 */
function audioSpy(): void {
  type Data = { numberOfFrames: number; copyTo(dest: Float32Array, o: { planeIndex: number; format: string }): void };
  type Init = { output(d: Data): void; error(e: Error): void };
  const w = window as unknown as { AudioDecoder?: new (init: Init) => unknown; __audioSpy?: { frames: number; samples: number[] } };
  const Orig = w.AudioDecoder;
  if (!Orig) return;
  const spy = { frames: 0, samples: [] as number[] };
  w.__audioSpy = spy;
  w.AudioDecoder = class extends (Orig as new (init: Init) => object) {
    constructor(init: Init) {
      super({
        output(d: Data) {
          const left = new Float32Array(d.numberOfFrames);
          d.copyTo(left, { planeIndex: 0, format: "f32-planar" });
          spy.frames += 1;
          spy.samples.push(...left);
          if (spy.samples.length > 24_000) spy.samples.splice(0, spy.samples.length - 24_000);
          init.output(d);
        },
        error: (e: Error) => init.error(e),
      });
    }
  } as unknown as new (init: Init) => unknown;
}

/** 覗いた音：復号した数と、最後の 0.5 秒の高さ（Hz、負から正へ0を跨ぐ数）と大きさ（RMS） */
async function heard(f: FrameLocator): Promise<{ frames: number; hz: number; rms: number }> {
  return f.locator("body").evaluate(() => {
    const spy = (window as unknown as { __audioSpy?: { frames: number; samples: number[] } }).__audioSpy;
    if (!spy) return { frames: -1, hz: 0, rms: 0 };
    const x = spy.samples;
    let up = 0;
    let sq = 0;
    for (let i = 1; i < x.length; i++) {
      if (x[i - 1]! < 0 && x[i]! >= 0) up++;
      sq += x[i]! * x[i]!;
    }
    return { frames: spy.frames, hz: x.length > 1 ? up / ((x.length - 1) / 48_000) : 0, rms: x.length > 1 ? Math.sqrt(sq / (x.length - 1)) : 0 };
  });
}

const canvasFrame = (page: Page) => page.frameLocator('[data-testid="module-canvas-frame"]').frameLocator("iframe");

/**
 * 人の画面の絵（canvas）の、ページの点（CSS ピクセル）に当たる画素の色。圧縮でにじむので、いちばん強い成分で分ける
 */
async function colorsOnScreen(f: FrameLocator, points: Array<[number, number]>): Promise<string[]> {
  return f.getByTestId("browser-screen").evaluate((canvas: HTMLCanvasElement, pts) => {
    const k = canvas.width / Number(canvas.dataset.pageWidth);
    const g = canvas.getContext("2d")!;
    return pts.map(([x, y]) => {
      const d = g.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data;
      const hi = (v: number) => v > 160;
      const lo = (v: number) => v < 120;
      const [r, gr, b] = [d[0]!, d[1]!, d[2]!];
      if (hi(r) && hi(gr) && lo(b)) return "yellow";
      if (hi(r) && lo(gr) && lo(b)) return "red";
      if (lo(r) && hi(gr) && lo(b)) return "green";
      if (lo(r) && lo(gr) && hi(b)) return "blue";
      return `rgb(${r},${gr},${b})`;
    });
  }, points);
}

/**
 * 絵が `/corners`（width×height）と合う：角の四角の境目の両側（margin CSS px ずつ内と外）と、真ん中。動画はページの画素の
 * まま描くので境目の両側の1画素ずつ（margin 0——画素単位）。JPEG は画面の大きさに縮めて流すので境目がにじむ——数画素離す
 */
async function expectCorners(f: FrameLocator, width: number, height: number, what: string, margin = 0): Promise<void> {
  const points: Array<[number, number]> = [
    [1, 1],
    [CORNER - 1 - margin, CORNER - 1 - margin],
    [CORNER + margin, CORNER + margin],
    [width - 2, height - 2],
    [width - CORNER + margin, height - CORNER + margin],
    [width - CORNER - 1 - margin, height - CORNER - 1 - margin],
    [width >> 1, height >> 1],
  ];
  const want = ["red", "red", "blue", "green", "green", "blue", "blue"];
  await expect.poll(() => colorsOnScreen(f, points), { timeout: 20_000, message: `${what}：絵の角の印がページと合わない` }).toEqual(want);
}

/** 絵の大きさ（canvas の画素）と頭のページの大きさ */
async function expectPageSize(f: FrameLocator, width: number, height: number): Promise<void> {
  const screen = f.getByTestId("browser-screen");
  await expect(screen, "絵の頭がページの大きさになっていない").toHaveAttribute("data-page-width", String(width), { timeout: 30_000 });
  await expect(screen).toHaveAttribute("data-page-height", String(height));
  // 倍率1で起きている——絵の画素はページの CSS ピクセルと同じ（x264 は偶数しか受けないので奇数なら1画素落ちる）
  await expect.poll(() => screen.evaluate((c: HTMLCanvasElement) => [c.width, c.height]), { timeout: 30_000 }).toEqual([width & ~1, height & ~1]);
}

/** 静かなページで流れが止まり、止まっている間は増えない */
async function expectPaused(page: Page, what: string): Promise<void> {
  await expect.poll(async () => (await videoStatus(page))?.state, { timeout: 30_000, message: `${what}：静かなページで流れが止まらない` }).toBe("paused");
  const units = (await videoStatus(page))!.units;
  await new Promise((r) => setTimeout(r, 1500));
  const now = (await videoStatus(page))!;
  expect(now.state).toBe("paused");
  expect(now.units, `${what}：止まっているのにアクセスユニットが増えた`).toBe(units);
}

function refOf(tree: string, role: string, name: string): string {
  const m = new RegExp(`${role} "${name}"[^\\n]*\\[ref=(e\\d+)\\]`).exec(tree);
  if (!m) throw new Error(`${role} "${name}" がツリーに無い:\n${tree}`);
  return m[1]!;
}

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${CORE_BASE_URL}/api/modules/catalog/browser`, { headers, data: { name: "browser" } });
  const body = res.ok() ? "" : await res.text();
  if (!res.ok() && !body.includes("その名前はもう使われています")) throw new Error(`Browser を目録から入れられませんでした: ${res.status()} ${body}`);
});

test.afterAll(() => {
  testPage?.kill();
});

test("人の画面を動画で描く：角の印がページと合い、静かなページで流れが止まり、大きさを変えても（幅 500 未満も）合い、ポップアップでも選んでいるタブを映し、描けない画面は JPEG に落ちる", async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  // 画面の枠が読み込まれる前に、復号した音を覗く道具を入れる（6.）
  await page.context().addInitScript(audioSpy);
  await openApp(page);
  const PROJECT_NAME = projectName();
  await createProject(page, PROJECT_NAME, mkdtempSync(join(tmpdir(), "banto-e2e-browser-video-")));
  await waitForProjectModule(page, PROJECT_NAME, "browser");
  const projects = (await (await page.request.get(`${CORE_BASE_URL}/api/projects`, { headers })).json()) as { id: string; name: string }[];
  projectId = projects.find((p) => p.name === PROJECT_NAME)!.id;
  threadId = ((await (await page.request.get(`${CORE_BASE_URL}/api/projects/${projectId}/threads`, { headers })).json()) as { id: string }[])[0]!.id;

  testPage = spawn(
    "incus",
    ["exec", `banto-${projectId}`, "--user", String(process.getuid!()), "--group", String(process.getgid!()), "--", "/usr/local/bin/node", TEST_PAGE, String(PORT)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let pageOut = "";
  testPage.stdout!.on("data", (c: Buffer) => (pageOut += c.toString()));
  testPage.stderr!.on("data", (c: Buffer) => (pageOut += c.toString()));
  await expect.poll(() => pageOut, { timeout: 30_000, message: "試験用のページが立たない" }).toContain(`listening ${PORT}`);

  // ---- 1. 動画で描く ------------------------------------------------------------------------------------
  expect(await ai(page, "browserOpen", { url: `${BASE}/corners` })).toContain("タブ t1 で開きました");
  const card = page.getByTestId("tool-entry-card").filter({ hasText: `ブラウザで開いた：${BASE}/corners` });
  await expect(card, "browserOpen のカードが出ない").toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: "開く" }).click();
  const f = canvasFrame(page);
  await expect(f.getByTestId("browser-state"), "流れが開かない").toHaveAttribute("data-state", "open", { timeout: 180_000 });
  const screen = f.getByTestId("browser-screen");
  await expect(screen, "絵が描かれない").toBeVisible({ timeout: 60_000 });
  await expect(screen).toHaveAttribute("data-tab", "t1");
  await expect(screen, "動画で描いていない（GStreamer が入らなかったか、画面が H.264 を描けない）").toHaveAttribute("data-codec", "h264", { timeout: 60_000 });
  await expect(f.getByTestId("codec")).toHaveText("動画（H.264）");
  await expectPageSize(f, 1280, 800);
  await expectCorners(f, 1280, 800, "1280×800");
  await expect.poll(async () => (await videoStatus(page))?.viewers, { message: "動画で見ている画面が数えられていない" }).toBe(1);

  // ---- 2. 静かなページで流れが止まる。変われば流れ直す ---------------------------------------------------------
  await expectPaused(page, "開いたあと");
  const seq = Number(await screen.getAttribute("data-seq"));
  await ai(page, "browserEval", { expression: "(document.body.style.background = '#0000fe', 'ok')" });
  await expect.poll(async () => Number(await screen.getAttribute("data-seq")), { message: "ページが変わっても絵が新しくならない" }).toBeGreaterThan(seq);

  // ---- 3. ページの大きさを変える（幅 500 未満も）--------------------------------------------------------------
  for (const [w, h] of [
    [1024, 768],
    [390, 640],
    [1280, 800],
  ] as const) {
    expect(await ai(page, "browserAct", { action: "resize", width: w, height: h })).toContain(`ページの大きさを ${w}×${h} にしました`);
    await expectPageSize(f, w, h);
    await expect(f.getByTestId("viewport")).toHaveText(`ページ ${w}×${h}`);
    await expectCorners(f, w, h, `${w}×${h}`);
    await expect(screen).toHaveAttribute("data-codec", "h264");
    await expectPaused(page, `${w}×${h}`);
  }

  // ---- 4. ポップアップ -----------------------------------------------------------------------------------
  const tree = await ai(page, "browserSnapshot");
  await ai(page, "browserAct", { action: "click", ref: refOf(tree, "button", "ポップアップ") });
  const tab2 = f.locator('.tab[data-tab="t2"]');
  await expect(tab2, "ポップアップがタブの並びに出ない").toContainText("ポップアップ", { timeout: 30_000 });
  await expect(f.locator('.tab[data-tab="t1"]')).toHaveAttribute("aria-selected", "true");
  // 選んでいるタブ（t1）の絵のまま——ポップアップの窓が上に重なっていない
  await expect(screen).toHaveAttribute("data-tab", "t1");
  await expectCorners(f, 1280, 800, "ポップアップを開いた後の t1");
  // 選ぶとポップアップの絵（全面が黄）。大きさは同じ
  await tab2.locator(".tab-name").click();
  await expect(screen).toHaveAttribute("data-tab", "t2", { timeout: 20_000 });
  await expect.poll(() => colorsOnScreen(f, [[1, 1], [640, 400], [1278, 798]]), { timeout: 20_000, message: "ポップアップの絵にならない" }).toEqual(["yellow", "yellow", "yellow"]);
  await expectPageSize(f, 1280, 800);
  await f.getByRole("button", { name: "t2 を閉じる" }).click();
  await expect(f.locator(".tab[data-tab]")).toHaveCount(1);
  await expect(screen).toHaveAttribute("data-tab", "t1", { timeout: 20_000 });
  await expectCorners(f, 1280, 800, "ポップアップを閉じた後の t1");

  // ---- 5. VideoDecoder の無い画面は JPEG で描く -------------------------------------------------------------
  const nodecoder = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await nodecoder.addInitScript(() => {
      // Firefox for Android 等と同じ（WebCodecs が無い）
      delete (window as unknown as { VideoDecoder?: unknown }).VideoDecoder;
      // Safari 26 未満と同じ（AudioDecoder が無い）
      delete (window as unknown as { AudioDecoder?: unknown }).AudioDecoder;
    });
    await loginContext(nodecoder);
    const j = await nodecoder.newPage();
    j.on("pageerror", (err) => pageErrors.push(`jpeg: ${err.message}`));
    await openApp(j);
    await j.goto(page.url());
    const jf = canvasFrame(j);
    const jscreen = jf.getByTestId("browser-screen");
    await expect(jscreen, "VideoDecoder の無い画面に絵が出ない").toBeVisible({ timeout: 60_000 });
    await expect(jscreen).toHaveAttribute("data-codec", "jpeg");
    await expect(jf.getByTestId("codec")).toHaveText("JPEG");
    await expect(jf.getByTestId("codec")).toHaveAttribute("title", "この画面には VideoDecoder がありません");
    await expectCorners(jf, 1280, 800, "JPEG の画面", 3);
    // 音無し：「音を出す」は出さず、理由を出す
    await expect(jf.getByTestId("sound-note"), "AudioDecoder の無い画面に「音無し」が出ない").toBeVisible();
    await expect(jf.getByTestId("sound-note")).toHaveText("音無し");
    await expect(jf.getByTestId("sound-note")).toHaveAttribute("title", "この画面には AudioDecoder がありません");
    await expect(jf.getByTestId("sound")).toBeHidden();
    // 動画の画面と同時に映している：動画の画面は1つのまま、JPEG の screencast も張っている
    const st = (await uiCall(page, "getBrowserStatus")).view as { viewers: number; screencasting: boolean; video?: VideoStatus };
    expect(st.viewers).toBe(2);
    expect(st.screencasting).toBe(true);
    expect(st.video?.viewers).toBe(1);
    await expect(screen).toHaveAttribute("data-codec", "h264");
  } finally {
    await nodecoder.close();
  }

  // ---- 6. 音 -------------------------------------------------------------------------------------------
  const sound = f.getByTestId("sound");
  await expect(sound, "「音を出す」が出ない（Module が音を流せないか、画面が AudioDecoder を持たない）").toBeVisible();
  await expect(f.getByTestId("sound-note")).toBeHidden();
  await expect(sound).toHaveText("音を出す");
  await expect(sound).toHaveAttribute("data-sound", "off");
  expect(await ai(page, "browserOpen", { url: `${BASE}/tone` })).toContain("で開きました");
  await ai(page, "browserAct", { action: "click", ref: refOf(await ai(page, "browserSnapshot"), "button", "音を鳴らす") });
  // ページは鳴っているが、押すまでは画面に流さない（Module は音の子も起こさない）
  await new Promise((r) => setTimeout(r, 1500));
  expect(((await uiCall(page, "getBrowserStatus")).view as { audio?: unknown }).audio, "「音を出す」を押す前に音を流している").toBeUndefined();
  expect((await heard(f)).frames, "「音を出す」を押す前に音を復号した").toBe(0);
  await sound.click();
  await expect(sound, "押しても鳴り始めない").toHaveAttribute("data-sound", "on", { timeout: 10_000 });
  await expect(sound).toHaveText("音を消す");
  await expect(sound).toHaveAttribute("aria-pressed", "true");
  // 届いた音の高さが合う（0.5 秒ぶんがたまってから）
  await expect
    .poll(async () => {
      const h = await heard(f);
      return h.frames > 40 && h.rms > 0.05 && Math.abs(h.hz - TONE_HZ) / TONE_HZ < 0.02 ? "ok" : JSON.stringify(h);
    }, { timeout: 30_000, message: `復号した音が ${TONE_HZ}Hz にならない` })
    .toBe("ok");
  // WebAudio で鳴らしている（映像に合わせて時刻を決めた包みの数）
  await expect.poll(async () => Number(await sound.getAttribute("data-played")), { message: "WebAudio で鳴らしていない" }).toBeGreaterThan(20);
  const audioStatus = ((await uiCall(page, "getBrowserStatus")).view as { audio?: { sounding: boolean; viewers: number } }).audio;
  expect(audioStatus?.sounding).toBe(true);
  expect(audioStatus?.viewers).toBe(1);
  // 押したことを覚える（次に開いたら、画面に触れた最初の操作で鳴らし始める）
  expect(await f.locator("body").evaluate(() => window.localStorage.getItem("banto-browser-sound"))).toBe("1");
  // 音を消す——流れも止まる
  await sound.click();
  await expect(sound).toHaveAttribute("data-sound", "off");
  await expect(sound).toHaveText("音を出す");
  await expect.poll(async () => ((await uiCall(page, "getBrowserStatus")).view as { audio?: unknown }).audio, { message: "音を消しても音を流している" }).toBeUndefined();
  expect(await f.locator("body").evaluate(() => window.localStorage.getItem("banto-browser-sound"))).toBe("0");
  // 前に音を出していた状態で開き直し、覚えた後の最初の操作としていちばん自然な「ボタンを押す」で鳴り始め、鳴り続ける
  // （前は同じ押下の pointerdown で鳴らし始め、続く click で止めて覚えも消していた）
  await f.locator("body").evaluate(() => window.localStorage.setItem("banto-browser-sound", "1"));
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect.poll(async () => ((await uiCall(page, "getBrowserStatus")).view as { viewers: number }).viewers, { timeout: 20_000 }).toBe(0);
  await page.getByTestId("tool-entry-card").filter({ hasText: `ブラウザで開いた：${BASE}/tone` }).getByRole("button", { name: "開く" }).click();
  const g = canvasFrame(page);
  const again = g.getByTestId("sound");
  await expect(again, "覚えているのに待ちの表示にならない").toHaveAttribute("data-sound", "waiting", { timeout: 60_000 });
  await expect(again).toHaveText("音を出す");
  await again.click();
  await expect(again, "覚えた後にボタンを押しても鳴り始めない").toHaveAttribute("data-sound", "on", { timeout: 10_000 });
  // 押下の click で止まっていない（少し待っても鳴ったまま・覚えも残る・Module も流している）
  await new Promise((r) => setTimeout(r, 1500));
  await expect(again).toHaveAttribute("data-sound", "on");
  await expect(again).toHaveText("音を消す");
  expect(await g.locator("body").evaluate(() => window.localStorage.getItem("banto-browser-sound"))).toBe("1");
  await expect.poll(async () => Number(await again.getAttribute("data-played")), { message: "開き直した画面で鳴らしていない" }).toBeGreaterThan(20);
  expect(((await uiCall(page, "getBrowserStatus")).view as { audio?: { viewers: number } }).audio?.viewers).toBe(1);
  await again.click();
  await expect(again).toHaveAttribute("data-sound", "off");
  await ai(page, "browserAct", { action: "click", ref: refOf(await ai(page, "browserSnapshot"), "button", "音を止める") });

  // 閉じると動画も止まる
  await page.getByRole("button", { name: "Canvas を閉じる" }).click();
  await expect.poll(async () => (await uiCall(page, "getBrowserStatus")).view, { timeout: 20_000, message: "画面を閉じても動画が止まらない" }).toEqual({
    viewers: 0,
    watching: 0,
    screencasting: false,
  });
  expect(pageErrors, `画面側で例外が出た: ${pageErrors.join(" / ")}`).toEqual([]);
});
