// 人のログイン（docs/specs/v4-security.md「人のログイン」）を、本物の HTTP の口で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { GlobalMemoryStore } from "../global-memory/store.js";
import { InboxStore } from "../inbox/store.js";
import { HostRelayEndpoint, RelayRegistry } from "../relay/host-relay-endpoint.js";
import { AgentRelayEndpoint } from "../relay/agent-relay-endpoint.js";
import { PendingApprovalRegistry } from "../inbox/pending-approvals.js";
import { AppEventBus, type AppEvent } from "../http/app-events.js";
import { createApp } from "../http/app.js";
import { AuthStore, SESSION_IDLE_MS } from "./store.js";
import { AuthService, SESSION_COOKIE } from "./service.js";
import { writeLoginLink, loginLinkDir } from "./login-links.js";
import { SoftAuthenticator } from "./soft-authenticator.js";

const UI = "http://localhost:4175";
const TOKEN = "machine-token";

interface Ctx {
  base: string;
  dir: string;
  clock: { now: number };
  events: AppEvent[];
  /** 画面からの要求（独自のヘッダと Origin を付ける）。cookie を渡せば付ける */
  ui(path: string, init?: { method?: string; body?: unknown; cookie?: string; origin?: string | null; header?: boolean }): Promise<Response>;
  /** 新しい記録で起こし直す（host の再起動） */
  restart(): Promise<void>;
}

async function withAuth(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "banto-auth-test-"));
  const clock = { now: Date.parse("2026-10-03T00:00:00Z") };
  const events: AppEvent[] = [];
  let server: ReturnType<typeof createApp> | undefined;
  let base = "";
  const start = async (): Promise<void> => {
    const log = new EventLog(dir);
    await log.init();
    const projectThread = new ProjectThreadStore(dir, log);
    await projectThread.load();
    const globalMemory = new GlobalMemoryStore(dir, log);
    await globalMemory.load();
    const inbox = new InboxStore(dir, log);
    await inbox.load();
    const store = new AuthStore(dir, log, () => clock.now);
    await store.load();
    const appEvents = new AppEventBus();
    appEvents.subscribe((e) => events.push(e));
    server = createApp({
      projectThread,
      globalMemory,
      inbox,
      pendingApprovals: new PendingApprovalRegistry(),
      relayEndpoint: new HostRelayEndpoint({ registry: new RelayRegistry() }),
      agentRelayEndpoint: new AgentRelayEndpoint(TOKEN),
      authToken: TOKEN,
      appEvents,
      auth: new AuthService({
        store,
        dataDir: dir,
        authToken: TOKEN,
        uiOrigin: UI,
        apiBaseUrl: "http://localhost:4737",
        events: appEvents,
        now: () => clock.now,
      }),
      resolveModulesForThread: async () => [],
      dataDir: dir,
      configDir: dir,
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  };
  await start();
  const ctx: Ctx = {
    get base() {
      return base;
    },
    dir,
    clock,
    events,
    ui(path, init = {}) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (init.header !== false) headers["x-banto-client"] = "1";
      if (init.origin !== null) headers.origin = init.origin ?? UI;
      if (init.cookie) headers.cookie = init.cookie;
      return fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    },
    async restart() {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      await start();
    },
  };
  try {
    await fn(ctx);
  } finally {
    server?.closeAllConnections();
    server?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function sessionCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(set, "セッションの Cookie が出ていない");
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /Domain=/i, "__Host- の Cookie に Domain を付けてはいけない");
  return set.split(";")[0]!;
}

async function loginWithLink(ctx: Ctx): Promise<string> {
  const { code } = await writeLoginLink(ctx.dir, ctx.clock.now);
  const res = await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } });
  assert.equal(res.status, 200, await res.clone().text());
  return sessionCookie(res);
}

