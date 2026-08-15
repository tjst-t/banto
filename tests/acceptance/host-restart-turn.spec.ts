/**
 * imp-0037: `system.restart` が「再起動をまたぐ会話」を落とす穴。
 *
 * 3つの独立した原因を、**本体プロセスを落とさずに**確かめる。
 *
 * 1. 道具が `tool_end` を書く前にプロセスを落としている
 *    → `execute()` は文字列を返して即 resolve し、終了はターンの外へ出す
 * 2. 起動時に「running のまま残ったもの」を確定させる処理がどこにも無い
 *    → 読み戻しで `ok`/`failed` に確定させ、再起動なら続きを促す知らせを1件入れる
 * 3. `close()` に無期限で待つ経路があり保険が無い
 *    → 能動的に断ち、期限を超えたら `console.error` に残して先へ進む
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import {
  BANTO_WS_PATH,
  BantoHostServer,
  Inbox,
  ThreadRegistry,
  ThreadStore,
  createModuleRegistry,
  createRestartTool,
  type BantoModule,
} from "@banto/host";
import { TRUNK } from "./threadSpecs.js";

/** ターンを一切回さないハーネス。配信経路と後始末だけを見る。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "restart-test";
  readonly backendId = "fake";
  isStreaming = false;
  prompts: string[] = [];
  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => undefined;
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

let dir: string;
let server: BantoHostServer | undefined;
const sockets: net.Socket[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-turn-"));
});

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.length = 0;
  // 試験が落ちても待ち受けを残さない（残すと後続の試験が同じポートで詰まる）
  if (server) {
    try {
      await server.close();
    } catch {
      // 閉じられないことそのものを確かめている試験もある
    }
    server = undefined;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * **生ソケットで WebSocket の握手だけして、以後一切応答しない**クライアント。
 *
 * `ws` のクライアントは close フレームに自動で返事をするので、
 * 「応答しない相手」を再現できない——ここが原因3の発火条件そのものなので手で書く。
 */
