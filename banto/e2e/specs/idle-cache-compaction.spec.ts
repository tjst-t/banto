// **空いた会話の冷める前の要約**（Backlog #473 `idle-cache-compaction`、`docs/specs/v4-architecture.md` §3.1「冷める前の要約（host）」、
// v4-frontend.md §6.52）。
//
// 偽の Runner（`relayRequests`＋`relayCacheReadTokens`）が大きな会話の要求を中継に送り、中継の上流は偽の API（`fake-anthropic.ts`）。
// 1分は `BANTO_TEST_KEEP_ALIVE_MINUTE_MS` で 200ms に縮める——温め直しは 10・20・30・40 秒、要約は 45 秒。帯は要約の 8 秒前から
// （`BANTO_TEST_IDLE_COMPACTION_NOTICE_MS`。5分＝1秒では画面を操作しきれない）。偽の Runner は prompt `/compact` を受けると、同じ
// セッションの要求を1つ中継に送り（印 `x-e2e-compact`）、2秒かけて compact_boundary を出す。
//
// 見るもの（規則14——口の値・上流に届いたもの・画面の文まで）：
//   A. 4時間空いた会話が要約される：225 分に同じセッション・同じアカウントで要約の要求が1つ、200 分の温め直しの後。会話に
//      「4時間空いたので…要約しました」の印、受信箱にレビュー待ちが出ない、サイドバーの未読も付かない、最後のターンは人のターンの
//      まま、予定（idleCompactionAt）は消える。要約のあとは温めない
//   B. 帯で取りやめられる：帯が出ている会話の入力欄で1打鍵すると帯が消え、予定が消え、225 分を過ぎても要約しない。温め直しは
//      4時間を越えて続く（250 分）
//   C. 温め直しが外れた会話は要約しない：50 分の温め直しが外れたら、予定が消え、225 分を過ぎても要約の要求が来ない
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic, type FakeAnthropic } from "../fake-anthropic.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(420_000);

/** E2E の core と同じ最初の1つの置き場のトークン（`start-core.ts`） */
const HOST_TOKEN = "e2e-not-a-token";
/** 1分＝200ms */
const MINUTE_MS = 200;
/** 帯は要約の 8 秒前（40 分ぶん）から */
const NOTICE_MS = 8_000;
const IDLE_MARK = "4時間空いたので、続きの費用を抑えるために要約しました";

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

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

const warms = (fakeApi: FakeAnthropic, session: string) => fakeApi.replies.filter((r) => r.session === session && r.maxTokens === 0);
const compacts = (fakeApi: FakeAnthropic, session: string) => fakeApi.replies.filter((r) => r.session === session && r.compact);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ThreadView {
  idleCompactionAt: string | null;
  markers: Array<{ seq: number; kind: string; reason?: string }>;
  messages: Array<{ role: string }>;
  lastTurn?: { cause: string; turnId: string };
}