test("host のリンクで入れる。札は1回だけで、ファイルも消える", async () => {
  await withAuth(async (ctx) => {
    const { code } = await writeLoginLink(ctx.dir, ctx.clock.now);
    const first = await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } });
    assert.equal(first.status, 200);
    const cookie = sessionCookie(first);
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 200);
    const again = await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } });
    assert.equal(again.status, 401, "同じ札で2回入れてはいけない");
    assert.deepEqual(await readdir(loginLinkDir(ctx.dir)), []);
  });
});

test("リンクの札は10分で切れる", async () => {
  await withAuth(async (ctx) => {
    const { code } = await writeLoginLink(ctx.dir, ctx.clock.now);
    ctx.clock.now += 10 * 60 * 1000 + 1;
    assert.equal((await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } })).status, 401);
  });
});

test("Cookie の要求は、独自のヘッダが無い・別の Origin なら断る（兄弟のサブドメインからの CSRF）", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 200);
    assert.equal((await ctx.ui("/api/projects", { cookie, header: false })).status, 401, "独自のヘッダ無し");
    assert.equal(
      (await ctx.ui("/api/projects", { cookie, origin: "https://app-1234.banto.example" })).status,
      401,
      "別の Origin",
    );
    // 同じオリジンの GET は Origin を付けない——独自のヘッダがあれば通す
    assert.equal((await ctx.ui("/api/projects", { cookie, origin: null })).status, 200);
    // 札の引き換えも、画面からの要求でなければ断る
    const { code } = await writeLoginLink(ctx.dir, ctx.clock.now);
    assert.equal((await ctx.ui("/api/auth/redeem", { method: "POST", body: { code }, header: false })).status, 403);
  });
});

