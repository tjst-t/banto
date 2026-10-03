"use client";

// **設定の「ログイン」**（決定・2026-10-03、`docs/specs/v4-security.md`「人のログイン」）。
//
// - パスキー：この端末のものを登録する・消す
// - 端末を追加：10分・1回だけ使える QR とリンク（中身は同じ）。使われたら「端末が入りました」と出す
// - ログイン中の端末：一覧と、1台ずつ締め出す
//
// 端末を追加・パスキーの追加と削除・締め出しの前には、その場でパスキーを通す（パスキーが1つも無いうちは
// 求めない）。本人の確かめ方は端末に任せる（指紋・顔・パスコード）。
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, KeyRound, Loader2, LogOut, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { describeFailure } from "@/lib/report-failure";
import { onRealAppEvent } from "@/lib/backend/app-events";
import {
  METHOD_LABEL,
  createDeviceCode,
  fetchAuthMe,
  listAuthSessions,
  listPasskeys,
  logout,
  registerPasskey,
  removePasskey,
  revokeAuthSession,
  type AuthMe,
  type AuthPasskey,
  type AuthSession,
} from "@/lib/backend/auth";

function when(iso: string | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description ? <p className="mt-0.5 mb-2 text-xs text-ink-3">{description}</p> : <div className="mb-2" />}
      {children}
    </section>
  );
}

