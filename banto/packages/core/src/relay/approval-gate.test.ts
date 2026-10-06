// アーキ仕様 §2.5「初回のみ承認ゲート → 以降は同じ Project 内で自動許可」と
// 「メタデータだけ Event Store に記録」を、中継エンドポイントごと通して確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { markBundled, parseModuleMeta } from "@banto/module-contract";
import { EventLog, type StoredEvent } from "../event-store/log.js";
import { InboxStore } from "../inbox/store.js";
import type { JudgmentItem } from "../inbox/types.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { HostRelayEndpoint, RelayRegistry } from "./host-relay-endpoint.js";
import { RelayGrantStore } from "./grants.js";
import { ModuleCallTracker } from "./module-calls.js";
import { createRelayApprovalGate } from "./approval-gate.js";
import { AUTO_APPROVED_ANSWER_TEXT, AUTO_APPROVED_REASON } from "../inbox/auto-approve.js";

const THREAD = "thread-1";
const PROJECT = "project-1";

async function fakeVaultClient(auditArgs?: string[]): Promise<Client> {
  const server = new McpServer({ name: "fake-vault", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "resolveAlias",
        inputSchema: { type: "object", properties: {} },
        ...(auditArgs ? { _meta: { "dev.banto/auditArgs": auditArgs } } : {}),
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "explodes") throw new Error("宛先の Module が失敗しました");
    return { content: [{ type: "text", text: "SECRET-VALUE" }] };
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function setup(
  opts: {
    inContainer?: boolean;
    auditArgs?: string[];
    bundled?: boolean;
    /** 「承認をすべて自動で許可する」（試験の途中で切り替える） */
    autoApprove?: { on: boolean };
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-relay-gate-"));
  const log = new EventLog(dir);
  await log.init();
  const inbox = new InboxStore(dir, log);
  await inbox.load();
  const grants = new RelayGrantStore(dir, log);
  await grants.load();
  const pendingApprovals = new PendingApprovalRegistry();
  const moduleCalls = new ModuleCallTracker();

  /** 会話へ流したカードと、その答え */
  const cards: Array<{ threadId: string; id: string; message: string; toolInput: unknown }> = [];
  const settled: Array<{ threadId: string; id: string; answer: string }> = [];

  const registry = new RelayRegistry();
  registry.registerModule({
    name: "vault",
    client: await fakeVaultClient(opts.auditArgs),
    meta: parseModuleMeta({ satisfies: ["vault"], dependsOn: [], isolation: "subprocess" }, "vault"),
  });
  const rawShellMeta = parseModuleMeta(
    { satisfies: ["shell"], dependsOn: [{ role: "vault", required: true }], isolation: "subprocess" },
    "shell",
  );
  // 呼び出しの印（`dev.banto/callId`）を host が信じるのは同梱の Module だけ
  const shellMeta = opts.bundled ? markBundled(rawShellMeta, "shell") : rawShellMeta;
  const token = registry.issueToken({
    moduleName: "shell",
    connName: "shell-project-1",
    projectId: PROJECT,
    meta: shellMeta,
    ...(opts.inContainer ? { inContainer: true } : {}),
  });

  const endpoint = new HostRelayEndpoint({
    registry,
    // 進捗の間隔は試験用に短くする（本番は10秒）
    approvalProgressIntervalMs: 30,
    gate: createRelayApprovalGate({
      grants,
      inbox,
      pendingApprovals,
      moduleCalls,
      onJudgmentRaised: (threadId, j) => cards.push({ threadId, id: j.id, message: j.message, toolInput: j.toolInput }),
      onJudgmentSettled: (threadId, j) => settled.push({ threadId, ...j }),
      ...(opts.autoApprove ? { autoApproveAll: (projectId: string) => projectId === PROJECT && opts.autoApprove!.on } : {}),
    }),
    onAudit: async (r) => {
      await grants.recordCall(r, { allowed: r.allowed, reason: r.reason, ok: r.ok });
    },
  });
  const httpServer = createServer((req, res) => void endpoint.handleRequest(req, res));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/relay`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const caller = new Client({ name: "shell-module", version: "0.0.0" });
  await caller.connect(transport);

  const events = async (): Promise<StoredEvent[]> => {
    const all: StoredEvent[] = [];
    for await (const e of log.readFrom(0)) all.push(e);
    return all;
  };

  return {
    inbox,
    grants,
    pendingApprovals,
    moduleCalls,
    cards,
    settled,
    caller,
    events,
    async close() {
      await caller.close();
      httpServer.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 判断待ちが受信箱に出るまで待って、その1件を返す。 */
async function waitForJudgment(inbox: InboxStore, seen: Set<string>): Promise<JudgmentItem> {
  for (let i = 0; i < 200; i++) {
    const item = inbox
      .listOpen()
      .find((x): x is JudgmentItem => x.kind === "judgment" && !seen.has(x.id));
    if (item) {
      seen.add(item.id);
      return item;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("判断待ちが受信箱に出ませんでした");
}

test("初回は人に聞き、許可すると中継が通る——2回目は聞かない（同じ Project 内で自動許可）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);

    const first = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "github-token" } },
    });

    const judgment = await waitForJudgment(t.inbox, seen);
    assert.equal(judgment.threadId, THREAD, "承認は、その呼び出しが属する会話に出る");
    assert.equal(judgment.source, "relay");
    assert.match(judgment.message, /shell が vault の resolveAlias/);
    // **引数は記録しない**（§2.5——値そのものは残さない）
    assert.equal(JSON.stringify(judgment.toolInput).includes("github-token"), false);

    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });

    const result = await first;
    assert.equal((result.content as { text: string }[])[0]?.text, "SECRET-VALUE");

    // 2回目——同じ組み合わせなので、もう聞かない
    const before = t.inbox.listOpen().length;
    const second = await t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "other-token" } },
    });
    assert.equal((second.content as { text: string }[])[0]?.text, "SECRET-VALUE");
    assert.equal(t.inbox.listOpen().length, before, "承認済みの組み合わせで判断待ちを増やさない");

    endCall();

    const all = await t.events();
    const grants = all.filter((e) => e.type === "relay.grant_created");
    assert.equal(grants.length, 1);
    assert.deepEqual(grants[0]!.payload, {
      projectId: PROJECT,
      callerModule: "shell",
      targetModule: "vault",
      kind: "tool",
      name: "resolveAlias",
    });
    const calls = all.filter((e) => e.type === "relay.call_recorded");
    assert.equal(calls.length, 2, "呼び出しは毎回記録される（承認は初回だけでも）");
    for (const call of calls) {
      const payload = call.payload as Record<string, unknown>;
      assert.equal(payload.allowed, true);
      assert.equal(payload.ok, true);
      assert.equal(JSON.stringify(payload).includes("SECRET-VALUE"), false, "値は記録しない");
    }
  } finally {
    await t.close();
  }
});

// **人はすぐには答えない。** 待っている間、呼び出し元へ進捗を送らないと、MCP の
// 既定タイムアウト（60秒）で呼び出し元が先に諦め、「承認したのに、その回の操作は
// 失敗している」になる（docs/specs/v4-frontend.md「Module 間中継の承認」の 2.）。
test("承認を待っている間、呼び出し元へ進捗を送り続ける", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const notes: string[] = [];
    const call = t.caller.callTool(
      { name: "relayCallTool", arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} } },
      undefined,
      {
        resetTimeoutOnProgress: true,
        onprogress: (p) => notes.push(p.message ?? ""),
      },
    );

    const judgment = await waitForJudgment(t.inbox, seen);
    // 答えずに待つ——その間に進捗が届く
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(notes.length >= 3, `進捗が届いていない: ${JSON.stringify(notes)}`);
    assert.match(notes[0]!, /承認を待って/);

    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    await call;

    // 決着したら止まる（タイマーを残さない）
    const afterAnswer = notes.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(notes.length, afterAnswer, "答えた後も進捗が送られている");
    endCall();
  } finally {
    await t.close();
  }
});

test("拒否すると中継されない——記録には拒否として残る", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const call = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    t.pendingApprovals.resolve(judgment.id, { behavior: "deny", message: "やめておく" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "deny" });

    await assert.rejects(call, /許可されていません/);
    endCall();

    const all = await t.events();
    assert.equal(all.some((e) => e.type === "relay.grant_created"), false, "拒否は覚えない");
    const recorded = all.filter((e) => e.type === "relay.call_recorded");
    assert.equal(recorded.length, 1);
    assert.equal((recorded[0]!.payload as { allowed: boolean }).allowed, false);
  } finally {
    await t.close();
  }
});

test("宛先の失敗も記録に残る（成否まで見る）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const call = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "explodes", arguments: {} },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    await assert.rejects(call);
    endCall();

    const recorded = (await t.events()).filter((e) => e.type === "relay.call_recorded");
    assert.equal(recorded.length, 1);
    const payload = recorded[0]!.payload as { allowed: boolean; ok: boolean; name: string };
    assert.equal(payload.allowed, true);
    assert.equal(payload.ok, false, "失敗した呼び出しも残る");
    assert.equal(payload.name, "explodes");
  } finally {
    await t.close();
  }
});

test("どのターンからの呼び出しか決められないときは通さない（黙って許可しない）", async () => {
  const t = await setup();
  try {
    // 走行中の tool 呼び出しが無い＝人に聞く場所が無い
    await assert.rejects(
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
      /特定できません/,
    );
    assert.equal(t.inbox.listOpen().length, 0);
    const recorded = (await t.events()).filter((e) => e.type === "relay.call_recorded");
    assert.equal((recorded[0]!.payload as { allowed: boolean }).allowed, false);
  } finally {
    await t.close();
  }
});

test("同じ Module を2つのターンが同時に使っているときも、黙って片方に寄せない", async () => {
  const t = await setup();
  try {
    const endA = t.moduleCalls.begin("shell-project-1", THREAD);
    const endB = t.moduleCalls.begin("shell-project-1", "thread-2");
    await assert.rejects(
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      }),
      /決められません/,
    );
    endA();
    endB();
  } finally {
    await t.close();
  }
});

// **呼び出しの印があれば、その1件の会話で聞く**（追加・2026-09-28）。2つのターンが同じ Module を使っていても、
// 中継に印を返した同梱の Module なら、どちらのターンの仕事か決まる
test("2つのターンが同時に使っていても、同梱の Module が呼び出しの印を返せば、その会話で聞く", async () => {
  const t = await setup({ bundled: true });
  try {
    const a = t.moduleCalls.beginCall("shell-project-1", THREAD);
    const b = t.moduleCalls.beginCall("shell-project-1", "thread-2");
    const pending = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      _meta: { "dev.banto/callId": b.id },
    });
    const judgment = await waitForJudgment(t.inbox, new Set());
    assert.equal(judgment.threadId, "thread-2", "印で名指したターンの会話で聞いていない");
    t.pendingApprovals.resolve(judgment.id, { behavior: "deny", message: "試験" });
    await assert.rejects(pending);
    a.end();
    b.end();
  } finally {
    await t.close();
  }
});

test("承認は host を再起動しても残る（Event Store から畳み直す）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-relay-grants-"));
  try {
    const call = {
      projectId: PROJECT,
      callerModule: "shell",
      targetModule: "vault",
      kind: "tool" as const,
      name: "resolveAlias",
    };
    const log = new EventLog(dir);
    await log.init();
    const grants = new RelayGrantStore(dir, log);
    await grants.load();
    assert.equal(grants.isGranted(call), false);
    await grants.grant(call);
    assert.equal(grants.isGranted(call), true);
    await grants.save();

    // 別プロセスに相当するもう1組——スナップショットとログから同じ状態になる
    const log2 = new EventLog(dir);
    await log2.init();
    const grants2 = new RelayGrantStore(dir, log2);
    await grants2.load();
    assert.equal(grants2.isGranted(call), true);
    assert.equal(grants2.isGranted({ ...call, projectId: "別の Project" }), false);
    assert.equal(grants2.isGranted({ ...call, name: "createAlias" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// **コンテナから値を返す口を呼ぶときは、鍵の名前ごとに聞く**（決定・2026-09-25、v4-security.md §1・§3）。
// 中では AI が root で Module の合言葉も読めるので、道具の単位で許すと、一度許した resolveAlias から
// どの鍵でも引き出せる
test("コンテナからの値を返す口は、鍵の名前ごとに聞く——ホストの頃の承認は流用しない", async () => {
  const t = await setup({ inContainer: true, auditArgs: ["alias"] });
  const seen = new Set<string>();
  try {
    // ホストで動いていた頃の承認（対象を持たない）が残っていても
    await t.grants.grant({ projectId: PROJECT, callerModule: "shell", targetModule: "vault", kind: "tool", name: "resolveAlias" });
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const call = (alias: string) =>
      t.caller.callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias } } });

    const first = call("github-token");
    const judgment = await waitForJudgment(t.inbox, seen);
    assert.match(judgment.message, /shell が vault の resolveAlias（alias: github-token）を呼ぼうとしています/);
    assert.deepEqual((judgment.toolInput as Record<string, unknown>)["対象"], { alias: "github-token" });
    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    assert.equal(((await first).content as { text: string }[])[0]?.text, "SECRET-VALUE");

    // 同じ鍵なら、もう聞かない
    const before = t.inbox.listOpen().length;
    await call("github-token");
    assert.equal(t.inbox.listOpen().length, before, "同じ鍵で聞き直している");

    // 別の鍵なら、また聞く
    const other = call("other-token");
    const again = await waitForJudgment(t.inbox, seen);
    assert.match(again.message, /（alias: other-token）/);
    t.pendingApprovals.resolve(again.id, { behavior: "deny", message: "やめておく" });
    await t.inbox.answerJudgment(again.id, { behavior: "deny" });
    await assert.rejects(other, /許可されていません/);
    endCall();

    const grants = (await t.events()).filter((e) => e.type === "relay.grant_created").map((e) => e.payload);
    assert.deepEqual(grants.at(-1), {
      projectId: PROJECT,
      callerModule: "shell",
      targetModule: "vault",
      kind: "tool",
      name: "resolveAlias",
      scope: { alias: "github-token" },
    });
  } finally {
    await t.close();
  }
});

test("ホストで動く Module からの呼び出しは、今までどおり道具の単位で聞く", async () => {
  const t = await setup({ auditArgs: ["alias"] });
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const first = t.caller.callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "a" } } });
    const judgment = await waitForJudgment(t.inbox, seen);
    assert.doesNotMatch(judgment.message, /alias:/);
    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    await first;
    const before = t.inbox.listOpen().length;
    await t.caller.callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "b" } } });
    assert.equal(t.inbox.listOpen().length, before);
    endCall();
  } finally {
    await t.close();
  }
});

// **聞いた呼び出しが終わったら畳む**（追加・2026-10-04、ユーザー報告「publishService が承認待ちで止まる」）。
// 以前は終わっても待ち続け、カードの無い判断待ちが残り、次の呼び出しはそこに相乗りしてカードが二度と出なかった
test("聞いた呼び出しが答えを待たずに終わったら、判断待ちを畳み、次の呼び出しではまた聞く（相乗りしない）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const endFirst = t.moduleCalls.begin("shell-project-1", THREAD);
    const first = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    assert.equal(t.moduleCalls.list().length, 1);

    // 外側の呼び出し（AI → Module）が終わった——ターンが終わった・止まった等
    endFirst();
    const firstResult = await first.then(
      (r) => r,
      (err: unknown) => err,
    );
    assert.match(String((firstResult as Error).message ?? JSON.stringify(firstResult)), /人が答える前に終わりました/);
    const settled = t.inbox.get(judgment.id) as JudgmentItem;
    assert.equal(settled.liveness, "answered", "畳んだ判断待ちは受信箱にも残さない");

    // 次の呼び出しは新しく聞く（いまのターンにカードが出る）
    const endSecond = t.moduleCalls.begin("shell-project-1", THREAD);
    const second = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    const again = await waitForJudgment(t.inbox, seen);
    assert.notEqual(again.id, judgment.id);
    t.pendingApprovals.resolve(again.id, { behavior: "allow" });
    await t.inbox.answerJudgment(again.id, { behavior: "allow" });
    const result = await second;
    assert.equal((result.content as { text: string }[])[0]?.text, "SECRET-VALUE");
    endSecond();
  } finally {
    await t.close();
  }
});

// **畳む書き込みを待ってから返す**（追加・2026-10-06、Backlog #216 と同じ形。Fable のレビュー）。以前は書き込みを投げっぱなしで
// 返し、返った時点では判断待ちがまだ live。試験では書き込みをわざと遅らせて、その隙を確かめに見る
test("聞いた呼び出しが終わって断られた時点で、判断待ちはもう畳まれている（受信箱への書き込みが遅くても）", async () => {
  const t = await setup();
  const seen = new Set<string>();
  try {
    const answer = t.inbox.answerJudgment.bind(t.inbox);
    t.inbox.answerJudgment = async (...args: Parameters<typeof answer>) => {
      await new Promise((r) => setTimeout(r, 300));
      return answer(...args);
    };
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const first = t.caller
      .callTool({ name: "relayCallTool", arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} } })
      .then((r) => r, (err: unknown) => err);
    const judgment = await waitForJudgment(t.inbox, seen);
    endCall();
    await first;
    assert.equal((t.inbox.get(judgment.id) as JudgmentItem).liveness, "answered", "断ったとき、判断待ちがまだ live");
    assert.equal(t.settled.length, 1, "会話のカードを答え済みにする知らせが、断る前に出ていない");
  } finally {
    await t.close();
  }
});

test("承認を待っている間、その呼び出しは「人を待っている」——答えたら外れる", async () => {
  const t = await setup({ bundled: true });
  const seen = new Set<string>();
  try {
    const call = t.moduleCalls.beginCall("shell-project-1", THREAD);
    assert.equal(t.moduleCalls.isWaitingOnHuman("shell-project-1", call.id), false);
    const pending = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
      _meta: { "dev.banto/callId": call.id },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    assert.equal(t.moduleCalls.isWaitingOnHuman("shell-project-1", call.id), true);
    t.pendingApprovals.resolve(judgment.id, { behavior: "allow" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "allow" });
    await pending;
    assert.equal(t.moduleCalls.isWaitingOnHuman("shell-project-1", call.id), false);
    call.end();
  } finally {
    await t.close();
  }
});

// **相乗りした先が「聞いた呼び出しの終わり」で畳まれたら、続いている呼び出しは自分の会話で聞き直す**（追加・2026-10-05、
// docs/notes/2026-10-05-relay-stale-card.md）。以前は畳まれた理由をそのまま受け取り、後ろのターンにはカードが一度も
// 出なかった。許可したら記録に残り、次からは聞かない
test("1枚目を聞いた呼び出しが終わったら、相乗りしていた呼び出しは自分の会話で聞き直す——許可は残り、次は聞かない", async () => {
  const t = await setup({ bundled: true });
  const seen = new Set<string>();
  try {
    const a = t.moduleCalls.beginCall("shell-project-1", THREAD);
    const b = t.moduleCalls.beginCall("shell-project-1", "thread-2");
    const relay = (callId: string) =>
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
        _meta: { "dev.banto/callId": callId },
      });
    const first = relay(a.id).then((r) => r, (e: unknown) => e);
    const asked = await waitForJudgment(t.inbox, seen);
    assert.equal(asked.threadId, THREAD);
    const second = relay(b.id);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.inbox.listOpen().filter((x) => x.kind === "judgment").length, 1, "相乗りせずに2枚目を出した");
    assert.equal(t.moduleCalls.isWaitingOnHuman("shell-project-1", b.id), true, "相乗りした呼び出しが人待ちになっていない");

    // 1枚目を聞いた呼び出しが、人が答える前に終わった
    a.end();
    assert.match(String((await first as Error).message), /人が答える前に終わりました/);
    assert.equal((t.inbox.get(asked.id) as JudgmentItem).liveness, "answered");
    const again = await waitForJudgment(t.inbox, seen);
    assert.equal(again.threadId, "thread-2", "続いている呼び出しの会話で聞き直していない");
    t.pendingApprovals.resolve(again.id, { behavior: "allow" });
    await t.inbox.answerJudgment(again.id, { behavior: "allow" });
    assert.equal(((await second).content as { text: string }[])[0]?.text, "SECRET-VALUE");
    b.end();

    // 許可は残る——次の呼び出しは聞かない
    const c = t.moduleCalls.beginCall("shell-project-1", "thread-3");
    assert.equal(((await relay(c.id)).content as { text: string }[])[0]?.text, "SECRET-VALUE");
    assert.equal(t.inbox.listOpen().filter((x) => x.kind === "judgment").length, 0);
    c.end();
  } finally {
    await t.close();
  }
});

// **終わった呼び出しの印で来た中継は、別のターンの会話を借りない**（追加・2026-10-05）。外側が切れたあとも Module の中で
// 続いていた仕事（Backlog の送る）が、同じ Module をたまたま使っていた別のターンにカードを出し、その呼び出しを人待ちにしていた
test("終わった呼び出しの印で来た中継は、同じ Module を使っている別のターンでは聞かずに断る", async () => {
  const t = await setup({ bundled: true });
  try {
    const live = t.moduleCalls.beginCall("shell-project-1", "thread-2");
    const gone = t.moduleCalls.beginCall("shell-project-1", THREAD);
    gone.end();
    await assert.rejects(
      t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
        _meta: { "dev.banto/callId": gone.id },
      }),
      /特定できません/,
    );
    assert.equal(t.inbox.listOpen().filter((x) => x.kind === "judgment").length, 0, "別のターンの会話にカードを出した");
    assert.equal(t.moduleCalls.isWaitingOnHuman("shell-project-1", live.id), false);
    live.end();
  } finally {
    await t.close();
  }
});

// **承認をすべて自動で許可する**（決定・2026-10-05、ユーザー。docs/specs/v4-frontend.md §6.4）。コンテナからの
// 秘密を返す呼び出し（scope 付き）も聞かずに通す。**覚えない**——スイッチを切れば、また聞く
test("「承認をすべて自動で許可する」がオンなら、scope 付きでも聞かずに通し、答え済みのカードを残す——grant は残さず、切ればまた聞く", async () => {
  const autoApprove = { on: true };
  const t = await setup({ inContainer: true, auditArgs: ["alias"], autoApprove });
  const seen = new Set<string>();
  try {
    const endCall = t.moduleCalls.begin("shell-project-1", THREAD);
    const result = await t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "github-token" } },
    });
    assert.equal((result.content as { text: string }[])[0]?.text, "SECRET-VALUE", "人の操作なしで通る");
    assert.equal(t.inbox.listOpen().filter((i) => i.kind === "judgment").length, 0, "受信箱に未解決を残さない");

    // 会話には答え済みのカード——何を自動で通したかが読める
    assert.equal(t.cards.length, 1);
    assert.equal(t.cards[0]!.threadId, THREAD);
    assert.match(t.cards[0]!.message, /shell が vault の resolveAlias（alias: github-token）/);
    assert.match(JSON.stringify(t.cards[0]!.toolInput), /聞かずに通しました/);
    assert.deepEqual(t.settled, [{ threadId: THREAD, id: t.cards[0]!.id, answer: AUTO_APPROVED_ANSWER_TEXT }]);
    const item = t.inbox.get(t.cards[0]!.id) as JudgmentItem;
    assert.equal(item.liveness, "answered", "判断待ちは出したそばから決着している");

    let all = await t.events();
    assert.equal(all.filter((e) => e.type === "relay.grant_created").length, 0, "自動で通したものは覚えない");
    const recorded = all.filter((e) => e.type === "relay.call_recorded").map((e) => e.payload as Record<string, unknown>);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.allowed, true);
    assert.equal(recorded[0]!.reason, AUTO_APPROVED_REASON, "記録に「自動で許可」と分かる理由を残す");

    // スイッチを切ると、同じ呼び出しをまた聞く
    autoApprove.on = false;
    const again = t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: { alias: "github-token" } },
    });
    const judgment = await waitForJudgment(t.inbox, seen);
    assert.match(JSON.stringify(judgment.toolInput), /次から自動で通します/);
    t.pendingApprovals.resolve(judgment.id, { behavior: "deny", message: "拒否" });
    await t.inbox.answerJudgment(judgment.id, { behavior: "deny", message: "拒否" });
    await assert.rejects(again, /人が拒否しました/, "切った後は人の答えに従う");
    endCall();

    all = await t.events();
    assert.equal(all.filter((e) => e.type === "relay.grant_created").length, 0);
  } finally {
    await t.close();
  }
});

test("「承認をすべて自動で許可する」は、どの会話の呼び出しか分からなくても通す（カードは出さない）", async () => {
  const t = await setup({ autoApprove: { on: true } });
  try {
    const result = await t.caller.callTool({
      name: "relayCallTool",
      arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
    });
    assert.equal((result.content as { text: string }[])[0]?.text, "SECRET-VALUE");
    assert.equal(t.cards.length, 0);
    const all = await t.events();
    assert.equal(all.filter((e) => e.type === "inbox.judgment_raised").length, 0);
  } finally {
    await t.close();
  }
});

// **中継の承認の判断待ちに、属する AI の tool 呼び出しの id を残す**（追加・2026-10-05、Fable のレビュー）——起き直したあと、
// 承認を待ったまま無効になった呼び出しを続きの文に書くため。決まらなければ（Runner が id を渡さない）残さない
test("中継の承認の判断待ちは、呼び出しが持つ tool_use の id を withinToolCallId に残す（無ければ残さない）", async () => {
  const t = await setup({ bundled: true });
  const seen = new Set<string>();
  try {
    for (const toolUseId of ["toolu_outer", undefined]) {
      const call = t.moduleCalls.beginCall("shell-project-1", THREAD, "turn", PROJECT, false, toolUseId);
      const pending = t.caller.callTool({
        name: "relayCallTool",
        arguments: { targetModule: "vault", name: "resolveAlias", arguments: {} },
        _meta: { "dev.banto/callId": call.id },
      });
      const judgment = await waitForJudgment(t.inbox, seen);
      assert.equal(judgment.withinToolCallId, toolUseId);
      assert.equal(judgment.toolCallId, undefined, "承認する呼び出しそのものの id と混ぜた");
      t.pendingApprovals.resolve(judgment.id, { behavior: "deny", message: "いいえ" });
      await t.inbox.answerJudgment(judgment.id, { behavior: "deny" });
      await pending.catch(() => undefined);
      call.end();
    }
  } finally {
    await t.close();
  }
});
