// **Claude のアカウントを均す**（Backlog #417 `balance-core`、`docs/specs/v4-security.md` §2「均す」）。
//
// 本物の CLI（会話の本体）を偽の上流（`fake-anthropic.ts`——トークンごとに使用率の見出しを付け、要求のセッションの印を
// とっておく）に当てる。アカウントを足すので自前の host（`own-host.ts`）。使い方は既定（均す）のまま。
//
// 見るもの（規則14——どのアカウントがどのセッションに答えたか・記録・口の中身まで）：
//   1. 2つの会話が別のアカウントに固定される：host が重くなったあとに始めた会話は余裕のある B へ
//   2. 同じ会話は同じアカウント：host が B より重くなっても、host に固定した会話のセッションの要求は全部 host
//   3. 閾値越えで移る：host が 97% と返したら、その会話の次の要求から B。切り替えはその会話に1件
//   4. 切り替えの1行は選び直しでは出ない：最初の選び（2つ目の会話が B を選んだ）では1行も出ない
//   5. 口：その会話の固定先（`GET /api/threads/:id/claude-account`）・Project の使い方と固定先・設定の「いま使っている Project」
import { test, expect, type Page } from "../test-base.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRONTEND_BASE_URL } from "../config.js";
import { withOwnHost, type OwnHost } from "../own-host.js";
import { startFakeAnthropic } from "../fake-anthropic.js";
import { writeLoginLink } from "../../packages/core/dist/auth/login-links.js";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

/** 試験を流している側の Claude Code の環境（本物の CLI に持ち込まない） */
const OUTER_CLAUDE_ENV = Object.keys(process.env).filter((k) => /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|ANTHROPIC_.*)$/.test(k));
/** E2E の core と同じ最初の1つの置き場のトークン（`start-core.ts`） */
const HOST_TOKEN = "e2e-not-a-token";

interface Switch {
  from: string;
  to: string;
  reason: { kind: string; window?: string; utilization?: number };
}

