// **Claude のアカウントを閾値で切り替える**（Backlog #401 `mca-switch`、`docs/specs/v4-security.md` §2「Claude のアカウントを
// 複数持つ」の 5.・6.）。
//
// 本物の CLI（会話の本体）を偽の上流（`fake-anthropic.ts`——トークンごとに使用率の見出しを付け、上限の 429 で断る）に
// 当てる。アカウントを足すので、E2E の共有の core ではなく自前の host（`own-host.ts`）を使う——既定の並びを変えると
// ほかの spec が別のトークンで呼ぶことになる。アカウントは画面と同じ HTTP の口（ブラウザでのログインの写し）で足す。
//
// 見るもの（規則14——「通った」で終わらせず、どのアカウントが返事をしたか・記録と会話の1行・カードの中身まで）：
//   1. 閾値越えで次へ：host が 5時間 97% と返したら、次の要求から B。切り替えは Event Store に1件、その Thread に1行
//   2. リセットで戻る：host のリセットの時刻を過ぎたら host へ戻る（理由 recovered）
//   3. 3つ目まで送り直す：host と B が上限の 429 で断ると、同じ要求を C へ送り直して通る（理由 rejected）
//   4. 全部越えでカード：3つとも閾値を越えたら一番早くリセットされる B で続け、受信箱に1枚。B のリセットを過ぎたら
//      （要求が来なくても）自動で閉じる
//   5. Project の観測：いま使っているアカウントと最後の切り替え
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

