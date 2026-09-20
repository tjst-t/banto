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
import { Minus, Plus, RotateCcw, TriangleAlert } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
    return <p className="text-xs text-ink-3">読み込み中…</p>;
  }

  /**
   * **テーブルの1行**（改訂・2026-09-18、ユーザー要望）。
   *
   * 以前は1件ずつの箱に札を4〜5個並べていた。**同じ語が縦に繰り返される**ので、
   * 列にして見出しを1回だけ出す形にした（banto 全体の一覧と同じ作り）。
   *
   * **下書き＋保存の仕組みはそのまま**——押すたびに確認は出さず、
   * 最後に差分で見せる（`v4-frontend.md` §6.15）。
   */
  function Row({ module: mod }: { module: RealProjectModule }) {
    const on = draft?.has(mod.name) ?? false;
    const isAdded = on && !savedNames.has(mod.name);
    const isRemoved = !on && savedNames.has(mod.name);
    const missing = on ? missingDeps(mod) : [];
    const requires = mod.dependsOn.filter((d) => d.required).map((d) => d.role);
    return (
      <tr
        data-testid="module-row"
        data-module={mod.name}
        data-state={isAdded ? "added" : isRemoved ? "removed" : on ? "linked" : "off"}
        className={cn(
          "align-middle",
          isAdded && "bg-accent-soft/40",
          isRemoved && "bg-turn-soft/40",
          !on && !isRemoved && "text-ink-3",
        )}
      >
        <td className="px-3 py-2">
          <span className={cn("font-medium", on ? "text-foreground" : "text-ink-3")}>{mod.name}</span>
          {/* **未保存の変更は、その行で分かる**（帯の件数と対になる） */}
          {isAdded ? <span className="ml-1.5 text-xs text-accent-ink">有効にする（未保存）</span> : null}
          {isRemoved ? <span className="ml-1.5 text-xs text-foreground">無効にする（未保存）</span> : null}
        </td>
        <td className="px-3 py-2 whitespace-nowrap text-ink-3">{mod.satisfies.join("・") || "—"}</td>
        <td className="px-3 py-2 text-ink-3">
          {mod.scope === "instance" ? "Global" : "Project ごと"}
        </td>
        <td className="px-3 py-2 text-ink-3">{mod.confinement ? "Project" : "—"}</td>
        <td className="px-3 py-2">
          {missing.length > 0 ? (
            // **繋いだのに動かないものは、その場で言う**（保存前に気付ける）
            <span className="flex items-center gap-1 text-danger">
              <TriangleAlert className="size-3.5 shrink-0" />
              {missing.join("・")} が無効です
            </span>
          ) : requires.length > 0 ? (
            <span className="text-ink-3">{requires.join("・")}</span>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </td>
        <td className="px-3 py-2">
          {/* **入り切りはトグルで**（改訂・2026-09-19、ユーザー要望）
              ——banto 全体の面と同じ部品にする。押しても**その場では効かない**のは
              これまでどおり（効くのは保存のとき） */}
          <div className="flex justify-end">
            <Switch
              checked={on}
              aria-label={on ? `${mod.name} を無効にする` : `${mod.name} を有効にする`}
              onCheckedChange={() => toggle(mod)}
            />
          </div>
        </td>
      </tr>
    );
  }

  // **並び順は役割で固定する**（改訂・2026-09-19）。以前は「繋いでいる／いない」で
  // 分けていたので、**トグルを押した行がその場で飛んでいた**（押した先が別の行に
  // なる）。banto 全体の面と同じ規則にして、下書きでは動かさない。
  const rows = [...modules].sort(
    (a, b) =>
      (a.satisfies[0] ?? "\uffff").localeCompare(b.satisfies[0] ?? "\uffff") ||
      a.name.localeCompare(b.name),
  );

  return (
    <div className="pb-20">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">この Project の Module</h1>
      <p className="mb-4 text-xs text-ink-3">
        この Project の会話で AI が使える Module を選びます。<strong>変更は保存するまで反映されません</strong>。
        無効にしても Module は削除されません（他の Project では動いたままです）。
      </p>

      <div className="mb-3 empty:mb-0">
        <WideRootWarning scope={rootScope} />
      </div>

      {loadError ? (
        <div
          data-testid="project-modules-error"
          className="mb-3 flex flex-col items-start gap-2 rounded-md border border-border p-3"
        >
          <p className="text-sm text-foreground">Module の一覧を取得できませんでした</p>
          <p className="max-w-md text-xs break-all text-ink-3">{loadError}</p>
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={load}>
            再読み込み
          </Button>
        </div>
      ) : null}

      {/* **1枚のテーブルにまとめる**（改訂・2026-09-18、ユーザー要望）。
          繋いでいるものを上、繋いでいないものを下に並べる——見出しを2回出さず、
          **同じ列で比べられる**ようにする */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-ink-3">
              <th className="px-3 py-2 font-medium whitespace-nowrap">Module</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">役割</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">実行場所</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">サンドボックス</th>
              <th className="px-3 py-2 font-medium whitespace-nowrap">依存</th>
              <th className="px-3 py-2 text-right font-medium whitespace-nowrap">有効</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((mod) => (
              <Row key={mod.name} module={mod} />
            ))}
          </tbody>
        </table>
      </div>

      {modules.length === 0 && !loadError ? (
        <p className="mt-2 rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
          利用できる Module がありません
        </p>
      ) : null}
      {(draft?.size ?? 0) === 0 && modules.length > 0 && !loadError ? (
        <p className="mt-2 text-xs text-ink-3">
          この Project では Module が1つも有効になっていません（AI は会話のみ可能です）
        </p>
      ) : null}

      {/* **変えている間だけ出る帯**——何件変えたかと、保存／捨てる */}
      {dirty ? (
        <div
          data-testid="module-draft-bar"
          className="sticky bottom-0 -mx-1 mt-4 flex items-center justify-between gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
        >
          <p className="text-xs text-ink-2">
            未保存の変更 {added.length + removed.length} 件
            {added.length > 0 ? `（有効 ${added.length}）` : ""}
            {removed.length > 0 ? `（無効 ${removed.length}）` : ""}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => setDraft(new Set(savedNames))}
            >
              <RotateCcw className="size-3.5" /> 取り消す
            </Button>
            <Button size="sm" className="h-7 px-3 text-xs" onClick={() => setConfirming(true)}>
              保存
            </Button>
          </div>
        </div>
      ) : null}

      {/* 保存——**変わるものを差分で**見せてから確定する */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="module-save-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Module の設定を保存しますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm text-ink-2">
                <ul className="flex flex-col gap-1.5">
                  {added.map((mod) => (
                    <li key={mod.name} className="flex items-start gap-2">
                      <Plus className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
                      <span>
                        <span className="text-foreground">{mod.name}</span> を有効にする
                        <span className="block text-xs text-ink-3">
                          {mod.satisfies.length > 0 ? `${mod.satisfies.join("・")} の機能が使えるようになります・` : ""}
                          {mod.scope === "instance"
                            ? "Global の1本を共有します"
                            : "この Project 専用のプロセスが起動します"}
                        </span>
                      </span>
                    </li>
                  ))}
                  {removed.map((mod) => (
                    <li key={mod.name} className="flex items-start gap-2">
                      <Minus className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                      <span>
                        <span className="text-foreground">{mod.name}</span> を無効にする
                        <span className="block text-xs text-ink-3">
                          {mod.satisfies.length > 0 ? `${mod.satisfies.join("・")} の機能が使えなくなります・` : ""}
                          {mod.scope === "instance"
                            ? "Global の Module は停止しません（この Project から使わなくなるだけです）"
                            : "この Project 専用のプロセスが停止します"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                {breaking.length > 0 ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {breaking.map((b) => b.name).join("・")}
                      は、依存している Module が無効なため動作しません。
                    </span>
                  </p>
                ) : null}
                <p className="text-xs text-ink-3">変更は次の会話のターンから反映されます。</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>キャンセル</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={(e) => {
              e.preventDefault();
              void save();
            }}>
              {saving ? "保存中…" : "保存"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
