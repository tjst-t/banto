"use client";

// **Claude のアカウントを足す・ログインし直す**（決定・2026-10-18、v4-frontend.md §6.46・v4-security.md §2「Claude のアカウントを
// 複数持つ」の 4.）。番号つきの2段：1. claude.ai のログインの画面を新しいタブで開く 2. そこに出たコードを貼る。
//
// ダイアログを開いたときに host に手続きを始めてもらい（認可の URL・10分）、1段目はその URL へのただのリンクにする——
// 押してから取りに行くと、ブラウザが新しいタブを開くのを止めることがある。期限切れ・交換に行った失敗は手続きが使えなく
// なるので、始め直して1段目からにする（state が合わない・形が違うは手続きが残るので貼り直せる）
import { useCallback, useEffect, useState } from "react";
import { CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ClaudeAccountLoginFailed, finishClaudeAccountLogin, startClaudeAccountLogin, type ClaudeAccountView } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";
import { cn } from "@/lib/utils";
import { planLabel } from "@/components/banto/settings/claude-accounts-shared";

/** 手続きが使えなくなった失敗（始め直す） */
const RESTART_CODES = new Set(["expired", "unknown", "exchange-failed", "account-mismatch"]);

function failureText(err: unknown): string {
  if (err instanceof ClaudeAccountLoginFailed) {
    if (err.code === "state-mismatch")
      return "このコードは、いま開いたログインの画面のものではありません。もう一度「ログインの画面を開く」からやり直してください。";
    if (err.code === "expired" || err.code === "unknown")
      return "ログインの画面を開いてから10分を過ぎました。もう一度「ログインの画面を開く」から始めてください。";
    if (err.code === "exchange-failed")
      return `コードを交換できませんでした（${err.message}）。もう一度「ログインの画面を開く」から始めてください。`;
    return err.message;
  }
  return describeFailure(err);
}

