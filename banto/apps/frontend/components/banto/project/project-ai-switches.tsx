"use client";

// **「この Project の AI」の3つのスイッチ**（決定・2026-10-20、ユーザー。v4-frontend.md §6.51）。
//
// 新しい Project の画面（「作成する」の上）と、Project の設定の「一般」が**同じ並び・同じ言葉**で出す——並びと文は
// ここだけに置く（規則3）。値の持ち方は面ごとに違う：新しい Project の画面は手元の状態で持って作るときに送り、設定は
// 押したらすぐ保存する。
//
//  1. ターンの終わりのまとめ（`thread.turnSummary`、アーキ仕様 §2.2）
//  2. 承認をすべて自動で許可する（`approvals.autoApproveAll`、§6.4）——オンのときは警告色で注意を出す
//  3. 空いた会話を冷める前に要約する（`thread.idleCompaction`、アーキ仕様 §3.1）
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { RealNewProjectSettings } from "@/lib/backend/client";

export type ProjectAiSwitchKey = keyof Required<RealNewProjectSettings>;

export const PROJECT_AI_HEADING = "この Project の AI";

export const PROJECT_AI_SWITCHES: ReadonlyArray<{ key: ProjectAiSwitchKey; label: string; description: string }> = [
  {
    key: "turnSummary",
    label: "ターンの終わりのまとめ",
    description: "作業したターンの最後に、頼んだこと・結果・決めることをまとめて受信箱にも出す",
  },
  {
    key: "autoApproveAll",
    label: "承認をすべて自動で許可する",
    description: "この Project の AI が頼むものは、Vault の秘密の取り出し・公開も含めて人に聞かずに通す",
  },
  {
    key: "idleCompaction",
    label: "空いた会話を冷める前に要約する",
    description: "4時間空いた会話は、続きの費用を抑えるために要約する（それまではキャッシュを温め直す）",
  },
];

/** 自動で許可がオンのときの注意（文を JSX の中で折り返さない——改行が空白になり、日本語の途中に隙間が出る） */
export const AUTO_APPROVE_CAUTION =
  "オンの間は承認のカードで止まりません。通したものは会話に「自動で許可しました」と残ります。" +
  "パスキーの確認・値の入力（Vault の登録・ログイン）・AI からの質問・Skill の取り込みは、オンでも聞きます。";

/** 新しい Project の画面の初めの位置（ユーザー了承済み——どれもオン、自動で許可も含む） */
export const NEW_PROJECT_AI_DEFAULTS: Required<RealNewProjectSettings> = {
  turnSummary: true,
  autoApproveAll: true,
  idleCompaction: true,
};

/** 1行。`testId` はスイッチに、`${testId}-description`・`${testId}-caution` は説明と注意に付く */
export function ProjectAiSwitchRow({
  switchKey,
  id,
  testId,
  checked,
  disabled,
  onCheckedChange,
}: {
  switchKey: ProjectAiSwitchKey;
  id: string;
  testId: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const spec = PROJECT_AI_SWITCHES.find((s) => s.key === switchKey)!;
  const warn = switchKey === "autoApproveAll" && checked;
  return (
    <div
      data-testid={`${testId}-row`}
      className={
        "flex items-start justify-between gap-4 rounded-md border p-3 " +
        (warn ? "border-destructive/40 bg-destructive/5" : "border-border")
      }
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{spec.label}</Label>
        <p className="text-xs text-ink-3" data-testid={`${testId}-description`}>
          {spec.description}
        </p>
        {warn ? (
          <p className="text-xs text-destructive" data-testid={`${testId}-caution`}>
            {AUTO_APPROVE_CAUTION}
          </p>
        ) : null}
      </div>
      <Switch id={id} data-testid={testId} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** 新しい Project の画面の3行（値は呼ぶ側が持つ） */
export function NewProjectAiSwitches({
  value,
  onChange,
}: {
  value: Required<RealNewProjectSettings>;
  onChange: (next: Required<RealNewProjectSettings>) => void;
}) {
  return (
    <section data-testid="new-project-ai" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{PROJECT_AI_HEADING}</h3>
      {PROJECT_AI_SWITCHES.map((s) => (
        <ProjectAiSwitchRow
          key={s.key}
          switchKey={s.key}
          id={`new-project-ai-${s.key}`}
          testId={`new-project-ai-${s.key}`}
          checked={value[s.key]}
          onCheckedChange={(next) => onChange({ ...value, [s.key]: next })}
        />
      ))}
    </section>
  );
}
