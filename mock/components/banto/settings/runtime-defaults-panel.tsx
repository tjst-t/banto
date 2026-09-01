"use client";

// 層2：runtime config の instance 既定値（§2.6）。Project 単位に上書きできる
// （§2.2「設定のカスケード」）が、ここは instance 既定そのものを変える場所。
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mockRuntimeDefaults } from "@/lib/mock/settings";

export function RuntimeDefaultsPanel() {
  const [defaults, setDefaults] = useState(mockRuntimeDefaults);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div id="anchor-default-model" className="flex flex-col gap-1.5 rounded-md">
        <Label htmlFor="default-model" className="text-xs text-ink-3">
          既定モデル
        </Label>
        <Select value={defaults.model} onValueChange={(v) => setDefaults((d) => ({ ...d, model: v }))}>
          <SelectTrigger id="default-model" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="claude-opus-5">claude-opus-5</SelectItem>
            <SelectItem value="claude-sonnet-5">claude-sonnet-5</SelectItem>
            <SelectItem value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div id="anchor-default-effort" className="flex flex-col gap-1.5 rounded-md">
        <Label htmlFor="default-effort" className="text-xs text-ink-3">
          既定 reasoning effort
        </Label>
        <Select
          value={defaults.effort}
          onValueChange={(v) => setDefaults((d) => ({ ...d, effort: v as typeof d.effort }))}
        >
          <SelectTrigger id="default-effort" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">low</SelectItem>
            <SelectItem value="medium">medium</SelectItem>
            <SelectItem value="high">high</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div id="anchor-default-memory" className="flex flex-col gap-1.5 rounded-md">
        <Label htmlFor="default-memory" className="text-xs text-ink-3">
          Memory 上限文字数
        </Label>
        <Input
          id="default-memory"
          type="number"
          className="h-8"
          value={defaults.memoryLimitChars}
          onChange={(e) => setDefaults((d) => ({ ...d, memoryLimitChars: Number(e.target.value) }))}
        />
      </div>
      <p className="text-xs text-ink-3 sm:col-span-3">
        Project は個別に上書きできる（既定で全項目が対象——上書きさせたくない項目だけ
        ブラックリストで塞ぐ、§2.6）。この画面の値は上書きしていない Project に効く。
      </p>
    </div>
  );
}
