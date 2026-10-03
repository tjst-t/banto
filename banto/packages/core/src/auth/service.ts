// 人のログインの口（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// - API の認証は2本：`Authorization: Bearer <authToken>`（機械）か、セッションの Cookie（人）
// - **Cookie で来た要求は、独自のヘッダ `X-Banto-Client: 1` が無ければ断る**。独自のヘッダ付きの要求は別の
//   オリジンから preflight 無しに出せず、CORS は画面のオリジンにしか許さない——兄弟のサブドメイン（AI が動かす
//   公開先・Canvas の sandbox。同じサイトなので SameSite は止めない）からの `<img>`・フォーム・遷移・no-cors fetch
//   がまとめて落ちる。`Origin` が付いていれば画面のオリジンとの一致も見る
// - パスキーの守りは**検証時の origin の一致**（RP ID の子＝公開先もプロンプトは出せるので、RP ID では守れない）
// - 端末を追加・パスキーの追加と削除・端末の締め出しは、その場でパスキーを通してから（step-up）。パスキーが
//   まだ1つも無いときは求めない

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { AuthStore, randomSecret, sha256, type LoginMethod, type SessionRecord } from "./store.js";
import { consumeLoginLink, loginLinkUrl, ONE_TIME_CODE_TTL_MS } from "./login-links.js";
import { deviceLabel } from "./device-label.js";

export const SESSION_COOKIE = "__Host-banto-session";
/** 公開先の通行証（その公開先のホストにだけ置く） */
export const PASS_COOKIE = "__Host-banto-pass";
/** 公開先から banto へ戻ってくる道（Caddy がこのパスだけ host へ回す） */
export const PUBLISH_CALLBACK_PATH = "/.banto-auth/callback";
/** 公開先へ渡す札の寿命 */
const PUBLISH_CODE_TTL_MS = 60 * 1000;
export const CLIENT_HEADER = "x-banto-client";
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
/** step-up の効く時間（パスキーを通してから、この間だけ大事な操作ができる） */
const STEP_UP_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** 認証の要らない口は、コンテナからも叩ける（host は 0.0.0.0 で待ち受ける）。溜められる数に上限を置く */
const MAX_PENDING_CHALLENGES = 50;
const MAX_PENDING_DEVICE_CODES = 20;
/** 認証の要らない口の速さの上限（1分あたり） */
const UNAUTH_PER_MINUTE = 30;

export type Principal = { kind: "machine" } | { kind: "session"; session: SessionRecord; token: string };

export interface AuthEventSink {
  publish(event: { type: "auth.device_added"; codeId: string; label: string }): void;
}

export interface AuthServiceOptions {
  store: AuthStore;
  dataDir: string;
  authToken: string;
  /** 画面のオリジン（例 `https://banto.tjstkm.net`）。Origin の検め・パスキー・CORS・リンクに使う */
  uiOrigin: string;
  /** 画面から見た API の基点。画面と同じオリジンなら同じ値 */
  apiBaseUrl: string;
  /** Canvas の sandbox のオリジン（公開先として扱わない） */
  sandboxOrigin?: string;
  events?: AuthEventSink;
  now?: () => number;
}

export class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface PendingChallenge {
  kind: "register" | "login" | "stepup";
  sessionId?: string;
  expiresAt: number;
}

function isIpAddress(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || out.has(name)) continue; // 同名が2つあれば先のもの（ブラウザは長いパスを先に送る）
    out.set(name, part.slice(i + 1).trim());
  }
  return out;
}

export class AuthService {
  readonly uiOrigin: string;
  private readonly rpID: string | undefined;
  private readonly now: () => number;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly deviceCodes = new Map<string, { codeId: string; expiresAt: number }>();
  private readonly stepUps = new Map<string, number>();
  /** 締め出したときに切る、開いている流れ（`/api/events` 等） */
  private readonly openResponses = new Map<string, Set<ServerResponse>>();
  /** Cookie を出し直した時刻（滑走する期限をブラウザ側にも伸ばす） */
  private readonly cookieIssued = new Map<string, number>();
  private unauthWindow = { startedAt: 0, count: 0 };
  /** 公開先へ渡す札（1回だけ・1分）。札のハッシュ → どの公開先・どのセッション */
  private readonly publishCodes = new Map<string, { host: string; sessionId: string; expiresAt: number }>();
  private passKeyCache: Buffer | undefined;

