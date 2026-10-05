// **Module からの問いが、正しい会話に届くか**（`relay-lifecycle-and-elicitation`、
// 2026-09-10）。
//
// host は実 Module への接続を1本だけ持つ。その1本に Elicit のハンドラを付けると、
// **最後に作った代理サーバが上書きする**——並行して2つのターンが走っていると、
// Vault の「この alias が無い」が**別の会話に出る**（コード内 TODO だった）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CALL_ID_META_KEY, parseModuleMeta } from "@banto/module-contract";
import { ElicitationRouter, ElicitationRouteError } from "./elicitation-router.js";
import { ModuleCallTracker } from "./module-calls.js";

const META = parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault");

/** 「その会話に届いた問い」を数える、代理サーバの代わり。 */
function fakeProxyServer(received: string[], label: string): Server {
  return {
    elicitInput: async (params: { message?: string }) => {
      received.push(`${label}:${params.message ?? ""}`);
      return { action: "decline" as const };
    },
  } as unknown as Server;
}

/** 実 Module 側から `elicitInput()` を呼べる、最小の偽 Module。 */
async function fakeModule(): Promise<{ client: Client; ask(message: string): Promise<unknown> }> {
  const server = new Server({ name: "fake-vault", version: "0.0.0" }, { capabilities: {} });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    client,
    ask: (message: string) => server.elicitInput({ message, requestedSchema: { type: "object" as const, properties: {} } }),
  };
}

test("走行中のターンの会話に届く——同じ Module を2つのターンが持っていても", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };

  const received: string[] = [];
  router.register(conn, "thread-A", fakeProxyServer(received, "A"));
  router.register(conn, "thread-B", fakeProxyServer(received, "B"));

  // いま vault を使っているのは thread-B のターン
  const endB = tracker.begin("vault", "thread-B");
  await module.ask("alias が要ります");
  endB();

  assert.deepEqual(received, ["B:alias が要ります"], "走っていないほうの会話に出た");

  // 次は thread-A が使っている
  const endA = tracker.begin("vault", "thread-A");
  await module.ask("もう一度");
  endA();
  assert.deepEqual(received, ["B:alias が要ります", "A:もう一度"]);

  await module.client.close();
});

test("どちらのターンか決められないときは、推測せず断る", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };

  const received: string[] = [];
  router.register(conn, "thread-A", fakeProxyServer(received, "A"));
  router.register(conn, "thread-B", fakeProxyServer(received, "B"));

  // 2つのターンが同時にこの Module を使っている
  const endA = tracker.begin("vault", "thread-A");
  const endB = tracker.begin("vault", "thread-B");
  await assert.rejects(() => module.ask("どっち？"), /決められません|Elicit/);
  assert.deepEqual(received, [], "決められないのに、どこかの会話へ出してしまった");
  endA();
  endB();

  await module.client.close();
});

test("繋がっているターンが1つだけなら、走行中の呼び出しが無くてもそこへ届く", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };

  const received: string[] = [];
  router.register(conn, "thread-A", fakeProxyServer(received, "A"));

  await module.ask("ひとつだけ");
  assert.deepEqual(received, ["A:ひとつだけ"]);

  await module.client.close();
});

test("宛先が無くなったら断る（ターンの接続が閉じた後）", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };

  router.register(conn, "thread-A", fakeProxyServer([], "A"));
  router.unregister("vault", "thread-A");

  await assert.rejects(() => module.ask("誰もいない"), /会話がありません|Elicit/);
  await module.client.close();
});

test("ハンドラは接続ごとに1回だけ付く（付け替え合戦をしない）", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };

  let installs = 0;
  const original = module.client.setRequestHandler.bind(module.client);
  module.client.setRequestHandler = ((schema: unknown, handler: unknown) => {
    if (schema === ElicitRequestSchema) installs += 1;
    return original(schema as never, handler as never);
  }) as typeof module.client.setRequestHandler;

  router.register(conn, "thread-A", fakeProxyServer([], "A"));
  router.register(conn, "thread-B", fakeProxyServer([], "B"));
  router.register(conn, "thread-C", fakeProxyServer([], "C"));
  assert.equal(installs, 1, "代理サーバごとにハンドラを付け替えている");

  await module.client.close();
});

test("ElicitationRouteError は router から直接も投げる（型で分かる）", () => {
  const router = new ElicitationRouter(new ModuleCallTracker());
  assert.throws(
    () => (router as unknown as { resolve(n: string): unknown }).resolve("居ない"),
    ElicitationRouteError,
  );
});

