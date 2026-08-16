/**
 * task-0156: 共有ブラウザ モジュールの最小の縦串（面で見て、面から触れる）。
 *
 * **本物のブラウザは起こさない。** 検証の器（`docker/Dockerfile.test`）は node:24-alpine で
 * chromium が入っておらず、playwright が落としてくる chromium は glibc 版なので musl では
 * 動かない（2026-08-15 の判定 §5-0）。そこで CDP がただの WebSocket + JSON-RPC である
 * ことを使い、**偽の CDP エンドポイント**を `ws` で立てて、実装が守るべき作法を機械で固定する：
 *
 *   - 起こす／落とすで状態が往復し、落としたら CDP への接続が閉じている
 *   - 面が繋いだら `Page.startScreencast` が送られる
 *   - 届いた `Page.screencastFrame` が面へ流れ、**必ず `Page.screencastFrameAck` が返る**
 *   - 面からの操作が `Input.dispatchMouseEvent` / `Input.insertText` へ写る
 *   - 面の表示サイズとフレームの実寸が違うときの座標変換
 *
 * 本物の chromium で動くことはここでは確かめられない（面で人が見て確かめる）。
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

import {
  PlaceRegistry,
  PlaceGrantStore,
  createModuleRegistry,
  createStaticPlaceProvider,
  createWorkspaceModule,
  type BantoModule,
} from "@banto/host";
import { createRepoManagerModule } from "@banto/repo-manager";
import { EnvironmentPool, createEnvironmentPoolModule } from "@banto/environment-pool";

import {
  BROWSER_VIEWER_WS_PATH,
  createBrowserModule,
  createUnimplementedLauncher,
  toCdpCalls,
  toPageCoordinates,
  type BrowserLauncher,
  type BrowserStatus,
} from "../../packages/banto-host/src/browser/index.js";

// ── 偽の CDP エンドポイント ───────────────────────────────────────────────────

interface CdpCommandRecord {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface FakeCdp {
  url: string;
  /** 受け取ったコマンドを届いた順に。 */
  commands: CdpCommandRecord[];
  /** いま繋がっている本数。落としたら 0 になる。 */
  connections(): number;
  /** 閉じられた回数。 */
  closes(): number;
  /** こちらからイベントを投げる。 */
  emit(method: string, params: Record<string, unknown>): void;
  /** ある method が n 件届くまで待つ。 */
  waitFor(method: string, count?: number): Promise<CdpCommandRecord[]>;
  close(): Promise<void>;
}