async function api<T>(host: OwnHost, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${host.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

/** 人のセッションで（アカウントを足すのは人だけ） */
async function human<T>(page: Page, host: OwnHost, method: "GET" | "POST" | "PUT", path: string, data?: unknown): Promise<{ status: number; body: T }> {
  const res = await page.context().request.fetch(`${host.url}${path}`, {
    method,
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    ...(data !== undefined ? { data } : {}),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : undefined) as T };
}

async function login(page: Page, host: OwnHost): Promise<void> {
  const { code } = await writeLoginLink(host.dataDir);
  const res = await page.context().request.post(`${host.url}/api/auth/redeem`, {
    headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
    data: { code },
  });
  if (!res.ok()) throw new Error(`自前の host にログインできませんでした：${res.status()} ${await res.text()}`);
}

/** ターンを1本最後まで。SSE の終わりまで読む */
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<void> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
}

const secondsFromNow = (s: number) => Math.floor(Date.now() / 1000) + s;

test("均す：2つの会話が別のアカウントに固定され、同じ会話は同じアカウント、閾値越えで移る。最初の選びは切り替えの1行にならない", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-balance-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-balance-root-"));
  try {
    await withOwnHost(
      async (own) => {
        await login(page, own);
        // ---- アカウント B を足す（画面と同じ口） ----------------------------------------------------------------
        fakeApi.addLogin("code-b", { accessToken: "tok-b", email: "b@example.com" });
        const started = await human<{ loginId: string; url: string }>(page, own, "POST", "/api/claude-accounts/login");
        const state = new URL(started.body.url).searchParams.get("state");
        const finished = await human<{ account: { id: string } }>(page, own, "POST", `/api/claude-accounts/login/${started.body.loginId}`, { pasted: `code-b#${state}` });
        expect(finished.status, JSON.stringify(finished.body)).toBe(200);
        const bId = finished.body.account.id;
        const nameOf = (id: string) => (id === bId ? "b" : id);
        const tokenName: Record<string, string> = { [HOST_TOKEN]: "host", "tok-b": "b" };
        // 既定は均す
        const listed = await human<{ mode: string; defaultOrder: string[] }>(page, own, "GET", "/api/claude-accounts");
        expect(listed.body).toMatchObject({ mode: "balance", defaultOrder: ["host", bId] });

        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: "E2E 均す", root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const projectView = await human<{ mode: string | null; effectiveMode: string }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(projectView.body).toMatchObject({ mode: null, effectiveMode: "balance" });
        const newThread = async () => (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        const t1 = await newThread();
        const t2 = await newThread();
        const pinnedOf = async (threadId: string) => (await api<{ accountId?: string }>(own, `/api/threads/${threadId}/claude-account`)).body.accountId;
        const switchesOf = async (threadId: string) =>
          ((await api<{ accountSwitches?: Switch[] }>(own, `/api/threads/${threadId}`)).body.accountSwitches ?? []).map(
            (s) => `${nameOf(s.from)}→${nameOf(s.to)} ${s.reason.kind}${s.reason.window ? ` ${s.reason.window} ${s.reason.utilization}` : ""}`,
          );
        /** その文を最後の user の発言に持つ要求（会話の要求） */
        const requestOf = (said: string) => fakeApi.requests.filter((r) => [...r.messages].reverse().find((m) => m.role === "user")?.text.includes(said)).at(-1);
        expect(await pinnedOf(t1), "まだ送っていない会話に固定先がある").toBeUndefined();

        // 使用率：host 20%・B 25%（選ぶ前の読み直しでも同じ値が返る）
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.2, resetsAt: secondsFromNow(4 * 3600) } });
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.25, resetsAt: secondsFromNow(4 * 3600) } });

        // ---- 1. 会話1は余裕のある host に固定 -----------------------------------------------------------------------
        await sendTurn(own, t1, "会話1の1回目。合言葉は one-1");
        const s1 = requestOf("合言葉は one-1")?.session;
        expect(s1, "会話の要求にセッションの印が無い").toBeTruthy();
        expect(requestOf("合言葉は one-1")?.auth).toBe(`Bearer ${HOST_TOKEN}`);
        expect(await pinnedOf(t1)).toBe("host");
        // host が人の claude で 50% まで使われた（会話1の次の要求の見出しで分かる）
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.5, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, t1, "会話1の2回目。合言葉は two-2");
        expect(requestOf("合言葉は two-2")?.auth, "同じ会話なのに host から動いた").toBe(`Bearer ${HOST_TOKEN}`);

        // ---- 2. 会話2は余裕のある B に固定 ------------------------------------------------------------------------
        await sendTurn(own, t2, "会話2の1回目。合言葉は three-3");
        const s2 = requestOf("合言葉は three-3")?.session;
        expect(s2).toBeTruthy();
        expect(s2, "2つの会話が同じセッションの印").not.toBe(s1);
        expect(requestOf("合言葉は three-3")?.auth, "host が 50% なのに会話2が B（25%）に固定されていない").toBe("Bearer tok-b");
        expect(await pinnedOf(t2)).toBe(bId);
        // ---- 同じ会話は同じアカウント：host のほうが重くても会話1は host のまま（キャッシュを崩さない） --------------------
        await sendTurn(own, t1, "会話1の3回目。合言葉は four-4");
        expect(requestOf("合言葉は four-4")?.auth, "会話1が固定先の host から動いた").toBe(`Bearer ${HOST_TOKEN}`);
        // 会話1のセッションの要求は全部 host、会話2のは全部 B（count_tokens も）
        const servedFor = (session: string | null | undefined) => [...new Set(fakeApi.replies.filter((r) => r.session === session).map((r) => tokenName[r.token] ?? r.token))];
        expect(servedFor(s1)).toEqual(["host"]);
        expect(servedFor(s2)).toEqual(["b"]);

        // ---- 4. 最初の選びは切り替えの1行にならない ---------------------------------------------------------------
        expect(await switchesOf(t1)).toEqual([]);
        expect(await switchesOf(t2)).toEqual([]);

        // 口：Project の固定先は両方・設定の「いま使っている Project」は両方のアカウントの下
        const pinnedView = await human<{ effectiveMode: string; pinnedAccounts?: string[]; currentAccount?: string }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(pinnedView.body.pinnedAccounts).toEqual(["host", bId]);
        expect(pinnedView.body.currentAccount).toBeUndefined();
        const usedBy = await human<{ accounts: Array<{ id: string; usedBy: Array<{ projectId: string; name: string }> }> }>(page, own, "GET", "/api/claude-accounts");
        expect(usedBy.body.accounts.map((a) => [nameOf(a.id), a.usedBy.map((u) => u.name)])).toEqual([
          ["host", ["E2E 均す"]],
          ["b", ["E2E 均す"]],
        ]);

        // ---- 3. 閾値越えで移る -----------------------------------------------------------------------------------
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.97, resetsAt: secondsFromNow(4 * 3600) } });
        await sendTurn(own, t1, "会話1の4回目。合言葉は five-5"); // host が 97% と返す
        await sendTurn(own, t1, "会話1の5回目。合言葉は six-6");
        expect(requestOf("合言葉は six-6")?.auth, "host が 97% と返したのに会話1が B へ移っていない").toBe("Bearer tok-b");
        expect(requestOf("合言葉は six-6")?.session, "移ってもセッションは同じ").toBe(s1);
        expect(await pinnedOf(t1)).toBe(bId);
        await expect.poll(() => switchesOf(t1), { timeout: 15_000 }).toEqual(["host→b threshold 5h 0.97"]);
        // 会話2は何も変わらない（記録は固定の鍵ごと）
        await sendTurn(own, t2, "会話2の2回目。合言葉は seven-7");
        expect(requestOf("合言葉は seven-7")?.auth).toBe("Bearer tok-b");
        expect(await switchesOf(t2)).toEqual([]);
        // 上流には Thread の印を流さない
        expect(fakeApi.requests.filter((r) => r.threadHeader !== null)).toEqual([]);
      },
      {
        // **本物の CLI を偽の API に当てる**（会話の本体は中継を通る。偽の API は中継の上流・取り直しの口・プロフィールの口・使用率の口）
        unsetEnv: OUTER_CLAUDE_ENV,
        env: {
          BANTO_FAKE_RUNNER: "",
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_CLAUDE_PROFILE_URL: `${fakeApi.url}/api/oauth/profile`,
          BANTO_CLAUDE_USAGE_URL: `${fakeApi.url}/api/oauth/usage`,
          CLAUDE_SECURESTORAGE_CONFIG_DIR: securestorage,
          DISABLE_TELEMETRY: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
    );
  } finally {
    await fakeApi.close();
    rmSync(securestorage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
