"use client";

// 通知（§10 item28）のモック向け発火口。実際の判断待ち発生（Elicitation等）とは
// 繋がっていない——「新着が来たらこう気づける」を見せるためだけの手動トリガー。
// DemoHints の並びに置く（モックのデモ導線と同じ場所）。
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { addInboxItem, getInboxItemHref } from "@/lib/mock/inbox";
import { getNotificationPermission, showBrowserNotification } from "@/lib/mock/notifications";
import type { MockInboxJudgmentElicitation, MockInboxReviewModule } from "@/lib/mock/types";

let demoSeq = 0;

// 奇数回はElicitation発の判断待ち（生きている間はThread側にも同じtool呼び出しが
// 表示されているので、そのThreadへ直接飛ぶ）、偶数回はModule発のレビュー
// （Canvasへ直接飛べる）——トーストの行き先が項目の種類で変わることを
// 1つのボタンで両方見せる（レビュー指摘 2026-09-02、二度手間の解消）
function nextDemoItem(): MockInboxJudgmentElicitation | MockInboxReviewModule {
  demoSeq += 1;
  const id = `inbox-demo-${demoSeq}`;
  if (demoSeq % 2 === 1) {
    return {
      kind: "judgment",
      source: "elicitation",
      id,
      projectId: "banto",
      serverName: "banto.repo",
      threadId: "banto-base",
      threadKind: "base",
      message: "`git push --force` を実行してよいですか？",
      age: "たった今",
      elicitation: {
        mode: "form",
        enumOptions: ["実行する", "実行しない"],
        allowFreeText: false,
      },
      status: "live",
    };
  }
  return {
    kind: "review",
    source: "module",
    id,
    projectId: "banto",
    serverName: "banto.worker",
    message: "「views.css の分割」の作業者から診断レポートが届きました。",
    age: "たった今",
    moduleId: "banto.worker",
    viewId: "report",
  };
}

const ACTION_LABEL: Record<"elicitation" | "module", string> = {
  elicitation: "Thread を開く",
  module: "Canvas を開く",
};

export function NotificationDemoTrigger() {
  const router = useRouter();

  function trigger() {
    const item = nextDemoItem();
    addInboxItem(item);

    toast(item.message, {
      description: `${item.serverName} からの${item.kind === "judgment" ? "判断待ち" : "レビュー待ち"}`,
      action: {
        label: ACTION_LABEL[item.source],
        onClick: () => router.push(getInboxItemHref(item)),
      },
    });

    if (getNotificationPermission() === "granted") {
      showBrowserNotification(`banto — ${item.serverName}`, item.message);
    }
  }

  return (
    <button
      type="button"
      onClick={trigger}
      className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-ink-2 hover:bg-accent"
    >
      新着通知
    </button>
  );
}