async function startFakeCdp(): Promise<FakeCdp> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  const commands: CdpCommandRecord[] = [];
  const sockets = new Set<WebSocket>();
  let closed = 0;
  const watchers: Array<() => void> = [];

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      closed += 1;
    });
    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as CdpCommandRecord;
      commands.push({ ...msg, params: msg.params ?? {} });
      // CDP はどのコマンドにも必ず結果を返す。中身は問わないので空で足りる
      socket.send(JSON.stringify({ id: msg.id, result: {} }));
      for (const notify of watchers.splice(0)) notify();
    });
  });

  const matching = (method: string): CdpCommandRecord[] =>
    commands.filter((c) => c.method === method);

  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    commands,
    connections: () => sockets.size,
    closes: () => closed,
    emit(method, params) {
      for (const socket of sockets) socket.send(JSON.stringify({ method, params }));
    },
    async waitFor(method, count = 1) {
      const deadline = Date.now() + 5_000;
      while (matching(method).length < count) {
        // I2: 待ち続けて固まらない。届かなかったことは失敗として出す
        if (Date.now() > deadline) {
          throw new Error(
            `CDP へ ${method} が ${count} 件届きませんでした（届いたのは ${matching(method).length} 件、` +
              `全体: ${commands.map((c) => c.method).join(", ")}）`
          );
        }
        await new Promise<void>((resolve) => {
          watchers.push(resolve);
          setTimeout(resolve, 25);
        });
      }
      return matching(method);
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/** 偽の起こし手。本物の chromium は起こさない——偽の CDP を指すだけ。 */
function fakeLauncher(url: string): { launcher: BrowserLauncher; launched: () => number; closed: () => number } {
  let launched = 0;
  let closed = 0;
  return {
    launcher: {
      name: "fake",
      async launch() {
        launched += 1;
        return {
          webSocketDebuggerUrl: url,
          async close() {
            closed += 1;
          },
        };
      },
    },
    launched: () => launched,
    closed: () => closed,
  };
}

// ── Tool を呼ぶ小道具 ────────────────────────────────────────────────────────

async function callTool(module: BantoModule, name: string, args: unknown = {}): Promise<BrowserStatus> {
  const tool = module.tools.find((t) => t.name === name);
  assert.ok(tool, `Tool ${name} がありません`);
  const result = await tool.execute(args);
  return result.details as BrowserStatus;
}

/**
 * ホストと同じ形で upgrade をモジュールへ回す小さなサーバ
 * （`packages/banto-host/src/server.ts` が到達先の下の upgrade を回してくるのと同じ経路）。
 */
async function startViewerHost(module: BantoModule): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    const base = module.endpoint.baseUrl.replace(/\/$/, "");
    if ((req.url ?? "").startsWith(base) && module.handleUpgrade?.(req, socket, head)) return;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 面の側の WebSocket。届いたメッセージを溜める。 */
interface FakeViewer {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  waitFor(type: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function connectViewer(port: number): Promise<FakeViewer> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${BROWSER_VIEWER_WS_PATH}`);
  const messages: Array<Record<string, unknown>> = [];
  const watchers: Array<() => void> = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    for (const notify of watchers.splice(0)) notify();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (err) => reject(err));
  });
  return {
    socket,
    messages,
    async waitFor(type) {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = messages.find((m) => m["type"] === type);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(
            `面へ ${type} が届きませんでした（届いたのは ${messages.map((m) => String(m["type"])).join(", ")}）`
          );
        }
        await new Promise<void>((resolve) => {
          watchers.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      }),
  };
}

// ── [a1] 登録できて、既存と衝突しない ────────────────────────────────────────

describe("[task-0156] browser モジュールを登録できる", () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-module-"));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("既存の組み込みモジュールと、名前・Tool 名・canvas kind のどれも衝突しない", () => {
    const places = new PlaceRegistry([createStaticPlaceProvider([{ id: "x", path: dir }])]);
    const grants = new PlaceGrantStore(path.join(dir, "grants.json"));
    const registry = createModuleRegistry([
      createWorkspaceModule(places, {}, grants),
      createRepoManagerModule(),
      createEnvironmentPoolModule(new EnvironmentPool({ dataDir: dir })),
    ]);

    // createModuleRegistry は名前・Tool・kind・SKILL の衝突を例外で弾く（module.ts:151-192）
    registry.register(createBrowserModule());

    assert.ok(registry.get("browser"), "browser モジュールが帳簿にない");
  });

  it("Tool は browser.start / browser.stop / browser.status の3本", () => {
    const module = createBrowserModule();
    assert.deepEqual(
      module.tools.map((t) => t.name).sort(),
      ["browser.start", "browser.status", "browser.stop"]
    );
    assert.deepEqual(module.internalTools ?? [], []);
  });

  it("canvas kind browser.viewer を提供している", () => {
    const registry = createModuleRegistry([createBrowserModule()]);
    const kinds = registry.views().map((v) => v.kind);
    assert.ok(kinds.includes("browser.viewer"), `browser.viewer が無い: ${kinds.join(", ")}`);
    assert.equal(registry.moduleForView("browser.viewer")?.name, "browser");
  });
});

// ── [a2] 起こす／落とす ──────────────────────────────────────────────────────

describe("[task-0156] 偽の launcher と偽の CDP に対して起こす・落とす", () => {
  let cdp: FakeCdp;

  beforeEach(async () => {
    cdp = await startFakeCdp();
  });
  afterEach(async () => {
    await cdp.close();
  });

  it("start で running、stop で stopped に戻り、CDP への接続が閉じる", async () => {
    const fake = fakeLauncher(cdp.url);
    const module = createBrowserModule({ launcher: fake.launcher });

    assert.equal((await callTool(module, "browser.status")).state, "stopped");

    const started = await callTool(module, "browser.start", { url: "about:blank" });
    assert.equal(started.state, "running");
    assert.equal(fake.launched(), 1);
    assert.equal((await callTool(module, "browser.status")).state, "running");
    assert.equal(cdp.connections(), 1, "CDP へ繋がっていない");

    const stopped = await callTool(module, "browser.stop");
    assert.equal(stopped.state, "stopped");
    assert.equal(fake.closed(), 1, "起こしたブラウザを閉じていない");
    assert.equal((await callTool(module, "browser.status")).state, "stopped");
    assert.equal(cdp.connections(), 0, "CDP への接続が閉じていない");
    assert.ok(cdp.closes() >= 1, "CDP 側で close を受けていない");
  });

  it("二重に起こさない・落ちているものを落としても失敗しない（冪等）", async () => {
    const fake = fakeLauncher(cdp.url);
    const module = createBrowserModule({ launcher: fake.launcher });

    await callTool(module, "browser.start");
    await callTool(module, "browser.start");
    assert.equal(fake.launched(), 1, "起きているのに起こし直している");

    await callTool(module, "browser.stop");
    assert.equal((await callTool(module, "browser.stop")).state, "stopped");
  });

  it("既定の launcher は chromium を名乗り、見つからなければ探した場所を添えて失敗する（黙って成功しない）", async () => {
    // K2 で既定が createUnimplementedLauncher() から createChromiumLauncher() に替わった。
    // このホストには本物の chromium が（playwright キャッシュ等に）居ることがあるため、
    // 既定のまま呼ぶと本物を起こしてしまいかねない。HOME/PATH/BANTO_BROWSER_EXECUTABLE を
    // 差し替えて「どこにも無い」状態を作り、探索が尽きて失敗する経路を確定させる。
    const savedEnv = {
      BANTO_BROWSER_EXECUTABLE: process.env["BANTO_BROWSER_EXECUTABLE"],
      HOME: process.env["HOME"],
      PATH: process.env["PATH"],
    };
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "banto-no-chromium-home-"));
    delete process.env["BANTO_BROWSER_EXECUTABLE"];
    process.env["HOME"] = emptyHome;
    process.env["PATH"] = "";
    try {
      const module = createBrowserModule();
      assert.equal(
        (await callTool(module, "browser.status")).launcher,
        "chromium",
        "既定の launcher が chromium を名乗っていない"
      );
      await assert.rejects(
        () => callTool(module, "browser.start"),
        /chromium の実行ファイルが見つかりません/,
        "既定の launcher が黙って成功している"
      );
      assert.equal((await callTool(module, "browser.status")).state, "stopped");
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("createUnimplementedLauncher は消えていない（K1 の口として残っている）", async () => {
    const module = createBrowserModule({ launcher: createUnimplementedLauncher() });
    await assert.rejects(() => callTool(module, "browser.start"), /実装はまだありません/);
  });
});

// ── [a3] 面の WebSocket と screencast ────────────────────────────────────────

describe("[task-0156] 面の WebSocket でフレームが往復する", () => {
  let cdp: FakeCdp;
  let host: { port: number; close(): Promise<void> };
  let module: BantoModule;

  beforeEach(async () => {
    cdp = await startFakeCdp();
    module = createBrowserModule({ launcher: fakeLauncher(cdp.url).launcher });
    host = await startViewerHost(module);
  });
  afterEach(async () => {
    await callTool(module, "browser.stop");
    await host.close();
    await cdp.close();
  });

  it("面が繋ぐと Page.startScreencast が CDP へ送られる", async () => {
    await callTool(module, "browser.start");
    const viewer = await connectViewer(host.port);
    try {
      const [start] = await cdp.waitFor("Page.startScreencast");
      assert.equal(start?.params["format"], "jpeg");
      assert.ok(typeof start?.params["quality"] === "number");
      assert.ok(typeof start?.params["maxWidth"] === "number");
      assert.ok(typeof start?.params["maxHeight"] === "number");
      // 面が閉じたら流させ続けない
      await viewer.close();
      await cdp.waitFor("Page.stopScreencast");
    } finally {
      await viewer.close();
    }
  });

  it("screencastFrame が面へ届き、screencastFrameAck が CDP へ返る", async () => {
    await callTool(module, "browser.start");
    const viewer = await connectViewer(host.port);
    try {
      await cdp.waitFor("Page.startScreencast");
      cdp.emit("Page.screencastFrame", {
        data: "ZmFrZS1qcGVn",
        metadata: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 },
        sessionId: 7,
      });

      const frame = await viewer.waitFor("frame");
      assert.equal(frame["data"], "ZmFrZS1qcGVn");
      assert.deepEqual(frame["metadata"], {
        deviceWidth: 1280,
        deviceHeight: 800,
        offsetTop: 0,
        pageScaleFactor: 1,
      });

      // ack を返さないと次のフレームが来ない。**必ず返る**ことを固定する
      const [ack] = await cdp.waitFor("Page.screencastFrameAck");
      assert.equal(ack?.params["sessionId"], 7);
    } finally {
      await viewer.close();
    }
  });

  it("起きていない面は理由を返して閉じる（黙って開いたままにしない）", async () => {
    const viewer = await connectViewer(host.port);
    try {
      const error = await viewer.waitFor("error");
      assert.match(String(error["message"]), /起きていません/);
    } finally {
      await viewer.close();
    }
  });
});

// ── [a4] 面からの操作 ────────────────────────────────────────────────────────

describe("[task-0156] 面からの操作が CDP のコマンドへ写る", () => {
  let cdp: FakeCdp;
  let host: { port: number; close(): Promise<void> };
  let module: BantoModule;
  let viewer: FakeViewer;

  beforeEach(async () => {
    cdp = await startFakeCdp();
    module = createBrowserModule({ launcher: fakeLauncher(cdp.url).launcher });
    host = await startViewerHost(module);
    await callTool(module, "browser.start");
    viewer = await connectViewer(host.port);
    await cdp.waitFor("Page.startScreencast");
    // 座標変換に使う metadata は、直前のフレームのもの
    cdp.emit("Page.screencastFrame", {
      data: "ZmFrZQ==",
      metadata: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 },
      sessionId: 1,
    });
    await viewer.waitFor("frame");
  });
  afterEach(async () => {
    await viewer.close();
    await callTool(module, "browser.stop");
    await host.close();
    await cdp.close();
  });

  it("クリックは mouseMoved → mousePressed → mouseReleased になる", async () => {
    viewer.socket.send(
      JSON.stringify({ type: "click", x: 320, y: 200, view: { width: 640, height: 400 } })
    );
    const events = await cdp.waitFor("Input.dispatchMouseEvent", 3);
    assert.deepEqual(
      events.map((e) => e.params["type"]),
      ["mouseMoved", "mousePressed", "mouseReleased"]
    );
    // 面 640x400 に 1280x800 のフレーム＝倍率 2
    assert.equal(events[1]?.params["x"], 640);
    assert.equal(events[1]?.params["y"], 400);
    assert.equal(events[1]?.params["button"], "left");
    assert.equal(events[1]?.params["clickCount"], 1);
  });

  it("ホイールは mouseWheel になる", async () => {
    viewer.socket.send(
      JSON.stringify({
        type: "wheel",
        x: 100,
        y: 50,
        deltaX: 0,
        deltaY: 120,
        view: { width: 640, height: 400 },
      })
    );
    const [wheel] = await cdp.waitFor("Input.dispatchMouseEvent");
    assert.equal(wheel?.params["type"], "mouseWheel");
    assert.equal(wheel?.params["deltaY"], 120);
    assert.equal(wheel?.params["x"], 200);
    assert.equal(wheel?.params["y"], 100);
  });

  it("日本語の文字入力は Input.insertText になる（IME は要らない）", async () => {
    viewer.socket.send(JSON.stringify({ type: "text", text: "こんにちは、番頭さん" }));
    const [insert] = await cdp.waitFor("Input.insertText");
    assert.equal(insert?.params["text"], "こんにちは、番頭さん");
  });

  it("特殊キーは Input.dispatchKeyEvent（down → up）になる", async () => {
    viewer.socket.send(JSON.stringify({ type: "key", key: "Enter", code: "Enter", text: "\r" }));
    const events = await cdp.waitFor("Input.dispatchKeyEvent", 2);
    assert.deepEqual(
      events.map((e) => e.params["type"]),
      ["keyDown", "keyUp"]
    );
    assert.equal(events[0]?.params["key"], "Enter");
  });

  it("知らない操作は黙って捨てず、理由を面へ返す", async () => {
    viewer.socket.send(JSON.stringify({ type: "teleport" }));
    const error = await viewer.waitFor("error");
    assert.match(String(error["message"]), /知らない操作/);
  });
});

// ── [a4] 座標変換の純関数 ────────────────────────────────────────────────────

describe("[task-0156] 面の座標をページの実座標へ直す", () => {
  it("面の表示サイズとフレームの実寸が違うとき、比で伸ばす", () => {
    const metadata = { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1 };
    assert.deepEqual(toPageCoordinates({ x: 0, y: 0 }, { width: 640, height: 400 }, metadata), {
      x: 0,
      y: 0,
    });
    assert.deepEqual(toPageCoordinates({ x: 320, y: 200 }, { width: 640, height: 400 }, metadata), {
      x: 640,
      y: 400,
    });
    assert.deepEqual(toPageCoordinates({ x: 640, y: 400 }, { width: 640, height: 400 }, metadata), {
      x: 1280,
      y: 800,
    });
  });

  it("幅と高さで倍率が違っても、それぞれの比で直す", () => {
    const point = toPageCoordinates(
      { x: 100, y: 100 },
      { width: 500, height: 200 },
      { deviceWidth: 1000, deviceHeight: 1000 }
    );
    assert.deepEqual(point, { x: 200, y: 500 });
  });

  it("offsetTop を引き、pageScaleFactor で割る", () => {
    const point = toPageCoordinates(
      { x: 100, y: 100 },
      { width: 1000, height: 1000 },
      { deviceWidth: 1000, deviceHeight: 1000, offsetTop: 20, pageScaleFactor: 2 }
    );
    assert.deepEqual(point, { x: 50, y: 40 });
  });

  it("実寸も表示サイズも欠けているときは倍率 1 として扱う（NaN を作らない）", () => {
    const point = toPageCoordinates({ x: 12, y: 34 }, { width: 0, height: 0 }, {});
    assert.deepEqual(point, { x: 12, y: 34 });
  });

  it("写した先の座標は、面から来た倍率のまま CDP のコマンドに載る", () => {
    const calls = toCdpCalls(
      { type: "click", x: 50, y: 25, view: { width: 100, height: 50 } },
      { deviceWidth: 400, deviceHeight: 200 }
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]
    );
    assert.equal(calls[1]?.params["x"], 200);
    assert.equal(calls[1]?.params["y"], 100);
  });
});

// ── [a5] 面の実装が UI 側の解決表に載っている ────────────────────────────────

describe("[task-0156] browser.viewer が UI 側で解決できる", () => {
  it("registry.tsx が BrowserViewer を import して解決表に載せている", () => {
    const viewsDir = new URL("../../packages/banto-web/src/views/", import.meta.url).pathname;
    const source = fs.readFileSync(path.join(viewsDir, "registry.tsx"), "utf-8");

    const view = createBrowserModule().views.find((v) => v.kind === "browser.viewer");
    assert.ok(view, "browser.viewer の canvas view が無い");
    assert.equal(view.component, "BrowserViewer");

    assert.match(source, /import \{ BrowserViewer \} from "\.\/BrowserViewer\.js";/);
    // 表は `const REGISTRY = { ... }` の形。名前が現れていれば解決できる
    assert.match(source, new RegExp(`\\b${view.component}\\b`));

    // 解決先の実装が実在し、その名前で export されている
    const file = path.join(viewsDir, `${view.component}.tsx`);
    assert.ok(fs.existsSync(file), `${file} が無い`);
    assert.match(fs.readFileSync(file, "utf-8"), new RegExp(`export function ${view.component}\\b`));
  });
});
