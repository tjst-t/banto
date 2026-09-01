"use client";

// 文脈内訳の表示（§10 item9、実測 2026-08-30・§8）。コンパクトな入口は
// 使用率だけのメーター（「上限に対する単一の比率」→ meter、dataviz スキル）、
// 開くとカテゴリごとの内訳（part-to-whole → 横向き stacked bar、カテゴリ色）。
// 色は dataviz スキルの検証済み既定パレット slot 1〜5（banto の実サーフェスに
// 対して validate_palette.js で確認済み、globals.css 参照）。Autocompact
// buffer・Free space は「中身」ではないので中立色——カテゴリ色を使わない。
import { useState } from "react";
import { ChevronRight, Gauge } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { getContextUsage, type ContextCategory } from "@/lib/mock/context-usage";
import type { ThreadId } from "@/lib/mock/types";

const CONTENT_COLOR: Readonly<Record<string, string>> = {
  "system-tools": "bg-chart-1",
  skills: "bg-chart-2",
  "mcp-tools": "bg-chart-3",
  memory: "bg-chart-4",
  messages: "bg-chart-5",
};

function segmentColor(category: ContextCategory): string {
  if (category.kind === "reserved") {
    return category.id === "autocompact" ? "bg-surface-3" : "bg-surface-2";
  }
  return CONTENT_COLOR[category.id] ?? "bg-surface-3";
}

function formatTokens(n: number): string {
  return n.toLocaleString("ja-JP");
}

export function ContextUsageMeter({ threadId }: { threadId: ThreadId }) {
  const usage = getContextUsage(threadId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const freeTokens = usage.categories.find((c) => c.id === "free")?.tokens ?? 0;
  const usedRatio = (usage.windowTokens - freeTokens) / usage.windowTokens;
  const meterFill = usedRatio >= 0.85 ? "bg-turn" : "bg-accent";

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`文脈使用量 ${Math.round(usedRatio * 100)}%`}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-ink-2 hover:bg-accent"
            >
              <Gauge className="size-3.5 shrink-0 text-ink-3" />
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
                <span
                  className={cn("block h-full rounded-full", meterFill)}
                  style={{ width: `${Math.round(usedRatio * 100)}%` }}
                />
              </span>
              <span className="tabular-nums">{Math.round(usedRatio * 100)}%</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>文脈の内訳を見る</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-96 p-0">
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-sm font-medium text-foreground">文脈の内訳</p>
          <p className="text-xs text-ink-3">
            {formatTokens(usage.windowTokens - freeTokens)} / {formatTokens(usage.windowTokens)}{" "}
            トークン使用中（{Math.round(usedRatio * 100)}%）
          </p>
        </div>

        <div className="px-3 py-3">
          {/* 横向き stacked bar。外側の端だけ丸め、セグメント間は surface の
              2px gap で分ける（塗りの境界に線を引かない、dataviz スキル） */}
          <div className="flex h-5 gap-0.5 overflow-hidden rounded-full">
            {usage.categories.map((cat, i) => {
              const pct = (cat.tokens / usage.windowTokens) * 100;
              if (pct <= 0) return null;
              return (
                <Tooltip key={cat.id}>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        segmentColor(cat),
                        i === 0 && "rounded-l-full",
                        i === usage.categories.length - 1 && "rounded-r-full",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    {cat.label}：{formatTokens(cat.tokens)} トークン（{pct.toFixed(1)}%）
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          {/* legend＝表形式（コントラストが足りない色の relief、dataviz スキル）。
              Skill・MCP・Memory は名前ごとの内訳を持つ（§5.7） */}
          <div className="mt-3 flex flex-col gap-0.5">
            {usage.categories.map((cat) => {
              const pct = (cat.tokens / usage.windowTokens) * 100;
              const hasItems = (cat.items?.length ?? 0) > 0;
              const isExpanded = expanded.has(cat.id);
              return (
                <div key={cat.id}>
                  <button
                    type="button"
                    disabled={!hasItems}
                    onClick={() => toggle(cat.id)}
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-accent disabled:hover:bg-transparent"
                  >
                    {hasItems ? (
                      <ChevronRight
                        className={cn(
                          "size-3 shrink-0 text-ink-3 transition-transform",
                          isExpanded && "rotate-90",
                        )}
                      />
                    ) : (
                      <span className="size-3 shrink-0" />
                    )}
                    <span className={cn("size-2 shrink-0 rounded-full", segmentColor(cat))} />
                    <span className="min-w-0 flex-1 truncate text-ink-2">{cat.label}</span>
                    <span className="shrink-0 tabular-nums text-ink-3">
                      {formatTokens(cat.tokens)}（{pct.toFixed(1)}%）
                    </span>
                  </button>
                  {hasItems && isExpanded ? (
                    <div className="ml-8 flex flex-col gap-0.5 border-l border-border pl-2.5">
                      {cat.items!.map((item) => (
                        <div
                          key={item.name}
                          className="flex items-center justify-between gap-2 py-0.5 text-xs text-ink-3"
                        >
                          <span className="min-w-0 truncate">{item.name}</span>
                          <span className="shrink-0 tabular-nums">{formatTokens(item.tokens)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {usage.deferred.length > 0 ? (
          <div className="border-t border-border bg-surface-2 px-3 py-2.5">
            <p className="text-xs font-medium text-ink-3">
              文脈の外（deferred）——モデルの文脈には入らない
            </p>
            <div className="mt-1 flex flex-col gap-0.5">
              {usage.deferred.map((d) => (
                <div key={d.name} className="flex items-center justify-between text-xs text-ink-3">
                  <span>{d.name}</span>
                  <span className="tabular-nums">{formatTokens(d.tokens)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
