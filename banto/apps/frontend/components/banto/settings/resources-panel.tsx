"use client";

// 設定の「資源」（決定・2026-10-09、ユーザー。v4-frontend.md §6.36。見本はモックの同名のもの）——この機械と Project の
// コンテナが、いま何にどれだけ使っているか。測るのは host（`resources.ts`、10 秒ごと）、画面は開いている間だけ
// 10 秒ごとに読み直す（計算はしない、規則3）。
//
// - 上に「この機械」：メモリの使い道を1本の帯、CPU・メモリ・ディスクの空きを待つ時間、banto 本体の止まり
// - 下に Project ごと：混んでいるものが先（host が並べる）。押すと何が使っているかと上限に当たった記録
// - 「混んでいる」は host が待たされている時間で決めたもの。色は文字と札の注意の色だけ（面を塗ってよいのは turn だけ、E9）
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, CircleAlert, Gauge, PauseCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeFailure } from "@/lib/report-failure";
import {
  fetchRealResources,
  type RealProjectResources,
  type RealResourceGroup,
  type RealResourcesSnapshot,
  type RealResourceWaiting,
} from "@/lib/backend/client";
import { settingsOpenHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";

const GROUP_COLOR: Readonly<Record<RealResourceGroup["id"], string>> = {
  modules: "bg-chart-1",
  work: "bg-chart-2",
  commands: "bg-chart-4",
  services: "bg-chart-3",
  nested: "bg-chart-5",
  other: "bg-ink-3/40",
};

const PROJECT_COLORS = ["bg-chart-1", "bg-chart-3", "bg-chart-2", "bg-chart-4", "bg-chart-5"];
const REFRESH_MS = 10_000;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function bytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / MB))} MB`;
}

/** ISO → この端末の時刻「10:41」 */
function clock(iso: string, seconds = false): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getHours()}:${p(d.getMinutes())}${seconds ? `:${p(d.getSeconds())}` : ""}`;
}

function groupBytes(g: RealResourceGroup): number {
  return g.items.reduce((a, i) => a + i.bytes, 0);
}

