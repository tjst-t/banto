"use client";

// どの GitHub アカウントで始めるか（決定・2026-09-29、ユーザー）。
// - **1つだけなら選ばせない**——どのアカウントで動くかは1行で言うだけ
// - 2つ以上なら札を並べる（数個しか無いものに、開いて選ぶ Select は重い）
// - 1つも無ければ、登録する場所へ案内する（空は次の手を示す）
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MockGithubAccount } from "@/lib/mock/github";
import { ChoicePills } from "./choice-pills";

export const REPO_SETTINGS_HREF = "/settings?section=module:banto.repo";

export function AccountMark({ login }: { login: string }) {
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs leading-none font-semibold text-ink-2 uppercase"
    >
      {login.slice(0, 1)}
    </span>
  );
}

export function GithubAccountChooser({
  accounts,
  value,
  onChange,
  id,
  singleNote,
}: {
  accounts: readonly MockGithubAccount[];
  value: string;
  onChange: (id: string) => void;
  id: string;
  /** 1つだけのときに、アカウント名の後ろに続ける文（例「で探します」） */
  singleNote: string;
}) {
  if (accounts.length === 0) return null;
  if (accounts.length === 1) {
    return (
      <p data-testid="github-account-single" className="flex items-center gap-1.5 text-xs text-ink-3">
        <AccountMark login={accounts[0].login} />
        <span className="font-medium text-ink-2">{accounts[0].login}</span>
        {singleNote}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p id={`${id}-label`} className="text-xs font-medium text-foreground">
        アカウント
      </p>
      <ChoicePills
        labelledBy={`${id}-label`}
        testId="github-account"
        value={value}
        onChange={onChange}
        choices={accounts.map((a) => ({
          value: a.id,
          label: (
            <>
              <AccountMark login={a.login} />
              {a.login}
            </>
          ),
        }))}
      />
    </div>
  );
}

export function NoGithubAccount({ reason }: { reason: string }) {
  return (
    <div
      data-testid="github-account-none"
      className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border px-4 py-4"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        <KeyRound className="size-4 text-ink-3" />
        GitHub のアカウントがまだありません
      </p>
      <p className="text-xs text-ink-2">
        Repo の設定で、名前・PAT・SSH 鍵を登録してください。{reason}
      </p>
      <Button asChild variant="outline" size="sm" className="h-7 text-xs">
        <Link href={REPO_SETTINGS_HREF}>Repo の設定を開く</Link>
      </Button>
    </div>
  );
}
