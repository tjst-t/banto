"use client";

// 設定の「資源」（モック・2026-10-09、Fork「資源の逼迫」）——この機械と Project のコンテナが、いま何にどれだけ
// 使っているか。
//
// - 上に「この機械」：メモリの使い道（Project ごと・banto 本体・Incus・その他）を1本の帯で、混み具合（待たされている
//   時間）を言葉と数で、banto 本体の止まりを出す
// - 下に Project：混んでいるものを先に。1行に状態・メモリ（上限に対する帯）・CPU・プロセス数。押すと内訳
//   （Module・AI の仕事・コマンド・Service・入れ子のコンテナ）と、上限に当たった記録
// - 「混んでいる」は待たされている時間（PSI）で決める。使っている量だけでは決めない（ビルド中はキャッシュで多く見える）
// - メモリは「使っている」と「戻せるキャッシュ」を分ける（キャッシュは足りなくなれば捨てられる）
//
// 本物の通信はしない。状態は `?resources-demo=<状態>`（画面の隅のデモ用の切り替え）
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, CircleAlert, FlaskConical, Gauge, PauseCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  GB,
  MB,
  RESOURCES_DEMO_STATES,
  getResourcesSnapshot,
  parseResourcesDemo,
  type Busy,
  type ConsumerGroup,
  type ProjectResources,
  type ResourcesDemo,
  type Waiting,
} from "@/lib/mock/resources";
import { cn } from "@/lib/utils";

/** 内訳の色。Module は守る対象なので落ち着いた色、仕事・コマンドは膨らむもの */
const GROUP_COLOR: Readonly<Record<ConsumerGroup["id"], string>> = {
  modules: "bg-chart-1",
  work: "bg-chart-2",
  commands: "bg-chart-4",
  services: "bg-chart-3",
  nested: "bg-chart-5",
};

/** この機械のメモリの帯の色。Project は順に、それ以外は中立 */
const PROJECT_COLORS = ["bg-chart-1", "bg-chart-3", "bg-chart-2", "bg-chart-4", "bg-chart-5"];

function bytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.round(n / MB)} MB`;
}

function groupBytes(g: ConsumerGroup): number {
  return g.items.reduce((a, i) => a + i.bytes, 0);
}

export function ResourcesPanel() {
  const searchParams = useSearchParams();
  const demo = parseResourcesDemo(searchParams.get("resources-demo"));
  const snap = getResourcesSnapshot(demo);
  const projects = [...snap.projects].sort(
    (a, b) => Number(b.busy === "busy") - Number(a.busy === "busy") || b.usedBytes - a.usedBytes,
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(projects.filter((p) => p.busy === "busy").map((p) => p.projectId)));

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="resources-panel">
      <HostSection snap={snap} />

      <section aria-labelledby="resources-projects">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 id="resources-projects" className="text-sm font-semibold text-foreground">
            Project ごと
          </h2>
          <p className="text-xs text-ink-3">{snap.measuredAt} に測りました・10 秒ごとに更新</p>
        </div>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
          {projects.map((p) => (
            <ProjectRow key={p.projectId} p={p} open={open.has(p.projectId)} onToggle={() => toggle(p.projectId)} />
          ))}
        </ul>
      </section>

      <ResourcesDemoSwitcher demo={demo} />
    </div>
  );
}

function BusyChip({ busy, reason }: { busy: Busy; reason?: string }) {
  if (busy === "calm") {
    return <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">空いている</span>;
  }
  const chip = (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
      <Gauge className="size-3" />
      混んでいる
    </span>
  );
  if (!reason) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/** 待たされている時間（直近10秒）。数だけだと読めないので、言葉を先に置く */
function WaitingLine({ waiting }: { waiting: Waiting }) {
  const items: Array<{ label: string; value: number }> = [
    { label: "CPU", value: waiting.cpu },
    { label: "メモリ", value: waiting.memory },
    { label: "ディスク", value: waiting.io },
  ];
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">{it.label}の空きを待つ時間</dt>
          <dd className={cn("tabular-nums", it.value >= 20 ? "font-medium text-warn" : "text-ink-2")}>{it.value}%</dd>
        </div>
      ))}
    </dl>
  );
}

function HostSection({ snap }: { snap: ReturnType<typeof getResourcesSnapshot> }) {
  const h = snap.host;
  const used = h.memory.reduce((a, m) => a + m.bytes, 0);
  const free = Math.max(0, h.totalBytes - used);
  const colorFor = (projectId: string | undefined, i: number) =>
    projectId ? PROJECT_COLORS[i % PROJECT_COLORS.length]! : "bg-ink-3/40";
  const stall = h.stalls[0];

  return (
    <section aria-labelledby="resources-host" className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="resources-host" className="text-sm font-semibold text-foreground">
          この機械
        </h2>
        <BusyChip busy={h.busy} reason={h.busyReason} />
      </div>
      {h.busy === "busy" && h.busyReason ? <p className="mt-1 text-xs text-warn">{h.busyReason}</p> : null}

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-2">メモリ</span>
          <span className="tabular-nums text-ink-3">
            {bytes(used)} を使用・空き {bytes(free)}（全体 {bytes(h.totalBytes)}）
          </span>
        </div>
        <div className="mt-1.5 flex h-4 gap-0.5 overflow-hidden rounded-full bg-surface-3">
          {h.memory.map((m, i) => (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <div className={cn("h-full", colorFor(m.projectId, i))} style={{ width: `${(m.bytes / h.totalBytes) * 100}%` }} />
              </TooltipTrigger>
              <TooltipContent>
                {m.label}：{bytes(m.bytes)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {h.memory.map((m, i) => (
            <li key={m.id} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", colorFor(m.projectId, i))} />
              <span className="text-ink-2">{m.label}</span>
              <span className="tabular-nums text-ink-3">{bytes(m.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <WaitingLine waiting={h.waiting} />
      </div>

      <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-xs">
        <PauseCircle className={cn("mt-px size-3.5 shrink-0", stall && stall.seconds >= 5 ? "text-warn" : "text-ink-3")} />
        {stall ? (
          <div>
            <p className={cn(stall.seconds >= 5 ? "font-medium text-warn" : "text-ink-2")}>
              banto 本体が {stall.at} に {stall.seconds} 秒止まっていました
            </p>
            <p className="mt-0.5 text-ink-3">
              止まっている間に答えられなかった Module は、止まったとみなさずに確かめ直しています。
              {h.stalls.length > 1 ? `直近 10 分で ${h.stalls.length} 回。` : ""}
            </p>
          </div>
        ) : (
          <p className="text-ink-3">banto 本体は直近 10 分止まっていません</p>
        )}
      </div>
    </section>
  );
}

function ProjectRow({ p, open, onToggle }: { p: ProjectResources; open: boolean; onToggle: () => void }) {
  const usedPct = (p.usedBytes / p.limitBytes) * 100;
  const cachePct = (p.cacheBytes / p.limitBytes) * 100;
  const busy = p.busy === "busy";

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-4"
      >
        <span className="flex min-w-0 items-center gap-2 sm:w-44">
          <ChevronRight className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-ink-2">
            {p.initial}
          </span>
          <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex h-2 overflow-hidden rounded-full bg-surface-3">
            <span className="h-full bg-ink-2" style={{ width: `${usedPct}%` }} />
            <span className="h-full bg-ink-3/30" style={{ width: `${cachePct}%` }} />
          </span>
          <span className="flex flex-wrap gap-x-3 text-xs tabular-nums text-ink-3">
            <span>
              メモリ <span className={cn(usedPct >= 85 ? "font-medium text-warn" : "text-ink-2")}>{bytes(p.usedBytes)}</span> ／{" "}
              {bytes(p.limitBytes)}
            </span>
            <span>
              CPU {p.cpuUsed.toFixed(1)} ／ {p.cpuLimit} コア
            </span>
            <span>
              プロセス {p.processes.toLocaleString("ja-JP")}
            </span>
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
          <BusyChip busy={p.busy} />
        </span>
      </button>

      {open ? <ProjectDetail p={p} busy={busy} /> : null}
    </li>
  );
}

function ProjectDetail({ p, busy }: { p: ProjectResources; busy: boolean }) {
  const groups = p.groups.filter((g) => g.items.length > 0);
  const total = p.usedBytes + p.cacheBytes;

  return (
    <div className="flex flex-col gap-4 border-t border-border bg-surface-2/60 px-4 py-4 sm:pl-12">
      {busy && p.busyReason ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <Gauge className="mt-px size-3.5 shrink-0" />
          {p.busyReason}
        </p>
      ) : null}

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-2">何が使っているか（メモリ）</p>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
          {groups.map((g) => (
            <div key={g.id} className={GROUP_COLOR[g.id]} style={{ width: `${(groupBytes(g) / total) * 100}%` }} />
          ))}
          <div className="bg-surface-3" style={{ width: `${(p.cacheBytes / total) * 100}%` }} />
        </div>

        <div className="mt-3 flex flex-col gap-3">
          {groups.map((g) => (
            <ConsumerGroupBlock key={g.id} g={g} />
          ))}
          <div className="flex items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-full bg-surface-3 ring-1 ring-border" />
            <span className="flex-1 text-ink-3">戻せるキャッシュ（足りなくなれば捨てられる）</span>
            <span className="tabular-nums text-ink-3">{bytes(p.cacheBytes)}</span>
          </div>
        </div>
      </div>

      <WaitingLine waiting={p.waiting} />

      <div className="text-xs">
        <p className="mb-1 font-medium text-ink-2">上限に当たった記録</p>
        {p.hits.length === 0 ? (
          <p className="text-ink-3">ありません</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {p.hits.map((h) => (
              <li key={`${h.at}-${h.what}`} className="flex gap-2">
                <CircleAlert className="mt-px size-3.5 shrink-0 text-warn" />
                <span className="tabular-nums text-ink-3">{h.at}</span>
                <span className="text-ink-2">{h.what}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-ink-3">
          上限は Project の設定の「コンテナ」で下げられます（
          <Link href={`/settings?project=${p.projectId}&section=project-container`} className="text-accent-ink underline-offset-2 hover:underline">
            {p.name} のコンテナの設定
          </Link>
          ）。
        </p>
      </div>
    </div>
  );
}

function ConsumerGroupBlock({ g }: { g: ConsumerGroup }) {
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", GROUP_COLOR[g.id])} />
        <span className="flex-1 font-medium text-ink-2">{g.label}</span>
        <span className="tabular-nums text-ink-2">{bytes(groupBytes(g))}</span>
      </div>
      <ul className="mt-1 ml-1 flex flex-col gap-0.5 border-l border-border pl-3">
        {[...g.items]
          .sort((a, b) => b.bytes - a.bytes)
          .map((item, i) => (
            <li key={`${item.name}-${i}`} className="flex items-baseline gap-2">
              <span className="shrink-0 text-ink-2">{item.name}</span>
              {item.detail ? <span className="min-w-0 flex-1 truncate text-ink-3">{item.detail}</span> : <span className="flex-1" />}
              <span className="shrink-0 tabular-nums text-ink-3">{bytes(item.bytes)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * **モックだけの**状態の切り替え。本物には無い——破線・注意の色・「デモ」の札で、画面の一部ではないと分かるようにする
 */
function ResourcesDemoSwitcher({ demo }: { demo: ResourcesDemo }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  function set(value: ResourcesDemo) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("resources-demo", value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="fixed right-3 bottom-3 z-50 flex items-center gap-1.5 rounded-full border border-dashed border-warn bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn shadow-2"
        >
          <FlaskConical className="size-3.5" />
          デモ：{RESOURCES_DEMO_STATES.find((s) => s.id === demo)?.label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-50 w-64 border-dashed border-warn p-2">
        <p className="mb-1 px-1 text-xs text-warn">モックだけ（本物には無い）</p>
        <div className="flex flex-col">
          {RESOURCES_DEMO_STATES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => set(s.id)}
              className={cn(
                "rounded-md px-2 py-2 text-left text-sm sm:py-1",
                s.id === demo ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-accent",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * サイドバーの Project の行に付ける印（混んでいるときだけ）。行そのものが Project へのリンクなので、印はリンクにしない
 * （詳しくは設定の「資源」）
 */
export function BusyProjectMark({ projectName, reason }: { projectName: string; reason?: string }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`${projectName} が混んでいます`}
          className="flex size-5 shrink-0 items-center justify-center text-warn"
        >
          <Gauge className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">混んでいます{reason ? `：${reason}` : ""}</TooltipContent>
    </Tooltip>
  );
}

/** この機械全体が混んでいるとき、サイドバーの上に出す帯。押すと設定の「資源」 */
export function HostBusyBand({ reason }: { reason?: string }): ReactNode {
  return (
    <Link
      href="/settings?section=resources"
      className="mx-2 mb-1 flex items-start gap-2 rounded-md bg-warn-soft px-2.5 py-2 text-xs text-warn hover:underline"
    >
      <Gauge className="mt-px size-3.5 shrink-0" />
      <span>
        <span className="font-medium">この機械が混んでいます</span>
        {reason ? <span className="block text-warn/80">{reason}</span> : null}
      </span>
    </Link>
  );
}
