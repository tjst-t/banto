"use client";

// **コンテナの資源の上限**（決定・2026-10-02、ユーザー。`docs/specs/v4-security.md` §1）。
//
// - banto 全体（`ContainerLimitsPanel`）：上限そのものではなく「host に何を残すか」を決める——いろんな host に
//   入れても同じ設定で意味が通る。上限は host が自分の資源から計算する
// - Project ごと（`ProjectContainerLimits`）：banto 全体の上限より**下げることだけ**できる。空欄は banto 全体のまま
//
// どちらも、保存すると動いているコンテナにも起こし直さずに効く。計算は host がする（画面は計算しない、規則3）
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeFailure } from "@/lib/report-failure";
import {
  fetchRealContainerLimits,
  setRealContainerLimitPolicy,
  setRealProjectContainerLimits,
  type RealContainerLimits,
  type RealLimitNumbers,
} from "@/lib/backend/client";

const gib = (mib: number) => Math.round((mib / 1024) * 10) / 10;
const toMiB = (gibText: string) => Math.round(Number(gibText) * 1024);

/** 上限を1行で（例「メモリ 13.6 GiB・CPU 3 コア分・プロセス 8192」） */
export function limitsSummary(n: RealLimitNumbers): string {
  return `メモリ ${gib(n.memoryMiB)} GiB・CPU ${n.cpus} コア分・プロセス ${n.processes}`;
}

function NumberField(props: {
  id: string;
  label: string;
  unit: string;
  value: string;
  placeholder?: string;
  step: string;
  disabled?: boolean;
  onChange(v: string): void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={props.id} className="text-xs">
        {props.label}
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={props.id}
          data-testid={props.id}
          type="number"
          inputMode="decimal"
          step={props.step}
          min="0"
          className="h-8 w-28"
          value={props.value}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <span className="text-xs text-ink-3">{props.unit}</span>
      </div>
    </div>
  );
}

