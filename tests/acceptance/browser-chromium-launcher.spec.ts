/**
 * task-0178: 共有ブラウザ——本物の chromium を起こすアダプタ（K2）。
 *
 * **本物の chromium はここでは起こさない。** 検証の器（`docker/Dockerfile.test`）は
 * node:24-alpine で chromium が入っていない（2026-08-15 の判定 §5-0）。そこで:
 *
 *   - 探索・起動引数・DevToolsActivePort 解析は**純関数**として直接試験する
 *   - page ターゲットの発見は**偽の HTTP エンドポイント**（`node:http`）に対して試験する
 *   - プロセスの寿命・後始末は `process.execPath` で走らせる**偽のプロセス**
 *     （chromium のふりをする小さな node スクリプト）に対して試験する
 *
 * 本物の chromium で実際に動くことは、番頭が面で確認する（review: banto）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";

import {
  createBrowserModule,
  createBrowserSession,
  createChromiumLauncher,
  createUnimplementedLauncher,
  findChromiumExecutable,
  buildChromiumArgs,
  parseDevToolsActivePort,
  discoverPageWebSocketUrl,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  type BrowserLauncher,
  type BrowserStatus,
  type CdpConnection,
} from "../../packages/banto-host/src/browser/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROMIUM_LAUNCHER_SOURCE_PATH = path.join(
  HERE,
  "../../packages/banto-host/src/browser/chromium-launcher.ts"
);

// ── 小道具 ────────────────────────────────────────────────────────────────

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * `kill(pid, 0)` は zombie（死んでいるが親が `wait()` していない）にも成功する——
 * カーネルの pid スロットがまだ残っているため。init の居ない検証コンテナでは、
 * close() が正しく殺した孤児（グループ経由で殺されるので親と同時に死ぬ）が誰にも
 * reap されず zombie のまま残り続け、「殺せていない」と誤読させる（実機で確認済み：
 * `/proc/<pid>/status` が `State: Z (zombie)` でも `kill(pid,0)` は成功する）。
 * `/proc` が読めれば zombie を「生きていない」として扱う。読めない（非Linux／既に
 * 消えている）ときは `kill(pid,0)` の判定に落ちる——D6：既存の `process-driver.ts`
 * の `isOurs()` と同じ姿勢。
 */
