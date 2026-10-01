"use client";

// 「Project も作る」（2026-10-01、ユーザー）——リポジトリの一覧の「URL から clone」と「新しいリポジトリ」で同じ形。
// **既定はオン**（2026-10-01、ユーザー決定）。オンのまま押すと、Repositories がフォルダを用意したあと、一覧が **core の
// 新しい Project の画面を、そのフォルダを入れた状態で開く**——人がそこで Project 名を確かめて「作る」。
// Repositories は Project を作らない（core に「Project を作る」口を足さない。Project を作るのは core の画面だけ）。
// オフなら一覧に足すだけ（「Project はまだ無い」の表に地つきで出る）。
// 意味が無いとき（もう手元にある・clone し直す場所をもう Project が使っている）は出さない——それは入口の側が決める。
import { Switch } from "@/components/ui/switch";

export function RepoProjectOption({
  checked,
  onCheckedChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <section aria-label="Project" data-testid="repo-project-option" className="border-t border-border pt-4">
      <label className="flex items-start gap-2.5">
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          data-testid="repo-with-project"
          className="mt-0.5"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Project も作る</span>
          <span className="text-xs text-ink-3">
            用意できたら、新しい Project の画面をこのフォルダで開きます（名前はそこで決めます）
          </span>
        </span>
      </label>
    </section>
  );
}
