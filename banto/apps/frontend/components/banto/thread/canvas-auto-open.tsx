"use client";

// MCP Apps の display mode "fullscreen"（§6.2）——AI の tool 呼び出し自身が
// fullscreen を要求したケース。inline（tool呼び出しカードの中）でも、人が
// launcher/ヘッダのボタンから開くのでもなく、**tool の結果が揃った瞬間に
// banto が自動で Canvas を開く**、という第三の起点（§6.2 軸2）。
import { useEffect, useRef } from "react";
import { useAuiState } from "@assistant-ui/react";
import { getFullscreenView } from "@/lib/mock/adapter";

export function CanvasAutoOpen({
  onOpenCanvas,
}: {
  onOpenCanvas: (moduleId: string, viewId: string) => void;
}) {
  const messages = useAuiState((s) => s.thread.messages);
  const openedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type !== "tool-call" || part.result === undefined) continue;
        if (openedRef.current.has(part.toolCallId)) continue;
        const view = getFullscreenView(part.toolCallId);
        if (!view) continue;
        openedRef.current.add(part.toolCallId);
        onOpenCanvas(view.moduleId, view.viewId);
      }
    }
  }, [messages, onOpenCanvas]);

  return null;
}