export function ClaudeAccountLoginDialog({
  open,
  onOpenChange,
  target,
  inDefaultOrder,
  onAdded,
  onAppendToDefaultOrder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 行の「ログインし直す」——違うアカウントが返ったら host が断る。無ければ足す */
  target?: ClaudeAccountView;
  /** 足したアカウントがいま既定の並びに入っているか（足したあとの文を変える） */
  inDefaultOrder: (accountId: string) => boolean;
  /** 足せた・ログインし直せた（一覧を読み直す） */
  onAdded: () => void;
  onAppendToDefaultOrder: (accountId: string) => Promise<void>;
}) {
  const [login, setLogin] = useState<{ loginId: string; url: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ account: ClaudeAccountView; replaced: boolean } | null>(null);
  const [appending, setAppending] = useState(false);

  const begin = useCallback(async () => {
    setLogin(null);
    setOpened(false);
    setCode("");
    setStartError(null);
    try {
      const started = await startClaudeAccountLogin();
      setLogin({ loginId: started.loginId, url: started.url });
    } catch (err) {
      setStartError(describeFailure(err));
    }
  }, []);

  // 呼び元は開くたびにこれを作り直す（`open` のときだけ描く）——開いたら手続きを始める
  useEffect(() => {
    let cancelled = false;
    startClaudeAccountLogin()
      .then((started) => !cancelled && setLogin({ loginId: started.loginId, url: started.url }))
      .catch((err: unknown) => !cancelled && setStartError(describeFailure(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    if (!login || busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await finishClaudeAccountLogin(login.loginId, code.trim(), target?.id);
      setDone(result);
      onAdded();
    } catch (err) {
      setError(failureText(err));
      if (err instanceof ClaudeAccountLoginFailed && err.code && RESTART_CODES.has(err.code)) void begin();
    } finally {
      setBusy(false);
    }
  }

  const title = target ? `${target.label}にログインし直す` : "Claude のアカウントを足す";
  const plan = done ? planLabel(done.account.subscriptionType, done.account.rateLimitTier) : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="claude-account-login-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">claude.ai でログインして、出たコードを貼ります</DialogDescription>
        </DialogHeader>
        {done ? (
          <div data-testid="claude-account-login-done" className="flex flex-col gap-3">
            <p className="text-sm text-foreground">
              {done.replaced
                ? `${done.account.email ?? done.account.label}${plan ? `（${plan}）` : ""}にログインし直しました。並びはそのままです。`
                : `${done.account.email ?? done.account.label}${plan ? `（${plan}）` : ""}を足しました。`}
            </p>
            {done.replaced ? null : inDefaultOrder(done.account.id) ? (
              <p className="text-xs text-ink-2">既定の並びの最後に入りました。順番は「既定の並び」で入れ替えられます。</p>
            ) : (
              <p className="text-xs text-ink-2">並びにはまだ入っていません。既定の並びか、Project の設定で並びに足すと使われます。</p>
            )}
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                閉じる
              </Button>
              {!done.replaced && !inDefaultOrder(done.account.id) ? (
                <Button
                  size="sm"
                  disabled={appending}
                  onClick={async () => {
                    setAppending(true);
                    try {
                      await onAppendToDefaultOrder(done.account.id);
                      onOpenChange(false);
                    } finally {
                      setAppending(false);
                    }
                  }}
                >
                  既定の並びの最後に足す
                </Button>
              ) : null}
            </DialogFooter>
          </div>
        ) : (
          <>
            <ol className="flex flex-col gap-4">
              <li className="flex gap-3">
                <StepMark n={1} done={opened} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-sm text-foreground">
                    claude.ai のログインの画面を開いて、{target ? "このアカウント" : "足したいアカウント"}でログインします。
                  </p>
                  <p className="text-xs text-ink-2">
                    いま claude.ai
                    にほかのアカウントでログインしていると、そのアカウントが返ってきます。開いたタブで一度ログアウトしてから入ってください。
                  </p>
                  {startError ? (
                    <ErrorLine testId="claude-account-login-start-error" text={`ログインの手続きを始められませんでした：${startError}`} />
                  ) : login ? (
                    <Button asChild size="sm" variant="outline" className="self-start">
                      <a
                        data-testid="claude-account-login-open"
                        href={login.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpened(true)}
                      >
                        <ExternalLink className="size-3.5" />
                        ログインの画面を開く
                      </a>
                    </Button>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs text-ink-3">
                      <Loader2 className="size-3.5 animate-spin" />
                      手続きを始めています…
                    </span>
                  )}
                </div>
              </li>
              <li className="flex gap-3">
                <StepMark n={2} done={false} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className={cn("text-sm", opened ? "text-foreground" : "text-ink-3")}>
                    ログインのあとに出るコードをコピーして、ここに貼ります。
                  </p>
                  <Input
                    data-testid="claude-account-login-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
                    }}
                    disabled={!opened || busy}
                    placeholder="例：AbC123…#xyz789…"
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {error ? <ErrorLine testId="claude-account-login-error" text={error} /> : null}
                </div>
              </li>
            </ol>
            <p className="text-xs text-ink-3">
              banto が受け取るのは推論とプロフィール（メールアドレス・契約の種類）の権限だけです。トークンはこの機械の banto
              の中に置き、コンテナや AI には渡しません。
            </p>
            <DialogFooter className="border-t border-border pt-4">
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                キャンセル
              </Button>
              <Button
                data-testid="claude-account-login-submit"
                size="sm"
                disabled={!opened || busy || !code.trim()}
                onClick={() => void submit()}
              >
                {busy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    確かめています…
                  </>
                ) : target ? (
                  "ログインし直す"
                ) : (
                  "アカウントを足す"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StepMark({ n, done }: { n: number; done: boolean }) {
  return (
    <span
      data-testid={`claude-account-login-step-${n}`}
      data-done={done ? "true" : "false"}
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums",
        done ? "bg-ok-soft text-ok" : "bg-surface-3 text-ink-2",
      )}
    >
      {n}
    </span>
  );
}

function ErrorLine({ text, testId }: { text: string; testId?: string }) {
  return (
    <p data-testid={testId} className="flex items-start gap-1.5 text-xs text-stop">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}
