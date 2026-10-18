"use client";

// 見本：「Module を追加」で banto の Module をまとめて入れる（fork/module-bulk-add）。
// 上の帯は見本だけの場面切り替え（本物には無い）。
import { useMemo, useState } from "react";
import { Check, CircleAlert, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  BUNDLED_MODULES,
  installedFor,
  type BundledModule,
  type Scenario,
} from "@/lib/mock/bundled-modules";

type Tab = "bundled" | "custom";
type RowResult = "ok" | "failed";

export default function AddModulesMockPage() {
  const [scenario, setScenario] = useState<Scenario>("some");
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-2">
        <span className="font-medium text-foreground">見本の場面：</span>
        {(
          [
            ["fresh", "まっさらな banto"],
            ["some", "いくつか入れてある"],
            ["result", "入れた結果（1件失敗）"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setScenario(id)}
            className={cn(
              "rounded-md px-2 py-1",
              scenario === id ? "bg-background text-foreground shadow-sm" : "hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex flex-1 items-start justify-center bg-black/40 p-4 sm:p-10">
        <AddModuleDialogMock key={scenario} scenario={scenario} />
      </div>
    </div>
  );
}

function AddModuleDialogMock({ scenario }: { scenario: Scenario }) {
  const installed = installedFor(scenario);
  const [tab, setTab] = useState<Tab>("bundled");
  const byId = useMemo(() => new Map(BUNDLED_MODULES.map((m) => [m.id, m])), []);
  const bulk = BUNDLED_MODULES.filter((m) => !m.perConnection);
  const perConnection = BUNDLED_MODULES.filter((m) => m.perConnection);
  const notInstalled = bulk.filter((m) => !installed[m.id]);

  // 人が自分で選んだもの
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    scenario === "result" ? new Set(["factory", "browser", "publish-directory"]) : new Set(),
  );
  // 選んだものが要るので一緒に入るもの（id → 要る理由になった Module の名前）
  const pulledIn = useMemo(() => {
    const out = new Map<string, string[]>();
    const visit = (m: BundledModule) => {
      for (const dep of m.requires) {
        if (installed[dep] || chosen.has(dep)) continue;
        const list = out.get(dep) ?? [];
        if (!list.includes(m.name)) list.push(m.name);
        out.set(dep, list);
        const d = byId.get(dep);
        if (d) visit(d);
      }
    };
    for (const id of chosen) {
      const m = byId.get(id);
      if (m) visit(m);
    }
    return out;
  }, [chosen, installed, byId]);
  const toInstall = bulk.filter((m) => chosen.has(m.id) || pulledIn.has(m.id));

  const [phase, setPhase] = useState<"pick" | "running" | "done">(scenario === "result" ? "done" : "pick");
  const results: Record<string, RowResult> =
    phase === "done"
      ? Object.fromEntries(
          toInstall.map((m) => [m.id, m.id === "publish-caddy" ? "failed" : "ok"] as const),
        )
      : {};

  const allChosen = notInstalled.length > 0 && notInstalled.every((m) => chosen.has(m.id) || pulledIn.has(m.id));

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const projectRows = bulk.filter((m) => m.scope === "project");
  const instanceRows = bulk.filter((m) => m.scope === "instance");

  return (
    <div className="flex max-h-[calc(100vh-6rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
      <div className="flex flex-col gap-3 px-5 pt-5">
        <h2 className="text-base font-semibold text-foreground">Module を追加</h2>
        <div className="grid grid-cols-2 border-b border-border">
          {(
            [
              ["bundled", "banto の Module", BUNDLED_MODULES.length],
              ["custom", "カスタム", undefined],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center justify-center gap-1.5 px-2 py-2 text-xs",
                tab === id ? "bg-surface-2 text-foreground" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {label}
              {count === undefined ? null : <span className="tabular-nums text-ink-3">{count}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === "custom" ? (
        <div className="flex flex-col gap-2 px-5 py-4 text-xs text-ink-2">
          <p>今のまま（JSON を貼り付け・手動で入力・MCP Registry を探す）。</p>
          <p className="text-ink-3">
            Stripe・Notion などの外部の MCP は、ここの「MCP Registry を探す」から入れます。
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-4">
          <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-background py-3">
            <p className="text-xs text-ink-2">
              banto に入っているコードです。選んだものをまとめて入れます。
            </p>
            {phase === "pick" && notInstalled.length > 0 ? (
              <button
                type="button"
                className="shrink-0 text-xs font-medium text-[var(--banto-accent)] hover:underline"
                onClick={() =>
                  setChosen(allChosen ? new Set() : new Set(notInstalled.map((m) => m.id)))
                }
              >
                {allChosen ? "選択を外す" : `まだ入れていないものを全部（${notInstalled.length}）`}
              </button>
            ) : null}
          </div>

          <Group
            title="Project で使うもの"
            note="入れると、どの Project でも使えるようになります。使わない Project では、その Project の設定で外せます。"
          >
            {projectRows.map((m) => (
              <Row
                key={m.id}
                m={m}
                byId={byId}
                installed={installed[m.id]}
                chosen={chosen.has(m.id)}
                pulledInBy={pulledIn.get(m.id)}
                result={results[m.id]}
                running={phase === "running" && toInstall.includes(m)}
                locked={phase !== "pick"}
                onToggle={() => toggle(m.id)}
              />
            ))}
          </Group>

          <Group title="banto 全体で1本" note="この機械の banto に1本だけ立ち、どの Project からも使います。">
            {instanceRows.map((m) => (
              <Row
                key={m.id}
                m={m}
                byId={byId}
                installed={installed[m.id]}
                chosen={chosen.has(m.id)}
                pulledInBy={pulledIn.get(m.id)}
                result={results[m.id]}
                running={phase === "running" && toInstall.includes(m)}
                locked={phase !== "pick"}
                onToggle={() => toggle(m.id)}
              />
            ))}
          </Group>

          <Group
            title="接続先ごとに入れるもの"
            note="1本ずつ名前を付けて入れ、入れたあと設定で接続先を入れます。まとめて入れる対象には入りません。"
          >
            {perConnection.map((m) => (
              <PerConnectionRow key={m.id} m={m} installed={installed[m.id] ?? []} />
            ))}
          </Group>
        </div>
      )}

      {tab === "bundled" ? (
        <div className="flex flex-col gap-2 border-t border-border bg-surface-2/60 px-5 py-3">
          {phase === "done" ? (
            <DoneSummary toInstall={toInstall} results={results} />
          ) : (
            <p className="text-xs text-ink-2" data-testid="bulk-summary">
              {toInstall.length === 0
                ? "入れるものを選んでください"
                : `${toInstall.length} 本を入れます：${toInstall.map((m) => m.name).join("、")}`}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm">
              {phase === "done" ? "閉じる" : "キャンセル"}
            </Button>
            {phase === "done" ? (
              results && Object.values(results).includes("failed") ? (
                <Button size="sm" onClick={() => setPhase("pick")}>
                  失敗したものをもう一度
                </Button>
              ) : null
            ) : (
              <Button
                size="sm"
                disabled={toInstall.length === 0 || phase === "running"}
                onClick={() => {
                  setPhase("running");
                  setTimeout(() => setPhase("done"), 1400);
                }}
              >
                {phase === "running" ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    入れています…
                  </>
                ) : toInstall.length > 0 ? (
                  `${toInstall.length} 本を入れる`
                ) : (
                  "入れる"
                )}
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mt-3 flex flex-col gap-1.5 first:mt-0">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-ink-3">{note}</p>
      <div className="mt-1 flex flex-col divide-y divide-border rounded-lg border border-border">{children}</div>
    </section>
  );
}

function Row({
  m,
  byId,
  installed,
  chosen,
  pulledInBy,
  result,
  running,
  locked,
  onToggle,
}: {
  m: BundledModule;
  byId: Map<string, BundledModule>;
  installed?: string[];
  chosen: boolean;
  pulledInBy?: string[];
  result?: RowResult;
  running: boolean;
  locked: boolean;
  onToggle(): void;
}) {
  const isInstalled = !!installed;
  const checked = isInstalled || chosen || !!pulledInBy;
  const disabled = isInstalled || !!pulledInBy || locked;
  return (
    <label
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-2/50",
        isInstalled && "opacity-60",
      )}
    >
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-[var(--banto-accent)]"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-foreground">{m.name}</span>
          {isInstalled ? <span className="text-xs text-ink-3">入れてあります</span> : null}
          {pulledInBy ? (
            <span className="text-xs text-[var(--banto-accent)]">{pulledInBy.join("・")} に要るので一緒に入れます</span>
          ) : null}
        </span>
        <span className="text-xs leading-relaxed text-ink-3">{m.description}</span>
        {m.requires.length > 0 && !isInstalled ? (
          <span className="text-xs text-ink-3">
            要るもの：{m.requires.map((d) => byId.get(d)?.name ?? d).join("・")}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 flex w-5 shrink-0 justify-end">
        {running ? <Loader2 className="size-4 animate-spin text-ink-3" /> : null}
        {result === "ok" ? <Check className="size-4 text-ok" aria-label="入れました" /> : null}
        {result === "failed" ? <CircleAlert className="size-4 text-turn" aria-label="入れられませんでした" /> : null}
      </span>
    </label>
  );
}

function PerConnectionRow({ m, installed }: { m: BundledModule; installed: string[] }) {
  const [open, setOpen] = useState(false);
  const suggested = (() => {
    let n = m.id;
    for (let i = 2; installed.includes(n); i += 1) n = `${m.id}-${i}`;
    return n;
  })();
  const [name, setName] = useState(suggested);
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-foreground">{m.name}</span>
            {installed.length > 0 ? (
              <span className="text-xs text-ink-3">入れてあります：{installed.join("、")}</span>
            ) : null}
          </span>
          <span className="text-xs leading-relaxed text-ink-3">{m.description}</span>
        </span>
        {!open ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" />
            {installed.length > 0 ? "もう1本" : "入れる"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-ink-2">
            名前（設定画面と置き場は、この名前ごとに分かれます）
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
          </label>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            やめる
          </Button>
          <Button size="sm" disabled={name.trim() === ""}>
            入れて設定を開く
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DoneSummary({ toInstall, results }: { toInstall: BundledModule[]; results: Record<string, RowResult> }) {
  const ok = toInstall.filter((m) => results[m.id] === "ok");
  const failed = toInstall.filter((m) => results[m.id] === "failed");
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="text-ink-2">
        {ok.length} 本を入れました：{ok.map((m) => m.name).join("、")}
      </p>
      {failed.length > 0 ? (
        <p className="text-turn">
          {failed.map((m) => m.name).join("、")} は入れられませんでした——その名前はもう使われています: publish-caddy
          （本物では host の理由をそのまま出します）
        </p>
      ) : null}
      <p className="text-ink-3">設定が要るもの（Publish（Caddy）の基のドメインなど）は、一覧の行の「設定」から入れます。</p>
    </div>
  );
}
