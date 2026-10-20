import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CacheKeepAlive,
  KEEP_ALIVE_MAX_ENTRIES,
  type CacheKeepAliveDeps,
  type CacheUsage,
  type MarginCheck,
  type ObservedRequest,
  type WarmOutcome,
  type WarmRequest,
} from "./keep-alive.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-20T00:00:00Z");

interface Harness {
  ka: CacheKeepAlive;
  clock: { now: number };
  sent: WarmRequest[];
  /** 次に返す結果（無ければ当たった返事） */
  replies: WarmOutcome[];
  margin: { value: MarginCheck };
  warmable: { value: boolean };
  logs: string[];
  /** その時刻にして、時刻の来たものを送る */
  at(minutes: number): Promise<void>;
}

function harness(overrides: Partial<CacheKeepAliveDeps> = {}): Harness {
  const clock = { now: T0 };
  const sent: WarmRequest[] = [];
  const replies: WarmOutcome[] = [];
  const margin = { value: { ok: true } as MarginCheck };
  const warmable = { value: true };
  const logs: string[] = [];
  const ka = new CacheKeepAlive({
    send: async (req) => {
      sent.push(req);
      return replies.shift() ?? { kind: "ok", usage: hit(60_000), utilization: "5h=10% 7d=5%" };
    },
    margin: () => margin.value,
    stillWarmable: () => warmable.value,
    now: () => clock.now,
    random: () => 0,
    timers: false,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return {
    ka,
    clock,
    sent,
    replies,
    margin,
    warmable,
    logs,
    at: async (minutes) => {
      clock.now = T0 + minutes * MIN;
      await ka.runDue();
    },
  };
}

/** キャッシュに当たった usage（入力のほぼ全部が cache_read） */
const hit = (total: number): CacheUsage => ({ inputTokens: 10, cacheReadTokens: total - 10, cacheCreationTokens: 0 });

function request(o: Partial<ObservedRequest> & { tokens?: number; minute?: number; text?: string } = {}): ObservedRequest {
  const body = { model: "claude-opus-5-5", max_tokens: 128000, stream: true, messages: [{ role: "user", content: o.text ?? "secret tool output" }] };
  return {
    projectId: "p1",
    threadId: "t1",
    key: "p1\u0000s1",
    sessionId: "s1",
    path: "/v1/messages?beta=true",
    accountId: "host",
    startedAt: T0 + (o.minute ?? 0) * MIN,
    usage: hit(o.tokens ?? 60_000),
    body: Buffer.from(JSON.stringify(body)),
    headers: { "anthropic-beta": "oauth-2025-04-20", "x-claude-code-session-id": "s1", accept: "text/event-stream" },
    ...o,
  };
}

const TICKET = { sessionId: "s1", fingerprint: "fp" };

/** ターンを1本（要求を受けて、温めてよいと渡す） */
function turn(h: Harness, reqs: ObservedRequest[], ticket: typeof TICKET | null = TICKET, threadId = "t1"): void {
  h.ka.turnStarted(threadId);
  for (const r of reqs) h.ka.observe(r);
  h.ka.turnEnded(threadId, ticket ?? undefined);
}

test("温め直しは最後の本物の要求の開始から 50・100・150・200 分。本文は max_tokens 0・stream 無し、見出しは stream を求めない", async () => {
  const h = harness();
  // ターンの中で要求が2つ——時刻の基準は最後の要求の開始（2分）
  turn(h, [request({ minute: 0 }), request({ minute: 2 })]);
  await h.at(51);
  assert.equal(h.sent.length, 0);
  await h.at(52);
  assert.equal(h.sent.length, 1);
  const body = JSON.parse(h.sent[0]!.body.toString("utf8")) as Record<string, unknown>;
  assert.equal(body.max_tokens, 0);
  assert.equal("stream" in body, false);
  assert.deepEqual(body.messages, [{ role: "user", content: "secret tool output" }]);
  assert.equal(h.sent[0]!.accountId, "host");
  assert.equal(h.sent[0]!.path, "/v1/messages?beta=true");
  assert.deepEqual(h.sent[0]!.headers, { "anthropic-beta": "oauth-2025-04-20", "x-claude-code-session-id": "s1" });
  await h.at(101);
  assert.equal(h.sent.length, 1);
  await h.at(102);
  await h.at(152);
  await h.at(202);
  assert.equal(h.sent.length, 4);
  // 4時間を越えたら温めない（要約は #473）
  await h.at(400);
  assert.equal(h.sent.length, 4);
  assert.equal(h.ka.warmingCount(), 0);
  const state = h.ka.cacheOf("t1")!;
  assert.equal(state.lastHit, true);
  assert.equal(state.lastHitAt, T0 + 202 * MIN);
  assert.equal(state.warms, 4);
  assert.equal(state.abandoned, undefined);
  // ログは1回1行、本文の断片は出さない
  assert.equal(h.logs.filter((l) => l.includes("温め直し project=p1 thread=t1 account=host cache_read=59990")).length, 4);
  assert.equal(h.logs.some((l) => l.includes("secret")), false);
});

test("送る時刻は 0〜5分 散らす", async () => {
  const h = harness({ random: () => 1 });
  turn(h, [request()]);
  await h.at(54.9);
  assert.equal(h.sent.length, 0);
  await h.at(55);
  assert.equal(h.sent.length, 1);
});

test("覚えるのはそのターンで入力が最大の要求（あとの小さな副要求で上書きしない）。5万トークン未満は温めない", async () => {
  const h = harness();
  turn(h, [request({ tokens: 80_000, text: "big" }), request({ tokens: 3_000, text: "side", minute: 1 })]);
  await h.at(51);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.body.toString("utf8"), /"big"/);

  const small = harness();
  turn(small, [request({ tokens: 49_999 })]);
  await small.at(300);
  assert.equal(small.sent.length, 0);
  // 本文を持てなかった要求は候補にしない
  const noBody = harness();
  turn(noBody, [request({ body: undefined })]);
  await noBody.at(300);
  assert.equal(noBody.sent.length, 0);
});

test("host が温めてよいと渡さなければ温めない。覚えた要求のセッションがいまのものと違っても温めない", async () => {
  const h = harness();
  turn(h, [request()], null);
  await h.at(300);
  assert.equal(h.sent.length, 0);
  turn(h, [request({ minute: 300 })], { sessionId: "s-after-clear", fingerprint: "fp" });
  await h.at(600);
  assert.equal(h.sent.length, 0);
});

test("止める：次のターンが始まった・止めた・Project を眠らせた・host がもう温めてよくないと言った", async () => {
  // 次のターンが始まった（人が送った・届いたもので起きた）——時計は次の要求から数え直す
  const h = harness();
  turn(h, [request()]);
  await h.at(51);
  assert.equal(h.sent.length, 1);
  h.ka.turnStarted("t1");
  await h.at(101);
  assert.equal(h.sent.length, 1);
  h.ka.observe(request({ minute: 102 }));
  h.ka.turnEnded("t1", TICKET);
  await h.at(151);
  assert.equal(h.sent.length, 1);
  await h.at(152);
  assert.equal(h.sent.length, 2);

  // 閉じた・Clear・やり直し（host が stop を呼ぶ）
  const stopped = harness();
  turn(stopped, [request()]);
  stopped.ka.stop("t1");
  await stopped.at(300);
  assert.equal(stopped.sent.length, 0);

  // 眠らせた（Project ごと）。別の Project は続ける
  const slept = harness();
  turn(slept, [request()]);
  turn(slept, [request({ projectId: "p2", threadId: "t2", key: "p2\u0000s1" })], TICKET, "t2");
  slept.ka.stopProject("p1");
  await slept.at(51);
  assert.deepEqual(
    slept.sent.map((r) => r.threadId),
    ["t2"],
  );

  // モデル・effort・Module の集合を変えた・閉じた等は、送る前に host が答える（印が違う）——送らずにやめ、再開しない
  const changed = harness();
  turn(changed, [request()]);
  changed.warmable.value = false;
  await changed.at(51);
  changed.warmable.value = true;
  await changed.at(300);
  assert.equal(changed.sent.length, 0);
  assert.equal(changed.ka.warmingCount(), 0);
});

test("外れた（cache_creation が入力の1割超）ら、その1回で止めて再開しない。#473 が読む印も残す", async () => {
  const h = harness();
  turn(h, [request()]);
  h.replies.push({ kind: "ok", usage: { inputTokens: 10, cacheReadTokens: 50_000, cacheCreationTokens: 10_000 }, utilization: "5h=10% 7d=5%" });
  await h.at(51);
  assert.equal(h.sent.length, 1);
  await h.at(400);
  assert.equal(h.sent.length, 1);
  const state = h.ka.cacheOf("t1")!;
  assert.equal(state.lastHit, false);
  // 当たったのは最後の本物の要求のとき
  assert.equal(state.lastHitAt, T0);
  assert.equal(state.warming, false);
  assert.match(state.abandoned ?? "", /外れました/);
  // 1割ちょうどまでは当たり
  const edge = harness();
  turn(edge, [request()]);
  edge.replies.push({ kind: "ok", usage: { inputTokens: 0, cacheReadTokens: 54_000, cacheCreationTokens: 6_000 }, utilization: "" });
  await edge.at(51);
  await edge.at(101);
  assert.equal(edge.sent.length, 2);
});

test("送り直さない：失敗（429・401・5xx・通信）したら、その1回で止める。次の時刻にも送らない", async () => {
  for (const reason of ["上流が 429 を返しました", "上流が 401 を返しました", "上流が 503 を返しました", "上流に届きませんでした（ECONNRESET）"]) {
    const h = harness();
    turn(h, [request()]);
    h.replies.push({ kind: "failed", reason });
    await h.at(51);
    await h.at(101);
    await h.at(400);
    assert.equal(h.sent.length, 1, reason);
    assert.match(h.ka.cacheOf("t1")!.abandoned ?? "", /失敗しました/);
  }
  // send が投げても同じ
  const thrown = harness({
    send: async () => {
      throw new Error("boom");
    },
  });
  turn(thrown, [request()]);
  await thrown.at(51);
  assert.match(thrown.ka.cacheOf("t1")!.abandoned ?? "", /boom/);
});

test("余白：固定のアカウントの使用率が閾値より15ポイント下でなければ送らず、止める（余白が戻っても再開しない）", async () => {
  const h = harness();
  turn(h, [request()]);
  h.margin.value = { ok: false, reason: "5時間 85%" };
  await h.at(51);
  assert.equal(h.sent.length, 0);
  h.margin.value = { ok: true };
  await h.at(101);
  assert.equal(h.sent.length, 0);
  assert.match(h.ka.cacheOf("t1")!.abandoned ?? "", /余白/);
  // 次のターンが始まれば止まった印は消える（人が戻ったので、今どおり書き直す）
  h.ka.turnStarted("t1");
  assert.equal(h.ka.cacheOf("t1")!.abandoned, undefined);
});

test("上限：同時に20本まで。超えたら最後の要求が古い会話からやめる", async () => {
  const h = harness();
  for (let i = 0; i <= KEEP_ALIVE_MAX_ENTRIES; i++) {
    turn(h, [request({ threadId: `t${i}`, key: `p1\u0000s${i}`, minute: i * 0.01 })], TICKET, `t${i}`);
  }
  assert.equal(h.ka.warmingCount(), KEEP_ALIVE_MAX_ENTRIES);
  assert.match(h.ka.cacheOf("t0")!.abandoned ?? "", /押し出されました/);
  await h.at(60);
  assert.equal(h.sent.length, KEEP_ALIVE_MAX_ENTRIES);
  assert.equal(h.sent.some((r) => r.threadId === "t0"), false);
});

test("上限：5時間の窓で2,000万トークン（これから送る分を含めて）。超えたら古い会話からやめる", async () => {
  const h = harness({
    send: async (req) => {
      h.sent.push(req);
      return { kind: "ok", usage: hit(2_000_000), utilization: "" };
    },
  });
  // 1本 200万 × 4回 = 800万。3本目で 2,400万 > 2,000万 → 最初の1本をやめる
  turn(h, [request({ tokens: 2_000_000, threadId: "a", minute: 0 })], TICKET, "a");
  turn(h, [request({ tokens: 2_000_000, threadId: "b", minute: 1 })], TICKET, "b");
  assert.equal(h.ka.warmingCount(), 2);
  turn(h, [request({ tokens: 2_000_000, threadId: "c", minute: 2 })], TICKET, "c");
  assert.equal(h.ka.warmingCount(), 2);
  assert.match(h.ka.cacheOf("a")!.abandoned ?? "", /押し出されました/);
  await h.at(60);
  assert.deepEqual(
    h.sent.map((r) => r.threadId),
    ["b", "c"],
  );
});

test("上限：覚えた本文は合計 256MB まで。超えたら古い会話からやめる", async () => {
  const h = harness();
  const big = "x".repeat(30 * 1024 * 1024);
  for (let i = 0; i < 9; i++) {
    turn(h, [request({ threadId: `t${i}`, minute: i, text: big })], TICKET, `t${i}`);
  }
  // 30MB × 9 = 270MB > 256MB
  assert.equal(h.ka.warmingCount(), 8);
  assert.match(h.ka.cacheOf("t0")!.abandoned ?? "", /押し出されました/);
});

test("送っている間に次のターンが始まったら、その結果で予定を作らない", async () => {
  let release!: () => void;
  const h = harness({
    send: async (req) => {
      h.sent.push(req);
      await new Promise<void>((r) => (release = r));
      return { kind: "ok", usage: hit(60_000), utilization: "" };
    },
  });
  turn(h, [request()]);
  h.clock.now = T0 + 51 * MIN;
  const running = h.ka.runDue();
  await new Promise((r) => setImmediate(r));
  h.ka.turnStarted("t1");
  release();
  await running;
  h.ka.turnEnded("t1", undefined);
  await h.at(400);
  assert.equal(h.sent.length, 1);
});

test("#473：4時間の温め直しのあと要約を待ち（本文は次の 50 分まで持つ）、取りやめ（extend）なら 50 分ごとに温め続ける", async () => {
  const changes: string[] = [];
  const h = harness({ onChange: (threadId) => changes.push(threadId) });
  turn(h, [request({ minute: 2 })]);
  assert.equal(h.ka.cacheOf("t1")!.baseAt, T0 + 2 * MIN);
  assert.ok(changes.length >= 1, "温め始めたら知らせる");
  for (const m of [52, 102, 152, 202]) await h.at(m);
  assert.equal(h.sent.length, 4);
  const parked = h.ka.cacheOf("t1")!;
  assert.equal(parked.warming, false);
  assert.equal(parked.baseAt, T0 + 2 * MIN, "要約を待つ間は基準を残す");
  assert.equal(parked.totalWarms, 4);
  assert.equal(parked.totalWarmTokens, 4 * 59_990);
  // 取りやめ——250 分にまた温める
  assert.equal(h.ka.extend("t1"), true);
  assert.equal(h.ka.cacheOf("t1")!.warming, true);
  await h.at(251);
  assert.equal(h.sent.length, 4);
  await h.at(252);
  assert.equal(h.sent.length, 5);
  await h.at(302);
  assert.equal(h.sent.length, 6);
  // 人が戻ったら止まる（合計は残る）
  h.ka.turnStarted("t1");
  const back = h.ka.cacheOf("t1")!;
  assert.equal(back.baseAt, undefined);
  assert.equal(back.warms, 0);
  assert.equal(back.totalWarms, 6);
  await h.at(500);
  assert.equal(h.sent.length, 6);
});

test("#473：取りやめが無ければ、4時間の温め直しのあと持っていた本文は 250 分で捨てる（送らない）", async () => {
  const h = harness();
  turn(h, [request()]);
  for (const m of [50, 100, 150, 200]) await h.at(m);
  assert.equal(h.ka.warmingCount(), 1, "要約を待つ間は本文を持つ");
  await h.at(250);
  assert.equal(h.sent.length, 4);
  assert.equal(h.ka.warmingCount(), 0);
  assert.equal(h.ka.cacheOf("t1")!.baseAt, undefined);
  assert.equal(h.ka.extend("t1"), false, "捨てたあとは続けられない");
});

test("#473：途中でやめたら基準を消し、止まった理由を残す。4時間の前の取りやめは 200 分のあとも続ける", async () => {
  const h = harness();
  turn(h, [request()]);
  h.margin.value = { ok: false, reason: "5h=90%" };
  await h.at(50);
  const state = h.ka.cacheOf("t1")!;
  assert.equal(state.baseAt, undefined);
  assert.match(state.abandoned ?? "", /余白/);

  const early = harness();
  turn(early, [request()]);
  await early.at(50);
  assert.equal(early.ka.extend("t1"), true);
  for (const m of [100, 150, 200, 250, 300]) await early.at(m);
  assert.equal(early.sent.length, 6);
  assert.equal(early.ka.cacheOf("t1")!.warming, true);
});
