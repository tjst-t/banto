"use client";

// AI 発言の左ガターに置くマーク。「番アイコン」（20px角丸青地に「番」の1文字）は
// 不要という指示に基づき、汎用の Lucide アイコンに置き換える。名前も文字も出さない
// ——走行中だけ強調色になる。ThreadPrimitive.If は非推奨（@deprecated）なので
// 推奨される AuiIf + useAuiState を使う。
import { Sparkles } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import { cn } from "@/lib/utils";

export function AssistantMark() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  return (
    <div className="absolute top-1 left-0 flex size-5 items-center justify-center">
      <Sparkles
        className={cn("size-3.5", isRunning ? "text-primary" : "text-ink-3")}
        strokeWidth={1.7}
      />
    </div>
  );
}
