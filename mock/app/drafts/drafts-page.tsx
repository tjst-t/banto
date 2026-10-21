"use client";

// 相談の片づけ（モック・2026-10-21）：閉じた相談の一覧と、いつ眠らせる・閉じるかの設定
import Link from "next/link";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getClosedDrafts, getDraftSettings, getDrafts, setDraftCleanup, type DraftCleanup } from "@/lib/mock/drafts";
import { ChoicePills } from "@/components/banto/project/choice-pills";

export function DraftsPage() {
  useMockStoreVersion();
  const { sleepAfterMinutes, cleanup } = getDraftSettings();
  const open = getDrafts();
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">相談</h1>
          <p className="text-sm text-ink-2">
            開いている相談 {open.length} 件。相談は中身は普通の Project で、「Project にする」までは名前もフォルダも決めずに使えます。
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">片づけ方</h2>
          <div className="flex flex-col gap-1">
            <p className="text-sm">試作のコンテナは、{sleepAfterMinutes}分使わなければ眠らせます。</p>
            <p className="text-xs text-ink-3">眠っている相談は場所（ディスク）だけを使います。話しかければ数秒で起きます。</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span id="cleanup" className="text-sm">触らなくなった相談を閉じるまで</span>
            <ChoicePills<DraftCleanup>
              labelledBy="cleanup"
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
              閉じるとコンテナを消し、会話とフォルダは残します。下の一覧から開き直せます。Project にしたものは閉じません。
            </p>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">閉じた相談</h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {getClosedDrafts().map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{d.title}</p>
                  <p className="text-xs text-ink-3">
                    {d.closedAt}　{d.why}
                  </p>
                </div>
                <Link href="#" className="rounded-md px-2 py-1 text-xs hover:bg-accent">
                  開き直す
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
