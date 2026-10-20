// **空いた会話のキャッシュの温め直し**（Backlog #472 `idle-cache-keepalive`、`docs/specs/v4-architecture.md` §3.1「温め直し（中継）」）。
//
// 偽の Runner（`relayRequests`＋`relayCacheReadTokens`）が会話の本体と同じ道で中継に大きな会話の要求（stream・cache_read 8万）を
// 送り、中継の上流は偽の API（`fake-anthropic.ts`）。温め直しの時刻の1分は `BANTO_TEST_KEEP_ALIVE_MINUTE_MS` で 200ms に縮める
// ——50分＝10秒、散らす幅は 0〜1秒。本物の CLI は起こさない。画面の要素は無い（中継と host の仕組みだけ）ので、上流に届いたもので見る。
//
// 見るもの：
//   1. 空いた会話に温め直しが届く：最後の要求から「50分」以降に、同じセッション・同じアカウントのトークンで、max_tokens 0・stream
//      無し・Thread の印無し。「100分」にも2回目が届く
//   2. 人が送れば止まる：次のターンが始まったら（そのターンは中継を呼ばない）、それより後には温め直しが届かない
//   3. Project の「空いた会話の要約」を切ると、その Project の会話は温めない
import { test, expect } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic, type FakeAnthropic } from "../fake-anthropic.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

/** E2E の core と同じ最初の1つの置き場のトークン（`start-core.ts`） */
const HOST_TOKEN = "e2e-not-a-token";
/** 1分＝200ms */
const MINUTE_MS = 200;

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** ターンを1本最後まで（流れの中に error が無いことも見る） */
async function send(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(200);
  expect(text, "ターンが error で終わった").not.toContain('"type":"error"');
}

/** そのセッションの本物の要求（中継を通った会話の要求。温め直しではない） */
const realRequests = (fakeApi: FakeAnthropic, session: string) =>
  fakeApi.replies.filter((r) => r.session === session && r.path.startsWith("/v1/messages?") && r.maxTokens !== 0);