  constructor(private readonly opts: AuthServiceOptions) {
    this.uiOrigin = new URL(opts.uiOrigin).origin;
    const host = new URL(this.uiOrigin).hostname;
    // **パスキーは名前の住所でだけ使える**（WebAuthn は IP アドレスを RP ID に取れない。2026-10-03 実測）
    this.rpID = isIpAddress(host) ? undefined : host;
    this.now = opts.now ?? Date.now;
  }

  get store(): AuthStore {
    return this.opts.store;
  }

  // ───────────── 入口で使う ─────────────

  /** CORS：画面のオリジンにだけ、資格情報つきで許す。ほかには何も返さない */
  applyCors(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("vary", "Origin");
    if (req.headers.origin !== this.uiOrigin) return;
    res.setHeader("access-control-allow-origin", this.uiOrigin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", `authorization, content-type, mcp-session-id, ${CLIENT_HEADER}`);
  }

  /** 要求の送り主を確かめる。Bearer（機械）か、検めを通った Cookie（人）か。どちらでもなければ undefined */
  async authenticate(req: IncomingMessage, res: ServerResponse): Promise<Principal | undefined> {
    const header = req.headers["authorization"];
    if (typeof header === "string" && header === `Bearer ${this.opts.authToken}`) return { kind: "machine" };
    if (!this.browserRequestAllowed(req)) return undefined;
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (!token) return undefined;
    const session = await this.opts.store.resolveSession(token);
    if (!session) return undefined;
    this.track(session.id, res);
    // 滑走する期限を、ブラウザの側にも伸ばす（1日に1回まで出し直す）
    if (this.now() - (this.cookieIssued.get(session.id) ?? 0) > 24 * 60 * 60 * 1000) {
      this.setSessionCookie(res, token, session.id);
    }
    return { kind: "session", session, token };
  }

  /** ブラウザからの要求として受けてよいか（独自のヘッダ＋Origin の一致） */
  private browserRequestAllowed(req: IncomingMessage): boolean {
    if (req.headers[CLIENT_HEADER] !== "1") return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== this.uiOrigin) return false;
    return true;
  }

  private track(sessionId: string, res: ServerResponse): void {
    let set = this.openResponses.get(sessionId);
    if (!set) this.openResponses.set(sessionId, (set = new Set()));
    set.add(res);
    res.on("close", () => {
      set!.delete(res);
      if (set!.size === 0 && this.openResponses.get(sessionId) === set) this.openResponses.delete(sessionId);
    });
  }

  private setSessionCookie(res: ServerResponse, token: string, sessionId: string): void {
    appendSetCookie(res, `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`);
    this.cookieIssued.set(sessionId, this.now());
  }

