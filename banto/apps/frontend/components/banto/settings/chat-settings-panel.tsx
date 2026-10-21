"use client";

// **設定の「チャット」**（追加・2026-10-21、v4-frontend.md §6.53。見本はモック `fork/draft-projects` の
// `mock/components/banto/settings/chat-settings-panel.tsx`）。チャットが資源を取らないための2つの時間だけを置く
// ——banto 全体の設定 `chat.sleepAfterMinutes`・`chat.closeAfterDays`（`PUT /api/settings/chat`）。
// 押したらすぐ保存する。保存できなければ理由を出し、札は host の値のまま（画面だけ替わった状態にしない、規則2）
import { useState } from "react";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { saveChatSettings, useChatSettings } from "@/lib/backend/chat-settings";
import type { RealChatSettings } from "@/lib/backend/client";
import { describeFailure } from "@/lib/report-failure";

type SleepChoice = "5" | "15" | "60";
type CloseChoice = "7" | "14" | "30" | "off";

export function ChatSettingsPanel() {
  const { settings, error } = useChatSettings();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save(patch: Partial<RealChatSettings>) {
    setSaving(true);
    setSaveError(null);
    try {
      await saveChatSettings(patch);
    } catch (err) {
      setSaveError(describeFailure(err));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <p className="text-sm text-ink-3" data-testid="chat-settings-loading">
        {error ? `読み込めませんでした（${error}）` : "読み込んでいます…"}
      </p>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6" data-testid="chat-settings">
      <section className="flex flex-col gap-1.5" id="anchor-chat-sleep">
        <span id="chat-sleep" className="text-sm font-medium">
          試作のコンテナを眠らせるまで
        </span>
        <ChoicePills<SleepChoice>
          labelledBy="chat-sleep"
          value={String(settings.sleepAfterMinutes) as SleepChoice}
          onChange={(v) => void save({ sleepAfterMinutes: Number(v) as RealChatSettings["sleepAfterMinutes"] })}
          disabled={saving}
          testId="chat-sleep-choice"
          choices={[
            { value: "5", label: "5分" },
            { value: "15", label: "15分" },
            { value: "60", label: "1時間" },
          ]}
        />
        <p className="text-xs text-ink-3">
          AI もあなたも使っていない時間が続いたら、コンテナを止めます。眠っている間はディスクだけを使い、話しかけると起きます。
        </p>
      </section>

      <section className="flex flex-col gap-1.5" id="anchor-chat-close">
        <span id="chat-close" className="text-sm font-medium">
          触らなくなったチャットを閉じるまで
        </span>
        <ChoicePills<CloseChoice>
          labelledBy="chat-close"
          value={String(settings.closeAfterDays) as CloseChoice}
          onChange={(v) => void save({ closeAfterDays: v === "off" ? "off" : (Number(v) as 7 | 14 | 30) })}
          disabled={saving}
          testId="chat-close-choice"
          choices={[
            { value: "7", label: "7日" },
            { value: "14", label: "14日" },
            { value: "30", label: "30日" },
            { value: "off", label: "閉じない" },
          ]}
        />
        <p className="text-xs text-ink-3">
          閉じるとコンテナを消し、会話とフォルダは残します。サイドバーの「閉じたチャット」から開き直せます。Project にしたものは閉じません。
        </p>
      </section>

      {saveError ? (
        <p className="text-sm text-destructive" role="alert" data-testid="chat-settings-error">
          保存できませんでした（{saveError}）
        </p>
      ) : null}
    </div>
  );
}
