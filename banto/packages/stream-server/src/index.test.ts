// Module の側の流れの待ち受け（アーキ仕様 §5.8「共通の部品」）。host の代わりに、本物の WebSocket で刻印つきで繋ぐ。
// 見るもの：古いソケットを消して立てる・刻印の無い相手は断る・刻印を名前ごとの受け口へ渡す・名乗っていない名前は 4404・
// 同じ名前の2本は別の相手・閉じたらソケットのファイルを消す
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { WebSocket } from "ws";
import { encodeStreamStamp, STREAM_STAMP_HEADER, type StreamStamp } from "@banto/module-contract";
import { listenStreams, streamSocketPathOf } from "./index.js";

const stamp = (name: string): StreamStamp => ({ name, params: { cols: 80 }, projectId: "p1", resourceUri: "ui://echo/main", human: true });

/** host と同じく、フォルダの番号を通して繋ぐ（置き場のパスは 107 バイトを越えることがある——TMPDIR が長いときも） */
function dial(path: string, headers: Record<string, string>) {
  let fd: number | undefined = openSync(dirname(path), "r");
  const release = () => {
    if (fd === undefined) return;
    closeSync(fd);
    fd = undefined;
  };
  const ws = new WebSocket(`ws+unix:///proc/self/fd/${fd}/${basename(path)}:/`, { headers });
  ws.once("upgrade", release);
  ws.once("close", release);
  const got: string[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (data: Buffer) => {
    got.push(data.toString());
    for (const w of waiters.splice(0)) w();
  });
  ws.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  const rejected = new Promise<number>((resolve) =>
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    }),
  );
  const next = async (n: number) => {
    while (got.length < n) await new Promise<void>((r) => waiters.push(r));
    return got[n - 1]!;
  };
  return { ws, next, closed, rejected };
}

async function withDir(fn: (dataDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "banto-stream-server-"));
  try {
    await fn(join(root, "m"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("古いソケットのファイルを消して立て、刻印を名前ごとの受け口へ渡す。同じ名前の2本は別の相手", async () => {
  await withDir(async (dataDir) => {
    const path = streamSocketPathOf(dataDir);
    mkdirSync(join(dataDir, "s"), { recursive: true });
    writeFileSync(path, "前の自分が残したもの");
    const server = await listenStreams(
      {
        echo(ws, s) {
          ws.send(JSON.stringify(s));
          ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
        },
      },
      { dataDir },
    );
    try {
      assert.equal(server.path, path);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(join(dataDir, "s")).mode & 0o777, 0o700);

      const a = dial(path, { [STREAM_STAMP_HEADER]: encodeStreamStamp(stamp("echo")) });
      const b = dial(path, { [STREAM_STAMP_HEADER]: encodeStreamStamp(stamp("echo")) });
      assert.deepEqual(JSON.parse(await a.next(1)), stamp("echo"));
      await b.next(1);
      a.ws.send("A");
      b.ws.send("B");
      assert.equal(await a.next(2), "echo:A");
      assert.equal(await b.next(2), "echo:B");
      a.ws.close();
      await a.closed;
      b.ws.send("B2");
      assert.equal(await b.next(3), "echo:B2");
      b.ws.close();
      await b.closed;
    } finally {
      await server.close();
    }
    assert.equal(existsSync(path), false, "閉じたあともソケットのファイルが残っている");
  });
});

test("刻印の無い・読めない相手は 400、名乗っていない名前は 4404、受け口が投げたら 1011", async () => {
  await withDir(async (dataDir) => {
    const errors: Error[] = [];
    const server = await listenStreams(
      {
        echo() {},
        broken() {
          throw new Error("受け口の失敗");
        },
      },
      { dataDir, onError: (err) => errors.push(err) },
    );
    try {
      assert.equal(await dial(server.path, {}).rejected, 400);
      assert.equal(await dial(server.path, { [STREAM_STAMP_HEADER]: "not-a-stamp" }).rejected, 400);
      assert.equal(await dial(server.path, { [STREAM_STAMP_HEADER]: encodeStreamStamp(stamp("shell")) }).closed, 4404);
      assert.equal(await dial(server.path, { [STREAM_STAMP_HEADER]: encodeStreamStamp(stamp("broken")) }).closed, 1011);
      assert.deepEqual(errors.map((e) => e.message), ["受け口の失敗"]);
    } finally {
      await server.close();
    }
  });
});

test("閉じると開いている流れを 1001 で閉じる。置き場が無ければ立てずに投げる", async () => {
  await withDir(async (dataDir) => {
    const server = await listenStreams({ echo: (ws) => ws.send("hi") }, { dataDir });
    const c = dial(server.path, { [STREAM_STAMP_HEADER]: encodeStreamStamp(stamp("echo")) });
    await c.next(1);
    await server.close();
    assert.equal(await c.closed, 1001);
  });
  const saved = process.env.BANTO_MODULE_DATA_DIR;
  delete process.env.BANTO_MODULE_DATA_DIR;
  try {
    await assert.rejects(listenStreams({}), /BANTO_MODULE_DATA_DIR/);
  } finally {
    if (saved !== undefined) process.env.BANTO_MODULE_DATA_DIR = saved;
  }
});