/** 人のセッションで（アカウントを足す・並びを決めるのは人だけ） */
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
async function sendTurn(host: OwnHost, threadId: string, prompt: string): Promise<string> {
  const res = await fetch(`${host.apiUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt, permissionMode: "bypassPermissions" }),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text, "ターンが失敗した").not.toContain('"type":"error"');
  return text;
}


const secondsFromNow = (s: number) => Math.floor(Date.now() / 1000) + s;

test("閾値を越えたら次のアカウントへ・リセットで戻る・上限の 429 は3つ目まで送り直す・全部越えでカードが出て閉じる", async ({ page }) => {
  const fakeApi = await startFakeAnthropic();
  const securestorage = mkdtempSync(join(tmpdir(), "banto-e2e-mca-cred-"));
  const root = mkdtempSync(join(tmpdir(), "banto-e2e-mca-root-"));
  try {
    await withOwnHost(
      async (own) => {
        await login(page, own);
        // この spec が見るのは「上から順に」（既定は均す——v4-security.md §2「均す」。均すは claude-accounts-balance.spec.ts）
        {
          const ordered = await page.context().request.put(`${own.url}/api/claude-accounts/settings`, {
            headers: { "x-banto-client": "1", origin: FRONTEND_BASE_URL, "content-type": "application/json" },
            data: { mode: "ordered" },
          });
          expect(ordered.status(), await ordered.text()).toBe(200);
        }
        // ---- アカウントを2つ足す（画面と同じ口：始める → 向こうに出た `<コード>#<state>` を貼る） ------------------------
        const ids: Record<string, string> = { host: "host" };
        for (const name of ["b", "c"]) {
          fakeApi.addLogin(`code-${name}`, { accessToken: `tok-${name}`, email: `${name}@example.com` });
          const started = await human<{ loginId: string; url: string }>(page, own, "POST", "/api/claude-accounts/login");
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const state = new URL(started.body.url).searchParams.get("state");
          const finished = await human<{ account: { id: string; email: string }; replaced: boolean }>(
            page,
            own,
            "POST",
            `/api/claude-accounts/login/${started.body.loginId}`,
            { pasted: `code-${name}#${state}` },
          );
          expect(finished.status, JSON.stringify(finished.body)).toBe(200);
          expect(finished.body.account.email).toBe(`${name}@example.com`);
          ids[name] = finished.body.account.id;
        }
        const listed = await human<{ defaultOrder: string[]; thresholds: { fiveHour: number; sevenDay: number } }>(page, own, "GET", "/api/claude-accounts");
        expect(listed.body.defaultOrder).toEqual([ids.host, ids.b, ids.c]);
        expect(listed.body.thresholds).toEqual({ fiveHour: 0.95, sevenDay: 0.95 });
        const nameOfToken: Record<string, string> = { [HOST_TOKEN]: "host", "tok-b": "b", "tok-c": "c" };
        const nameOf = (id: string) => Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;

        const project = await api<{ id: string }>(own, "/api/projects", { method: "POST", body: { name: "E2E アカウントの切り替え", root } });
        expect(project.status, JSON.stringify(project.body)).toBe(201);
        const projectId = project.body.id;
        const threadId = (await api<{ id: string }>(own, `/api/projects/${projectId}/threads`, { method: "POST" })).body.id;
        // Project の並びは「既定のまま」
        const settings = await human<{ order: string[] | null; effectiveOrder: string[] }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(settings.body).toMatchObject({ order: null, effectiveOrder: [ids.host, ids.b, ids.c] });

        /** その文を最後の user の発言に持つ要求に、どのトークンで答えたか */
        const servedBy = (said: string) =>
          fakeApi.requests.filter((r) => [...r.messages].reverse().find((m) => m.role === "user")?.text.includes(said)).at(-1)?.auth;
        const switches = async () =>
          ((await api<{ accountSwitches?: Switch[] }>(own, `/api/threads/${threadId}`)).body.accountSwitches ?? []).map(
            (s) => `${nameOf(s.from)}→${nameOf(s.to)} ${s.reason.kind}${s.reason.window ? ` ${s.reason.window} ${s.reason.utilization}` : ""}`,
          );

        // 最初のターンは Project の用意（コンテナ・Module）を含んで遅い——リセットの時刻を決める前に済ませておく
        await sendTurn(own, threadId, "はじめまして。合言葉は zero-0");
        expect(servedBy("合言葉は zero-0")).toBe(`Bearer ${HOST_TOKEN}`);

        // ---- 1. 閾値越えで次へ ---------------------------------------------------------------------------------
        const hostReset = secondsFromNow(40);
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.97, resetsAt: hostReset } });
        await sendTurn(own, threadId, "1回目。合言葉は one-1");
        expect(servedBy("合言葉は one-1"), "最初は既定の並びの先頭（host）").toBe(`Bearer ${HOST_TOKEN}`);
        await sendTurn(own, threadId, "2回目。合言葉は two-2");
        expect(servedBy("合言葉は two-2"), "host が 97% と返したのに切り替わらない").toBe("Bearer tok-b");
        // Event Store に1件・その Thread に1行（記録は返事のあとに書くので、出るまで待つ）
        await expect.poll(switches, { timeout: 15_000 }).toEqual(["host→b threshold 5h 0.97"]);
        // 上流には Thread の印を流さない
        expect(fakeApi.requests.filter((r) => r.threadHeader !== null)).toEqual([]);

        // ---- 2. リセットで戻る ---------------------------------------------------------------------------------
        fakeApi.setLimit(HOST_TOKEN, undefined);
        const waitUntil = hostReset * 1000 + 500 - Date.now();
        if (waitUntil > 0) await page.waitForTimeout(waitUntil);
        await sendTurn(own, threadId, "3回目。合言葉は three-3");
        expect(servedBy("合言葉は three-3"), "host のリセットを過ぎたのに戻らない").toBe(`Bearer ${HOST_TOKEN}`);
        await expect.poll(switches, { timeout: 15_000 }).toEqual(["host→b threshold 5h 0.97", "b→host recovered"]);

        // ---- 3. 上限の 429 は3つ目まで送り直す -------------------------------------------------------------------
        const rejectedUntil = secondsFromNow(20);
        fakeApi.setLimit(HOST_TOKEN, { rejected: { resetsAt: rejectedUntil } });
        fakeApi.setLimit("tok-b", { rejected: { resetsAt: rejectedUntil } });
        const before = fakeApi.replies.length;
        await sendTurn(own, threadId, "4回目。合言葉は four-4");
        expect(servedBy("合言葉は four-4"), "host と B が断ったのに C で通っていない").toBe("Bearer tok-c");
        // 同じ要求を host → B → C の順に送った（CLI は1回しか送っていない——429 は中継が受けた）
        // 推論の要求（count_tokens でないもの）の最初の3つ
        const inference = fakeApi.replies.slice(before).filter((r) => r.path.startsWith("/v1/messages?"));
        expect(inference.slice(0, 3).map((r) => `${nameOfToken[r.token] ?? r.token} ${r.status}`)).toEqual([
          "host 429",
          "b 429",
          "c 200",
        ]);
        await expect.poll(switches, { timeout: 15_000 }).toEqual(["host→b threshold 5h 0.97", "b→host recovered", "host→c rejected"]);

        // ---- 4. 全部越えでカードが出て、戻ったら閉じる ----------------------------------------------------------------
        // 3つとも閾値を越えた値を返す。B のリセットが一番早い。中継が覚えるのは使ったアカウントの値だけで、CLI は1ターンに
        // 推論1回と文脈の量の数え（count_tokens）を数回送り、そのたびに選び直す——全部を知るまでターンを重ねる
        const bReset = secondsFromNow(90);
        fakeApi.setLimit(HOST_TOKEN, { fiveHour: { utilization: 0.97, resetsAt: secondsFromNow(3600) } });
        fakeApi.setLimit("tok-b", { fiveHour: { utilization: 0.96, resetsAt: bReset } });
        fakeApi.setLimit("tok-c", { fiveHour: { utilization: 0.98, resetsAt: secondsFromNow(7200) } });
        // host と B の rejected が切れるのを待つ（中継が覚えた `-reset` の時刻）
        const waitRejected = rejectedUntil * 1000 + 500 - Date.now();
        if (waitRejected > 0) await page.waitForTimeout(waitRejected);
        const TITLE = "Claude のアカウントが全部、閾値を越えました";
        const openCards = async () => JSON.stringify((await api<unknown>(own, "/api/inbox")).body).split(TITLE).length - 1;
        expect(await openCards(), "全部越える前にカードが出た").toBe(0);
        const usedBefore = fakeApi.replies.length;
        for (let i = 0; i < 6 && (await openCards()) === 0; i++) {
          await sendTurn(own, threadId, `全部越えを待つ ${i}。合言葉は over-${i}`);
        }
        await expect.poll(openCards, { timeout: 15_000, message: "3つとも閾値を越えたのにカードが出ない" }).toBe(1);
        // 全部を使って値を知った（C は 98% と返している）
        expect(new Set(fakeApi.replies.slice(usedBefore).map((r) => nameOfToken[r.token]))).toEqual(new Set(["host", "b", "c"]));
        expect(Date.now(), "ターンが遅く、B のリセットを過ぎてしまった（試験の前提が崩れた）").toBeLessThan(bReset * 1000 - 10_000);
        const inboxText = JSON.stringify((await api<unknown>(own, "/api/inbox")).body);
        expect(inboxText).toContain("「b@example.com」で続けています");
        expect(inboxText).toContain("5時間 95%・週 95%");
        // 全部越えのあいだは、一番早くリセットされる B で続ける。開いている間はカードを増やさない
        const afterCard = fakeApi.replies.length;
        await sendTurn(own, threadId, "全部越えのあと。合言葉は after-1");
        expect(servedBy("合言葉は after-1"), "全部越えたのに一番早くリセットされる B で続けていない").toBe("Bearer tok-b");
        expect(fakeApi.replies.slice(afterCard).map((r) => nameOfToken[r.token]).filter((n) => n !== "b"), "全部越えのあいだに B 以外を使った").toEqual([]);
        expect(await openCards()).toBe(1);
        // 切り替えの1行：最初の3つはここまでのとおり。最後は B に来ている（3つとも越えたので、理由は前のものの閾値越え）
        const lines = await switches();
        expect(lines.slice(0, 3)).toEqual(["host→b threshold 5h 0.97", "b→host recovered", "host→c rejected"]);
        expect(lines.at(-1)).toMatch(/→b threshold 5h 0\.9[78]$/);
        // B のリセットを過ぎたら、要求が来なくても閉じる
        await expect
          .poll(openCards, { timeout: Math.max(0, bReset * 1000 - Date.now()) + 30_000, intervals: [1000], message: "B のリセットを過ぎてもカードが閉じない" })
          .toBe(0);

        // ---- 5. Project の観測 ------------------------------------------------------------------------------------
        const observed = await human<{ currentAccount?: string; lastSwitch?: Switch }>(page, own, "GET", `/api/projects/${projectId}/claude-accounts`);
        expect(observed.body.currentAccount).toBe(ids.b);
        expect(observed.body.lastSwitch).toMatchObject({ to: ids.b, reason: { kind: "threshold", window: "5h" } });
      },
      {
        // **本物の CLI を偽の API に当てる**（会話の本体は中継を通る。偽の API は中継の上流・取り直しの口・プロフィールの口）
        unsetEnv: OUTER_CLAUDE_ENV,
        env: {
          BANTO_FAKE_RUNNER: "",
          BANTO_CLAUDE_RELAY_UPSTREAM: fakeApi.url,
          BANTO_CLAUDE_RELAY_TOKEN_URL: `${fakeApi.url}/v1/oauth/token`,
          BANTO_CLAUDE_PROFILE_URL: `${fakeApi.url}/api/oauth/profile`,
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
