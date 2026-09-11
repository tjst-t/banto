"use client";

// **この Project で、AI が使える道具を選ぶ**（`phase1-project-modules-ui`、
// 2026-09-11。形はモックで決めた——`docs/specs/v4-frontend.md` §6.15）。
//
// 宣言は banto 全体の既定なので、Module を1本足すと**全 Project に繋がる**
// ——本数が増えるほど、使わない Project にも tool が載り、プロセスが増える。
// 増やす前に「この Project では何を使うか」を選べるようにする（Phase 2 の入口）。
//
// **その場で繋いだり外したりして、最後に保存する。** 押すたびに確認を出さない
// ——確認は保存のときに1回、何がどう変わるかを差分で見せる。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Lock, Minus, Plus, RotateCcw, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describeFailure, reportFailure } from "@/lib/report-failure";
import { getProject } from "@/lib/mock/projects";
import {
  WideRootWarning,
  useRootScope,
} from "@/components/banto/settings/wide-root-warning";
import {
  listRealProjectModules,
  setRealProjectModules,
  type RealProjectModule,
} from "@/lib/backend/client";

function ScopeBadges({ module: mod }: { module: RealProjectModule }) {
  return (
    <>
      <Badge variant="outline" className="gap-1 text-xs font-normal">
        {mod.scope === "instance" ? (
          <>
            <Boxes className="size-3" /> banto 全体で1本
          </>
        ) : (
          <>
            <Plus className="size-3 rotate-45" /> この Project に1本
          </>
        )}
      </Badge>
      {mod.confinement ? (
        <Badge variant="outline" className="gap-1 text-xs font-normal">
          <Lock className="size-3" /> Project の外は読めない
        </Badge>
      ) : null}
    </>
  );
}

