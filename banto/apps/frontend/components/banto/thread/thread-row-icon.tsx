"use client";

// **AI が動いている Thread は、行のアイコンを回す**（決定・2026-10-03、ユーザー要望。v4-frontend.md §6.33）。
//
// 走っていなければその行のいつものアイコン（Base は吹き出し、Fork は枝分かれ）、走っていれば回る輪に替える。
// 置き場所はアイコンと同じ——行の幅も文字の位置も変わらない。何が「動いている」かは host が決める
// （`lib/backend/running-threads.ts`）。
import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";
import { useThreadRunning } from "@/lib/backend/running-threads";
import { cn } from "@/lib/utils";
import type { IconComponent } from "@/components/banto/thread/thread-icons";

export function ThreadRowIcon({
  threadId,
  icon: Icon,
  className,
}: {
  threadId: string;
  icon: IconComponent;
  className?: ComponentProps<"svg">["className"];
}) {
  const running = useThreadRunning(threadId);
  if (!running) return <Icon className={className} />;
  return (
    <LoaderCircle
      className={cn(className, "animate-spin")}
      role="img"
      aria-label="AI が動いています"
      data-testid="thread-running"
    />
  );
}
