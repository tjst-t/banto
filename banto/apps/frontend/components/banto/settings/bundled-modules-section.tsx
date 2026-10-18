"use client";

// **「Module を追加」の「banto の Module」**（決定・2026-10-18、ユーザー「モックの形で実装して」。モックは
// fork/module-bulk-add の mock/app/add-modules）。
//
// banto に入っているコード（同梱の目録 `BUNDLED_CATALOG`）を、**チェックで選んでまとめて入れる**。
// - 組は3つ：Project で使うもの／banto 全体で1本／接続先ごとに入れるもの（Vault（Infisical）——名前を付けて1本ずつ）
// - 入れてあるものは薄くチェック済みで外せない
// - **要るもの（`requires`）は host が目録から決めたもの**をそのまま使い、選んだものに要れば「〜に要るので一緒に
//   入れます」で付ける。入れる口（`/api/modules/catalog/bulk`）も依存を自分で決め直す——画面の言い分は使わない
// - 結果は行ごと。入れられなかったものは理由を出し、もう一度押せる
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  installRealModuleFromCatalog,
  installRealModulesFromCatalog,
  listRealModuleCatalog,
  type RealCatalogBulkResult,
  type RealCatalogEntry,
} from "@/lib/backend/client";
import { cn } from "@/lib/utils";

