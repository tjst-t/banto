"use client";

// 人のログインの口（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。host の `/api/auth/*` を呼ぶ。
// パスキーはブラウザの WebAuthn（`@simplewebauthn/browser`）。本人の確かめ方（指紋・顔・パスコード）は端末が決める。

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { hostFetch } from "./client";

export interface AuthMe {
  authenticated: boolean;
  via: "session" | "machine" | null;
  session?: { id: string; label: string; method: LoginMethod };
  /** パスキーを使える住所で開いているか（IP アドレスでは使えない） */
  passkeyAvailable: boolean;
  hasPasskeys: boolean;
}
export type LoginMethod = "login-link" | "device-code" | "passkey";

export interface AuthSession {
  id: string;
  method: LoginMethod;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
}

export interface AuthPasskey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

export class StepUpRequiredError extends Error {}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await hostFetch(`/api/auth${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    if (data.code === "step-up-required") throw new StepUpRequiredError(data.error ?? "本人の確認が要ります");
    throw new Error(data.error ?? `banto が ${res.status} を返しました`);
  }
  return data as T;
}

export function fetchAuthMe(): Promise<AuthMe> {
  return call<AuthMe>("/me");
}

/** 1回だけの札（ログインのリンク・端末を追加）で入る */
export async function redeemLoginCode(code: string): Promise<void> {
  await call("/redeem", { method: "POST", body: { code } });
}

/** **パスキーのやり取りの失敗を、人に読める言葉にする**——取り消しはブラウザの名前のまま出さない */
function describeWebAuthnError(err: unknown): Error {
  if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
    return new Error("パスキーの確認が取り消されたか、時間切れになりました");
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function loginWithPasskey(): Promise<void> {
  const options = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/passkey/login/options", { method: "POST" });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw describeWebAuthnError(err);
  }
  await call("/passkey/login/verify", { method: "POST", body: { response } });
}

/** その場でパスキーを通す（大事な操作の前） */
export async function stepUp(): Promise<void> {
  const options = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/stepup/options", { method: "POST" });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (err) {
    throw describeWebAuthnError(err);
  }
  await call("/stepup/verify", { method: "POST", body: { response } });
}

/** 本人の確認を求められたら、パスキーを通してからもう一度だけ試す */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof StepUpRequiredError)) throw err;
    await stepUp();
    return action();
  }
}

export async function registerPasskey(label?: string): Promise<{ passkey: { id: string; label: string } }> {
  try {
    return await registerPasskeyOnce(label);
  } catch (err) {
    if (!(err instanceof StepUpRequiredError)) throw err;
  }
  // 入ってから10分を過ぎた端末は、登録の前に本人確認が要る。この端末にパスキーが無ければ通らない——そう言う
  try {
    await stepUp();
  } catch {
    throw new Error(
      "登録の前の本人確認が通りませんでした。この端末にまだパスキーが無いときは、ほかの端末の「端末を追加」でこの端末に入り直し、10分以内に登録してください",
    );
  }
  return registerPasskeyOnce(label);
}

function registerPasskeyOnce(label?: string): Promise<{ passkey: { id: string; label: string } }> {
  return (async () => {
    const options = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/passkey/register/options", {
      method: "POST",
    });
    let response;
    try {
      response = await startRegistration({ optionsJSON: options });
    } catch (err) {
      if (err instanceof Error && err.name === "InvalidStateError") {
        throw new Error("この端末のパスキーはもう登録してあります");
      }
      throw describeWebAuthnError(err);
    }
    return call<{ passkey: { id: string; label: string } }>("/passkey/register/verify", {
      method: "POST",
      body: { response, ...(label ? { label } : {}) },
    });
  })();
}

export function listAuthSessions(): Promise<AuthSession[]> {
  return call<AuthSession[]>("/sessions");
}
export function revokeAuthSession(id: string): Promise<void> {
  return withStepUp(() => call<void>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }));
}
export function listPasskeys(): Promise<AuthPasskey[]> {
  return call<AuthPasskey[]>("/passkeys");
}
export function removePasskey(id: string): Promise<void> {
  return withStepUp(() => call<void>(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }));
}
export function createDeviceCode(): Promise<{ codeId: string; url: string; expiresAt: string }> {
  return withStepUp(() => call<{ codeId: string; url: string; expiresAt: string }>("/device-codes", { method: "POST" }));
}
export async function logout(): Promise<void> {
  await call("/logout", { method: "POST" });
}

export const METHOD_LABEL: Record<LoginMethod, string> = {
  "login-link": "host のリンク",
  "device-code": "端末を追加",
  passkey: "パスキー",
};
