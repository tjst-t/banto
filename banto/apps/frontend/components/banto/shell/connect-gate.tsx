"use client";

// **ログインしていないなら、そう言う**（決定・2026-09-18、改訂・2026-10-03）。
//
// 2026-09-18：合言葉が無いと API を1回も呼ばずに「まだ Project がありません」と出していた——聞いていないのに
// 「無い」と言い切っていた（規則2・規則13）。だから門で止め、繋がっていないことを言う。
//
// 2026-10-03（`docs/specs/v4-security.md`「人のログイン」）：合言葉を打つ欄をやめ、**端末ごとのセッション**にした。
// 入り方は3つ——パスキー・ほかの端末の「端末を追加」（QR かリンク）・host のコマンドが出すリンク。リンクの札は
// URL のフラグメント（`#banto-login=…`）にあり、門が読んで引き換え、URL から消す。

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBackendConfig, onUnauthorized } from "@/lib/backend/client";
import { fetchAuthMe, loginWithPasskey, redeemLoginCode, type AuthMe } from "@/lib/backend/auth";

const LOGIN_FRAGMENT = "banto-login=";

/** 札と古い合言葉を URL から外した場所（履歴とブックマークに焼き付けない） */
function cleanUrl(): string {
  const url = new URL(window.location.href);
  url.hash = "";
  url.searchParams.delete("bantoToken");
  return `${url.pathname}${url.search}`;
}

/**
 * **HTTPS でなければ使わせない**（決定・2026-10-03、ユーザー）。
 *
 * http で開くと、ブラウザが「安全な文脈」でしか出さない機能（`crypto.randomUUID`・クリップボード等）が無く、
 * 携帯から送信ごと落ちていた（a029ea1a で送信は直したが、ほかにも同じ形の穴がありうる）。加えて合言葉が
 * 平文で流れ、http と https は別のオリジンなので覚えた合言葉も別々になる。だから途中まで動かすより、
 * 最初に止めて HTTPS の住所へ案内する。localhost（開発・E2E）は安全な文脈なので止まらない。
 */