function isAlive(pid: number): boolean {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const state = /^State:\s+(\S)/m.exec(status)?.[1];
    if (state === "Z") return false;
  } catch {
    // /proc/<pid>/status が読めない。以下の kill(pid, 0) 判定に任せる
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("期限内に条件が満たされませんでした");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startFakeDevToolsHttp(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── 1. 実行ファイルの探索 ─────────────────────────────────────────────────

describe("findChromiumExecutable", () => {
  it("BANTO_BROWSER_EXECUTABLE があれば最優先で使う", () => {
    const tmp = makeTmpDir("banto-chromium-env-");
    try {
      const bin = path.join(tmp, "my-chrome");
      fs.writeFileSync(bin, "#!/bin/sh\n");
      const result = findChromiumExecutable({ executableEnv: bin });
      assert.deepEqual(result, { path: bin, source: "env" });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("BANTO_BROWSER_EXECUTABLE が指すパスが無ければ、他へは落ちずに失敗する", () => {
    assert.throws(
      () => findChromiumExecutable({ executableEnv: "/no/such/chrome" }),
      /BANTO_BROWSER_EXECUTABLE.*\/no\/such\/chrome/
    );
  });

  it("playwright キャッシュから revision が数値として最大のものを選ぶ（文字列比較ではない）", () => {
    const home = makeTmpDir("banto-chromium-home-");
    try {
      for (const rev of ["chromium-999", "chromium-1200"]) {
        const dir = path.join(home, ".cache", "ms-playwright", rev, "chrome-linux64");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "chrome"), "#!/bin/sh\n");
      }
      const result = findChromiumExecutable({ executableEnv: undefined, homeDir: home });
      assert.equal(result.source, "playwright-cache");
      assert.ok(
        result.path.includes(`${path.sep}chromium-1200${path.sep}`),
        `文字列比較なら 999 が選ばれてしまう。実際: ${result.path}`
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("chrome-linux64 と chrome-linux の両方を探す", () => {
    const home = makeTmpDir("banto-chromium-home-");
    try {
      const dir = path.join(home, ".cache", "ms-playwright", "chromium-500", "chrome-linux");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "chrome"), "#!/bin/sh\n");
      const result = findChromiumExecutable({ executableEnv: undefined, homeDir: home });
      assert.equal(result.source, "playwright-cache");
      assert.ok(result.path.endsWith(path.join("chrome-linux", "chrome")));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("chromium_headless_shell-* は選ばない", () => {
    const home = makeTmpDir("banto-chromium-home-");
    try {
      const dir = path.join(
        home,
        ".cache",
        "ms-playwright",
        "chromium_headless_shell-9999",
        "chrome-linux64"
      );
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "chrome"), "#!/bin/sh\n");
      assert.throws(
        () => findChromiumExecutable({ executableEnv: undefined, homeDir: home, pathEnv: "" }),
        /見つかりません/
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("PATH 上の chromium / chromium-browser / google-chrome を探す", () => {
    const home = makeTmpDir("banto-chromium-home-"); // .cache が無い＝②は空振り
    const bin = makeTmpDir("banto-chromium-path-");
    try {
      fs.writeFileSync(path.join(bin, "chromium-browser"), "#!/bin/sh\n");
      const result = findChromiumExecutable({ executableEnv: undefined, homeDir: home, pathEnv: bin });
      assert.deepEqual(result, { path: path.join(bin, "chromium-browser"), source: "path" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("どれも見つからなければ、探した場所を全部並べて失敗する", () => {
    const home = makeTmpDir("banto-chromium-home-");
    const bin = makeTmpDir("banto-chromium-path-");
    try {
      // revision はあるが中身（chrome-linux64 / chrome-linux）が無い——探しには行くが見つからない
      fs.mkdirSync(path.join(home, ".cache", "ms-playwright", "chromium-100"), { recursive: true });
      assert.throws(
        () => findChromiumExecutable({ executableEnv: undefined, homeDir: home, pathEnv: bin }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /見つかりません/);
          assert.match(err.message, /chromium-100/);
          assert.match(err.message, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          return true;
        }
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("playwright を import していない（ソースの検査）", () => {
    const source = fs.readFileSync(CHROMIUM_LAUNCHER_SOURCE_PATH, "utf8");
    assert.ok(!/from\s+["']playwright["']/.test(source), "playwright を import している");
    assert.ok(!/require\(\s*["']playwright["']\s*\)/.test(source), "playwright を require している");
  });
});

// ── 2. 起動引数の組み立て ─────────────────────────────────────────────────

describe("buildChromiumArgs", () => {
  it("既定の幅・高さと必須の引数を含む", () => {
    const args = buildChromiumArgs({ userDataDir: "/tmp/banto-x" });
    assert.ok(args.includes("--remote-debugging-port=0"));
    assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
    assert.ok(args.includes("--user-data-dir=/tmp/banto-x"));
    assert.ok(args.includes("--no-first-run"));
    assert.ok(args.includes("--no-default-browser-check"));
    assert.ok(args.includes(`--window-size=${DEFAULT_WINDOW_WIDTH},${DEFAULT_WINDOW_HEIGHT}`));
  });

  it("width/height を指定できる", () => {
    const args = buildChromiumArgs({ userDataDir: "/tmp/banto-x", width: 640, height: 480 });
    assert.ok(args.includes("--window-size=640,480"));
  });

  it("DISPLAY があれば headless を付けない（headful）", () => {
    const args = buildChromiumArgs({ userDataDir: "/tmp/banto-x", display: ":0" });
    assert.ok(!args.includes("--headless=new"));
  });

  it("DISPLAY が無ければ --headless=new を付ける", () => {
    const args = buildChromiumArgs({ userDataDir: "/tmp/banto-x", display: undefined });
    assert.ok(args.includes("--headless=new"));
  });

  it("最初に開く URL は最後の位置引数。無ければ about:blank", () => {
    assert.equal(buildChromiumArgs({ userDataDir: "/tmp/banto-x" }).at(-1), "about:blank");
    assert.equal(
      buildChromiumArgs({ userDataDir: "/tmp/banto-x", url: "https://example.com/" }).at(-1),
      "https://example.com/"
    );
  });
});

// ── 3. DevToolsActivePort の解析 ─────────────────────────────────────────

describe("parseDevToolsActivePort", () => {
  it("正常な2行を読める", () => {
    assert.deepEqual(parseDevToolsActivePort("12345\n/devtools/browser/abc-123\n"), {
      ready: true,
      port: 12345,
      browserPath: "/devtools/browser/abc-123",
    });
  });

  it("1行しか書かれていない途中の状態は ready:false（例外にしない）", () => {
    assert.deepEqual(parseDevToolsActivePort("12345"), { ready: false });
    assert.deepEqual(parseDevToolsActivePort("12345\n"), { ready: false });
  });

  it("空ファイルは ready:false（例外にしない）", () => {
    assert.deepEqual(parseDevToolsActivePort(""), { ready: false });
  });

  it("ポートが数値でなければ ready:false", () => {
    assert.deepEqual(parseDevToolsActivePort("not-a-port\n/devtools/browser/x\n"), {
      ready: false,
    });
  });
});

// ── 4. page ターゲットの発見（偽の HTTP エンドポイント） ────────────────────

describe("discoverPageWebSocketUrl", () => {
  it("page ターゲットが既にあれば、それを返し /json/new は叩かない", async () => {
    let newCalled = false;
    const fake = await startFakeDevToolsHttp((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/json/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/EXIST" }]));
        return;
      }
      if (url.pathname === "/json/new") newCalled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    try {
      const wsUrl = await discoverPageWebSocketUrl(fake.baseUrl);
      assert.equal(wsUrl, "ws://127.0.0.1:1/devtools/page/EXIST");
      assert.equal(newCalled, false);
    } finally {
      await fake.close();
    }
  });

  it("page ターゲットが無ければ /json/new (GET) で作る", async () => {
    let newMethod: string | undefined;
    const fake = await startFakeDevToolsHttp((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/json/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      if (url.pathname === "/json/new") {
        newMethod = req.method;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/NEW" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const wsUrl = await discoverPageWebSocketUrl(fake.baseUrl, "https://example.com/");
      assert.equal(wsUrl, "ws://127.0.0.1:1/devtools/page/NEW");
      assert.equal(newMethod, "GET");
    } finally {
      await fake.close();
    }
  });

  it("GET /json/new が405なら PUT で叩き直す", async () => {
    const methodsTried: string[] = [];
    const fake = await startFakeDevToolsHttp((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/json/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      if (url.pathname === "/json/new") {
        methodsTried.push(req.method ?? "");
        if (req.method === "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/PUT" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const wsUrl = await discoverPageWebSocketUrl(fake.baseUrl);
      assert.equal(wsUrl, "ws://127.0.0.1:1/devtools/page/PUT");
      assert.deepEqual(methodsTried, ["GET", "PUT"]);
    } finally {
      await fake.close();
    }
  });

  it("page ターゲットを取得も作成もできなければ失敗する", async () => {
    const fake = await startFakeDevToolsHttp((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/json/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({})); // webSocketDebuggerUrl が無い
    });
    try {
      await assert.rejects(discoverPageWebSocketUrl(fake.baseUrl), /page ターゲット/);
    } finally {
      await fake.close();
    }
  });
});

// ── 5. 寿命と後始末（偽のプロセス） ──────────────────────────────────────

const FAKE_CHROMIUM_SCRIPT = `
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const userDataDir = process.argv[2];
const mode = process.argv[3] || "normal";

if (mode === "hang") {
  // DevToolsActivePort をわざと書かない（ハンドシェイクのタイムアウト試験用）
  setInterval(() => {}, 1000);
} else {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/json/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:" + server.address().port + "/devtools/page/FAKE" },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    fs.writeFileSync(path.join(userDataDir, "DevToolsActivePort"), port + "\\n/devtools/browser/fake-id\\n");
    // chromium はレンダラ等の子を生やす——それを模した子を1つ生やして眠らせる
    const child = spawn(process.execPath, ["-e", "setInterval(function(){},1000)"], { stdio: "ignore" });
    fs.writeFileSync(path.join(userDataDir, "child.pid"), String(child.pid));
  });
}
`;

describe("createChromiumLauncher: 寿命と後始末（偽のプロセス）", () => {
  let scriptDir: string;
  let scriptPath: string;

  before(() => {
    scriptDir = makeTmpDir("banto-fake-chromium-");
    scriptPath = path.join(scriptDir, "fake-chromium.cjs");
    fs.writeFileSync(scriptPath, FAKE_CHROMIUM_SCRIPT);
  });

  after(() => {
    fs.rmSync(scriptDir, { recursive: true, force: true });
  });

  function spawnFake(
    mode: "normal" | "hang"
  ): {
    spawn: (ctx: { executablePath: string; args: string[]; userDataDir: string }) => childProcess.ChildProcess;
    userDataDir(): string | undefined;
    mainPid(): number | undefined;
  } {
    let userDataDir: string | undefined;
    let mainPid: number | undefined;
    return {
      spawn(ctx) {
        userDataDir = ctx.userDataDir;
        // detached: true が要る——プロセスグループ kill の試験がこれに依存する
        // （本番の既定挙動と同じにしておかないと、close() が偽プロセスの木を落とせない）
        const child = childProcess.spawn(process.execPath, [scriptPath, ctx.userDataDir, mode], {
          detached: true,
          stdio: "ignore",
        });
        mainPid = child.pid;
        return child;
      },
      userDataDir: () => userDataDir,
      mainPid: () => mainPid,
    };
  }

  it("起動して page ターゲットの webSocketDebuggerUrl が返る", async () => {
    const fake = spawnFake("normal");
    const launcher = createChromiumLauncher({ executablePath: process.execPath, spawn: fake.spawn });
    const browser = await launcher.launch({});
    try {
      assert.ok(
        browser.webSocketDebuggerUrl.includes("/devtools/page/"),
        `page ターゲットではない: ${browser.webSocketDebuggerUrl}`
      );
    } finally {
      await browser.close();
    }
  });

  it("close() でプロセスグループごと落ち、生やした子プロセスも残らない", async () => {
    const fake = spawnFake("normal");
    const launcher = createChromiumLauncher({
      executablePath: process.execPath,
      spawn: fake.spawn,
      closeGraceMs: 300,
    });
    const browser = await launcher.launch({});
    const userDataDir = fake.userDataDir();
    const mainPid = fake.mainPid();
    assert.ok(userDataDir && mainPid, "偽プロセスの pid / user-data-dir が取れていません");
    await waitUntil(() => fs.existsSync(path.join(userDataDir!, "child.pid")));
    const childPid = Number(fs.readFileSync(path.join(userDataDir!, "child.pid"), "utf8"));
    assert.ok(isAlive(mainPid!), "起動直後は生きているはず");
    assert.ok(isAlive(childPid), "起動直後は子プロセスも生きているはず");

    await browser.close();

    await waitUntil(() => !isAlive(mainPid!));
    await waitUntil(() => !isAlive(childPid));
  });

  it("close() は冪等（2回呼んでも成功する）", async () => {
    const fake = spawnFake("normal");
    const launcher = createChromiumLauncher({ executablePath: process.execPath, spawn: fake.spawn });
    const browser = await launcher.launch({});
    await browser.close();
    await browser.close(); // 例外にならなければ良い
  });

  it("一時 user-data-dir は close() で消える", async () => {
    const fake = spawnFake("normal");
    const launcher = createChromiumLauncher({ executablePath: process.execPath, spawn: fake.spawn });
    const browser = await launcher.launch({});
    const userDataDir = fake.userDataDir();
    assert.ok(userDataDir && fs.existsSync(userDataDir));
    await browser.close();
    assert.equal(fs.existsSync(userDataDir!), false);
  });

  it("期限内に CDP の口を掴めなかったとき、起こしたプロセスを落としてから失敗する", async () => {
    const fake = spawnFake("hang");
    const launcher = createChromiumLauncher({
      executablePath: process.execPath,
      spawn: fake.spawn,
      handshakeTimeoutMs: 200,
      closeGraceMs: 300,
    });

    await assert.rejects(launcher.launch({}), /DevToolsActivePort/);

    const mainPid = fake.mainPid();
    const userDataDir = fake.userDataDir();
    assert.ok(mainPid && userDataDir, "偽プロセスの pid / user-data-dir が取れていません");
    await waitUntil(() => !isAlive(mainPid!));
    assert.equal(fs.existsSync(userDataDir!), false);
  });
});

// ── 6. createBrowserModule の既定 launcher ───────────────────────────────

describe("createBrowserModule: 既定の launcher", () => {
  it("launcher を渡さなければ既定が chromium になる（ブラウザは起こさない）", async () => {
    const module = createBrowserModule();
    const tool = module.tools.find((t) => t.name === "browser.status");
    assert.ok(tool);
    const result = await tool.execute({});
    const details = result.details as BrowserStatus;
    assert.equal(details.launcher, "chromium");
    assert.equal(details.state, "stopped");
  });

  it("createUnimplementedLauncher は消されずに残っている", async () => {
    const launcher = createUnimplementedLauncher();
    assert.equal(launcher.name, "unimplemented");
    await assert.rejects(launcher.launch({}));
  });
});

// ── 7. アイドル TTL（偽の時計・偽のタイマー） ────────────────────────────

function fakeIdleTimer(): {
  scheduleIdleTimer: (callback: () => void, ms: number) => unknown;
  cancelIdleTimer: (handle: unknown) => void;
  isScheduled(): boolean;
  scheduledMs(): number | undefined;
  fire(): void;
} {
  let seq = 0;
  let current: { id: number; callback: () => void; ms: number } | undefined;
  return {
    scheduleIdleTimer(callback, ms) {
      seq += 1;
      current = { id: seq, callback, ms };
      return current.id;
    },
    cancelIdleTimer(handle) {
      if (current && current.id === handle) current = undefined;
    },
    isScheduled: () => current !== undefined,
    scheduledMs: () => current?.ms,
    fire() {
      if (!current) throw new Error("何も予約されていません");
      const { callback } = current;
      current = undefined;
      callback();
    },
  };
}

function fakeConnection(): CdpConnection {
  let closed = false;
  return {
    async send() {
      return {};
    },
    on() {
      return () => {};
    },
    async close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

function fakeBrowserLauncher(): { launcher: BrowserLauncher; closedCount(): number } {
  let closedCount = 0;
  return {
    launcher: {
      name: "fake",
      async launch() {
        return {
          webSocketDebuggerUrl: "ws://fake/devtools/page/x",
          async close() {
            closedCount += 1;
          },
        };
      },
    },
    closedCount: () => closedCount,
  };
}

interface FakeSocket {
  readyState: number;
  handlers: Record<string, Array<() => void>>;
  send(): void;
  close(): void;
  on(event: string, cb: () => void): void;
  triggerClose(): void;
}

function fakeSocket(): FakeSocket {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    readyState: 1,
    handlers,
    send() {
      /* 面への配信は TTL の試験対象ではないので捨てる */
    },
    close() {
      this.readyState = 3;
    },
    on(event, cb) {
      (handlers[event] ??= []).push(cb);
    },
    triggerClose() {
      for (const cb of handlers["close"] ?? []) cb();
    },
  };
}

describe("createBrowserSession: アイドル TTL", () => {
  it("起動直後、面が無ければ既定（または指定）の時間で TTL が予約される", async () => {
    const timer = fakeIdleTimer();
    const { launcher } = fakeBrowserLauncher();
    const session = createBrowserSession({
      launcher,
      connect: async () => fakeConnection(),
      idleTtlMs: 1_234,
      scheduleIdleTimer: timer.scheduleIdleTimer,
      cancelIdleTimer: timer.cancelIdleTimer,
    });

    await session.start({});

    assert.equal(timer.isScheduled(), true);
    assert.equal(timer.scheduledMs(), 1_234);
  });

  it("面が繋がっている間は TTL を予約しない", async () => {
    const timer = fakeIdleTimer();
    const { launcher } = fakeBrowserLauncher();
    const session = createBrowserSession({
      launcher,
      connect: async () => fakeConnection(),
      scheduleIdleTimer: timer.scheduleIdleTimer,
      cancelIdleTimer: timer.cancelIdleTimer,
    });

    await session.start({});
    assert.equal(timer.isScheduled(), true);

    session.attachViewer(fakeSocket() as unknown as WebSocket);
    assert.equal(timer.isScheduled(), false);
  });

  it("最後の面が閉じたら、そこから TTL が再び予約される", async () => {
    const timer = fakeIdleTimer();
    const { launcher } = fakeBrowserLauncher();
    const session = createBrowserSession({
      launcher,
      connect: async () => fakeConnection(),
      scheduleIdleTimer: timer.scheduleIdleTimer,
      cancelIdleTimer: timer.cancelIdleTimer,
    });

    await session.start({});
    const socket = fakeSocket();
    session.attachViewer(socket as unknown as WebSocket);
    assert.equal(timer.isScheduled(), false);

    socket.triggerClose();
    assert.equal(timer.isScheduled(), true);
  });

  it("予約が発火し、面が0のままなら共有ブラウザを自動で落とす", async () => {
    const timer = fakeIdleTimer();
    const { launcher, closedCount } = fakeBrowserLauncher();
    const session = createBrowserSession({
      launcher,
      connect: async () => fakeConnection(),
      idleTtlMs: 999,
      scheduleIdleTimer: timer.scheduleIdleTimer,
      cancelIdleTimer: timer.cancelIdleTimer,
    });

    await session.start({});
    assert.equal(session.status().state, "running");

    timer.fire();
    await waitUntil(() => session.status().state === "stopped");
    assert.equal(closedCount(), 1);
  });
});
