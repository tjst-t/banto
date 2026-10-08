// 画面と Module の間の流れの中継（アーキ仕様 §5.8）。本物の待ち受け（`@banto/stream-server`）に、本物の WebSocket で繋ぐ。
// 見るもの：札（1回だけ・期限・Origin・最初の1通）・中身をそのまま渡す（文字と2進・閉じる番号）・1通の上限（1009）・
// Module が落ちたら 1012・iframe ごとの上限・長いパスの置き場
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { listenStreams, streamSocketPathOf, type StreamServer } from "@banto/stream-server";
import { viaDirectoryFd } from "@banto/module-contract";
import { StreamRelay, STREAMS_PER_FRAME, STREAMS_PER_PROJECT, StreamRefusal, streamUrlOf, type StreamTarget } from "./streams.js";

const SANDBOX = "http://127.0.0.1:4176";

interface Harness {
  relay: StreamRelay;
  url: string;
  module: StreamServer;
  dataDir: string;
  audit: Array<Record<string, unknown>>;
  /** Module の側で流れが閉じた番号 */
  moduleCloses: number[];
  clock: { now: number };
  target(overrides?: Partial<StreamTarget>): StreamTarget;
}

async function withRelay(
  fn: (h: Harness) => Promise<void>,
  opts: { dataDir?: string; timing?: ConstructorParameters<typeof StreamRelay>[0]["timing"] } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "banto-streams-"));
  const dataDir = opts.dataDir ?? join(root, "m");
  mkdirSync(dataDir, { recursive: true });
  const moduleCloses: number[] = [];
  const module = await listenStreams(
    {
      echo(ws, stamp) {
        ws.send(JSON.stringify({ hello: stamp }));
        ws.on("close", (code) => moduleCloses.push(code));
        ws.on("message", (data, isBinary) => {
          if (!isBinary && data.toString() === "gone") return ws.close(4404, "もう無い");
          if (!isBinary && data.toString() === "crash") return ws.terminate();
          if (!isBinary && data.toString() === "huge") return ws.send(Buffer.alloc(1024 * 1024 + 1));
          ws.send(data, { binary: isBinary });
        });
      },
    },
    { dataDir },
  );
  const audit: Array<Record<string, unknown>> = [];
  const clock = { now: Date.now() };
  const server: Server = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const relay = new StreamRelay({
    url: streamUrlOf(base),
    allowedOrigin: SANDBOX,
    audit: (e) => audit.push(e),
    now: () => clock.now,
    ...(opts.timing ? { timing: opts.timing } : {}),
  });
  server.on("upgrade", (req, socket, head) => {
    if (!relay.handleUpgrade(req, socket, head)) socket.destroy();
  });
  try {
    await fn({
      relay,
      url: relay.url,
      module,
      dataDir,
      audit,
      moduleCloses,
      clock,
      target: (overrides = {}) => ({
        server: "echo-module",
        connName: "echo-module-p1",
        socketPath: streamSocketPathOf(dataDir),
        frameKey: "session:frame-1",
        stamp: { name: "echo", params: { cols: 80 }, projectId: "p1", resourceUri: "ui://echo/main", human: true },
        ...overrides,
      }),
    });
  } finally {
    relay.closeAll();
    await module.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

/** 繋いで札を送る。届いたものと閉じた番号を集める */
function connect(url: string, ticket: string | undefined, origin = SANDBOX) {
  const ws = new WebSocket(url, { origin });
  const got: Array<{ data: Buffer; isBinary: boolean }> = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data: Buffer, isBinary) => {
    got.push({ data, isBinary });
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const rejected = new Promise<number>((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
  ws.on("error", () => undefined);
  const opened = new Promise<void>((resolve) => ws.on("open", () => resolve()));
  if (ticket !== undefined) void opened.then(() => ws.send(JSON.stringify({ ticket })));
  const next = async (n: number) => {
    while (got.length < n) await new Promise<void>((r) => waiters.push(r));
    return got[n - 1]!;
  };
  return { ws, got, next, closed, rejected, opened };
}

test("札で繋ぎ、文字と2進をそのまま往復させる。刻印は host が組んだもの", async () => {
  await withRelay(async (h) => {
    const grant = h.relay.issue(h.target());
    assert.equal(grant.url, h.url);
    assert.match(grant.ticket, /^[A-Za-z0-9_-]{43}$/); // 32 バイト
    const c = connect(h.url, grant.ticket);
    const hello = JSON.parse((await c.next(1)).data.toString()) as { hello: unknown };
    assert.deepEqual(hello.hello, { name: "echo", params: { cols: 80 }, projectId: "p1", resourceUri: "ui://echo/main", human: true });
    c.ws.send("こんにちは");
    const text = await c.next(2);
    assert.equal(text.isBinary, false);
    assert.equal(text.data.toString(), "こんにちは");
    // 1 MiB ちょうどは通る（上限は「越えたら」）
    const big = Buffer.alloc(1024 * 1024, 7);
    big[0] = 1;
    big[big.length - 1] = 2;
    c.ws.send(big);
    const back = await c.next(3);
    assert.equal(back.isBinary, true);
    assert.equal(createHash("sha256").update(back.data).digest("hex"), createHash("sha256").update(big).digest("hex"));
    assert.equal(h.relay.openCount, 1);
    c.ws.close(1000);
    await c.closed;
    await waitFor(() => h.relay.openCount === 0);
    const events = h.audit.map((e) => e.event);
    assert.deepEqual(events, ["stream.open", "stream.close"]);
    // 中身は残さない（開閉だけ）
    assert.ok(!JSON.stringify(h.audit).includes("こんにちは"));
  });
});

test("札は1回だけ・期限で切れる・最初の1通で来なければ閉じる・Origin が違えば断る", async () => {
  await withRelay(
    async (h) => {
      const grant = h.relay.issue(h.target());
      const first = connect(h.url, grant.ticket);
      await first.next(1);
      first.ws.close();
      await first.closed;
      const reused = connect(h.url, grant.ticket);
      assert.equal((await reused.closed).code, 1008);

      const late = h.relay.issue(h.target());
      h.clock.now += 30_001;
      assert.equal((await connect(h.url, late.ticket).closed).code, 1008);

      const silent = connect(h.url, undefined);
      assert.equal((await silent.closed).code, 1008);

      const fresh = h.relay.issue(h.target());
      const wrongOrigin = connect(h.url, fresh.ticket, "http://localhost:4175");
      assert.equal(await wrongOrigin.rejected, 403);
      // 断った札は使われていないので、正しい Origin からはまだ使える
      const ok = connect(h.url, fresh.ticket);
      await ok.next(1);
      ok.ws.close();
      await ok.closed;
    },
    { timing: { firstMessageMs: 200 } },
  );
});

test("1MiB を越えた1通は 1009 で閉じる。Module の番号（4404）は渡し、落ちたら 1012", async () => {
  await withRelay(async (h) => {
    const tooBig = connect(h.url, h.relay.issue(h.target()).ticket);
    await tooBig.next(1);
    tooBig.ws.send(Buffer.alloc(1024 * 1024 + 1));
    assert.equal((await tooBig.closed).code, 1009);
    await waitFor(() => h.moduleCloses.length === 1);
    assert.deepEqual(h.moduleCloses, [1009], "Module に 1009 が渡っていない");

    // 逆向き（Module → 画面）も 1009。「Module が止まりました」（1012）にしない。記録にも 1009 を残す
    const tooBigBack = connect(h.url, h.relay.issue(h.target()).ticket);
    await tooBigBack.next(1);
    tooBigBack.ws.send("huge");
    const back = await tooBigBack.closed;
    assert.equal(back.code, 1009);
    assert.doesNotMatch(back.reason, /止まりました/);
    assert.equal(tooBigBack.got.length, 1, "1 MiB を越えた1通が画面に渡った");
    await waitFor(() => h.audit.filter((e) => e.event === "stream.close").length === 2);
    assert.deepEqual(
      h.audit.filter((e) => e.event === "stream.close").map((e) => e.code),
      [1009, 1009],
    );

    const gone = connect(h.url, h.relay.issue(h.target()).ticket);
    await gone.next(1);
    gone.ws.send("gone");
    assert.equal((await gone.closed).code, 4404);

    const crash = connect(h.url, h.relay.issue(h.target()).ticket);
    await crash.next(1);
    crash.ws.send("crash");
    assert.equal((await crash.closed).code, 1012);
  });
});

test("Module の待ち受けが無ければ 1012（画面は札を取り直す）", async () => {
  await withRelay(async (h) => {
    await h.module.close();
    const c = connect(h.url, h.relay.issue(h.target()).ticket);
    assert.equal((await c.closed).code, 1012);
    assert.ok(h.audit.some((e) => e.event === "stream.refused"));
  });
});

test("Module へ繋いでいる途中で画面が閉じたら、閉じたことだけを記録する（「Module に繋がりません」と書かない）", async () => {
  await withRelay(async (h) => {
    // 繋がりは受けるが、Upgrade に答えない待ち受け——host の側は繋いでいる途中のまま
    const dir = join(h.dataDir, "hang");
    mkdirSync(dir, { recursive: true });
    const socketPath = join(dir, "stream.sock");
    const held: Socket[] = [];
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const hang = createNetServer((sock) => {
      held.push(sock);
      sock.once("data", () => arrived());
    });
    await viaDirectoryFd(socketPath, (p) => new Promise<void>((resolve) => hang.listen(p, resolve)));
    try {
      // 画面の回線が切れる（繋いでいる途中は画面から読むのを止めているので、気づけるのは RST で切れたとき）
      const c = connect(h.url, h.relay.issue(h.target({ socketPath })).ticket);
      await reached;
      (c.ws as unknown as { _socket: Socket })._socket.resetAndDestroy(); // ws の型に下の口が無い（試験で RST を起こすため）
      await waitFor(() => h.audit.some((e) => e.event === "stream.close"));
      // terminate が出す error が後から届く分を待つ
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(
        h.audit.map((e) => [e.event, e.closedBy]),
        [["stream.close", "screen"]],
      );
      assert.equal(h.relay.openCount, 0);

      // banto が止まる（closeAll）ときも同じ：途中で切ったのは banto で、Module の失敗ではない
      h.audit.length = 0;
      const d = connect(h.url, h.relay.issue(h.target({ socketPath })).ticket);
      await waitFor(() => held.length === 2);
      await new Promise((r) => setTimeout(r, 50));
      h.relay.closeAll();
      assert.equal((await d.closed).code, 1012);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(
        h.audit.map((e) => [e.event, e.closedBy, e.code]),
        [["stream.close", "banto", 1012]],
      );
    } finally {
      for (const s of held) s.destroy();
      await new Promise<void>((resolve) => hang.close(() => resolve()));
    }
  });
});

test("1つの画面（iframe）で 8 本まで。別の iframe は別に数える", async () => {
  await withRelay(async (h) => {
    for (let i = 0; i < STREAMS_PER_FRAME; i++) h.relay.issue(h.target());
    assert.throws(() => h.relay.issue(h.target()), (err: unknown) => err instanceof StreamRefusal && err.status === 429);
    h.relay.issue(h.target({ frameKey: "session:frame-2" }));
    // 札が切れたら数えない
    h.clock.now += 30_001;
    h.relay.issue(h.target());
  });
});

test("1つの Project で 64 本まで（iframe をまたいで数える）。別の Project・Project の無い画面は別", async () => {
  await withRelay(async (h) => {
    const p1 = (i: number) => h.target({ frameKey: `session:frame-${Math.floor(i / STREAMS_PER_FRAME)}` });
    for (let i = 0; i < STREAMS_PER_PROJECT; i++) h.relay.issue(p1(i));
    assert.throws(
      () => h.relay.issue(h.target({ frameKey: "session:frame-new" })),
      (err: unknown) => err instanceof StreamRefusal && err.status === 429,
    );
    const p2 = h.target({ frameKey: "session:frame-p2" });
    h.relay.issue({ ...p2, stamp: { ...p2.stamp, projectId: "p2" } });
    const instance = h.target({ frameKey: "session:frame-instance" });
    const { projectId: _projectId, ...stamp } = instance.stamp;
    h.relay.issue({ ...instance, stamp });
  });
});

test("置き場のパスが 107 バイトを越えても、フォルダの番号を通して立てて繋げる", async () => {
  const root = mkdtempSync(join(tmpdir(), "banto-streams-long-"));
  const long = join(root, "x".repeat(120));
  assert.ok(Buffer.byteLength(streamSocketPathOf(long)) > 107);
  try {
    await withRelay(
      async (h) => {
        const c = connect(h.url, h.relay.issue(h.target()).ticket);
        await c.next(1);
        c.ws.send("長い道");
        assert.equal((await c.next(2)).data.toString(), "長い道");
        c.ws.close();
        await c.closed;
      },
      { dataDir: long },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("止めるときは開いている流れを 1012 で閉じ、それからは札を出さない", async () => {
  await withRelay(async (h) => {
    const c = connect(h.url, h.relay.issue(h.target()).ticket);
    await c.next(1);
    h.relay.closeAll();
    assert.equal((await c.closed).code, 1012);
    assert.throws(() => h.relay.issue(h.target()), (err: unknown) => err instanceof StreamRefusal && err.status === 503);
  });
});

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "待っても条件が成り立たない");
}