/** banto 全体の設定画面の「コンテナ」 */
export function ContainerLimitsPanel() {
  const [state, setState] = useState<RealContainerLimits | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ memory: "", cpus: "", processes: "" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fill = useCallback((v: RealContainerLimits) => {
    setState(v);
    setDraft({
      memory: String(gib(v.policy.hostReserveMemoryMiB)),
      cpus: String(v.policy.hostReserveCpus),
      processes: String(v.policy.processes),
    });
  }, []);
  const load = useCallback(() => {
    fetchRealContainerLimits()
      .then((v) => {
        setLoadError(null);
        fill(v);
      })
      .catch((err: unknown) => setLoadError(describeFailure(err)));
  }, [fill]);
  useEffect(load, [load]);

  async function save(policy: { hostReserveMemoryMiB: number; hostReserveCpus: number; processes: number }) {
    setBusy(true);
    setSaveError(null);
    try {
      fill(await setRealContainerLimitPolicy(policy));
    } catch (err) {
      setSaveError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div data-testid="container-limits-error" className="flex flex-col items-start gap-2 rounded-md border border-border p-3">
        <p className="text-sm text-foreground">コンテナの上限の設定を取得できませんでした</p>
        <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={load}>
          再読み込み
        </Button>
      </div>
    );
  }
  if (!state) return <p className="text-xs text-ink-3">読み込み中…</p>;

  return (
    <div data-testid="container-limits-panel">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">コンテナ</h1>
      <p className="mb-4 text-xs text-ink-3">
        {"Project の Module・AI のコマンド・サブエージェントは、Project ごとのコンテナの中で動きます。" +
          "1つの Project が暴走しても banto 本体とこの機械が止まらないよう、コンテナごとに資源の上限を付けます。" +
          "ここでは、この機械に必ず残す分を決めます。上限はこの機械の資源から計算します。"}
      </p>
      <p className="mb-3 text-xs text-ink-2">
        この機械：メモリ {gib(state.host.memoryMiB)} GiB・CPU {state.host.cpus} コア
      </p>
      <div className="flex flex-wrap gap-4">
        <NumberField id="container-limits-reserve-memory" label="この機械に残すメモリ" unit="GiB" step="0.5" value={draft.memory} disabled={busy} onChange={(v) => setDraft({ ...draft, memory: v })} />
        <NumberField id="container-limits-reserve-cpus" label="この機械に残す CPU" unit="コア" step="0.5" value={draft.cpus} disabled={busy} onChange={(v) => setDraft({ ...draft, cpus: v })} />
        <NumberField id="container-limits-processes" label="1台あたりのプロセス数" unit="" step="256" value={draft.processes} disabled={busy} onChange={(v) => setDraft({ ...draft, processes: v })} />
      </div>
      <p className="mt-3 text-xs text-ink-2">
        1台あたりの上限：<span data-testid="container-limits-ceiling">{limitsSummary(state.ceiling)}</span>
      </p>
      <p className="mt-1 text-xs text-ink-3">
        {"上限は1台ごとです。重い Project が同時にいくつも動くと、合わせてこの機械の資源を越えることがあります。"}
      </p>
      {saveError && (
        <p data-testid="container-limits-save-error" className="mt-2 text-xs text-stop">
          保存できませんでした：{saveError}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          disabled={busy}
          onClick={() =>
            void save({ hostReserveMemoryMiB: toMiB(draft.memory), hostReserveCpus: Number(draft.cpus), processes: Number(draft.processes) })
          }
        >
          保存する
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={() => void save(state.defaults)}>
          既定に戻す
        </Button>
      </div>
    </div>
  );
}

/**
 * Project の設定の「コンテナ」の中に置く。`limits` は `GET /api/projects/:id/container` の中身。
 * 入力欄は最初の値から始まる——保存した値で描き直すには、呼ぶ側が `key` を替える
 */
export function ProjectContainerLimits({
  projectId,
  limits,
  onSaved,
}: {
  projectId: string;
  limits: RealContainerLimits;
  onSaved(next: RealContainerLimits): void;
}) {
  const fromOverride = (l: RealContainerLimits) => ({
    memory: l.override?.memoryMiB !== undefined ? String(gib(l.override.memoryMiB)) : "",
    cpus: l.override?.cpus !== undefined ? String(l.override.cpus) : "",
    processes: l.override?.processes !== undefined ? String(l.override.processes) : "",
  });
  const [draft, setDraft] = useState(() => fromOverride(limits));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blankToNull = (v: string, conv: (s: string) => number) => (v.trim() === "" ? null : conv(v));
  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      onSaved(
        await setRealProjectContainerLimits(projectId, {
          memoryMiB: blankToNull(draft.memory, toMiB),
          cpus: blankToNull(draft.cpus, Number),
          processes: blankToNull(draft.processes, Number),
        }),
      );
    } catch (err) {
      setSaveError(describeFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="project-container-limits" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Label className="text-sm">資源の上限</Label>
      <p className="text-xs text-ink-3">
        {"この Project のコンテナが使えるメモリ・CPU・プロセス数です（サブエージェントも含みます）。" +
          "空欄は banto 全体の上限のまま。banto 全体の上限より大きくはできません。保存すると、動いているコンテナにもそのまま効きます。"}
      </p>
      <p className="text-xs text-ink-2">
        いま：<span data-testid="project-container-limits-effective">{limits.effective ? limitsSummary(limits.effective) : "—"}</span>
      </p>
      <div className="flex flex-wrap gap-4">
        <NumberField id="project-container-limits-memory" label="メモリ" unit="GiB" step="0.5" value={draft.memory} placeholder={String(gib(limits.ceiling.memoryMiB))} disabled={busy} onChange={(v) => setDraft({ ...draft, memory: v })} />
        <NumberField id="project-container-limits-cpus" label="CPU" unit="コア" step="0.5" value={draft.cpus} placeholder={String(limits.ceiling.cpus)} disabled={busy} onChange={(v) => setDraft({ ...draft, cpus: v })} />
        <NumberField id="project-container-limits-processes" label="プロセス数" unit="" step="256" value={draft.processes} placeholder={String(limits.ceiling.processes)} disabled={busy} onChange={(v) => setDraft({ ...draft, processes: v })} />
      </div>
      {saveError && (
        <p data-testid="project-container-limits-save-error" className="text-xs text-stop">
          保存できませんでした：{saveError}
        </p>
      )}
      <div>
        <Button size="sm" className="h-7 px-3 text-xs" disabled={busy} onClick={() => void save()}>
          保存する
        </Button>
      </div>
    </div>
  );
}
