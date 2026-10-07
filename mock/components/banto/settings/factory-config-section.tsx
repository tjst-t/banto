"use client";

// Factory の設定（Project ごと、v4-modules.md §4.5「設定」）。Module 自身の設定面（`ui://banto.factory/config`）に描く。
// 人が一番先に要るのはテストのコマンド——無いと流せない。それを一番上に、大きく。ほかは既定のままで動く。
// 保存しても、走っている実行は流し始めたときの設定のまま最後まで走る（流し直しが同じ手順になるように）。
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { FACTORY_AGENTS, getFactorySettings, setFactorySettings, type FactorySettings } from "@/lib/mock/factory";

export function FactoryConfigSection({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const saved = getFactorySettings(projectId);
  const [draft, setDraft] = useState<FactorySettings>(saved);
  const [savedAt, setSavedAt] = useState<string | undefined>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<FactorySettings>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Label htmlFor="factory-test" className="text-md font-semibold text-foreground">
          テストのコマンド
        </Label>
        <p className="mt-0.5 text-sm text-ink-3">
          worktree の中で走らせます。通ったものだけを main に取り込みます——空のままでは流せません
        </p>
        <Input
          id="factory-test"
          value={draft.testCommand}
          onChange={(e) => set({ testCommand: e.target.value })}
          placeholder="npm test"
          className={cn("mt-2 font-mono text-sm", !draft.testCommand.trim() && "border-turn")}
        />
        {!draft.testCommand.trim() && <p className="mt-1 text-sm text-turn">テストのコマンドを入れると、Factory に流せるようになります</p>}
      </div>

      <div>
        <Label htmlFor="factory-prepare" className="text-sm font-semibold text-ink-2">
          準備のコマンド（任意）
        </Label>
        <p className="mt-0.5 text-sm text-ink-3">worktree を作った直後に一度だけ。依存を写すなど</p>
        <Input
          id="factory-prepare"
          value={draft.prepareCommand}
          onChange={(e) => set({ prepareCommand: e.target.value })}
          placeholder="npm ci"
          className="mt-2 font-mono text-sm"
        />
      </div>

      <div className="grid gap-4 @lg:grid-cols-2">
        <AgentField
          label="実装役"
          hint="タスクを実装してコミットする"
          value={draft.implementer}
          onChange={(implementer) => set({ implementer })}
        />
        <AgentField
          label="レビュー役"
          hint="別の目で見るなら、実装役と別のものを"
          value={draft.reviewer}
          onChange={(reviewer) => set({ reviewer })}
        />
      </div>

      <div className="grid gap-4 @lg:grid-cols-2">
        <div>
          <Label htmlFor="factory-target" className="text-sm font-semibold text-ink-2">
            取り込む先のブランチ
          </Label>
          <Input id="factory-target" value={draft.targetBranch} onChange={(e) => set({ targetBranch: e.target.value })} className="mt-2 font-mono text-sm" />
        </div>
        <NumberField
          id="factory-concurrency"
          label="同時に進める件数"
          hint="テストを並べてコンテナを詰まらせない数に"
          value={draft.concurrency}
          min={1}
          max={16}
          onChange={(concurrency) => set({ concurrency })}
        />
      </div>

      <fieldset>
        <legend className="text-sm font-semibold text-ink-2">止まって聞くまでの回数</legend>
        <p className="mt-0.5 text-sm text-ink-3">越えたら止まって、頼んだ会話に知らせます</p>
        <div className="mt-2 grid gap-3 @lg:grid-cols-3">
          <NumberField
            id="factory-test-retries"
            label="テストのやり直し"
            value={draft.limits.testRetries}
            min={0}
            max={20}
            onChange={(testRetries) => set({ limits: { ...draft.limits, testRetries } })}
          />
          <NumberField
            id="factory-review-rounds"
            label="レビューの差し戻し"
            value={draft.limits.reviewRounds}
            min={0}
            max={20}
            onChange={(reviewRounds) => set({ limits: { ...draft.limits, reviewRounds } })}
          />
          <NumberField
            id="factory-rebase"
            label="取り込みのやり直し"
            value={draft.limits.rebaseRetries}
            min={0}
            max={20}
            onChange={(rebaseRetries) => set({ limits: { ...draft.limits, rebaseRetries } })}
          />
        </div>
      </fieldset>

      <NumberField
        id="factory-timeout"
        label="テスト1回の上限（分）"
        value={draft.testTimeoutMinutes}
        min={1}
        max={1440}
        onChange={(testTimeoutMinutes) => set({ testTimeoutMinutes })}
      />

      <div className="flex items-center gap-3 border-t border-border pt-3">
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() => {
            setFactorySettings(projectId, draft);
            setSavedAt(new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }));
          }}
        >
          設定を保存
        </Button>
        {dirty ? (
          <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
            元に戻す
          </Button>
        ) : null}
        <span className="text-sm text-ink-3">
          {savedAt && !dirty ? `${savedAt} に保存しました。` : ""}走っている実行は、流し始めたときの設定のまま進みます
        </span>
      </div>
    </div>
  );
}

function AgentField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: { agent: string; model: string };
  onChange: (v: { agent: string; model: string }) => void;
}) {
  const agent = FACTORY_AGENTS.find((a) => a.id === value.agent) ?? FACTORY_AGENTS[0];
  return (
    <div>
      <p className="text-sm font-semibold text-ink-2">{label}</p>
      <p className="mt-0.5 text-sm text-ink-3">{hint}</p>
      <div className="mt-2 flex gap-2">
        <Select value={agent.id} onValueChange={(id) => onChange({ agent: id, model: FACTORY_AGENTS.find((a) => a.id === id)!.models[0] })}>
          <SelectTrigger className="w-36" aria-label={`${label}のエージェント`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FACTORY_AGENTS.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={value.model} onValueChange={(model) => onChange({ agent: agent.id, model })}>
          <SelectTrigger className="min-w-0 flex-1" aria-label={`${label}のモデル`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agent.models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-sm text-ink-2">
        {label}
      </Label>
      {hint && <p className="mt-0.5 text-sm text-ink-3">{hint}</p>}
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
        className="mt-1.5 w-24 tabular-nums"
      />
    </div>
  );
}
