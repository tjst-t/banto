"use client";

// **繋がっていないなら、そう言う**（決定・2026-09-18、ユーザー要望）。
//
// これまでは合言葉が無いと **API を1回も呼ばずに**「まだ Project がありません」
// と出していた。**聞いていないのに「無い」と言い切っていた**——規則2（黙って
// 別の経路へ落ちない）と規則13（見えているものは繋がっている）に正面から反する。
//
// 実際に踏んだ（2026-09-18）：http と https は**別のオリジン**なので、https で
// 開いた瞬間に保存済みの合言葉が見えなくなり、**Project が全部消えたように見えた**。
// データは無事だったが、画面がそう言わなかったので分からなかった。
//
// **確かめてから覚える。** 打った合言葉で実際に1回呼び、通らなければ保存しない
// ——間違った値を覚えると、次に開いたときまた同じ空っぽを見ることになる。

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getBackendConfig, setBackendConfig, type BackendConfig } from "@/lib/backend/client";

/** 打った値で実際に呼んでみる。**通らなければ覚えない**。 */
async function verify(config: BackendConfig): Promise<void> {
  // **ヘッダに載らない文字は、載せる前に断る**（追加・2026-09-18、試験が教えた）。
  // そのまま `fetch` に渡すと「String contains non ISO-8859-1 code point」という
  // **何が悪いのか分からない**文言が出る（規則2——嘘ではないが、直す手がかりが無い）
  if (!/^[\x21-\x7e]+$/.test(config.token)) {
    throw new Error("アクセストークンに使えない文字が含まれています（記号と半角英数字のみ）");
  }
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/api/projects`, {
      headers: { authorization: `Bearer ${config.token}` },
    });
  } catch (err) {
    throw new Error(
      `${config.baseUrl} に繋がりません（${err instanceof Error ? err.message : String(err)}）`,
    );
  }
  if (res.status === 401) throw new Error("アクセストークンが違います");
  if (!res.ok) throw new Error(`banto が ${res.status} を返しました`);
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
            出さず（メッセージの送信などが落ちる）、アクセストークンも暗号化されずに流れます。
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

export function ConnectGate({ children }: { children: ReactNode }) {
  /** `undefined` ＝まだ調べていない（**「無い」と言い切らない**）。`"insecure"` ＝ http で開かれている */
  const [config, setConfig] = useState<BackendConfig | null | undefined | "insecure">(undefined);
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // http では合言葉を読みも覚えもしない（URL の bantoToken は HTTPS の住所へそのまま運ぶ）
    setConfig(window.isSecureContext ? getBackendConfig() : "insecure");
    // **既定は、いま開いているところ**（Caddy が `/api/*` を host へ回している）。
    // 直に叩く開発では違うので、直せる欄として出す
    setBaseUrl(window.location.origin);
  }, []);

  if (config === "insecure") return <InsecureNotice />;
  // 調べている間は何も断定しない（一瞬なので、余計なものを出さない）
  if (config === undefined) return null;
  if (config) return <>{children}</>;

  async function connect(e: FormEvent) {
    e.preventDefault();
    const next: BackendConfig = { baseUrl: baseUrl.trim().replace(/\/$/, ""), token: token.trim() };
    if (!next.token) return;
    setBusy(true);
    setError(null);
    try {
      await verify(next);
      setBackendConfig(next);
      // **持ってきた合言葉を URL に残さない**——履歴とブックマークに合言葉が
      // 焼き付く。覚えたあとは素の場所へ行き直す
      window.location.replace(window.location.pathname);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-6" data-testid="connect-gate">
      <form onSubmit={connect} className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">banto に繋ぐ</h1>
          {/* **「無い」ではなく「まだ繋がっていない」**——ここが今回の本題 */}
          <p className="text-sm text-ink-3">
            この画面はまだ banto に接続していません。
            <strong>アクセストークンを入力すると、Project が表示されます。</strong>
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="connect-token">アクセストークン</Label>
          <Input
            id="connect-token"
            type="password"
            autoFocus
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="config.json の authToken"
          />
          <p className="text-xs text-ink-3">
            サーバの <code>~/.config/banto/config.json</code> の <code>authToken</code>
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="connect-host">接続先</Label>
          <Input
            id="connect-host"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://banto.example"
          />
        </div>

        {error ? (
          <p className="text-sm text-danger" data-testid="connect-error">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy || token.trim().length === 0}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          接続
        </Button>
      </form>
    </div>
  );
}