function InsecureNotice() {
  const { hostname, pathname, search, hash } = window.location;
  // 名前で開いていれば、同じ名前の https（既定のポート＝前に置いた Caddy 等）へ。IP アドレスには証明書が無いので案内できない
  const isAddress = /^[\d.]+$/.test(hostname) || hostname.includes(":");
  const httpsUrl = isAddress ? null : `https://${hostname}${pathname}${search}${hash}`;
  return (
    <div className="grid min-h-dvh place-items-center p-6" data-testid="insecure-gate">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">HTTPS で開いてください</h1>
          <p className="text-sm text-ink-3">
            この画面は http で開かれています。banto は HTTPS でしか動きません——http ではブラウザが一部の機能を
            出さず（メッセージの送信などが落ちる）、ログインの情報も暗号化されずに流れます。
          </p>
        </div>
        {httpsUrl ? (
          <Button asChild>
            <a href={httpsUrl}>HTTPS で開き直す</a>
          </Button>
        ) : (
          <p className="text-sm text-ink-3">
            いまは IP アドレス（<code>{hostname}</code>）で開いています。HTTPS の名前（Caddy などで証明書を付けた住所）で開いてください。
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * **公開先から回されてきたとき**（`?next=…/api/auth/publish-start?rd=…`）、入ったらそこへ戻る。
 * 戻ってよいのは banto 自身の `publish-start` だけ（よそへ飛ばす道にしない）
 */
function publishNext(): string | null {
  const next = new URLSearchParams(window.location.search).get("next");
  const base = getBackendConfig()?.baseUrl;
  if (!next || !base) return null;
  try {
    const url = new URL(next);
    return url.origin === new URL(base).origin && url.pathname === "/api/auth/publish-start" ? url.href : null;
  } catch {
    return null;
  }
}

type GateState =
  | { kind: "checking" }
  | { kind: "insecure" }
  | { kind: "in" }
  | { kind: "login"; me: AuthMe | null; error: string | null };

export function ConnectGate({ children }: { children: ReactNode }) {
  /** `checking` ＝まだ調べていない（**「無い」と言い切らない**） */
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [busy, setBusy] = useState(false);

  const check = useCallback(async (error: string | null = null) => {
    try {
      const me = await fetchAuthMe();
      const next = me.authenticated && !error ? publishNext() : null;
      if (next) {
        window.location.assign(next);
        return;
      }
      setState(me.authenticated && !error ? { kind: "in" } : { kind: "login", me, error });
    } catch (err) {
      setState({ kind: "login", me: null, error: `banto に繋がりません（${err instanceof Error ? err.message : String(err)}）` });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // 描いてから調べる（初めの描画は「調べている」のまま——サーバで描いたものと食い違わせない）
      await Promise.resolve();
      if (!window.isSecureContext) {
        setState({ kind: "insecure" });
        return;
      }
      const hash = window.location.hash.slice(1);
      if (hash.startsWith(LOGIN_FRAGMENT)) {
        const code = hash.slice(LOGIN_FRAGMENT.length);
        // 先に URL から消す——引き換えに失敗しても、札を履歴に残さない
        window.history.replaceState(null, "", cleanUrl());
        try {
          await redeemLoginCode(code);
        } catch (err) {
          await check(err instanceof Error ? err.message : String(err));
          return;
        }
        // 入ったら読み込み直す——門より先に走った読み込み（ログイン前で通らなかったもの）も取り直す
        window.location.replace(cleanUrl());
        return;
      }
      if (new URLSearchParams(window.location.search).has("bantoToken")) {
        window.history.replaceState(null, "", cleanUrl());
      }
      await check();
    })();
  }, [check]);

  // ログインが切れた・締め出された（どこかの要求が 401）——門を出し直す
  useEffect(() => onUnauthorized(() => void check()), [check]);

  if (state.kind === "insecure") return <InsecureNotice />;
  if (state.kind === "checking") return null;
  if (state.kind === "in") return <>{children}</>;

  async function passkey() {
    setBusy(true);
    try {
      await loginWithPasskey();
      window.location.replace(cleanUrl());
    } catch (err) {
      setState({ kind: "login", me: state.kind === "login" ? state.me : null, error: err instanceof Error ? err.message : String(err) });
      setBusy(false);
    }
  }

  const me = state.me;
  return (
    <div className="grid min-h-dvh place-items-center p-6" data-testid="connect-gate">
      <div className="flex w-full max-w-sm flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">banto にログイン</h1>
          {/* **「無い」ではなく「まだ入っていない」** */}
          <p className="text-sm text-ink-3">この端末はまだ banto にログインしていません。</p>
          {publishNext() ? (
            <p className="text-sm text-ink-3">入ると、開こうとしていた公開先へ戻ります。</p>
          ) : null}
        </div>

        {me?.passkeyAvailable ? (
          <div className="flex flex-col gap-1.5">
            <Button onClick={() => void passkey()} disabled={busy} data-testid="login-passkey">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              パスキーで入る
            </Button>
            {!me.hasPasskeys ? (
              <p className="text-xs text-ink-3">まだパスキーが登録されていません。下のどちらかで入ってから、設定で登録できます。</p>
            ) : null}
          </div>
        ) : null}

        {state.error ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-danger" data-testid="connect-error">
              {state.error}
            </p>
            {/* 繋がらなかった（host に届かない）——やり直す口を出す */}
            {me === null ? (
              <Button variant="outline" size="sm" onClick={() => void check()}>
                もう一度試す
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-4 text-sm">
          <div>
            <p className="font-medium text-foreground">ほかの端末から入る</p>
            <p className="text-ink-3">
              ログインしている端末で <strong>設定 → ログイン → 端末を追加</strong> を押し、出た QR をこの端末で読むか、リンクを開いてください。
            </p>
          </div>
          <div>
            <p className="font-medium text-foreground">どの端末にも入っていないとき</p>
            <p className="text-ink-3">
              banto を動かしている機械で、banto のフォルダから <code className="text-xs">node scripts/login-link.mjs</code>{" "}
              を打つと、1回だけ使えるリンクが出ます。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
