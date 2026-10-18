// **上限で止まったターンを、リセットのあと人を待たずに続ける**（決定・2026-10-18、v4-security.md §2「Claude のアカウントを
// 複数持つ」の 9.、Backlog #402）。画面（待ちの帯・ボタン）は #404——ここは host の振る舞いを HTTP と記録で見る。
//
// 偽の Runner（`rateLimit`）が本物の CLI と同じ形で上限に当たる（`rate_limit_event` の `resetsAt`・`error: "rate_limit"`・
// `is_error` の result）。中継は通らない（偽の Runner は API を呼ばない）ので、続ける時刻は `rate_limit_event.resetsAt` から
// 決まる。余白（リセットの1分後）は `BANTO_TEST_RATE_LIMIT_MARGIN_MS=0` で縮める。自前の host（`own-host.ts`）——起こし直すため。
//
// 見るもの（規則14——記録の中身・受信箱まで）：
//   1. 上限で止まる→終わりに印と時刻、受信箱には何も出ない→時刻に banto の届いたもので同じ会話が続く
//   2. 待っている間に人が送ると待ちが外れ、時刻を過ぎても自動では続かない
//   3. 待つのをやめる→続かない（「今すぐ続ける」も断る）。別の待ちで「今すぐ続ける」→すぐ続く
//   4. 続けて上限に当たり続けると、6回続けたところで受信箱で聞く→「続ける」で 0 から続く
//   5. 起こし直しをまたぐ：待っている間に host を止めて起こすと、時刻に続く
//   6. 眠った Project が起きて続く（起きた理由は delivery、終わったら眠りに戻る）
import { test, expect } from "../test-base.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTurn } from "../helpers.js";
import { withOwnHost, type OwnHost } from "../own-host.js";

test.setTimeout(600_000);

const CONTINUE_TITLE = "Claude の使用量の上限が戻ったので、止まったところから続けます";
const GAVE_UP_TITLE = "Claude の使用量の上限に続けて当たったので、自動で続けるのをやめました";
const LIMIT_TEXT = "You've hit your session limit";
/** 続けて続ける回数の上限（core の `RATE_LIMIT_CONTINUE_LIMIT`） */
const CONTINUE_LIMIT = 6;

interface HostThread {
  id: string;
  messages: Array<{ role: string; text: string; origin?: { from: string; title: string } }>;
  deliveries?: unknown[];
  lastTurn?: {
    turnId: string;
    attempt: number;
    cause: string;
    outcome?: string;
    continuesReason?: string;
    rateLimit?: { continueAt?: string };
    continuationCancelled?: string;
  };
}
interface InboxEntry {
  id: string;
  kind: string;
  title?: string;
  threadId?: string;
  dedupeKey?: string;
  resume?: { threadId: string; turnId: string };
}

async function api<T>(host: OwnHost, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}
const get = async <T>(host: OwnHost, path: string): Promise<T> => {
  const r = await api<T>(host, "GET", path);
  if (r.status !== 200) throw new Error(`${path} が ${r.status}`);
  return r.body;
};
const threadOf = (host: OwnHost, id: string) => get<HostThread>(host, `/api/threads/${id}`);

async function createProject(host: OwnHost, name: string): Promise<{ id: string; threadId: string }> {
  const r = await api<{ id: string }>(host, "POST", "/api/projects", { name, root: mkdtempSync(join(tmpdir(), "banto-e2e-rate-limit-")) });
  expect(r.status).toBe(201);
  const t = await api<{ id: string }>(host, "POST", `/api/projects/${r.body.id}/threads`);
  expect(t.status).toBe(201);
  return { id: r.body.id, threadId: t.body.id };
}

/** 人が送ったターンを最後まで流す（流れの中に error が無いことも見る） */
async function send(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const stream = await res.text();
  expect(res.status, stream.slice(0, 500)).toBe(200);
  expect(stream, "ターンが error で終わった").not.toContain('"type":"error"');
}

/** 上限で止まるターンを送り、待ちが立ったことを確かめる。待ちの時刻を返す */
async function sendLimited(host: OwnHost, threadId: string, resetInMs: number, times = 1): Promise<number> {
  const before = Date.now();
  await send(host, threadId, "作って。" + fakeTurn({ rateLimit: { resetInMs, times } }));
  const t = await threadOf(host, threadId);
  expect(t.messages.at(-1)?.role, "上限の文が記録に無い").toBe("assistant");
  expect(t.messages.at(-1)?.text).toContain(LIMIT_TEXT);
  const continueAt = Date.parse(t.lastTurn?.rateLimit?.continueAt ?? "");
  expect(Number.isFinite(continueAt), `待ちの時刻が無い：${JSON.stringify(t.lastTurn)}`).toBe(true);
  // 時刻は resetsAt（今から resetInMs 後の秒）——余白は 0
  expect(continueAt).toBeGreaterThanOrEqual(Math.floor((before + resetInMs) / 1000) * 1000);
  expect(continueAt).toBeLessThanOrEqual(Date.now() + resetInMs + 1_000);
  return continueAt;
}