export function BundledModulesSection({
  open,
  existingNames,
  onInstalled,
  onClose,
}: {
  /** ダイアログが開いているか（開いたときに目録を読み直す） */
  open: boolean;
  existingNames: readonly string[];
  onInstalled(): Promise<void>;
  onClose(): void;
}) {
  const [catalog, setCatalog] = useState<RealCatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<"pick" | "running" | "done">("pick");
  const [results, setResults] = useState<RealCatalogBulkResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCatalog(await listRealModuleCatalog());
      setLoadError(null);
    } catch (err) {
      // **読めなかったことを「無い」と混同しない**（規則2）
      setCatalog([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 開いたときに読む（ダイアログの中身は閉じると捨てられるので、選んだものや結果は開くたびに初めから）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRealModuleCatalog()
      .then((list) => !cancelled && (setCatalog(list), setLoadError(null)))
      // **読めなかったことを「無い」と混同しない**（規則2）
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog([]);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const byId = useMemo(() => new Map((catalog ?? []).map((e) => [e.id, e])), [catalog]);
  const bulk = (catalog ?? []).filter((e) => !e.perConnection);
  const perConnection = (catalog ?? []).filter((e) => e.perConnection);
  const isInstalled = (e: RealCatalogEntry) => e.installed.length > 0;
  const notInstalled = bulk.filter((e) => !isInstalled(e));

  /** 選んだものに要るので一緒に入るもの（id → それを要る Module の名前） */
  const pulledIn = useMemo(() => {
    const out = new Map<string, string[]>();
    const visit = (e: RealCatalogEntry, seen: Set<string>) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      for (const dep of e.requires) {
        const d = byId.get(dep);
        if (!d || isInstalled(d) || chosen.has(dep)) continue;
        const list = out.get(dep) ?? [];
        if (!list.includes(e.name)) list.push(e.name);
        out.set(dep, list);
        visit(d, seen);
      }
    };
    for (const id of chosen) {
      const e = byId.get(id);
      if (e) visit(e, new Set());
    }
    return out;
  }, [chosen, byId]);

  const toInstall = bulk.filter((e) => chosen.has(e.id) || pulledIn.has(e.id));
  const allChosen = notInstalled.length > 0 && notInstalled.every((e) => chosen.has(e.id) || pulledIn.has(e.id));
  const resultOf = (id: string) => results?.find((r) => r.id === id);
  const failed = (results ?? []).filter((r) => r.status === "failed");

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function install(ids: string[]) {
    setPhase("running");
    setError(null);
    try {
      const res = await installRealModulesFromCatalog(ids);
      setResults(res);
      setPhase("done");
      await onInstalled();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("pick");
    }
  }

  const rowProps = (e: RealCatalogEntry) => ({
    e,
    byId,
    chosen: chosen.has(e.id),
    pulledInBy: pulledIn.get(e.id),
    result: resultOf(e.id),
    running: phase === "running" && toInstall.includes(e),
    locked: phase !== "pick",
    onToggle: () => toggle(e.id),
  });

  return (
    <>
      <div className="flex flex-col" data-testid="add-module-bundled">
        <div className="sticky -top-4 z-10 -mx-4 flex items-center justify-between gap-3 bg-popover px-4 py-2">
          <p className="text-xs text-ink-2">banto に入っているコードです。選んだものをまとめて入れます。</p>
          {phase === "pick" && notInstalled.length > 0 ? (
            <button
              type="button"
              data-testid="add-module-bundled-all"
              className="shrink-0 text-xs font-medium text-primary hover:underline"
              onClick={() => setChosen(allChosen ? new Set() : new Set(notInstalled.map((e) => e.id)))}
            >
              {allChosen ? "選択を外す" : `まだ入れていないものを全部（${notInstalled.length}）`}
            </button>
          ) : null}
        </div>

        {catalog === null ? (
          <p className="text-xs text-ink-3">読み込み中…</p>
        ) : loadError ? (
          <p className="text-xs text-danger">{loadError}</p>
        ) : catalog.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
            入れられる banto の Module はありません
          </p>
        ) : (
          <>
            <Group
              title="Project で使うもの"
              note="入れると、どの Project でも使えるようになります。使わない Project では、その Project の設定で外せます。"
              rows={bulk.filter((e) => e.scope === "project").map((e) => <Row key={e.id} {...rowProps(e)} />)}
            />
            <Group
              title="banto 全体で1本"
              note="この機械の banto に1本だけ立ち、どの Project からも使います。"
              rows={bulk.filter((e) => e.scope === "instance").map((e) => <Row key={e.id} {...rowProps(e)} />)}
            />
            <Group
              title="接続先ごとに入れるもの"
              note="1本ずつ名前を付けて入れ、入れたあと設定で接続先を入れます。まとめて入れる対象には入りません。"
              rows={perConnection.map((e) => (
                <PerConnectionRow
                  key={e.id}
                  e={e}
                  existingNames={existingNames}
                  onInstalled={async () => {
                    await onInstalled();
                    await load();
                  }}
                />
              ))}
            />
          </>
        )}
      </div>

      <div className="sticky -bottom-4 z-10 -mx-4 -mb-4 flex flex-col gap-2 border-t border-border bg-popover px-4 py-3">
        {phase === "done" && results ? (
          <div className="flex flex-col gap-1 text-xs" data-testid="add-module-bundled-result">
            {results.some((r) => r.status === "installed") ? (
              <p className="text-ink-2">
                {results.filter((r) => r.status === "installed").length} 本を入れました：
                {results
                  .filter((r) => r.status === "installed")
                  .map((r) => byId.get(r.id)?.name ?? r.id)
                  .join("、")}
              </p>
            ) : null}
            {failed.map((r) => (
              <p key={r.id} className="text-turn">
                {byId.get(r.id)?.name ?? r.id} は入れられませんでした：{r.error}
              </p>
            ))}
            <p className="text-ink-3">設定が要るもの（Publish（Caddy）の基のドメインなど）は、一覧の行の「設定」から入れます。</p>
          </div>
        ) : (
          <p className="text-xs text-ink-2" data-testid="add-module-bundled-summary">
            {toInstall.length === 0
              ? "入れるものを選んでください"
              : `${toInstall.length} 本を入れます：${toInstall.map((e) => e.name).join("、")}`}
          </p>
        )}
        {error ? (
          <p className="text-xs text-danger" data-testid="add-module-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {phase === "done" ? "閉じる" : "キャンセル"}
          </Button>
          {phase === "done" ? (
            failed.length > 0 ? (
              <Button type="button" size="sm" onClick={() => void install(failed.map((r) => r.id))}>
                失敗したものをもう一度
              </Button>
            ) : null
          ) : (
            <Button
              type="button"
              size="sm"
              data-testid="add-module-bundled-install"
              disabled={toInstall.length === 0 || phase === "running"}
              onClick={() => void install([...chosen])}
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
    </>
  );
}

function Group({ title, note, rows }: { title: string; note: string; rows: React.ReactNode[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="mt-4 flex flex-col gap-1.5 first:mt-0">
      <h3 className="text-xs font-semibold text-foreground">{title}</h3>
      <p className="text-xs text-ink-3">{note}</p>
      <div className="mt-1 flex flex-col divide-y divide-border rounded-lg border border-border">{rows}</div>
    </section>
  );
}

function Row({
  e,
  byId,
  chosen,
  pulledInBy,
  result,
  running,
  locked,
  onToggle,
}: {
  e: RealCatalogEntry;
  byId: Map<string, RealCatalogEntry>;
  chosen: boolean;
  pulledInBy?: string[];
  result?: RealCatalogBulkResult;
  running: boolean;
  locked: boolean;
  onToggle(): void;
}) {
  const installed = e.installed.length > 0;
  const justInstalled = result?.status === "installed";
  const checked = installed || chosen || !!pulledInBy;
  const disabled = (installed && !justInstalled) || !!pulledInBy || locked;
  return (
    <label
      data-testid={`add-module-bundled-${e.id}`}
      data-state={installed ? "installed" : checked ? "checked" : "unchecked"}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        disabled ? "cursor-default" : "cursor-pointer hover:bg-surface-2/50",
        installed && !justInstalled && "opacity-60",
      )}
    >
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled || installed}
        onChange={onToggle}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-foreground">{e.name}</span>
          {installed && !justInstalled ? (
            <span className="text-xs text-ink-3">入れてあります</span>
          ) : null}
          {pulledInBy ? (
            <span className="text-xs text-primary">{pulledInBy.join("・")} に要るので一緒に入れます</span>
          ) : null}
        </span>
        <span className="text-xs leading-relaxed text-ink-3">{e.description}</span>
        {e.requires.length > 0 && !installed ? (
          <span className="text-xs text-ink-3">
            要るもの：{e.requires.map((d) => byId.get(d)?.name ?? d).join("・")}
          </span>
        ) : null}
      </span>
      <span className="mt-0.5 flex w-5 shrink-0 justify-end">
        {running ? <Loader2 className="size-4 animate-spin text-ink-3" /> : null}
        {justInstalled ? <Check className="size-4 text-ok" aria-label="入れました" /> : null}
        {result?.status === "failed" ? (
          <CircleAlert className="size-4 text-turn" aria-label="入れられませんでした" />
        ) : null}
      </span>
    </label>
  );
}

function PerConnectionRow({
  e,
  existingNames,
  onInstalled,
}: {
  e: RealCatalogEntry;
  existingNames: readonly string[];
  onInstalled(): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startAdding = () => {
    // **同じ名前が在れば、番号を足して出す**（人が考えなくてよい）
    const taken = new Set(existingNames);
    let next = e.suggestedName;
    for (let i = 2; taken.has(next); i += 1) next = `${e.suggestedName}-${i}`;
    setName(next);
    setError(null);
    setOpen(true);
  };
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5" data-testid={`add-module-bundled-${e.id}`}>
      <div className="flex items-start gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-foreground">{e.name}</span>
            {e.installed.length > 0 ? (
              <span className="text-xs text-ink-3">入れてあります：{e.installed.join("、")}</span>
            ) : null}
          </span>
          <span className="text-xs leading-relaxed text-ink-3">{e.description}</span>
        </span>
        {!open ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            data-testid={`add-module-bundled-${e.id}-add`}
            onClick={startAdding}
          >
            <Plus className="size-3.5" />
            {e.installed.length > 0 ? "もう1本" : "入れる"}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-ink-2">
              名前（設定画面と置き場は、この名前ごとに分かれます）
              <Input
                aria-label="名前"
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                className="h-8"
              />
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              やめる
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid={`add-module-bundled-${e.id}-submit`}
              disabled={busy || name.trim() === ""}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await installRealModuleFromCatalog(e.id, name.trim());
                  setOpen(false);
                  await onInstalled();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              入れる
            </Button>
          </div>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