test("CORS は画面のオリジンにだけ、資格情報つきで返す（* は返さない）", async () => {
  await withAuth(async (ctx) => {
    const ok = await fetch(`${ctx.base}/api/projects`, {
      method: "OPTIONS",
      headers: { origin: UI, "access-control-request-headers": "x-banto-client" },
    });
    assert.equal(ok.headers.get("access-control-allow-origin"), UI);
    assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
    assert.match(ok.headers.get("access-control-allow-headers") ?? "", /x-banto-client/);
    const other = await fetch(`${ctx.base}/api/projects`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });
});

test("機械の合言葉（Bearer）は今までどおり通るが、人の扱い（端末・パスキー）は変えられない", async () => {
  await withAuth(async (ctx) => {
    const machine = { authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${ctx.base}/api/projects`, { headers: machine })).status, 200);
    for (const [method, path] of [
      ["GET", "/api/auth/sessions"],
      ["POST", "/api/auth/device-codes"],
      ["POST", "/api/auth/passkey/register/options"],
    ] as const) {
      const res = await fetch(`${ctx.base}${path}`, { method, headers: machine });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

test("セッションは30日使わなければ切れ、使っていれば延びる。host を起こし直しても入ったまま", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    ctx.clock.now += 20 * 24 * 60 * 60 * 1000;
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 200, "20日目");
    await ctx.restart();
    ctx.clock.now += 20 * 24 * 60 * 60 * 1000;
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 200, "40日目（20日目に使った）");
    ctx.clock.now += SESSION_IDLE_MS + 1;
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 401, "30日使わなかった");
  });
});

test("端末を追加：札で別の端末が入り、出した側に知らせが届く。パスキーが無いうちは本人確認を求めない", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    const issued = await ctx.ui("/api/auth/device-codes", { method: "POST", cookie });
    assert.equal(issued.status, 200);
    const { url, codeId } = (await issued.json()) as { url: string; codeId: string };
    assert.match(url, /^http:\/\/localhost:4175\/\?bantoHost=http%3A%2F%2Flocalhost%3A4737#banto-login=/);
    const code = new URL(url).hash.replace("#banto-login=", "");
    const other = await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } });
    assert.equal(other.status, 200);
    const otherCookie = sessionCookie(other);
    assert.notEqual(otherCookie, cookie);
    assert.deepEqual(
      ctx.events.filter((e) => e.type === "auth.device_added").map((e) => (e as { codeId: string }).codeId),
      [codeId],
    );
    assert.equal((await ctx.ui("/api/auth/redeem", { method: "POST", body: { code } })).status, 401, "2回目");
    const sessions = (await (await ctx.ui("/api/auth/sessions", { cookie })).json()) as Array<{ current: boolean; method: string }>;
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions.map((s) => s.method).sort(), ["device-code", "login-link"]);
    assert.equal(sessions.filter((s) => s.current).length, 1);
  });
});

test("締め出すと、その端末の次の要求から 401。開いている流れも切れる", async () => {
  await withAuth(async (ctx) => {
    const mine = await loginWithLink(ctx);
    const other = await loginWithLink(ctx);
    const events = await ctx.ui("/api/events", { cookie: other });
    assert.equal(events.status, 200);
    const reader = events.body!.getReader();
    await reader.read(); // hello
    const list = (await (await ctx.ui("/api/auth/sessions", { cookie: mine })).json()) as Array<{ id: string; current: boolean }>;
    const target = list.find((s) => !s.current)!;
    assert.equal((await ctx.ui(`/api/auth/sessions/${target.id}`, { method: "DELETE", cookie: mine })).status, 200);
    assert.equal((await ctx.ui("/api/projects", { cookie: other })).status, 401);
    await assert.rejects(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) throw new Error("ended");
      }
    });
    assert.equal((await ctx.ui("/api/projects", { cookie: mine })).status, 200);
  });
});

test("ログアウトで自分のセッションを消し、Cookie も消す", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    const res = await ctx.ui("/api/auth/logout", { method: "POST", cookie });
    assert.equal(res.status, 200);
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && /Max-Age=0/.test(c)));
    assert.equal((await ctx.ui("/api/projects", { cookie })).status, 401);
  });
});

test("パスキー：登録して、それで入れる。別のオリジンで作った応答は断る", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    const authenticator = new SoftAuthenticator();
    const regOptions = (await (await ctx.ui("/api/auth/passkey/register/options", { method: "POST", cookie })).json()) as {
      challenge: string;
      rp: { id: string };
    };
    assert.equal(regOptions.rp.id, "localhost");
    const reg = await ctx.ui("/api/auth/passkey/register/verify", {
      method: "POST",
      cookie,
      body: { response: authenticator.register(regOptions, UI), label: "試験の端末" },
    });
    assert.equal(reg.status, 200, await reg.clone().text());
    const me = (await (await ctx.ui("/api/auth/me", { cookie })).json()) as { hasPasskeys: boolean };
    assert.equal(me.hasPasskeys, true);

    // 入っていない端末がパスキーで入る
    const loginOptions = (await (await ctx.ui("/api/auth/passkey/login/options", { method: "POST" })).json()) as {
      challenge: string;
      rpId: string;
    };
    const login = await ctx.ui("/api/auth/passkey/login/verify", {
      method: "POST",
      body: { response: authenticator.assert(loginOptions, UI) },
    });
    assert.equal(login.status, 200, await login.clone().text());
    assert.equal((await ctx.ui("/api/projects", { cookie: sessionCookie(login) })).status, 200);

    // 公開先（兄弟のサブドメイン）のページで署名させた応答は通らない
    const evilOptions = (await (await ctx.ui("/api/auth/passkey/login/options", { method: "POST" })).json()) as {
      challenge: string;
      rpId: string;
    };
    const evil = await ctx.ui("/api/auth/passkey/login/verify", {
      method: "POST",
      body: { response: authenticator.assert(evilOptions, "https://app-1234.localhost") },
    });
    assert.equal(evil.status, 401);

    // 同じパスキーを別の端末でも使う（同期）——署名回数が前より小さくても断らない
    const synced = Object.assign(Object.create(Object.getPrototypeOf(authenticator)), authenticator) as SoftAuthenticator;
    (synced as unknown as { signCount: number }).signCount = 0;
    const syncedOptions = (await (await ctx.ui("/api/auth/passkey/login/options", { method: "POST" })).json()) as {
      challenge: string;
      rpId: string;
    };
    const syncedLogin = await ctx.ui("/api/auth/passkey/login/verify", {
      method: "POST",
      body: { response: synced.assert(syncedOptions, UI) },
    });
    assert.equal(syncedLogin.status, 200, await syncedLogin.clone().text());

    // challenge は1回だけ
    const replay = await ctx.ui("/api/auth/passkey/login/verify", {
      method: "POST",
      body: { response: authenticator.assert(loginOptions, UI) },
    });
    assert.equal(replay.status, 401);
  });
});

test("パスキーがあれば、端末を追加・締め出し・パスキーの追加と削除の前に本人確認を求める", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    const authenticator = new SoftAuthenticator();
    const regOptions = (await (await ctx.ui("/api/auth/passkey/register/options", { method: "POST", cookie })).json()) as {
      challenge: string;
      rp: { id: string };
    };
    await ctx.ui("/api/auth/passkey/register/verify", {
      method: "POST",
      cookie,
      body: { response: authenticator.register(regOptions, UI) },
    });
    // 登録の直後は5分だけ通る。過ぎたら求める
    ctx.clock.now += 5 * 60 * 1000 + 1;
    const denied = await ctx.ui("/api/auth/device-codes", { method: "POST", cookie });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { code?: string }).code, "step-up-required");
    for (const [method, path] of [
      ["POST", "/api/auth/passkey/register/options"],
      ["DELETE", `/api/auth/passkeys/${authenticator.id}`],
    ] as const) {
      assert.equal((await ctx.ui(path, { method, cookie })).status, 403, `${method} ${path}`);
    }

    const stepOptions = (await (await ctx.ui("/api/auth/stepup/options", { method: "POST", cookie })).json()) as {
      challenge: string;
      rpId: string;
    };
    const step = await ctx.ui("/api/auth/stepup/verify", {
      method: "POST",
      cookie,
      body: { response: authenticator.assert(stepOptions, UI) },
    });
    assert.equal(step.status, 200, await step.clone().text());
    assert.equal((await ctx.ui("/api/auth/device-codes", { method: "POST", cookie })).status, 200);

    // ほかのセッションの step-up の challenge は使えない
    const other = await loginWithLink(ctx);
    const theirs = (await (await ctx.ui("/api/auth/stepup/options", { method: "POST", cookie })).json()) as {
      challenge: string;
      rpId: string;
    };
    const stolen = await ctx.ui("/api/auth/stepup/verify", {
      method: "POST",
      cookie: other,
      body: { response: authenticator.assert(theirs, UI) },
    });
    assert.equal(stolen.status, 401);
  });
});

test("リンクで入った直後の10分は、パスキーがほかにあっても、この端末のパスキーを登録できる（足したばかりの端末にはパスキーが無い）", async () => {
  await withAuth(async (ctx) => {
    const first = await loginWithLink(ctx);
    const pc = new SoftAuthenticator();
    const opts = (await (await ctx.ui("/api/auth/passkey/register/options", { method: "POST", cookie: first })).json()) as {
      challenge: string;
      rp: { id: string };
    };
    await ctx.ui("/api/auth/passkey/register/verify", { method: "POST", cookie: first, body: { response: pc.register(opts, UI) } });
    ctx.clock.now += 11 * 60 * 1000; // PC の登録直後の5分は過ぎた
    const issued = await ctx.ui("/api/auth/device-codes", { method: "POST", cookie: first });
    assert.equal(issued.status, 403, "PC 側は端末を追加の前に本人確認が要る");
    // 携帯：端末を追加の札で入る（PC の本人確認は別に通したとする——ここでは host のリンクで代える）
    const phone = await loginWithLink(ctx);
    const phoneKey = new SoftAuthenticator();
    const phoneOpts = await ctx.ui("/api/auth/passkey/register/options", { method: "POST", cookie: phone });
    assert.equal(phoneOpts.status, 200, "入った直後なのに本人確認を求めた");
    const reg = await ctx.ui("/api/auth/passkey/register/verify", {
      method: "POST",
      cookie: phone,
      body: { response: phoneKey.register((await phoneOpts.json()) as { challenge: string; rp: { id: string } }, UI) },
    });
    assert.equal(reg.status, 200, await reg.clone().text());
    // 10分を過ぎて入った端末は、また本人確認を求められる
    const late = await loginWithLink(ctx);
    ctx.clock.now += 10 * 60 * 1000 + 1;
    assert.equal((await ctx.ui("/api/auth/passkey/register/options", { method: "POST", cookie: late })).status, 403);
  });
});

test("IP アドレスの画面ではパスキーを使えないと言う", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banto-auth-ip-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new AuthStore(dir, log);
    const service = new AuthService({ store, dataDir: dir, authToken: TOKEN, uiOrigin: "http://127.0.0.1:4175", apiBaseUrl: "http://127.0.0.1:4737" });
    assert.match(service.loginUrl("abc"), /^http:\/\/127\.0\.0\.1:4175\/\?bantoHost=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ───────────── 公開先の前の認証（oauth2-proxy と同じ形） ─────────────

const SVC = "web-1a2b3c4d.localhost";
const SVC_ORIGIN = `http://${SVC}:4175`;

/** Caddy の forward_auth が host に送る問い合わせ（元の要求のヘッダが付く） */
function check(ctx: Ctx, init: { host?: string; cookie?: string; mode?: string; site?: string; uri?: string } = {}) {
  const headers: Record<string, string> = {
    "x-forwarded-host": init.host ?? SVC,
    "x-forwarded-uri": init.uri ?? "/app?x=1",
    "sec-fetch-mode": init.mode ?? "navigate",
  };
  if (init.site) headers["sec-fetch-site"] = init.site;
  if (init.cookie) headers.cookie = init.cookie;
  // fetch は Sec-Fetch-* を書かせない（ブラウザと同じ決まり）——Caddy の役は素の HTTP で送る
  return new Promise<{ status: number; headers: { get(name: string): string | null } }>((resolve, reject) => {
    const req = httpRequest(`${ctx.base}/api/auth/publish-check`, { headers }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        headers: { get: (name) => (res.headers[name.toLowerCase()] as string | undefined) ?? null },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** banto にログインした状態で publish-start を通り、公開先の戻り道で通行証を受け取る */
async function passFor(ctx: Ctx, cookie: string, host = SVC): Promise<string> {
  const start = await fetch(
    `${ctx.base}/api/auth/publish-start?rd=${encodeURIComponent(`http://${host}:4175/app?x=1`)}`,
    { headers: { cookie }, redirect: "manual" },
  );
  assert.equal(start.status, 302, await start.clone().text());
  const callback = new URL(start.headers.get("location")!);
  assert.equal(callback.origin, `http://${host}:4175`);
  assert.equal(callback.pathname, "/.banto-auth/callback");
  assert.equal(callback.searchParams.get("rd"), "/app?x=1");
  const back = await fetch(`${ctx.base}${callback.pathname}${callback.search}`, {
    headers: { "x-forwarded-host": host },
    redirect: "manual",
  });
  assert.equal(back.status, 302, await back.clone().text());
  assert.equal(back.headers.get("location"), "/app?x=1");
  const set = back.headers.getSetCookie().find((c) => c.startsWith("__Host-banto-pass="));
  assert.ok(set, "通行証が出ていない");
  assert.match(set, /HttpOnly/);
  assert.doesNotMatch(set, /Domain=/i);
  return set.split(";")[0]!;
}

test("公開先：通行証が無ければ、画面の遷移は banto へ回し、それ以外は 401。別のサイトからの要求は断る", async () => {
  await withAuth(async (ctx) => {
    const nav = await check(ctx);
    assert.equal(nav.status, 302);
    const to = new URL(nav.headers.get("location")!);
    assert.equal(to.origin, "http://localhost:4737");
    assert.equal(to.pathname, "/api/auth/publish-start");
    assert.equal(to.searchParams.get("rd"), `${SVC_ORIGIN}/app?x=1`);
    assert.equal((await check(ctx, { mode: "cors", site: "same-origin" })).status, 401);
    assert.equal((await check(ctx, { mode: "cors", site: "same-site" })).status, 403, "別の公開先のページから");
  });
});

test("公開先：banto に入っていなければ、ログインの画面へ回し、入ったら戻ってくる道を付ける", async () => {
  await withAuth(async (ctx) => {
    const res = await fetch(`${ctx.base}/api/auth/publish-start?rd=${encodeURIComponent(`${SVC_ORIGIN}/`)}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location")!);
    assert.equal(to.origin, UI);
    const next = new URL(to.searchParams.get("next")!);
    assert.equal(next.pathname, "/api/auth/publish-start");
    assert.equal(next.searchParams.get("rd"), `${SVC_ORIGIN}/`);
  });
});

test("公開先：ログインしていれば、その公開先だけの通行証で通る。ほかの公開先・締め出したあとは通らない", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    const pass = await passFor(ctx, cookie);
    assert.equal((await check(ctx, { cookie: pass })).status, 200);
    assert.equal((await check(ctx, { cookie: pass, mode: "cors", site: "same-origin" })).status, 200);
    // 別の公開先の名前では効かない
    assert.equal((await check(ctx, { cookie: pass, host: "other-1a2b3c4d.localhost" })).status, 302);
    // host を起こし直しても効く（鍵はデータ置き場）
    await ctx.restart();
    assert.equal((await check(ctx, { cookie: pass })).status, 200);
    // 締め出すと効かない
    const sessions = (await (await ctx.ui("/api/auth/sessions", { cookie })).json()) as Array<{ id: string; current: boolean }>;
    const mine = sessions.find((s) => s.current)!;
    await ctx.ui(`/api/auth/sessions/${mine.id}`, { method: "DELETE", cookie });
    assert.equal((await check(ctx, { cookie: pass })).status, 302);
  });
});

test("公開先：戻り先は banto の名前の下だけ。札は1回だけ・その公開先の名前でだけ引き換えられ、戻るのはパスだけ", async () => {
  await withAuth(async (ctx) => {
    const cookie = await loginWithLink(ctx);
    for (const rd of ["https://evil.example/", "http://localhost.evil.example:4175/", `http://localhost:4175/`, "http://x.localhost:9999/"]) {
      const res = await fetch(`${ctx.base}/api/auth/publish-start?rd=${encodeURIComponent(rd)}`, { headers: { cookie }, redirect: "manual" });
      assert.equal(res.status, 400, rd);
    }
    const start = await fetch(`${ctx.base}/api/auth/publish-start?rd=${encodeURIComponent(`${SVC_ORIGIN}/`)}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const callback = new URL(start.headers.get("location")!);
    const code = callback.searchParams.get("code")!;
    // 別の名前で引き換えようとしても通らない（Caddy を通らずに X-Forwarded-Host を偽った）
    const wrongHost = await fetch(`${ctx.base}/.banto-auth/callback?code=${code}&rd=/`, {
      headers: { "x-forwarded-host": "other-1a2b3c4d.localhost" },
      redirect: "manual",
    });
    assert.equal(wrongHost.status, 400);
    // 1回失敗した札はもう使えない
    const again = await fetch(`${ctx.base}/.banto-auth/callback?code=${code}&rd=/`, {
      headers: { "x-forwarded-host": SVC },
      redirect: "manual",
    });
    assert.equal(again.status, 400);
    // よそへ飛ばす戻り先は、ただのパスに落とす
    const start2 = await fetch(`${ctx.base}/api/auth/publish-start?rd=${encodeURIComponent(`${SVC_ORIGIN}/`)}`, {
      headers: { cookie },
      redirect: "manual",
    });
    const code2 = new URL(start2.headers.get("location")!).searchParams.get("code")!;
    const evil = await fetch(`${ctx.base}/.banto-auth/callback?code=${code2}&rd=${encodeURIComponent("//evil.example/")}`, {
      headers: { "x-forwarded-host": SVC },
      redirect: "manual",
    });
    assert.equal(evil.status, 302);
    assert.equal(evil.headers.get("location"), "/");
  });
});