export function LoginPanel() {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [sessions, setSessions] = useState<AuthSession[] | null>(null);
  const [passkeys, setPasskeys] = useState<AuthPasskey[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deviceDialog, setDeviceDialog] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([fetchAuthMe(), listAuthSessions(), listPasskeys()])
        .then(([m, s, p]) => {
          setMe(m);
          setSessions(s);
          setPasskeys(p);
          setLoadError(null);
        })
        .catch((err: unknown) => setLoadError(describeFailure(err))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // ほかの端末が入ったら一覧を取り直す
  useEffect(() => onRealAppEvent((e) => void (e.type === "auth.device_added" && load())), [load]);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(describeFailure(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div data-testid="login-panel-error" className="flex flex-col items-start gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-foreground">ログインの情報を取得できませんでした</p>
        <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void load()}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (!me || !sessions || !passkeys) return <p className="text-xs text-ink-3">読み込み中…</p>;
  const current = sessions.find((s) => s.current);

  return (
    <div data-testid="login-panel">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">ログイン</h1>
      <p className="mb-4 text-xs text-ink-3">
        {"banto には端末ごとにログインします。30日使わなかった端末は、入り直しになります。" +
          "端末を追加・パスキーの追加と削除・締め出しの前には、その場でパスキーを通します（指紋・顔・パスコードなど、端末が本人と認める方法）。"}
      </p>

      {actionError ? (
        <p data-testid="login-panel-action-error" className="mb-3 text-xs text-stop">
          {actionError}
        </p>
      ) : null}

      <Section title="この端末">
        <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
          <Smartphone className="size-4 shrink-0 text-ink-3" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{current?.label ?? me.session?.label ?? "この端末"}</p>
            <p className="text-xs text-ink-3">{current ? `${METHOD_LABEL[current.method]}で入りました・${when(current.createdAt)}` : null}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={busy !== null}
            data-testid="login-logout"
            onClick={() =>
              void run("logout", async () => {
                await logout();
                window.location.reload();
              })
            }
          >
            <LogOut className="size-3.5" />
            ログアウト
          </Button>
        </div>
      </Section>

      <Section
        title="パスキー"
        description={
          me.passkeyAvailable
            ? "登録しておくと、この端末はパスキーで入り直せます。Google パスワード マネージャーや iCloud キーチェーンに保存したものは、同じアカウントのほかの端末でも使えます。"
            : "パスキーは名前の住所（https://…）で開いたときだけ使えます。IP アドレスで開いていると使えません。"
        }
      >
        {passkeys.length > 0 ? (
          <ul className="mb-2 divide-y divide-border rounded-md border border-border" data-testid="login-passkeys">
            {passkeys.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <KeyRound className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{p.label}</p>
                  <p className="text-xs text-ink-3">
                    登録 {when(p.createdAt)}・最後に使った {when(p.lastUsedAt)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-stop"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(`パスキー「${p.label}」を消しますか？ その端末はパスキーで入れなくなります。`)) return;
                    void run(`passkey:${p.id}`, () => removePasskey(p.id));
                  }}
                >
                  消す
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-2 text-xs text-ink-2" data-testid="login-no-passkeys">
            まだパスキーがありません。
          </p>
        )}
        {me.passkeyAvailable ? (
          <Button
            size="sm"
            className="h-7 px-3 text-xs"
            disabled={busy !== null}
            data-testid="login-register-passkey"
            onClick={() => void run("register", () => registerPasskey())}
          >
            {busy === "register" ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
            この端末のパスキーを登録
          </Button>
        ) : null}
      </Section>

      <Section title="端末を追加" description="ほかの端末で読み取る QR とリンクを出します。10分・1回だけ使えます。">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          variant="outline"
          disabled={busy !== null}
          data-testid="login-add-device"
          onClick={() => {
            setActionError(null);
            setDeviceDialog(true);
          }}
        >
          端末を追加
        </Button>
      </Section>

      <Section title="ログイン中の端末" description="心当たりのない端末があれば締め出してください。次の操作から使えなくなります。">
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="login-sessions">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2" data-testid="login-session-row">
              <Smartphone className="size-4 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">
                  {s.label}
                  {s.current ? <span className="ml-2 text-xs text-ink-3">（この端末）</span> : null}
                </p>
                <p className="text-xs text-ink-3">
                  {METHOD_LABEL[s.method]}で入りました・最後に使った {when(s.lastUsedAt)}
                </p>
              </div>
              {!s.current ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-stop"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(`「${s.label}」を締め出しますか？`)) return;
                    void run(`session:${s.id}`, () => revokeAuthSession(s.id));
                  }}
                >
                  締め出す
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      {/* 開くたびに作り直す——前の札・知らせを持ち越さない */}
      {deviceDialog ? <AddDeviceDialog onClose={() => setDeviceDialog(false)} /> : null}
    </div>
  );
}

/** 端末を追加：QR とリンク（中身は同じ）。10分の残りを数え、使われたら知らせる */
function AddDeviceDialog({ onClose }: { onClose(): void }) {
  const [code, setCode] = useState<{ codeId: string; url: string; expiresAt: string; svg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    createDeviceCode()
      .then(async (c) => {
        const svg = await QRCode.toString(c.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
        if (!cancelled) setCode({ ...c, svg });
      })
      .catch((err: unknown) => !cancelled && setError(describeFailure(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!code || joined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code, joined]);

  useEffect(
    () =>
      onRealAppEvent((e) => {
        if (e.type === "auth.device_added" && code && e.codeId === code.codeId) setJoined(e.label);
      }),
    [code],
  );

  const remaining = code ? Math.max(0, Date.parse(code.expiresAt) - now) : 0;
  const expired = code !== null && remaining === 0 && !joined;
  const mmss = `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" data-testid="add-device-dialog">
        <DialogHeader>
          <DialogTitle>端末を追加</DialogTitle>
          <DialogDescription>入れたい端末のカメラで QR を読むか、リンクをその端末のブラウザで開いてください。</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-stop" data-testid="add-device-error">
            {error}
          </p>
        ) : joined ? (
          <p className="flex items-center gap-2 text-sm text-foreground" data-testid="add-device-joined">
            <Check className="size-4 text-ok" />
            {joined} が入りました
          </p>
        ) : !code ? (
          <p className="flex items-center gap-2 text-xs text-ink-3">
            <Loader2 className="size-3.5 animate-spin" />
            用意しています…
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              className={`mx-auto w-56 rounded-md bg-white p-2 ${expired ? "opacity-20" : ""}`}
              data-testid="add-device-qr"
              // QR は qrcode が作った SVG（中身は URL だけ）
              dangerouslySetInnerHTML={{ __html: code.svg }}
            />
            <div className="flex gap-1.5">
              <Input readOnly value={code.url} className="h-8 text-xs" data-testid="add-device-link" onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 px-2 text-xs"
                disabled={expired}
                onClick={() => {
                  void navigator.clipboard.writeText(code.url).then(() => setCopied(true));
                }}
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "コピーしました" : "コピー"}
              </Button>
            </div>
            <p className="text-xs text-ink-3" data-testid="add-device-remaining">
              {expired ? "期限が切れました。閉じて、もう一度出してください。" : `あと ${mmss}・1回だけ使えます`}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
