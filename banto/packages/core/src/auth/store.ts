// 人のログインの記録（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// **セッションとパスキーは Event Store が唯一の真実**（規則3）——host を起こし直しても、端末は入ったまま。
// セッションの値そのものは持たない。**ハッシュ（SHA-256）だけ**を持つので、データ置き場が漏れてもなりすませない。
//
// 1回だけの札・パスキーの challenge・step-up の印は**プロセスメモリ**（数分の寿命のために記録を増やさない
// ——OAuth の PKCE の途中の値と同じ扱い、v4-security.md §3）。host を起こし直せば消える＝やり直せばよい。

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { EventLog, StoredEvent } from "../event-store/log.js";
import { SnapshotProjection, type Fold } from "../event-store/snapshot.js";

/** セッションの期限：最後に使ってから 30 日（決定・2026-10-03、ユーザー「手間は増やしたくない」） */
export const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** 最後に使った時刻を記録へ書く間隔。毎回書くと、要求のたびに Event Store が伸びる */
const TOUCH_PERSIST_MS = 60 * 60 * 1000;

export type LoginMethod = "login-link" | "device-code" | "passkey";

export interface SessionRecord {
  /** 画面で指すための印（値そのものではない） */
  id: string;
  tokenHash: string;
  method: LoginMethod;
  /** User-Agent から作ったおおよその端末名 */
  label: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface PasskeyRecord {
  /** credential id（base64url） */
  id: string;
  /** COSE の公開鍵（base64url） */
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface AuthReadModel {
  sessions: Map<string, SessionRecord>;
  passkeys: Map<string, PasskeyRecord>;
}

type AuthEvent =
  | { type: "auth.session_created"; payload: SessionRecord }
  | { type: "auth.session_touched"; payload: { id: string; at: string } }
  | { type: "auth.session_revoked"; payload: { id: string; reason: "revoked" | "logout" | "expired" } }
  | { type: "auth.passkey_added"; payload: PasskeyRecord }
  | { type: "auth.passkey_used"; payload: { id: string; counter: number; at: string } }
  | { type: "auth.passkey_removed"; payload: { id: string } };

export const authFold: Fold<AuthReadModel> = {
  initial: () => ({ sessions: new Map(), passkeys: new Map() }),
  apply(state, raw: StoredEvent): AuthReadModel {
    const event = raw as unknown as AuthEvent;
    switch (event.type) {
      case "auth.session_created": {
        const sessions = new Map(state.sessions);
        sessions.set(event.payload.id, event.payload);
        return { ...state, sessions };
      }
      case "auth.session_touched": {
        const s = state.sessions.get(event.payload.id);
        if (!s) return state;
        const sessions = new Map(state.sessions);
        sessions.set(s.id, { ...s, lastUsedAt: event.payload.at });
        return { ...state, sessions };
      }
      case "auth.session_revoked": {
        if (!state.sessions.has(event.payload.id)) return state;
        const sessions = new Map(state.sessions);
        sessions.delete(event.payload.id);
        return { ...state, sessions };
      }
      case "auth.passkey_added": {
        const passkeys = new Map(state.passkeys);
        passkeys.set(event.payload.id, event.payload);
        return { ...state, passkeys };
      }
      case "auth.passkey_used": {
        const p = state.passkeys.get(event.payload.id);
        if (!p) return state;
        const passkeys = new Map(state.passkeys);
        passkeys.set(p.id, { ...p, counter: event.payload.counter, lastUsedAt: event.payload.at });
        return { ...state, passkeys };
      }
      case "auth.passkey_removed": {
        if (!state.passkeys.has(event.payload.id)) return state;
        const passkeys = new Map(state.passkeys);
        passkeys.delete(event.payload.id);
        return { ...state, passkeys };
      }
      default:
        return state;
    }
  },
};

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 推測できない値（256 bit）。Cookie・札に使う */
export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export class AuthStore {
  private readonly projection: SnapshotProjection<AuthReadModel>;
  /** 最後に使った時刻（記録に書くのは TOUCH_PERSIST_MS ごと。ここは毎回） */
  private readonly lastSeen = new Map<string, number>();

  constructor(
    dataDir: string,
    private readonly log: EventLog,
    private readonly now: () => number = Date.now,
  ) {
    this.projection = new SnapshotProjection(dataDir, "auth", log, authFold);
  }

  async load(): Promise<void> {
    await this.projection.load();
  }
  async save(): Promise<void> {
    await this.projection.save();
  }

  private async append(type: AuthEvent["type"], payload: AuthEvent["payload"]): Promise<void> {
    const event = await this.log.append(type, payload);
    this.projection.applyOne(event);
  }

  /** セッションを作り、**Cookie に入れる値**を返す（記録にはハッシュだけ） */
  async createSession(method: LoginMethod, label: string): Promise<{ token: string; session: SessionRecord }> {
    const token = randomSecret();
    const at = new Date(this.now()).toISOString();
    const session: SessionRecord = { id: randomUUID(), tokenHash: sha256(token), method, label, createdAt: at, lastUsedAt: at };
    await this.append("auth.session_created", session);
    return { token, session };
  }

  /** Cookie の値からセッションを引く。期限切れなら消して undefined */
  async resolveSession(token: string): Promise<SessionRecord | undefined> {
    const hash = sha256(token);
    const session = [...this.projection.current.sessions.values()].find((s) => s.tokenHash === hash);
    if (!session) return undefined;
    const now = this.now();
    const last = Math.max(Date.parse(session.lastUsedAt), this.lastSeen.get(session.id) ?? 0);
    if (now - last > SESSION_IDLE_MS) {
      await this.append("auth.session_revoked", { id: session.id, reason: "expired" });
      this.lastSeen.delete(session.id);
      return undefined;
    }
    this.lastSeen.set(session.id, now);
    if (now - Date.parse(session.lastUsedAt) > TOUCH_PERSIST_MS) {
      await this.append("auth.session_touched", { id: session.id, at: new Date(now).toISOString() });
    }
    return this.projection.current.sessions.get(session.id);
  }

  listSessions(): SessionRecord[] {
    return [...this.projection.current.sessions.values()].map((s) => {
      const seen = this.lastSeen.get(s.id);
      return seen && seen > Date.parse(s.lastUsedAt) ? { ...s, lastUsedAt: new Date(seen).toISOString() } : s;
    });
  }

  getSession(id: string): SessionRecord | undefined {
    return this.projection.current.sessions.get(id);
  }

  async revokeSession(id: string, reason: "revoked" | "logout"): Promise<boolean> {
    if (!this.projection.current.sessions.has(id)) return false;
    await this.append("auth.session_revoked", { id, reason });
    this.lastSeen.delete(id);
    return true;
  }

  listPasskeys(): PasskeyRecord[] {
    return [...this.projection.current.passkeys.values()];
  }
  getPasskey(id: string): PasskeyRecord | undefined {
    return this.projection.current.passkeys.get(id);
  }
  async addPasskey(record: PasskeyRecord): Promise<void> {
    await this.append("auth.passkey_added", record);
  }
  async markPasskeyUsed(id: string, counter: number): Promise<void> {
    await this.append("auth.passkey_used", { id, counter, at: new Date(this.now()).toISOString() });
  }
  async removePasskey(id: string): Promise<boolean> {
    if (!this.projection.current.passkeys.has(id)) return false;
    await this.append("auth.passkey_removed", { id });
    return true;
  }
}