export function ProjectModulesPanel({ projectId }: { projectId: string }) {
  // **この Project の根が広いなら、ここでも言う**（決定・2026-09-11、ユーザー）
  // ——閉じ込める Module（shell・filesystem）を使う場所だから
  const rootScope = useRootScope(getProject(projectId).basePath);
  const [modules, setModules] = useState<RealProjectModule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // **手元の下書き**——保存するまで、繋ぎ変えはここにだけある
  const [draft, setDraft] = useState<ReadonlySet<string> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    listRealProjectModules(projectId)
      .then((list) => {
        setLoadError(null);
        setModules(list);
        setDraft(new Set(list.filter((m) => m.selected).map((m) => m.name)));
      })
      .catch((err: unknown) => {
        // **読めなかったことを、画面に出す**（規則2——空の一覧に見せない）
        setLoadError(describeFailure(err));
        setModules([]);
      });
  }, [projectId]);
  useEffect(load, [load]);

  const savedNames = useMemo(
    () => new Set((modules ?? []).filter((m) => m.selected).map((m) => m.name)),
    [modules],
  );
  const added = (modules ?? []).filter((m) => draft?.has(m.name) && !savedNames.has(m.name));
  const removed = (modules ?? []).filter((m) => !draft?.has(m.name) && savedNames.has(m.name));
  const dirty = added.length + removed.length > 0;

  function roleInDraft(role: string): boolean {
    return (modules ?? []).some((m) => draft?.has(m.name) && m.satisfies.includes(role));
  }

  /** 要るのに繋がっていない依存（下書きの上で見る） */
  function missingDeps(mod: RealProjectModule): string[] {
    return mod.dependsOn.filter((d) => d.required && !roleInDraft(d.role)).map((d) => d.role);
  }

  function toggle(mod: RealProjectModule) {
    setDraft((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(mod.name)) {
        next.delete(mod.name);
        return next;
      }
      next.add(mod.name);
      // **要るものは黙って一緒に足す**（確認は保存のとき）。足したことは差分に
      // 出るので、要らなければその場で外せる
      for (const dep of mod.dependsOn) {
        if (!dep.required) continue;
        if ((modules ?? []).some((m) => next.has(m.name) && m.satisfies.includes(dep.role))) continue;
        const candidate = (modules ?? []).find((m) => m.satisfies.includes(dep.role));
        if (candidate) next.add(candidate.name);
      }
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await setRealProjectModules(projectId, [...draft]);
      setConfirming(false);
      load();
    } catch (err) {
      reportFailure("Module の選択を保存できませんでした", err);
    } finally {
      setSaving(false);
    }
  }

  /** 保存したら動かなくなるもの（要る役割が下書きから消えている） */
  const breaking = (modules ?? []).filter(
    (m) => draft?.has(m.name) && missingDeps(m).length > 0,
  );

  if (modules === null) {
    return <p className="text-xs text-ink-3">読み込んでいます…</p>;
  }

  function Row({ module: mod }: { module: RealProjectModule }) {
    const on = draft?.has(mod.name) ?? false;
    const isAdded = on && !savedNames.has(mod.name);
    const isRemoved = !on && savedNames.has(mod.name);
    const missing = on ? missingDeps(mod) : [];
    const requires = mod.dependsOn.filter((d) => d.required).map((d) => d.role);
    return (
      <div
        data-testid="module-row"
        data-module={mod.name}
        data-state={isAdded ? "added" : isRemoved ? "removed" : on ? "linked" : "off"}
        className={cn(
          "rounded-md border p-3",
          on ? "border-border" : "border-dashed border-border bg-surface-2/40",
          isAdded && "border-accent",
          isRemoved && "border-turn",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={cn("truncate text-sm font-medium", on ? "text-foreground" : "text-ink-3")}>
              {mod.name}
            </p>
            <p className="mt-0.5 text-xs text-ink-3">
              {mod.satisfies.join("・")}
              {requires.length > 0 ? `・${requires.join("・")} が要る` : ""}
            </p>
          </div>
          <Button
            variant={on ? "ghost" : "outline"}
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            aria-label={on ? `${mod.name} を外す` : `${mod.name} を繋ぐ`}
            onClick={() => toggle(mod)}
          >
            {on ? (
              <>
                <Minus className="size-3.5" /> 外す
              </>
            ) : (
              <>
                <Plus className="size-3.5" /> 繋ぐ
              </>
            )}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ScopeBadges module={mod} />
          {isAdded ? (
            <Badge className="bg-accent-soft text-xs font-normal text-accent-ink">繋ぐ（未保存）</Badge>
          ) : null}
          {isRemoved ? (
            <Badge className="bg-turn-soft text-xs font-normal text-foreground">外す（未保存）</Badge>
          ) : null}
        </div>
        {missing.length > 0 ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-turn-soft px-2.5 py-1.5 text-xs text-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{missing.join("・")} が繋がっていないので、このままでは動きません</span>
          </p>
        ) : null}
      </div>
    );
  }

  const onRows = modules.filter((m) => draft?.has(m.name) || savedNames.has(m.name));
  const offRows = modules.filter((m) => !draft?.has(m.name) && !savedNames.has(m.name));

  return (
    <div className="pb-20">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">この Project の Module</h1>
      <p className="mb-4 text-xs text-ink-3">
        この Project の会話で AI が使える道具。繋ぐ・外すはその場で選んで、最後に保存する
        ——保存するまで会話には効かない。外しても Module は消えない（他の Project では動いたまま）。
      </p>

      <div className="mb-3 empty:mb-0">
        <WideRootWarning scope={rootScope} />
      </div>

      {loadError ? (
        <div
          data-testid="project-modules-error"
          className="mb-3 flex flex-col items-start gap-2 rounded-md border border-border p-3"
        >
          <p className="text-sm text-foreground">Module の一覧を読めませんでした</p>
          <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={load}>
            もう一度読み込む
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {onRows.map((mod) => (
          <Row key={mod.name} module={mod} />
        ))}
        {onRows.length === 0 && !loadError ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
            この Project には Module が1つも繋がっていない——AI は会話しかできない
          </p>
        ) : null}
      </div>

      {offRows.length > 0 ? (
        <>
          <h2 className="mt-6 mb-0.5 text-sm font-semibold text-foreground">繋げる Module</h2>
          <p className="mb-2 text-xs text-ink-3">
            banto が知っている Module のうち、この Project では使っていないもの。
          </p>
          <div className="flex flex-col gap-2">
            {offRows.map((mod) => (
              <Row key={mod.name} module={mod} />
            ))}
          </div>
        </>
      ) : null}

      {/* **変えている間だけ出る帯**——何件変えたかと、保存／捨てる */}
      {dirty ? (
        <div
          data-testid="module-draft-bar"
          className="sticky bottom-0 -mx-1 mt-4 flex items-center justify-between gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
        >
          <p className="text-xs text-ink-2">
            未保存の変更 {added.length + removed.length} 件
            {added.length > 0 ? `（繋ぐ ${added.length}）` : ""}
            {removed.length > 0 ? `（外す ${removed.length}）` : ""}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setDraft(new Set(savedNames))}
            >
              <RotateCcw className="size-3.5" /> 捨てる
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={() => setConfirming(true)}>
              保存する
            </Button>
          </div>
        </div>
      ) : null}

      {/* 保存——**変わるものを差分で**見せてから確定する */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="module-save-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>この Project の Module を変えますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm text-ink-2">
                <ul className="flex flex-col gap-1.5">
                  {added.map((mod) => (
                    <li key={mod.name} className="flex items-start gap-2">
                      <Plus className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
                      <span>
                        <span className="text-foreground">{mod.name}</span> を繋ぐ
                        <span className="block text-xs text-ink-3">
                          {mod.satisfies.join("・")}の道具が使えるようになる・
                          {mod.scope === "instance"
                            ? "banto 全体の1本に繋ぐ"
                            : "この Project 用に1つ立ち上がる"}
                        </span>
                      </span>
                    </li>
                  ))}
                  {removed.map((mod) => (
                    <li key={mod.name} className="flex items-start gap-2">
                      <Minus className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                      <span>
                        <span className="text-foreground">{mod.name}</span> を外す
                        <span className="block text-xs text-ink-3">
                          {mod.satisfies.join("・")}の道具が使えなくなる・
                          {mod.scope === "instance"
                            ? "banto 全体のものは止まらない（この Project から使わなくなるだけ）"
                            : "この Project 用の1つが落ちる"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {breaking.length > 0 ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {breaking.map((b) => `「${b.name}」`).join("・")}
                      は、要るものが繋がっていないので動きません。
                    </span>
                  </p>
                ) : null}
                <p className="text-xs text-ink-3">変更は次のターンから効きます。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={(e) => {
              e.preventDefault();
              void save();
            }}>
              {saving ? "保存しています…" : "保存する"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