/** 新しい Fork を立て、用意のターンを済ませてから大きな会話のターンを1本。そのセッションと要求を受けた時刻を返す */
async function bigThread(
  host: OwnHost,
  fakeApi: FakeAnthropic,
  projectId: string,
  label: string,
  opts: { warmMiss?: boolean } = {},
): Promise<{ threadId: string; session: string; at: number }> {
  const threadId = (await api<{ id: string }>(host, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
  await send(host, threadId, `${label}のはじめまして`);
  const before = fakeApi.replies.length;
  await send(host, threadId, `${label}${fakeTurn({ relayRequests: 1, relayCacheReadTokens: 80_000, ...(opts.warmMiss ? { relayWarmMiss: true } : {}), say: "はい" })}`);
  const mine = fakeApi.replies.slice(before).filter((r) => r.path.startsWith("/v1/messages?") && r.maxTokens !== 0);
  expect(mine, "中継を通った会話の要求が1つ").toHaveLength(1);
  return { threadId, session: mine[0]!.session!, at: mine[0]!.at };
}

/** その Thread の開いているレビュー待ちを「見た」にする（このあと出たら、要約のターンが出したもの） */
async function acknowledgeReviews(host: OwnHost, threadId: string): Promise<void> {
  const items = (await api<Array<{ id: string; kind: string; threadId?: string }>>(host, "/api/inbox")).body;
  for (const item of items.filter((i) => i.kind === "review" && i.threadId === threadId)) {
    const res = await api(host, `/api/inbox/${item.id}/acknowledge`, { method: "POST" });
    expect(res.status).toBe(200);
  }
}

test("4時間空いた会話は冷める前に要約され、会話に印が出て受信箱に出ない。帯で取りやめられ、温め直しが外れた会話は要約しない", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-idle-compaction-"));
  try {
    await withOwnHost(
      async (own) => {
        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: "E2E 冷める前の要約", root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;

        // ---- A と C を並べて始める（C は 50 分の温め直しが外れる） -----------------------------------------------
        const a = await bigThread(own, fakeApi, projectId, "A：");
        const c = await bigThread(own, fakeApi, projectId, "C：", { warmMiss: true });
        await acknowledgeReviews(own, a.threadId);
        const aBefore = (await api<ThreadView>(own, `/api/threads/${a.threadId}`)).body;
        // 予定は最後の本物の要求の開始から 225 分
        expect(aBefore.idleCompactionAt).not.toBeNull();
        expect(Date.parse(aBefore.idleCompactionAt!) - a.at).toBeGreaterThanOrEqual(225 * MINUTE_MS - 50);
        expect(Date.parse(aBefore.idleCompactionAt!) - a.at).toBeLessThan(225 * MINUTE_MS + 1_000);

        // ---- C：50 分の温め直しが外れたら予定が消える ------------------------------------------------------------
        await expect.poll(() => warms(fakeApi, c.session).length, { timeout: 30_000, intervals: [250] }).toBe(1);
        await expect
          .poll(async () => (await api<ThreadView>(own, `/api/threads/${c.threadId}`)).body.idleCompactionAt, { timeout: 5_000 })
          .toBeNull();

        // ---- A：225 分に要約される ---------------------------------------------------------------------------------
        await expect.poll(() => compacts(fakeApi, a.session).length, { timeout: 70_000, intervals: [250] }).toBe(1);
        const compact = compacts(fakeApi, a.session)[0]!;
        const aWarms = warms(fakeApi, a.session);
        expect(aWarms, "50・100・150・200 分の温め直しのあと").toHaveLength(4);
        expect(compact.at).toBeGreaterThan(aWarms[3]!.at);
        expect(compact.at - a.at).toBeGreaterThanOrEqual(225 * MINUTE_MS);
        expect(compact.token, "同じアカウント").toBe(HOST_TOKEN);
        expect(compact.status).toBe(200);
        // 会話に印（fold から）。発言は増えない、最後のターンは人のターンのまま、予定は消える
        await expect
          .poll(async () => (await api<ThreadView>(own, `/api/threads/${a.threadId}`)).body.markers.filter((m) => m.kind === "compact"), { timeout: 15_000 })
          .toEqual([expect.objectContaining({ kind: "compact", reason: "idle" })]);
        const aAfter = (await api<ThreadView>(own, `/api/threads/${a.threadId}`)).body;
        expect(aAfter.messages).toHaveLength(aBefore.messages.length);
        expect(aAfter.lastTurn?.turnId).toBe(aBefore.lastTurn?.turnId);
        expect(aAfter.lastTurn?.cause).toBe("human");
        expect(aAfter.idleCompactionAt).toBeNull();
        // 受信箱に出さない（成功したターン）
        const inbox = (await api<Array<{ kind: string; threadId?: string }>>(own, "/api/inbox")).body;
        expect(inbox.filter((i) => i.threadId === a.threadId), JSON.stringify(inbox)).toEqual([]);

        // C は 225 分を過ぎても要約しない
        await sleep(Math.max(0, c.at + 230 * MINUTE_MS - Date.now()));
        expect(compacts(fakeApi, c.session), "温め直しが外れた会話を要約した").toEqual([]);
        expect(warms(fakeApi, c.session), "外れたら温め直しもやめる").toHaveLength(1);

        // ---- 画面：A の会話に印、サイドバーに未読は付かない -------------------------------------------------------
        // 未読（太字）は開いているレビュー待ちから出る——C の分は先に「見た」にして、残る印は要約のターンが出したものだけにする
        await acknowledgeReviews(own, c.threadId);
        await login(page, own);
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&fork=${a.threadId}`);
        await expect(page.getByPlaceholder(/に送る/).first()).toBeVisible({ timeout: 30_000 });
        const mark = page.locator('[data-testid="thread-marker"][data-kind="compact"][data-reason="idle"]');
        await expect(mark).toHaveCount(1, { timeout: 15_000 });
        await expect(mark).toHaveText(IDLE_MARK);
        // 要約のあとは温めない
        const warmsAfterCompact = warms(fakeApi, a.session).length;

        // ---- B：帯で取りやめる ------------------------------------------------------------------------------------
        const b = await bigThread(own, fakeApi, projectId, "B：");
        await page.goto(`/p/${projectId}?bantoHost=${own.url}&fork=${b.threadId}`);
        const composer = page.getByPlaceholder(/に送る/).first();
        await expect(composer).toBeVisible({ timeout: 30_000 });
        // 帯は要約の 8 秒前から（それまでは出ない）
        const notice = page.getByTestId("thread-idle-compaction-notice");
        await expect(notice).toHaveCount(0);
        await expect(notice).toBeVisible({ timeout: 60_000 });
        await expect(notice).toContainText("まもなく要約します");
        const planned = (await api<ThreadView>(own, `/api/threads/${b.threadId}`)).body.idleCompactionAt;
        expect(planned).not.toBeNull();
        expect(Date.parse(planned!) - Date.now(), "帯が出たのは要約の前").toBeGreaterThan(0);
        // 入力欄で1打鍵——取りやめ（押す操作と分けて見るため、焦点だけ当てる）
        await composer.focus();
        await composer.press("x");
        await expect(notice).toHaveCount(0, { timeout: 5_000 });
        await expect.poll(async () => (await api<ThreadView>(own, `/api/threads/${b.threadId}`)).body.idleCompactionAt, { timeout: 5_000 }).toBeNull();
        // 225 分を過ぎても要約しない。温め直しは4時間を越えて続く（250 分）
        await expect.poll(() => warms(fakeApi, b.session).length, { timeout: 70_000, intervals: [250] }).toBe(5);
        expect(warms(fakeApi, b.session)[4]!.at - b.at).toBeGreaterThanOrEqual(250 * MINUTE_MS);
        expect(compacts(fakeApi, b.session), "取りやめたのに要約した").toEqual([]);
        // 打った文字は入力欄に残っている（取りやめは書きかけを消さない）
        await expect(composer).toHaveValue("x");

        expect(warms(fakeApi, a.session).length, "要約したあとに温め直した").toBe(warmsAfterCompact);
        // サイドバーに未読（太字）の会話・Project が無い——A の要約のターンは受信箱に出していない（B は開いて見た）
        await expect(page.locator("[data-unread]")).toHaveCount(0, { timeout: 10_000 });
      },
      {
        env: {
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_TEST_KEEP_ALIVE_MINUTE_MS: String(MINUTE_MS),
          BANTO_TEST_IDLE_COMPACTION_NOTICE_MS: String(NOTICE_MS),
        },
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(root, { recursive: true, force: true });
  }
});