function unresponsiveUpgrade(port: number, pathname: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        [
          `GET ${pathname} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
          "",
          "",
        ].join("\r\n")
      );
    });
    sockets.push(socket);
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) {
        reject(new Error(`upgrade を断られました: ${chunk.toString("latin1").split("\r\n")[0]}`));
        return;
      }
      // 以後は何も読まず何も書かない＝無応答の相手
      resolve(socket);
    });
  });
}

/** 自分の到達先の下の upgrade を、中継のように**握ったまま離さない**モジュール。 */
function holdingModule(held: net.Socket[]): BantoModule {
  return {
    name: "kobo",
    title: "Kobo",
    description: "試験用の中継（upgrade を握ったまま離さない）",
    endpoint: { baseUrl: "/api/kobo" },
    tools: [],
    views: [],
    skills: [],
    handleUpgrade(req, socket): boolean {
      if (!(req.url ?? "").startsWith("/api/kobo")) return false;
      // remote-module.ts の中継と同じく、握手を返してソケットを生かし続ける
      const accept = crypto
        .createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n")
      );
      held.push(socket as net.Socket);
      return true;
    },
  };
}

async function startHost(modules?: ReturnType<typeof createModuleRegistry>): Promise<number> {
  const threads = new ThreadRegistry(async () => ({ harness: new FakeSession(), tools: [] }));
  await threads.open(TRUNK);
  server = await BantoHostServer.start({
    threads,
    port: 0,
    ...(modules ? { modules } : {}),
  });
  return server.port;
}

describe("[imp-0037] close() は期限つきで、必ず返る", () => {
  it("モジュール中継の upgrade が1本開いていても close() が5秒以内に返る", async () => {
    const held: net.Socket[] = [];
    const port = await startHost(createModuleRegistry([holdingModule(held)]));
    await unresponsiveUpgrade(port, "/api/kobo/ws");
    assert.equal(held.length, 1, "中継が upgrade を握っていること（試験の前提）");

    const started = Date.now();
    await server!.close();
    server = undefined;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `close() に ${elapsed}ms 掛かった（5秒以内であること）`);
  });

  it("/ws に無応答のクライアントが1本いても close() が2秒以内に返る", async () => {
    const port = await startHost();
    await unresponsiveUpgrade(port, BANTO_WS_PATH);

    const started = Date.now();
    await server!.close();
    server = undefined;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `close() に ${elapsed}ms 掛かった（2秒以内であること）`);
  });
});

describe("[imp-0037] 起動時に残った running を確定させる", () => {
  function registry(): ThreadRegistry {
    return new ThreadRegistry(
      async () => ({ harness: new FakeSession(), tools: [] }),
      new ThreadStore(dir)
    );
  }

  /** 取次は毎回まっさらにする（読み戻しごとに1つずつ作る）。 */
  function inbox(name: string): Inbox {
    return new Inbox(path.join(dir, `${name}.jsonl`));
  }

  /** 知らせの本文だけを取り出す。 */
  function notices(thread: { transcript: readonly { role: string }[] }): string[] {
    return thread.transcript
      .filter((e): e is typeof e & { role: "notice"; text: string } => e.role === "notice")
      .map((e) => e.text);
  }

  /** `state:"running"` の道具を1つ残したまま落ちた会話を作る。 */
  async function storeWithRunningTool(toolName: string): Promise<string> {
    const before = registry();
    const caller = await before.open({ kind: "trunk", title: "帳場を直す" });
    caller.record({ role: "po", text: "コードを直したので再起動して" });
    caller.record({ role: "tool", name: toolName, state: "running", input: {} });
    before.flushAll();
    return caller.id;
  }

  it("system.restart は ok に確定し、呼び出し元へ再開の知らせ・取次へ札が1件ずつ立つ", async () => {
    const callerId = await storeWithRunningTool("system.restart");

    const after = registry();
    const box = inbox("a");
    const resume = await after.restore(box);

    const caller = after.list().find((t) => t.id === callerId);
    assert.ok(caller, "会話が読み戻せること");
    const tool = caller.transcript.find((e) => e.role === "tool");
    assert.ok(tool?.role === "tool");
    assert.equal(tool.state, "ok", "system.restart は ok に確定する");
    assert.match(String(tool.output), /再起動しました/);

    assert.deepEqual(notices(caller), ["再起動が完了しました。中断した続きを進めてください。"]);
    assert.deepEqual(resume, [callerId], "ターンを回す宛先として呼び出し元が返る");

    const items = box.list();
    assert.equal(items.length, 1, "取次の札はちょうど1件");
    const item = items[0]!;
    assert.equal(item.notice, true, "判断ではなく報告（判断待ちの数に入れない）");
    assert.equal(item.source.id, "system", "差出人は機構（POや番頭の発言に化けない・imp-0026）");
    assert.equal(item.actions.length, 1, "判断を迫らない");
    assert.match(item.what, /banto を再起動しました。/);
    assert.match(item.what, new RegExp(`「帳場を直す」（${callerId}）`));
    assert.doesNotMatch(item.what, /failed として記録/, "中断された道具が無ければ書かない");
    assert.equal(item.opens?.threadId, callerId, "押せば呼び出し元の会話へ行ける");
  });

  it("一般の道具は failed に確定し、理由が入る（黙って ok にしない）", async () => {
    const callerId = await storeWithRunningTool("worker.delegate");

    const after = registry();
    const box = inbox("b");
    const resume = await after.restore(box);

    const caller = after.list().find((t) => t.id === callerId);
    assert.ok(caller);
    const tool = caller.transcript.find((e) => e.role === "tool");
    assert.ok(tool?.role === "tool");
    assert.equal(tool.state, "failed", "結果の分からない道具を ok にしない（I2）");
    assert.match(String(tool.output), /ホストの再起動で中断されました/);

    assert.deepEqual(notices(caller), [], "再起動の道具ではないので、勝手に会話を起こさない");
    assert.deepEqual(resume, [], "ターンは回さない");

    // 意図しない終了。取次には**そうと分かる文面で**1件立つ
    const items = box.list();
    assert.equal(items.length, 1);
    assert.match(items[0]!.what, /banto が予期せず終了し、再起動しました。/);
    assert.match(items[0]!.what, /中断した道具 1 件は failed として記録しました/);
    assert.match(items[0]!.what, /「帳場を直す」/);
  });

  it("running が1件も無ければ、取次には何も立たない", async () => {
    const before = registry();
    const trunk = await before.open({ kind: "trunk", title: "普通の朝" });
    trunk.record({ role: "po", text: "おはよう" });
    trunk.record({ role: "tool", name: "memory.recall", state: "ok", output: "なし" });
    before.flushAll();

    const after = registry();
    const box = inbox("c");
    const resume = await after.restore(box);
    assert.deepEqual(resume, []);
    assert.deepEqual(box.list(), [], "普通の起動で毎回札が立たない");
    assert.deepEqual(notices(after.list()[0]!), []);
  });

  it("確定させた結果は保存され、次の読み戻しで running へ戻らない", async () => {
    const callerId = await storeWithRunningTool("system.restart");

    await registry().restore(inbox("d1"));

    const twice = registry();
    const box = inbox("d2");
    const resume = await twice.restore(box);
    assert.deepEqual(resume, [], "2度目は中断が残っていない");
    assert.deepEqual(box.list(), [], "2度目は札が立たない");
    assert.equal(
      notices(twice.list().find((t) => t.id === callerId)!).length,
      1,
      "知らせが読み戻しのたびに増えない"
    );
  });
});

describe("[imp-0037] system.restart は結果を返してから落ちる", () => {
  it("execute() は返事を返して即座に resolve し、落ちるのはターンの外", async () => {
    const exits: number[] = [];
    let closed = 0;
    const tool = createRestartTool({
      notify: async () => {},
      close: async () => {
        closed++;
      },
      exit: (code) => {
        exits.push(code);
      },
      // 猶予より**十分早く**返ることを見たいので、猶予は長めに取る
      graceMs: 500,
    });

    const started = Date.now();
    const result = await Promise.race([
      tool.execute({}, { toolCallId: "t1" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("execute() が resolve しない")), 3000).unref()
      ),
    ]);
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 200, `execute() が返るまで ${elapsed}ms 掛かった（即座であること）`);
    assert.match(result.content[0]!.text, /再起動/);
    assert.equal(closed, 0, "返した時点ではまだ閉じていない");
    assert.equal(exits.length, 0, "返した時点ではまだ落ちていない＝tool_end を書く余地がある");

    // 猶予のあとで、ターンの外から閉じて落ちる
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(closed, 1);
    assert.deepEqual(exits, [0]);
  });
});
