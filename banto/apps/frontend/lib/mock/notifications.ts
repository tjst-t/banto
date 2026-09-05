// ブラウザのデスクトップ通知（Notification API）のモック向け薄いラッパー。
// §10 item28「受信箱に来たものを人の注意へ能動的に届ける」の、素朴な入口
// ——実装先（Module経由にするか等）は未決のまま（item28）。ここではモック
// なので、クライアント側で完結する最も単純な形（トースト＋Notification API）
// だけを見せる。

export type MockNotificationPermission = "default" | "granted" | "denied" | "unsupported";

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): MockNotificationPermission {
  if (!isNotificationSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<MockNotificationPermission> {
  if (!isNotificationSupported()) return "unsupported";
  const result = await Notification.requestPermission();
  return result;
}

/** 許可済みのときだけ実際にデスクトップ通知を出す。未許可・非対応では何もしない */
export function showBrowserNotification(title: string, body: string): void {
  if (getNotificationPermission() !== "granted") return;
  new Notification(title, { body });
}