// **問いの答えを待つ間、その呼び出しは人を待っている**（追加・2026-10-05）。起こし直しの「待つ」はこの呼び出しを待たない
// （`http/activity.ts`）。答えが来たら外す
test("問いの答えを待つ間だけ、その Module の呼び出しは人を待っている印が付く", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const module = await fakeModule();
  const conn = { name: "vault", client: module.client, meta: META };
  let answer!: () => void;
  const seen: boolean[] = [];
  router.register(conn, "thread-A", {
    elicitInput: async () => {
      seen.push(tracker.list().every((c) => c.waitingOnHuman));
      await new Promise<void>((r) => (answer = r));
      return { action: "decline" as const };
    },
  } as unknown as Server);

  const end = tracker.begin("vault", "thread-A");
  assert.deepEqual(tracker.list().map((c) => c.waitingOnHuman), [false]);
  const asked = module.ask("alias が要ります");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [true], "問いの間に人を待っている印が無い");
  answer();
  await asked;
  assert.deepEqual(tracker.list().map((c) => c.waitingOnHuman), [false], "答えたあとも人を待っている");
  end();
  await module.client.close();
});

// **質問の印は質問した呼び出しだけに**（改訂・2026-10-05、Fable のレビュー）。Module が問いの `_meta` に呼び出しの印
// （`dev.banto/callId`、中継と同じ契約）を返せば、その1件の会話に出してその1件だけを人待ちにする。返さなければ問いを出す
// 会話の呼び出しだけ——同じ Module を別の会話から並べて呼んでいても、そちらは実行中のまま（起こし直しで待たれる）
test("同じ接続の2つの呼び出しのうち片方だけが質問したら、その呼び出しだけが人待ちになる（印があれば会話もそれで決まる）", async () => {
  const tracker = new ModuleCallTracker();
  const router = new ElicitationRouter(tracker);
  const server = new Server({ name: "fake-vault", version: "0.0.0" }, { capabilities: {} });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "host", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  await Promise.all([server.connect(s), client.connect(c)]);
  const conn = { name: "vault", client, meta: META };
  const seen: Array<{ label: string; waiting: boolean[] }> = [];
  let answer!: () => void;
  const proxy = (label: string) =>
    ({
      elicitInput: async () => {
        seen.push({ label, waiting: tracker.list().map((x) => x.waitingOnHuman) });
        await new Promise<void>((r) => (answer = r));
        return { action: "decline" as const };
      },
    }) as unknown as Server;
  router.register(conn, "thread-A", proxy("A"));
  router.register(conn, "thread-B", proxy("B"));
  const a = tracker.beginCall("vault", "thread-A", "turn", "p", false, "toolu_a");
  const b = tracker.beginCall("vault", "thread-B", "turn", "p", false, "toolu_b");

  // 印つき：2つの会話が同じ Module を使っていても、印の会話（B）に出て、B の呼び出しだけが人待ち
  const asked = server.elicitInput({ message: "鍵は？", requestedSchema: { type: "object", properties: {} }, _meta: { [CALL_ID_META_KEY]: b.id } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ label: "B", waiting: [false, true] }]);
  assert.equal(tracker.elicitingToolUseId("thread-B"), "toolu_b");
  answer();
  await asked;
  assert.deepEqual(tracker.list().map((x) => x.waitingOnHuman), [false, false]);

  // 印なしで会話が決まらない（2つの会話が使っている）なら、今までどおり推測せず断る
  await assert.rejects(server.elicitInput({ message: "鍵は？", requestedSchema: { type: "object", properties: {} } }));
  a.end();
  b.end();

  // 印なし・同じ会話に2つ：その会話の呼び出しには両方立つ（どちらの質問か分からない——elicitingToolUseId は決めない）
  const a1 = tracker.beginCall("vault", "thread-A", "turn", "p", false, "toolu_a1");
  const a2 = tracker.beginCall("vault", "thread-A", "turn", "p", false, "toolu_a2");
  seen.length = 0;
  const asked2 = server.elicitInput({ message: "鍵は？", requestedSchema: { type: "object", properties: {} } });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [{ label: "A", waiting: [true, true] }]);
  assert.equal(tracker.elicitingToolUseId("thread-A"), undefined);
  answer();
  await asked2;
  a1.end();
  a2.end();
  await client.close();
});
