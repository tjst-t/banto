"use client";

// **枝分かれ（Fork）と、閉じる（Close）の印**（決定・2026-09-11、ユーザー要望）。
//
// **上下を反転して使う。** lucide の `git-fork` / `git-merge` は枝が**上へ**
// 伸びる向きだが、banto の会話は**下へ流れる**——分かれるのも合流するのも
// 下側に見えるほうが、起きていることに近い。
//
// 反転は**ここ1箇所**（規則3）。使う側は向きを気にしない——サイドバー・
// ヘッダ・会話の中・履歴、どこでも同じ向きで出る。
import { GitFork, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComponentProps, ComponentType } from "react";

/** アイコンとして受け取れるもの。lucide のアイコンと、ここで包んだものの両方。
 *  （lucide の型は `forwardRef` 前提なので、そのままだと包んだものが入らない） */
export type IconComponent = ComponentType<{ className?: string }>;

type IconProps = ComponentProps<typeof GitFork>;

/** 枝を分ける。会話が下へ流れるのに合わせて、枝も下へ */
export function ForkIcon({ className, ...props }: IconProps) {
  return <GitFork className={cn("-scale-y-100", className)} {...props} />;
}

/** 閉じる（Close）。**削除ではなく整理**——履歴から開き直せる */
export function CloseIcon({ className, ...props }: IconProps) {
  return <GitMerge className={cn("-scale-y-100", className)} {...props} />;
}
