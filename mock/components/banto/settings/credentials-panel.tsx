"use client";

// 資格情報（§2.8）。複数の資格情報を登録して使い分ける——それぞれの消費量を見て、
// 上限（%）を置き、達したら別のものへ移る。鍵そのものは Vault が持つので、
// ここに出すのは登録済みの一覧と消費率だけ（値は出さない）。
import { KeyRound, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { mockCredentials } from "@/lib/mock/settings";

export function CredentialsPanel() {
  return (
    <div className="flex flex-col gap-2">
      {mockCredentials.map((c) => (
        <div
          key={c.id}
          id={`anchor-credential-${c.id}`}
          className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-ink-3" />
            <div>
              <p className="text-sm text-foreground">{c.label}</p>
              <p className="text-xs text-ink-3">
                {c.kind === "subscription" ? "サブスク（OAuth）" : "API キー（従量課金）"}
              </p>
            </div>
          </div>
          {c.usagePercent !== undefined ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${c.usagePercent}%` }}
                />
              </div>
              <Badge variant="outline" className="text-xs">
                {c.usagePercent}% · {c.resetsAt}
              </Badge>
            </div>
          ) : (
            <Badge variant="outline" className="text-xs">
              総額で計上
            </Badge>
          )}
        </div>
      ))}
      <button
        type="button"
        title="対話的なログインを走らせる（shell 経由）。機微情報は Elicitation の URL モードで見せる（§2.8）"
        className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-ink-3 hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" /> 資格情報を登録
      </button>
    </div>
  );
}
