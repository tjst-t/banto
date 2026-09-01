"use client";

// モック専用のデモヒント（本実装には持ち込まない）。台本（threads.ts）の
// どの発言がどのデモに繋がるか、composer の直上に出しておく——「距離を
// 取れば取るほど動線に困ることをやめる」以前の指摘（Elicitation のUI）と
// 同じ理由で、隠さず出す。ThreadPrimitive.Suggestion をそのまま使う
// （thread.suggestions のような追加の状態は要らない）。
import { ThreadPrimitive } from "@assistant-ui/react";

const DEMO_PROMPTS: readonly { label: string; prompt: string }[] = [
  { label: "tool 呼び出し", prompt: "worktree を教えて" },
  { label: "判断待ち（Elicitation）", prompt: "メモリの状況は？" },
  { label: "承認ゲート", prompt: "distを削除して" },
  { label: "inline 表示", prompt: "差分を見せて" },
  { label: "fullscreen 表示", prompt: "fullscreenで見せて" },
];

export function DemoHints() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-ink-3">
      <span className="shrink-0">モックのデモ：</span>
      {DEMO_PROMPTS.map((d) => (
        <ThreadPrimitive.Suggestion
          key={d.prompt}
          prompt={d.prompt}
          method="replace"
          autoSend
          className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-ink-2 hover:bg-accent"
        >
          {d.label}
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );
}
