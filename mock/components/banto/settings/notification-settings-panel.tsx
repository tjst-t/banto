"use client";

// 通知（§10 item28）。「受信箱に来たものを人の注意へ能動的に届ける」の
// モック——行き先の仕組み（Module経由にするか等）は未決のまま（item28）。
// ここではモックとして最も単純な形（トースト＋ブラウザのデスクトップ通知）
// の許可設定だけを見せる。判断待ち・レビュー待ちが実際に発生するたびに
// 自動で飛ばす仕組みは無い——Base Thread の「モックのデモ」から手動で発火する
// （`components/banto/thread/notification-demo-trigger.tsx`）。
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getNotificationPermission,
  isNotificationSupported,
  requestNotificationPermission,
  type MockNotificationPermission,
} from "@/lib/mock/notifications";

const PERMISSION_LABEL: Record<MockNotificationPermission, string> = {
  default: "未許可",
  granted: "許可済み",
  denied: "拒否されています",
  unsupported: "このブラウザは非対応",
};

export function NotificationSettingsPanel() {
  // Notification.permission はブラウザ側の状態（サーバは知らない）——
  // ハイドレーション不一致を避けるため、マウント後に読み直す
  // （next-themes と同じ標準パターン、theme-toggle.tsx 参照）
  const [permission, setPermission] = useState<MockNotificationPermission>("default");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 上記コメント参照
    setPermission(getNotificationPermission());
  }, []);

  async function handleRequest() {
    const result = await requestNotificationPermission();
    setPermission(result);
  }

  return (
    <div id="anchor-notifications-permission" className="flex flex-col gap-3 rounded-md">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <Bell className="size-4 shrink-0 text-ink-3" />
        <div className="flex-1">
          <p className="text-sm text-foreground">デスクトップ通知</p>
          <p className="text-xs text-ink-3">
            判断待ち・レビュー待ちが新着した際、トースト表示に加えてブラウザのデスクトップ通知を出す。現在：
            {PERMISSION_LABEL[permission]}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={permission === "granted" || permission === "unsupported" || !isNotificationSupported()}
          onClick={handleRequest}
        >
          許可をリクエスト
        </Button>
      </div>
      {permission === "denied" ? (
        <p className="text-xs text-ink-3">
          ブラウザの設定でこのサイトの通知が拒否されています。許可し直すにはブラウザ側の設定を変更してください。
        </p>
      ) : null}
    </div>
  );
}