/** banto の上限の続き（届いたもの）の数 */
const continuations = (t: HostThread) => t.messages.filter((m) => m.origin?.from === "banto" && m.origin.title === CONTINUE_TITLE).length;

/** 上限の続きのターンが最後まで行くまで待つ */
async function expectContinued(host: OwnHost, threadId: string, count: number, timeout = 60_000): Promise<HostThread> {
  await expect
    .poll(
      async () => {
        const t = await threadOf(host, threadId);
        return `${continuations(t)}:${t.lastTurn?.continuesReason ?? "-"}:${t.lastTurn?.outcome ?? "running"}:${t.lastTurn?.rateLimit ? "limited" : "-"}`;
      },
      { timeout, message: "上限の続きが最後まで行かない" },
    )
    .toBe(`${count}:rate_limit:completed:-`);
  return threadOf(host, threadId);
}

/** その Thread についての受信箱の項目（レビュー待ち・お知らせ） */
async function inboxFor(host: OwnHost, threadId: string, projectId: string): Promise<InboxEntry[]> {
  const items = await get<Array<InboxEntry & { projectId?: string }>>(host, "/api/inbox");
  return items.filter((i) => i.threadId === threadId || i.resume?.threadId === threadId || (i.kind === "notice" && i.projectId === projectId));
}