  private clearSessionCookie(res: ServerResponse): void {
    appendSetCookie(res, `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
  }

  /** ログインのリンク（札はフラグメントに置く——アクセスログ・Referer に残らない） */
  loginUrl(code: string): string {
    return loginLinkUrl(this.uiOrigin, this.opts.apiBaseUrl, code);
  }

  // ───────────── /api/auth/* ─────────────

  /** `/api/auth/*` なら処理して true。違えば false（ほかの口へ） */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith("/api/auth/") && url.pathname !== PUBLISH_CALLBACK_PATH) return false;
    try {
      await this.route(req, res, url);
    } catch (err) {
      if (err instanceof AuthHttpError) {
        sendJson(res, err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      } else {
        console.warn("[host] ログインの口で失敗しました:", err);
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    if (url.pathname === PUBLISH_CALLBACK_PATH && method === "GET") return this.publishCallback(req, res, url);
    const path = url.pathname.slice("/api/auth".length);

    // ── 公開先の前の認証（Caddy の forward_auth と、画面の遷移） ──
    if (path === "/publish-check" && method === "GET") return this.publishCheck(req, res);
    if (path === "/publish-start" && method === "GET") return this.publishStart(req, res, url);

    // ── 入っていなくても呼べる口（ブラウザからの要求であることは求める） ──
    if (path === "/me" && method === "GET") {
      const principal = await this.authenticate(req, res);
      return sendJson(res, 200, {
        authenticated: principal !== undefined,
        via: principal?.kind ?? null,
        ...(principal?.kind === "session"
          ? { session: { id: principal.session.id, label: principal.session.label, method: principal.session.method } }
          : {}),
        passkeyAvailable: this.rpID !== undefined,
        hasPasskeys: this.opts.store.listPasskeys().length > 0,
      });
    }
    if (path === "/redeem" && method === "POST") {
      this.requireBrowser(req);
      this.countUnauthenticated();
      const body = await readBody(req);
      const code = typeof body.code === "string" ? body.code : "";
      const device = this.takeDeviceCode(code);
      let methodUsed: LoginMethod;
      if (device) methodUsed = "device-code";
      else if (await consumeLoginLink(this.opts.dataDir, code, this.now())) methodUsed = "login-link";
      else throw new AuthHttpError(401, "このリンクは使えません（使用済みか、10分を過ぎています）。新しいリンクを出してください");
      const label = deviceLabel(req.headers["user-agent"]);
      const { token, session } = await this.opts.store.createSession(methodUsed, label);
      this.setSessionCookie(res, token, session.id);
      if (device) this.opts.events?.publish({ type: "auth.device_added", codeId: device.codeId, label });
      return sendJson(res, 200, { ok: true, session: { id: session.id, label } });
    }
    if (path === "/passkey/login/options" && method === "POST") {
      this.requireBrowser(req);
      this.countUnauthenticated();
      const rpID = this.requireRpId();
      const options = await generateAuthenticationOptions({ rpID, userVerification: "required", timeout: CHALLENGE_TTL_MS });
      this.rememberChallenge(options.challenge, { kind: "login" });
      return sendJson(res, 200, options);
    }
    if (path === "/passkey/login/verify" && method === "POST") {
      this.requireBrowser(req);
      this.countUnauthenticated();
      const body = await readBody(req);
      const passkeyId = await this.verifyAssertion(body.response, "login");
      const { token, session } = await this.opts.store.createSession("passkey", deviceLabel(req.headers["user-agent"]));
      this.setSessionCookie(res, token, session.id);
      // パスキーで入った直後は、もう本人を確かめている
      this.stepUps.set(session.id, this.now() + STEP_UP_MS);
      return sendJson(res, 200, { ok: true, passkeyId, session: { id: session.id, label: session.label } });
    }

    // ── ここから先は人のセッションでだけ（機械の合言葉では人の扱いを変えさせない——レビュー高1） ──
    const principal = await this.authenticate(req, res);
    if (!principal) throw new AuthHttpError(401, "ログインしていません");
    if (principal.kind !== "session") throw new AuthHttpError(403, "この操作は人のセッションでだけ使えます");
    const session = principal.session;

    if (path === "/logout" && method === "POST") {
      await this.revoke(session.id, "logout", res);
      this.clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/sessions" && method === "GET") {
      return sendJson(
        res,
        200,
        this.opts.store
          .listSessions()
          .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
          .map(({ tokenHash: _hash, ...s }) => ({ ...s, current: s.id === session.id })),
      );
    }
    const sessionMatch = path.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "DELETE") {
      const id = decodeURIComponent(sessionMatch[1]!);
      if (id === session.id) {
        await this.revoke(id, "logout", res);
        this.clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      }
      this.requireStepUp(session.id);
      if (!(await this.revoke(id, "revoked"))) throw new AuthHttpError(404, "その端末はもうログインしていません");
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/passkeys" && method === "GET") {
      return sendJson(
        res,
        200,
        this.opts.store.listPasskeys().map((p) => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
      );
    }
    const passkeyMatch = path.match(/^\/passkeys\/([^/]+)$/);
    if (passkeyMatch && method === "DELETE") {
      this.requireStepUp(session.id);
      if (!(await this.opts.store.removePasskey(decodeURIComponent(passkeyMatch[1]!)))) {
        throw new AuthHttpError(404, "そのパスキーはもうありません");
      }
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/passkey/register/options" && method === "POST") {
      this.requireStepUp(session.id);
      const rpID = this.requireRpId();
      const options = await generateRegistrationOptions({
        rpName: "banto",
        rpID,
        // 1人で使う前提——ユーザーは持たない。端末のパスキーの一覧で見分けられる名前にする
        userName: `banto（${rpID}）`,
        userID: new TextEncoder().encode("banto-owner"),
        attestationType: "none",
        excludeCredentials: this.opts.store.listPasskeys().map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: CHALLENGE_TTL_MS,
      });
      this.rememberChallenge(options.challenge, { kind: "register", sessionId: session.id });
      return sendJson(res, 200, options);
    }
    if (path === "/passkey/register/verify" && method === "POST") {
      const body = await readBody(req);
      const response = body.response as RegistrationResponseJSON | undefined;
      if (!response || typeof response !== "object") throw new AuthHttpError(400, "応答がありません");
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response,
          expectedChallenge: (c) => this.takeChallenge(c, "register", session.id),
          expectedOrigin: this.uiOrigin,
          expectedRPID: this.requireRpId(),
          requireUserVerification: true,
        });
      } catch (err) {
        throw new AuthHttpError(400, `パスキーを確かめられませんでした（${err instanceof Error ? err.message : String(err)}）`);
      }
      if (!verified.verified || !verified.registrationInfo) throw new AuthHttpError(400, "パスキーを確かめられませんでした");
      const { credential } = verified.registrationInfo;
      const label =
        typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 80) : deviceLabel(req.headers["user-agent"]);
      await this.opts.store.addPasskey({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
        label,
        createdAt: new Date(this.now()).toISOString(),
      });
      // 登録した直後も、本人を確かめたことにする（続けて端末を追加できる）
      this.stepUps.set(session.id, this.now() + STEP_UP_MS);
      return sendJson(res, 200, { ok: true, passkey: { id: credential.id, label } });
    }
    if (path === "/stepup/options" && method === "POST") {
      const rpID = this.requireRpId();
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: "required",
        allowCredentials: this.opts.store.listPasskeys().map((p) => ({ id: p.id, transports: p.transports as never })),
        timeout: CHALLENGE_TTL_MS,
      });
      this.rememberChallenge(options.challenge, { kind: "stepup", sessionId: session.id });
      return sendJson(res, 200, options);
    }
    if (path === "/stepup/verify" && method === "POST") {
      const body = await readBody(req);
      await this.verifyAssertion(body.response, "stepup", session.id);
      this.stepUps.set(session.id, this.now() + STEP_UP_MS);
      return sendJson(res, 200, { ok: true });
    }
    if (path === "/device-codes" && method === "POST") {
      this.requireStepUp(session.id);
      const now = this.now();
      for (const [hash, c] of this.deviceCodes) if (c.expiresAt <= now) this.deviceCodes.delete(hash);
      if (this.deviceCodes.size >= MAX_PENDING_DEVICE_CODES) {
        throw new AuthHttpError(429, "使われていない札が多すぎます。10分ほど待ってから出してください");
      }
      const code = randomSecret();
      const codeId = randomUUID();
      const expiresAt = now + ONE_TIME_CODE_TTL_MS;
      this.deviceCodes.set(sha256(code), { codeId, expiresAt });
      return sendJson(res, 200, { codeId, url: this.loginUrl(code), expiresAt: new Date(expiresAt).toISOString() });
    }
    throw new AuthHttpError(404, "not found");
  }

  // ───────────── 公開先の前の認証 ─────────────
  //
  // oauth2-proxy と同じ形（`docs/specs/v4-security.md`「公開したものの前の認証」）。banto のセッションの Cookie は
  // 公開先へ届かない（`__Host-` で banto の名前だけ）。公開先には、その公開先の名前にだけ効く通行証を置く。
  // 札も通行証も**公開先の名前に結びつける**——Caddy を通らずに host へ直に来た要求が `X-Forwarded-Host` を
  // 偽っても、自分が持っている（＝自分の名前の）ものしか通らない。

  /** Caddy が付ける、元の要求の名前（無ければ Host） */
  private forwardedHost(req: IncomingMessage): string {
    const raw = req.headers["x-forwarded-host"] ?? req.headers.host ?? "";
    return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0]!.trim().toLowerCase().replace(/:\d+$/, "");
  }

  /** 公開先として扱ってよい URL か（banto の画面の名前の下・同じ scheme とポート・sandbox ではない） */
  private publishTarget(raw: string | null): URL | undefined {
    if (!raw) return undefined;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const ui = new URL(this.uiOrigin);
    if (url.protocol !== ui.protocol || url.port !== ui.port) return undefined;
    if (!url.hostname.endsWith(`.${ui.hostname}`)) return undefined;
    if (this.opts.sandboxOrigin && url.origin === new URL(this.opts.sandboxOrigin).origin) return undefined;
    if (url.username || url.password) return undefined;
    return url;
  }

  private passKey(): Buffer {
    if (this.passKeyCache) return this.passKeyCache;
    const dir = join(this.opts.dataDir, "auth");
    const path = join(dir, "pass-key");
    try {
      this.passKeyCache = Buffer.from(readFileSync(path, "utf8").trim(), "base64url");
    } catch {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key = randomSecret();
      writeFileSync(path, key, { mode: 0o600, flag: "wx" });
      this.passKeyCache = Buffer.from(key, "base64url");
    }
    return this.passKeyCache;
  }

  private signPass(payload: { s: string; h: string; e: number }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = createHmac("sha256", this.passKey()).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  /** 通行証を確かめる。その名前のもので、期限内で、もとのセッションが生きているときだけ通す */
  private async verifyPass(value: string | undefined, host: string): Promise<boolean> {
    if (!value) return false;
    const [body, mac] = value.split(".");
    if (!body || !mac) return false;
    const expected = createHmac("sha256", this.passKey()).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    let payload: { s?: unknown; h?: unknown; e?: unknown };
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as typeof payload;
    } catch {
      return false;
    }
    if (payload.h !== host || typeof payload.e !== "number" || payload.e <= this.now()) return false;
    // 締め出した端末の通行証は、次の要求から効かない
    const session = typeof payload.s === "string" ? this.opts.store.getSession(payload.s) : undefined;
    if (!session) return false;
    return this.now() - Date.parse(session.lastUsedAt) <= 30 * 24 * 60 * 60 * 1000;
  }

  /** Caddy の forward_auth から呼ばれる。通れば 200、だめなら画面の遷移は banto へ、それ以外は 401 */
  private async publishCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = this.forwardedHost(req);
    const mode = req.headers["sec-fetch-mode"];
    const site = req.headers["sec-fetch-site"];
    // **公開先どうしの横取りを断る**（Fable のレビュー中5）——別の公開先のページから要求を出すと、Lax の通行証が
    // 付いてこの公開先を人の名義で動かせる。画面の遷移（リンクを押した）は通す
    if (mode !== "navigate" && site !== undefined && site !== "same-origin" && site !== "none") {
      return sendJson(res, 403, { error: "別のサイトのページからの要求は通しません" });
    }
    if (await this.verifyPass(parseCookies(req.headers.cookie).get(PASS_COOKIE), host)) {
      res.writeHead(200, { "cache-control": "no-store" }).end();
      return;
    }
    if (mode === "navigate") {
      const uri = String(req.headers["x-forwarded-uri"] ?? "/");
      const proto = new URL(this.uiOrigin).protocol;
      const port = new URL(this.uiOrigin).port;
      const rd = `${proto}//${host}${port ? `:${port}` : ""}${uri.startsWith("/") ? uri : "/"}`;
      const start = `${new URL(this.opts.apiBaseUrl).origin}/api/auth/publish-start?rd=${encodeURIComponent(rd)}`;
      res.writeHead(302, { location: start, "cache-control": "no-store" }).end();
      return;
    }
    sendJson(res, 401, { error: "banto にログインしてから開いてください" });
  }

  /** 画面の遷移で来る。banto に入っていれば、その公開先だけの札を付けて戻す */
  private async publishStart(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const target = this.publishTarget(url.searchParams.get("rd"));
    if (!target) return sendHtml(res, 400, "戻り先が banto の公開先ではありません");
    // 遷移なので独自のヘッダは付かない。Cookie だけを見る（ここで起きるのは「その公開先へ札を持って戻る」だけ
    // ——札も通行証もその公開先の名前に結びつくので、よそから踏ませても、よそのものは手に入らない）
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = token ? await this.opts.store.resolveSession(token) : undefined;
    if (!session) {
      const back = `${new URL(this.opts.apiBaseUrl).origin}/api/auth/publish-start?rd=${encodeURIComponent(target.href)}`;
      res.writeHead(302, { location: `${this.uiOrigin}/?next=${encodeURIComponent(back)}`, "cache-control": "no-store" }).end();
      return;
    }
    const now = this.now();
    for (const [h, c] of this.publishCodes) if (c.expiresAt <= now) this.publishCodes.delete(h);
    if (this.publishCodes.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.publishCodes.keys().next().value;
      if (oldest !== undefined) this.publishCodes.delete(oldest);
    }
    const code = randomSecret();
    this.publishCodes.set(sha256(code), { host: target.hostname, sessionId: session.id, expiresAt: now + PUBLISH_CODE_TTL_MS });
    const back = `${target.pathname}${target.search}`;
    const callback = `${target.origin}${PUBLISH_CALLBACK_PATH}?code=${encodeURIComponent(code)}&rd=${encodeURIComponent(back)}`;
    res.writeHead(302, { location: callback, "cache-control": "no-store" }).end();
  }

  /** 公開先の `/.banto-auth/callback`（Caddy が host へ回す）。札を引き換えて通行証を置き、元の場所へ戻す */
  private async publishCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const host = this.forwardedHost(req);
    const code = url.searchParams.get("code") ?? "";
    const found = this.publishCodes.get(sha256(code));
    if (found) this.publishCodes.delete(sha256(code));
    if (!found || found.expiresAt <= this.now() || found.host !== host) {
      return sendHtml(res, 400, "この戻りは使えません（使用済みか、1分を過ぎています）。もう一度開き直してください");
    }
    const session = this.opts.store.getSession(found.sessionId);
    if (!session) return sendHtml(res, 400, "banto のログインが切れています。もう一度開き直してください");
    // 戻り先はパスだけ。`//` と `/\` は別の名前へ飛ぶので断る（開いたリダイレクトにしない）
    const rd = url.searchParams.get("rd") ?? "/";
    const safe = rd.startsWith("/") && !rd.startsWith("//") && !rd.startsWith("/\\") ? rd : "/";
    const pass = this.signPass({ s: session.id, h: host, e: this.now() + COOKIE_MAX_AGE_S * 1000 });
    res.writeHead(302, {
      location: safe,
      "set-cookie": `${PASS_COOKIE}=${pass}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
    });
    res.end();
  }

  // ───────────── 中身 ─────────────

  private requireBrowser(req: IncomingMessage): void {
    if (!this.browserRequestAllowed(req)) throw new AuthHttpError(403, "banto の画面からの要求ではありません");
  }

  private requireRpId(): string {
    if (!this.rpID) {
      throw new AuthHttpError(400, "パスキーは名前の住所（例 https://banto.example）で開いたときだけ使えます（IP アドレスでは使えません）");
    }
    return this.rpID;
  }

  /** 大事な操作の前の本人確認。パスキーがまだ1つも無いときは求めない */
  private requireStepUp(sessionId: string): void {
    if (this.opts.store.listPasskeys().length === 0) return;
    if ((this.stepUps.get(sessionId) ?? 0) > this.now()) return;
    throw new AuthHttpError(403, "この操作の前に、パスキーで本人を確かめてください", "step-up-required");
  }

  private countUnauthenticated(): void {
    const now = this.now();
    if (now - this.unauthWindow.startedAt > 60_000) this.unauthWindow = { startedAt: now, count: 0 };
    if (++this.unauthWindow.count > UNAUTH_PER_MINUTE) {
      throw new AuthHttpError(429, "ログインの試みが多すぎます。1分ほど待ってください");
    }
  }

  private rememberChallenge(challenge: string, pending: Omit<PendingChallenge, "expiresAt">): void {
    const now = this.now();
    for (const [c, p] of this.challenges) if (p.expiresAt <= now) this.challenges.delete(c);
    if (this.challenges.size >= MAX_PENDING_CHALLENGES) {
      // 古いものから捨てる（Map は入れた順）
      const oldest = this.challenges.keys().next().value;
      if (oldest !== undefined) this.challenges.delete(oldest);
    }
    this.challenges.set(challenge, { ...pending, expiresAt: now + CHALLENGE_TTL_MS });
  }

  /** challenge を1回だけ使う。種類と（あれば）セッションが合っているときだけ通す */
  private takeChallenge(challenge: string, kind: PendingChallenge["kind"], sessionId?: string): boolean {
    const pending = this.challenges.get(challenge);
    if (!pending) return false;
    this.challenges.delete(challenge);
    return pending.kind === kind && pending.sessionId === sessionId && pending.expiresAt > this.now();
  }

  private takeDeviceCode(code: string): { codeId: string } | undefined {
    if (!code) return undefined;
    const hash = sha256(code);
    const found = this.deviceCodes.get(hash);
    if (!found) return undefined;
    this.deviceCodes.delete(hash);
    return found.expiresAt > this.now() ? { codeId: found.codeId } : undefined;
  }

  private async verifyAssertion(raw: unknown, kind: "login" | "stepup", sessionId?: string): Promise<string> {
    const response = raw as AuthenticationResponseJSON | undefined;
    if (!response || typeof response !== "object" || typeof response.id !== "string") {
      throw new AuthHttpError(400, "応答がありません");
    }
    const passkey = this.opts.store.getPasskey(response.id);
    if (!passkey) throw new AuthHttpError(401, "このパスキーは banto に登録されていません（消されたか、別の banto のものです）");
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => this.takeChallenge(c, kind, sessionId),
        expectedOrigin: this.uiOrigin,
        expectedRPID: this.requireRpId(),
        credential: {
          id: passkey.id,
          publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
          // **署名回数が増えないことを複製とは見ない**（仕様。同期型のパスキーは常に 0 を返し、同じパスキーを
          // 複数の端末で使うと回数は端末ごとに進む）。ライブラリの「前より大きいか」の検めを効かせないよう 0 を渡す。
          // 記録には最後の値を残す（見るだけ）
          counter: 0,
          transports: passkey.transports as never,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      throw new AuthHttpError(401, `パスキーを確かめられませんでした（${err instanceof Error ? err.message : String(err)}）`);
    }
    if (!verified.verified) throw new AuthHttpError(401, "パスキーを確かめられませんでした");
    await this.opts.store.markPasskeyUsed(passkey.id, verified.authenticationInfo.newCounter);
    return passkey.id;
  }

  /** 締め出す：記録から消し、開いている流れも切る（`keep` はいま答えている応答——自分のログアウト） */
  private async revoke(sessionId: string, reason: "revoked" | "logout", keep?: ServerResponse): Promise<boolean> {
    const ok = await this.opts.store.revokeSession(sessionId, reason);
    this.stepUps.delete(sessionId);
    this.cookieIssued.delete(sessionId);
    for (const res of this.openResponses.get(sessionId) ?? []) if (res !== keep) res.destroy();
    this.openResponses.delete(sessionId);
    return ok;
  }
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader("set-cookie");
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev : [String(prev)];
  res.setHeader("set-cookie", [...list, value]);
}

function sendHtml(res: ServerResponse, status: number, message: string): void {
  const safe = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html =
    `<!doctype html><html lang="ja"><head><meta charset="utf-8" /><title>banto</title>` +
    `<style>body{font:16px/1.7 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;color-scheme:light dark}` +
    `p{max-width:34rem;padding:1.5rem}</style></head><body><p>${safe}</p></body></html>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 64 * 1024) throw new AuthHttpError(413, "送る中身が大きすぎます");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new AuthHttpError(400, "JSON として読めません");
  }
}
