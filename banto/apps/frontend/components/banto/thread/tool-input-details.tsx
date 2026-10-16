"use client";

// **何を承認するのか**を人が読める形で出す（§6.0）。会話の判断待ちのカードと受信箱の判断待ちで同じものを使う（規則3）。
//
// 引数が「見出し→値」のオブジェクトなら1行ずつ、文字列の値は改行をそのまま折り返して出す（2026-10-16、ユーザー
// 「削除するメモリの内容がわからない」——以前の会話のカードは JSON を1行に並べ、改行が \n のまま横にはみ出していた）。
// 文字列でない値・オブジェクトでない引数は JSON で出す。
import { Fragment } from "react";
import { cn } from "@/lib/utils";

export interface ToolInputRow {
  label: string;
  value: string;
  /** JSON にした値（等幅で出す） */
  json: boolean;
}

export function toolInputRows(input: unknown): ToolInputRow[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== "object" || Array.isArray(input)) return [{ label: "引数", value: JSON.stringify(input, null, 2), json: true }];
  return Object.entries(input as Record<string, unknown>).map(([label, v]) =>
    typeof v === "string" ? { label, value: v, json: false } : { label, value: JSON.stringify(v, null, 2), json: true },
  );
}

export function ToolInputDetails({ input, className }: { input: unknown; className?: string }) {
  const rows = toolInputRows(input);
  if (rows.length === 0) return null;
  return (
    <dl
      data-testid="tool-input-details"
      className={cn("grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-md bg-muted/60 px-3 py-2.5 text-xs", className)}
    >
      {rows.map((d) => (
        <Fragment key={d.label}>
          <dt className="whitespace-nowrap text-ink-3">{d.label}</dt>
          <dd className={cn("min-w-0 whitespace-pre-wrap break-words text-foreground", d.json && "font-mono")}>{d.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