const warms = (fakeApi: FakeAnthropic, session: string) => fakeApi.replies.filter((r) => r.session === session && r.maxTokens === 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 大きな会話のターン（中継に1回、cache_read 8万）を1本送り、そのセッションと要求を受けた時刻を返す */
async function bigTurn(host: OwnHost, fakeApi: FakeAnthropic, threadId: string, label: string): Promise<{ session: string; at: number }> {
  const before = fakeApi.replies.length;
  await send(host, threadId, `${label}${fakeTurn({ relayRequests: 1, relayCacheReadTokens: 80_000, say: "はい" })}`);
  const mine = fakeApi.replies.slice(before).filter((r) => r.path.startsWith("/v1/messages?") && r.maxTokens !== 0);
  expect(mine, "中継を通った会話の要求が1つ").toHaveLength(1);
  const req = mine[0]!;
  // 中継は本物の要求を変えずに流す（stream のまま・Thread の印は剥がす）
  expect(req.stream).toBe(true);
  expect(req.threadHeader).toBeNull();
  expect(req.session, "セッションの印がある").not.toBeNull();
  return { session: req.session!, at: req.at };
}

test("空いた会話に温め直しが届き、人が送れば止まる。空いた会話の要約を切った Project は温めない", async () => {
  const fakeApi = await startFakeAnthropic();
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-keepalive-"));
  try {
    await withOwnHost(
      async (own) => {
        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: "E2E 温め直し", root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        // 最初のターンは Project の用意（コンテナ・Module）を含んで遅い——先に済ませる（中継は呼ばない）
        await send(own, threadId, "はじめまして");

        // ---- 1. 空いた会話に温め直しが届く -----------------------------------------------------------------
        const first = await bigTurn(own, fakeApi, threadId, "大きな会話。");
        // 50分（10秒）＋散らす幅（1秒）＋余裕
        await expect.poll(() => warms(fakeApi, first.session).length, { timeout: 30_000, intervals: [250] }).toBeGreaterThanOrEqual(1);
        const warm1 = warms(fakeApi, first.session)[0]!;
        expect(warm1.token, "同じアカウント（最初の1つ）のトークン").toBe(HOST_TOKEN);
        expect(warm1.maxTokens).toBe(0);
        expect(warm1.stream, "stream を外す").toBeUndefined();
        expect(warm1.threadHeader, "Thread の印は上流へ付けない").toBeNull();
        expect(warm1.status).toBe(200);
        // 最後の要求から 50分以降・55分以内（散らす幅）
        expect(warm1.at - first.at).toBeGreaterThanOrEqual(50 * MINUTE_MS);
        expect(warm1.at - first.at).toBeLessThan(55 * MINUTE_MS + 2_000);
        // 当たったので続ける：100分に2回目
        await expect.poll(() => warms(fakeApi, first.session).length, { timeout: 30_000, intervals: [250] }).toBe(2);
        const warm2 = warms(fakeApi, first.session)[1]!;
        expect(warm2.at - first.at).toBeGreaterThanOrEqual(100 * MINUTE_MS);
        // 温め直しは会話の記録に出さない（AI の発言が増えない）
        const assistantCount = async () =>
          (await api<{ messages: Array<{ role: string }> }>(own, `/api/threads/${threadId}`)).body.messages.filter((m) => m.role === "assistant").length;
        const repliesBefore = await assistantCount();

        // ---- 2. 人が送れば止まる ------------------------------------------------------------------------------
        // 中継を呼ばないターン（候補が無い）——始まった時点で温め直しは止まり、終わっても新しく温めない
        await send(own, threadId, "戻りました");
        expect(await assistantCount()).toBe(repliesBefore + 1);
        const stoppedAt = Date.now();
        const warmsAtStop = warms(fakeApi, first.session).length;
        // 次の予定（150分＝30秒＋散らす幅）を越えるまで見て、届かない
        const nextDue = first.at + 155 * MINUTE_MS + 2_000;
        await sleep(Math.max(0, nextDue - Date.now()));
        expect(warms(fakeApi, first.session).filter((w) => w.at >= stoppedAt), "人が送ったあとに温め直しが届いた").toEqual([]);
        expect(warms(fakeApi, first.session).length).toBe(warmsAtStop);
        expect(realRequests(fakeApi, first.session)).toHaveLength(1);

        // ---- 3. 空いた会話の要約を切った Project は温めない ---------------------------------------------------
        const off = await api<{ enabled: boolean }>(own, `/api/projects/${projectId}/idle-compaction`, { method: "PUT", body: { enabled: false } });
        expect(off.status, JSON.stringify(off.body)).toBe(200);
        expect(off.body.enabled).toBe(false);
        const second = await bigTurn(own, fakeApi, threadId, "切ったあとの大きな会話。");
        expect(second.session).toBe(first.session);
        const afterOff = warms(fakeApi, second.session).length;
        await sleep(Math.max(0, second.at + 55 * MINUTE_MS + 2_000 - Date.now()));
        expect(warms(fakeApi, second.session).length, "切った Project で温め直しが届いた").toBe(afterOff);

        // 入れ直すと、次のターンの終わりからまた温める
        const on = await api<{ enabled: boolean }>(own, `/api/projects/${projectId}/idle-compaction`, { method: "PUT", body: { enabled: true } });
        expect(on.body.enabled).toBe(true);
        const third = await bigTurn(own, fakeApi, threadId, "入れ直したあとの大きな会話。");
        await expect
          .poll(() => warms(fakeApi, third.session).filter((w) => w.at > third.at).length, { timeout: 30_000, intervals: [250] })
          .toBe(1);
      },
      {
        env: {
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_TEST_KEEP_ALIVE_MINUTE_MS: String(MINUTE_MS),
        },
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(root, { recursive: true, force: true });
  }
});