export function ResourcesPanel() {
  const [snap, setSnap] = useState<RealResourcesSnapshot | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchRealResources();
      setSnap(next);
      setError(null);
    } catch (err) {
      setError(`資源を読めませんでした：${describeFailure(err)}`);
    }
  }, []);

  // 開いている間だけ読み直す（最初の1回もタイマーから——effect の中で直に state を変えない）
  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  // 人が開け閉めするまでは、混んでいる Project を開いておく
  const openSet = touched ? open : new Set((snap?.projects ?? []).filter((p) => p.busy).map((p) => p.projectId));

  function toggle(id: string) {
    const next = new Set(openSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
    setTouched(true);
  }

  if (snap === undefined && !error) return <p className="text-sm text-ink-3">読み込んでいます…</p>;

  return (
    <div className="flex max-w-3xl flex-col gap-6" data-testid="resources-panel">
      {error ? (
        <p data-testid="resources-error" className="text-xs text-stop">
          {error}
        </p>
      ) : null}
      {snap === null ? (
        <p className="text-sm text-ink-3">まだ測っていません。10 秒ほどで出ます。</p>
      ) : snap ? (
        <>
          <HostSection snap={snap} />
          <section aria-labelledby="resources-projects">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h2 id="resources-projects" className="text-sm font-semibold text-foreground">
                Project ごと
              </h2>
              <p className="text-xs text-ink-3">{clock(snap.measuredAt, true)} に測りました・10 秒ごとに更新</p>
            </div>
            {snap.projects.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-ink-3">
                動いている Project のコンテナはありません。Project を開くとコンテナが起き、ここに出ます。
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
                {snap.projects.map((p) => (
                  <ProjectRow key={p.projectId} p={p} open={openSet.has(p.projectId)} onToggle={() => toggle(p.projectId)} />
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function BusyChip({ busy, reason }: { busy: boolean; reason?: string }) {
  if (!busy) {
    return (
      <span data-testid="resources-chip" className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-xs text-ok">
        空いている
      </span>
    );
  }
  const chip = (
    <span
      data-testid="resources-chip"
      data-busy=""
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn"
    >
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

function WaitingLine({ waiting }: { waiting: RealResourceWaiting }) {
  const items = [
    { label: "CPU", value: waiting.cpu },
    { label: "メモリ", value: waiting.memory },
    { label: "ディスク", value: waiting.io },
  ];
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <dt className="text-ink-3">{it.label}の空きを待つ時間</dt>
          <dd className={cn("tabular-nums", it.value >= 20 ? "font-medium text-warn" : "text-ink-2")}>{Math.round(it.value)}%</dd>
        </div>
      ))}
    </dl>
  );
}

function HostSection({ snap }: { snap: RealResourcesSnapshot }) {
  const h = snap.host;
  const total = h.totalBytes ?? h.memory.reduce((a, m) => a + m.bytes, 0);
  const used = h.memory.reduce((a, m) => a + m.bytes, 0);
  let projectIndex = 0;
  const colors = h.memory.map((m) => (m.projectId ? PROJECT_COLORS[projectIndex++ % PROJECT_COLORS.length]! : "bg-ink-3/40"));
  const stall = h.stalls[h.stalls.length - 1];

  return (
    <section aria-labelledby="resources-host" data-testid="resources-host" className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="resources-host" className="text-sm font-semibold text-foreground">
          この機械
        </h2>
        <BusyChip busy={h.busy} {...(h.busyReason ? { reason: h.busyReason } : {})} />
      </div>
      {h.busy && h.busyReason ? <p className="mt-1 text-xs text-warn">{h.busyReason}</p> : null}

      <div className="mt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
          <span className="text-ink-2">メモリ</span>
          <span className="tabular-nums text-ink-3">
            {bytes(used)} を使用
            {h.availableBytes !== undefined ? `・空き ${bytes(h.availableBytes)}` : ""}
            {h.totalBytes !== undefined ? `（全体 ${bytes(h.totalBytes)}）` : ""}
          </span>
        </div>
        <div className="mt-1.5 flex h-4 gap-0.5 overflow-hidden rounded-full bg-surface-3">
          {h.memory.map((m, i) => (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <div className={cn("h-full", colors[i])} style={{ width: `${total > 0 ? (m.bytes / total) * 100 : 0}%` }} />
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
              <span className={cn("size-2 rounded-full", colors[i])} />
              <span className="text-ink-2">{m.label}</span>
              <span className="tabular-nums text-ink-3">{bytes(m.bytes)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <WaitingLine waiting={h.waiting} />
      </div>

      <div data-testid="resources-stall" className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-xs">
        <PauseCircle className={cn("mt-px size-3.5 shrink-0", stall && stall.seconds >= 5 ? "text-warn" : "text-ink-3")} />
        {stall ? (
          <div>
            <p className={cn(stall.seconds >= 5 ? "font-medium text-warn" : "text-ink-2")}>
              banto 本体が {clock(stall.at)} に {stall.seconds} 秒止まっていました
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

function ProjectRow({ p, open, onToggle }: { p: RealProjectResources; open: boolean; onToggle: () => void }) {
  const limit = p.limitBytes ?? p.usedBytes + p.cacheBytes;
  const usedPct = limit > 0 ? Math.min(100, (p.usedBytes / limit) * 100) : 0;
  const cachePct = limit > 0 ? Math.min(100 - usedPct, (p.cacheBytes / limit) * 100) : 0;
  const high = usedPct >= 85;

  return (
    <li data-testid="resources-project" data-project-id={p.projectId}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-col gap-2 px-4 py-3 text-left hover:bg-accent/50 sm:flex-row sm:items-center sm:gap-4"
      >
        <span className="flex min-w-0 items-center gap-2 sm:w-44">
          <ChevronRight className={cn("size-3.5 shrink-0 text-ink-3 transition-transform", open && "rotate-90")} />
          <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex h-2 overflow-hidden rounded-full bg-surface-3">
            <span className="h-full bg-ink-2" style={{ width: `${usedPct}%` }} />
            <span className="h-full bg-ink-3/30" style={{ width: `${cachePct}%` }} />
          </span>
          <span className="flex flex-wrap gap-x-3 text-xs tabular-nums text-ink-3">
            <span>
              メモリ <span className={cn(high ? "font-medium text-warn" : "text-ink-2")}>{bytes(p.usedBytes)}</span>
              {p.limitBytes !== undefined ? ` ／ ${bytes(p.limitBytes)}` : ""}
            </span>
            <span>
              CPU {p.cpuUsed !== undefined ? p.cpuUsed.toFixed(1) : "—"}
              {p.cpuLimit !== undefined ? ` ／ ${p.cpuLimit} コア` : ""}
            </span>
            <span>プロセス {p.processes.toLocaleString("ja-JP")}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pl-5 sm:pl-0">
          <BusyChip busy={p.busy} />
        </span>
      </button>
      {open ? <ProjectDetail p={p} /> : null}
    </li>
  );
}

function ProjectDetail({ p }: { p: RealProjectResources }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const groups = p.groups.filter((g) => g.items.length > 0);
  const total = groups.reduce((a, g) => a + groupBytes(g), 0) + p.cacheBytes;

  return (
    <div data-testid="resources-project-detail" className="flex flex-col gap-4 border-t border-border bg-surface-2/60 px-4 py-4 sm:pl-10">
      {p.busy && p.busyReason ? (
        <p className="flex items-start gap-1.5 text-xs text-warn">
          <Gauge className="mt-px size-3.5 shrink-0" />
          {p.busyReason}
        </p>
      ) : null}

      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-2">何が使っているか（メモリ）</p>
        {total > 0 ? (
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
            {groups.map((g) => (
              <div key={g.id} className={GROUP_COLOR[g.id]} style={{ width: `${(groupBytes(g) / total) * 100}%` }} />
            ))}
            <div className="bg-surface-3" style={{ width: `${(p.cacheBytes / total) * 100}%` }} />
          </div>
        ) : null}
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
          <p className="text-ink-3">banto を起こしてからはありません</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {p.hits.map((h) => (
              <li key={`${h.at}-${h.what}`} className="flex gap-2">
                <CircleAlert className="mt-px size-3.5 shrink-0 text-warn" />
                <span className="tabular-nums text-ink-3">{clock(h.at)}</span>
                <span className="text-ink-2">{h.what}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-ink-3">
          上限は Project の設定の「一般」にある「コンテナ」で下げられます（
          <Link
            href={settingsOpenHref(pathname, searchParams, { project: p.projectId, section: "project-general" })}
            className="text-accent-ink underline-offset-2 hover:underline"
          >
            {p.name} の設定
          </Link>
          ）。
        </p>
      </div>
    </div>
  );
}

function ConsumerGroupBlock({ g }: { g: RealResourceGroup }) {
  return (
    <div className="text-xs" data-testid="resources-group" data-group={g.id}>
      <div className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", GROUP_COLOR[g.id])} />
        <span className="flex-1 font-medium text-ink-2">{g.label}</span>
        <span className="tabular-nums text-ink-2">{bytes(groupBytes(g))}</span>
      </div>
      <ul className="mt-1 ml-1 flex flex-col gap-0.5 border-l border-border pl-3">
        {g.items.map((item, i) => (
          <li key={`${item.name}-${i}`} className="flex items-baseline gap-2">
            <span className="min-w-0 shrink truncate text-ink-2">{item.name}</span>
            {item.detail ? <span className="min-w-0 flex-1 truncate text-ink-3">{item.detail}</span> : <span className="flex-1" />}
            <span className="shrink-0 tabular-nums text-ink-3">{bytes(item.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * サイドバーの Project の行に付ける印（混んでいるときだけ、§6.36）。行そのものが Project へのリンクなので、印はリンクにしない。
 * 名前のすぐ後ろに置く——行の右端には「…」と開閉の印が重なって出るので、右端に寄せない（2026-10-09、ユーザー報告）
 */
export function BusyProjectMark({ projectName, reason }: { projectName: string; reason: string }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          data-testid="sidebar-project-busy"
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

/** この機械全体が混んでいるとき、サイドバーの Project の一覧の上に出す帯。押すと設定の「資源」 */
export function HostBusyBand({ reason, href, onNavigate }: { reason: string; href: string; onNavigate?: () => void }): ReactNode {
  return (
    <Link
      href={href}
      data-testid="sidebar-host-busy"
      onClick={onNavigate}
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