test("上限で止まったターンが、時刻に自動で続く・人が送ると外れる・やめられる・6回で受信箱・起こし直しと眠りをまたぐ", async () => {
  await withOwnHost(
    async (host) => {
      // ---- 1. 上限で止まる→時刻に自動で続く -----------------------------------------------------------------
      const p1 = await createProject(host, "E2E Rate Limit");
      const continueAt = await sendLimited(host, p1.threadId, 4_000);
      // 人の番ではない——レビュー待ちもお知らせも出ない
      expect(await inboxFor(host, p1.threadId, p1.id), "待っているのに受信箱に出た").toEqual([]);
      let t = await expectContinued(host, p1.threadId, 1);
      expect(Date.now(), "時刻より前に続けた").toBeGreaterThanOrEqual(continueAt);
      expect(t.messages.map((m) => (m.origin ? `delivered:${m.origin.from}` : m.role))).toEqual(["user", "assistant", "delivered:banto", "assistant"]);
      expect(t.messages[2]!.text).toContain("上限が戻ったので、止まったところから続けてください");
      expect(t.messages[3]!.text, "続きのターンの返事が無い").toBe("はい");
      expect(t.lastTurn?.cause).toBe("delivery");
      expect(t.lastTurn?.attempt).toBe(1);
      expect(t.deliveries ?? []).toEqual([]);
      expect((await inboxFor(host, p1.threadId, p1.id)).filter((i) => i.kind === "notice"), "続けたのにお知らせが出た").toEqual([]);

      // ---- 2. 待っている間に人が送ると待ちが外れる ---------------------------------------------------------------
      const at2 = await sendLimited(host, p1.threadId, 6_000);
      await send(host, p1.threadId, "どうなった？");
      t = await threadOf(host, p1.threadId);
      expect(t.lastTurn?.cause).toBe("human");
      expect(t.lastTurn?.rateLimit, "人が送ったのに待ちが残っている").toBeUndefined();
      expect(t.messages.at(-1)?.text).toBe("はい");
      await new Promise((r) => setTimeout(r, Math.max(0, at2 - Date.now()) + 3_000));
      expect(continuations(await threadOf(host, p1.threadId)), "人が送ったのに自動で続けた").toBe(1);

      // ---- 3. 待つのをやめる・今すぐ続ける -------------------------------------------------------------------------
      const at3 = await sendLimited(host, p1.threadId, 6_000);
      expect((await api(host, "POST", `/api/threads/${p1.threadId}/rate-limit-wait/cancel`)).status).toBe(200);
      t = await threadOf(host, p1.threadId);
      expect(t.lastTurn?.continuationCancelled).toBe("human");
      expect((await api(host, "POST", `/api/threads/${p1.threadId}/rate-limit-wait/continue`)).status, "やめた待ちを続けられた").toBe(409);
      await new Promise((r) => setTimeout(r, Math.max(0, at3 - Date.now()) + 3_000));
      expect(continuations(await threadOf(host, p1.threadId)), "やめたのに自動で続けた").toBe(1);
      // 別の待ち（1時間後）を「今すぐ続ける」
      await sendLimited(host, p1.threadId, 3_600_000);
      expect((await api(host, "POST", `/api/threads/${p1.threadId}/rate-limit-wait/continue`)).status).toBe(200);
      await expectContinued(host, p1.threadId, 2);

      // ---- 4. 続けて上限に当たり続けると、6回続けたところで受信箱で聞く ------------------------------------------------
      await sendLimited(host, p1.threadId, 0, CONTINUE_LIMIT + 1);
      let notice: InboxEntry | undefined;
      // お知らせはターンの終わりを書く直前に出る——終わり（続ける時刻の無い上限の印）まで待つ
      await expect
        .poll(
          async () => {
            notice = (await inboxFor(host, p1.threadId, p1.id)).find((i) => i.kind === "notice" && i.title === GAVE_UP_TITLE);
            const last = (await threadOf(host, p1.threadId)).lastTurn;
            return `${notice !== undefined}:${last?.outcome ?? "running"}:${JSON.stringify(last?.rateLimit ?? null)}`;
          },
          { timeout: 90_000, message: "受信箱で聞かない" },
        )
        .toBe("true:completed:{}");
      t = await threadOf(host, p1.threadId);
      expect(continuations(t), "6回続けていない").toBe(2 + CONTINUE_LIMIT);
      expect(t.lastTurn?.attempt).toBe(CONTINUE_LIMIT);
      expect(t.lastTurn?.rateLimit?.continueAt, "やめたのに待っている").toBeUndefined();
      expect(t.messages.at(-1)?.text).toContain(LIMIT_TEXT);
      expect(notice!.resume?.threadId).toBe(p1.threadId);
      expect((await inboxFor(host, p1.threadId, p1.id)).filter((i) => i.kind === "review"), "上限の回にレビュー待ちが出た").toEqual([]);
      // 「続ける」で 0 から続く
      expect((await api(host, "POST", `/api/inbox/${notice!.id}/resume`)).status).toBe(200);
      t = await expectContinued(host, p1.threadId, 3 + CONTINUE_LIMIT);
      expect(t.lastTurn?.attempt, "人が続けたのに数え直していない").toBe(0);
      expect(t.messages.at(-1)?.text).toBe("はい");
      expect((await inboxFor(host, p1.threadId, p1.id)).find((i) => i.id === notice!.id), "続けたのにお知らせが開いている").toBeUndefined();

      // ---- 5. 起こし直しをまたぐ -------------------------------------------------------------------------------------
      const p2 = await createProject(host, "E2E Rate Limit Restart");
      const at5 = await sendLimited(host, p2.threadId, 15_000);
      await host.stop("SIGTERM");
      await host.start();
      expect((await threadOf(host, p2.threadId)).lastTurn?.rateLimit?.continueAt, "起こし直したら待ちが消えた").toBe(new Date(at5).toISOString());
      t = await expectContinued(host, p2.threadId, 1);
      expect(Date.now()).toBeGreaterThanOrEqual(at5);
      expect(t.messages.at(-1)?.text).toBe("はい");

      // ---- 6. 眠った Project が起きて続く --------------------------------------------------------------------------
      const p3 = await createProject(host, "E2E Rate Limit Sleep");
      await sendLimited(host, p3.threadId, 30_000);
      // 待ちは「動いているもの」に数えない——眠らせられる
      await expect
        .poll(async () => (await api<{ error?: string }>(host, "POST", `/api/projects/${p3.id}/sleep`)).status, { timeout: 25_000, message: "待っている Project を眠らせられない" })
        .toBe(200);
      const project = async () => (await get<Array<{ id: string; sleep?: { by: string } }>>(host, "/api/projects")).find((p) => p.id === p3.id)!;
      expect((await project()).sleep?.by).toBe("human");
      t = await expectContinued(host, p3.threadId, 1, 90_000);
      expect(t.messages.at(-1)?.text).toBe("はい");
      const woke = readFileSync(join(host.dataDir, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type: string; payload: { id?: string; cause?: string } })
        .filter((e) => e.type === "project.woke" && e.payload.id === p3.id)
        .map((e) => e.payload.cause);
      expect(woke, "続きで起きていない").toEqual(["delivery"]);
      // 用事で起きたので、終わったら眠りに戻る
      await expect.poll(async () => (await project()).sleep?.by, { timeout: 60_000, message: "続けたあと眠りに戻らない" }).toBe("auto");
    },
    { env: { BANTO_TEST_RATE_LIMIT_MARGIN_MS: "0" } },
  );
});
