"use client";

// **Claude の API キーを足す**（追加・2026-10-24、`docs/specs/v4-distribution.md` §3）。名前とキーを入れると、host がキーを
// Vault に置き、台帳には alias だけを載せる（キーは画面にも台帳にも残らない）。キーは Claude Console で作る——リンクを添える。
// 足したら既定の並びの末尾に入る（サブスクと並べたときの優先は §10 の未決。当面は並び順に従う）
import { useState } from "react";
import { CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { addClaudeApiKey } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";

/** Claude Console の API キーの画面 */
export const CLAUDE_CONSOLE_KEYS_URL = "https://console.anthropic.com/settings/keys";

export function ClaudeApiKeyDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 足せた（一覧を読み直す）。済んでから閉じる */
  onAdded: () => Promise<void>;
}) {
  const [label, setLabel] = useState("API キー");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy || !key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addClaudeApiKey({ label, key });
      // キーは手元にも残さない
      setKey("");
      await onAdded();
      onOpenChange(false);
    } catch (err) {
      setError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="claude-api-key-dialog">
        <DialogHeader>
          <DialogTitle>Claude の API キーを足す</DialogTitle>
          <DialogDescription>
            キーは banto の Vault に置きます。会話の本体とコンテナの中の Claude は banto の中継を通して使い、キーはコンテナに入りません。
            使った分だけ Claude Console の請求になります。
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <a
            data-testid="claude-api-key-console-link"
            href={CLAUDE_CONSOLE_KEYS_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 self-start text-sm text-accent-ink underline underline-offset-2"
          >
            Claude Console で API キーを作る
            <ExternalLink className="size-3.5" />
          </a>
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            名前
            <Input data-testid="claude-api-key-label" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            API キー
            <Input
              data-testid="claude-api-key-input"
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={key}
              autoFocus
              onChange={(e) => setKey(e.target.value)}
              className="h-8 font-mono text-sm"
            />
          </label>
          {error ? (
            <p data-testid="claude-api-key-error" className="flex items-start gap-1 text-xs text-stop">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              やめる
            </Button>
            <Button data-testid="claude-api-key-submit" type="submit" disabled={busy || !key.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              足す
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
