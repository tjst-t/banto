"use client";

// Repositories の設定の中の「GitHub のアカウント」（決定・2026-09-29、ユーザー）——名前・PAT・SSH 鍵。
// PAT と鍵は Vault に預け、ここには alias の名前しか出さない（VaultUI と同じ作法）。
// 入力された PAT の値はモックでは**どこにも保存しない**
import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountMark } from "@/components/banto/project/github-account-chooser";
import { addGithubAccount, useGithubAccounts, removeGithubAccount } from "@/lib/mock/github";

const SSH_ALIASES = ["tjst-t-ssh", "work-ssh"] as const;
const NO_SSH = "none";

export function GithubAccountsSection() {
  const accounts = useGithubAccounts();
  const [adding, setAdding] = useState(false);

  return (
    <div id="anchor-github-accounts" className="mt-3 rounded-md border border-border bg-card p-3">
      <p className="mb-2 text-xs text-ink-3">
        GitHub のアカウント——PAT と SSH 鍵は Vault に預けます（値はここに出しません）
      </p>
      {accounts.length === 0 ? (
        <p className="py-2 text-sm text-ink-2">
          まだありません。登録すると、新しい Project で GitHub から clone できます。
        </p>
      ) : (
        <ul data-testid="github-accounts" className="flex flex-col divide-y divide-border">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center gap-2.5 py-2">
              <AccountMark login={a.login} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium text-foreground">{a.login}</span>
                <span className="truncate text-xs text-ink-3">
                  PAT <span className="font-mono">${a.tokenAlias}</span>
                  {" · "}
                  {a.sshAlias ? (
                    <>
                      SSH 鍵 <span className="font-mono">${a.sshAlias}</span>
                    </>
                  ) : (
                    "SSH 鍵なし（HTTPS で clone）"
                  )}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`${a.login} を外す`}
                onClick={() => removeGithubAccount(a.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddAccountForm onDone={() => setAdding(false)} />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2 h-7 gap-1 text-xs"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" />
          アカウントを登録
        </Button>
      )}
    </div>
  );
}

function AddAccountForm({ onDone }: { onDone: () => void }) {
  const [login, setLogin] = useState("");
  const [pat, setPat] = useState("");
  const [ssh, setSsh] = useState<string>(NO_SSH);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!login.trim() || !pat) return;
    addGithubAccount({
      login: login.trim(),
      tokenAlias: `github-${login.trim()}-token`,
      sshAlias: ssh === NO_SSH ? undefined : ssh,
    });
    onDone();
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gh-login">名前（GitHub のユーザー名か Organization）</Label>
        <Input id="gh-login" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gh-pat">PAT</Label>
        <Input
          id="gh-pat"
          type="password"
          autoComplete="off"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          className="font-mono text-xs"
        />
        <p className="text-xs text-ink-3">Vault に預けます。リポジトリを探す・作るのに使います。</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gh-ssh">SSH 鍵</Label>
        <Select value={ssh} onValueChange={setSsh}>
          <SelectTrigger id="gh-ssh" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SSH_ALIASES.map((s) => (
              <SelectItem key={s} value={s}>
                ${s}（Vault）
              </SelectItem>
            ))}
            <SelectItem value={NO_SSH}>使わない（HTTPS で clone・push）</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!login.trim() || !pat}>
          登録する
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          やめる
        </Button>
      </div>
    </form>
  );
}
