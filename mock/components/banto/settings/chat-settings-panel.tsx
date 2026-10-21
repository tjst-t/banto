"use client";

// 設定の「チャット」（モック・2026-10-21、Fork「Project 作成前の検討」）。
// チャットが資源を取らないための2つの時間だけを置く
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getDraftSettings, setDraftCleanup, setDraftSleepAfter, type DraftCleanup } from "@/lib/mock/drafts";
import { ChoicePills } from "@/components/banto/project/choice-pills";

export function ChatSettingsPanel() {
  useMockStoreVersion();
  const { sleepAfterMinutes, cleanup } = getDraftSettings();
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <section className="flex flex-col gap-1.5" id="anchor-chat-sleep">
        <span id="chat-sleep" className="text-sm font-medium">
          試作のコンテナを眠らせるまで
        </span>
        <ChoicePills<string>
          labelledBy="chat-sleep"
          value={String(sleepAfterMinutes)}
          onChange={(v) => setDraftSleepAfter(Number(v))}
          choices={[
            { value: "5", label: "5分" },
            { value: "15", label: "15分" },
            { value: "60", label: "1時間" },
          ]}
        />
        <p className="text-xs text-ink-3">
          AI もあなたも使っていない時間が続いたら、コンテナを止めます。眠っている間はディスクだけを使い、話しかけると数秒で起きます。
        </p>
      </section>

      <section className="flex flex-col gap-1.5" id="anchor-chat-cleanup">
        <span id="chat-cleanup" className="text-sm font-medium">
          触らなくなったチャットを閉じるまで
        </span>
        <ChoicePills<DraftCleanup>
          labelledBy="chat-cleanup"
          value={cleanup}
          onChange={setDraftCleanup}
          choices={[
            { value: "7", label: "7日" },
            { value: "14", label: "14日" },
            { value: "30", label: "30日" },
            { value: "off", label: "閉じない" },
          ]}
        />
        <p className="text-xs text-ink-3">
          閉じるとコンテナを消し、会話とフォルダは残します。履歴から開き直せます。Project にしたものは閉じません。
        </p>
      </section>
    </div>
  );
}
