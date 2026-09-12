// **焦点は、箱の中で示す**（改訂・2026-09-11、ユーザー指摘）。
//
// 以前は外側に青い輪（`ring-3`）を描いていたが、**要素の外にはみ出す**ので、
// ダイアログの縁や狭い枠の中では**端が切れて見えた**。輪をやめ、**枠の色**だけを
// 変える——箱の中で描くので、どこに置いても切れない。
//
// 焦点そのものは消さない（キーボードで辿る人には要る、§6.0）。
import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ink-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
