"use client";

// **Module の画面から頼まれた「新しい Project」**（2026-10-02、`lib/backend/canvas-new-project.ts`）。
// どの面（Project・設定・ホーム）にいても、外枠がこの1つを持つ——レール・スマホの引き出しの「新しい Project」とは
// 別のもの（あちらは人がレールで押したとき）。中身は同じ `NewProjectDialog`（Root パスと名前を入れた状態で開く）。
import { useEffect, useRef, useSyncExternalStore } from "react";
import { NewProjectDialog } from "@/components/banto/project/new-project-dialog";
import {
  clearNewProjectRequest,
  declineNewProjectRequest,
  getNewProjectRequest,
  registerNewProjectHost,
  subscribeNewProjectRequest,
} from "@/lib/backend/canvas-new-project";

export function RequestedNewProjectDialog() {
  const request = useSyncExternalStore(subscribeNewProjectRequest, getNewProjectRequest, () => null);
  // 開く場所が出ていることを知らせる（無い面——別タブの Canvas——からの頼みは断る）
  useEffect(() => registerNewProjectHost(), []);
  // 作って閉じたのか、人が作らずに閉じたのか（断ったなら、同じ画面からしばらく受けない）
  const created = useRef(false);
  if (!request) return null;
  return (
    <NewProjectDialog
      // 頼まれるたびに開き直す（前に打ちかけた値を持ち越さない）
      key={request.seq}
      open
      onOpenChange={(open) => {
        if (open) return;
        if (created.current) clearNewProjectRequest();
        else declineNewProjectRequest();
        created.current = false;
      }}
      onCreated={() => {
        created.current = true;
      }}
      initialBasePath={request.basePath}
      {...(request.name ? { initialName: request.name } : {})}
      {...(request.from ? { requestedBy: request.from } : {})}
    />
  );
}
