"use client";

// 「Project も作る」（2026-10-01、ユーザー）——リポジトリの一覧の「URL から clone」と「新しいリポジトリ」で同じ形。
// **既定は切**：一覧の用事は「このマシンに置く」こと。Project から始める入口は新しい Project の画面にもうあり
// （そちらは作るのが既定）、両方を同じ既定にすると同じ入口が2つになる。切っておけば一覧に留まり、足した行が
// 「Project はまだ無い」の表に地つきで出て、その行の「Project を始める」が次の手になる（設定面からも離れない）。
// 意味が無いとき（もう Project がある・clone しない）は出さない——それは入口の側が決める。
// 作るのは banto 本体の仕事なので、新しい Project の画面の下の段と同じ言い方をする。
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function RepoProjectOption({
  checked,
  onCheckedChange,
  name,
  onNameChange,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  /** Project 名（既定はリポジトリ名。人が打ったら、以後はその値） */
  name: string;
  onNameChange: (next: string) => void;
  disabled: boolean;
}) {
  return (
    <section
      aria-label="Project"
      data-testid="repo-project-option"
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
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
          <span className="text-xs text-ink-3">banto が、このフォルダを Root にして作り、開きます</span>
        </span>
      </label>
      {checked ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-project-name">Project 名</Label>
          <Input
            id="repo-project-name"
            data-testid="repo-project-name"
            value={name}
            disabled={disabled}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
      ) : null}
    </section>
  );
}
