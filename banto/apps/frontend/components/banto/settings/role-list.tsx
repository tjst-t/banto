"use client";

// 階層1：banto 全体（instance level、§6.1）。中心は Module 一覧ではなく
// 役割（role）一覧——同じ役割の複数実装が辞書として共存してよいので。
// 役割ごとに、満たす実装・プロセス境界・無ければ何が断るか・Module 自身の
// 設定を表示する。
import { useState } from "react";
import { Box, ChevronRight, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { useRovingFocus } from "@/hooks/use-roving-focus";
import { cn } from "@/lib/utils";
import {
  getBreaksIfDisabled,
  getIsolationViolation,
  getRole,
  getRoles,
  removeImplementation,
} from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockModuleImplementation } from "@/lib/mock/types";
import { AddModuleDialog } from "./add-module-dialog";
import { DisableImpactDialog } from "./disable-impact-dialog";
import { EditModuleDialog } from "./edit-module-dialog";

/** 依存先の role を人が読める名前で出す（未知の role は id のまま） */
function roleName(roleId: string): string {
  return getRole(roleId)?.name ?? roleId;
}

export function RoleList() {
  useMockStoreVersion();
  const roles = getRoles();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(roles.map((r) => r.id)));
  const [enabled, setEnabled] = useState<ReadonlyMap<string, boolean>>(
    new Map(roles.flatMap((r) => r.implementations.map((i) => [i.id, i.enabled] as const))),
  );
  const [disableTarget, setDisableTarget] = useState<MockModuleImplementation | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MockModuleImplementation | null>(null);
  const [editTarget, setEditTarget] = useState<MockModuleImplementation | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { containerRef, onKeyDown } = useRovingFocus<HTMLDivElement>();

  function toggleExpanded(roleId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  // 「いまの有効/無効」は押した瞬間にストアへ書き戻さない（この画面のローカル
  // 状態）ので、無効化の影響を導出するときもこちらを見る
  const isEnabled = (impl: MockModuleImplementation) => enabled.get(impl.id) ?? impl.enabled;

  function requestToggle(impl: MockModuleImplementation, next: boolean) {
    // 無効化は「押す前に何が壊れるか」を見せてから確定する（§6.1）。
    // 有効化は壊すものが無いので、即座に切り替えてよい
    if (!next) setDisableTarget(impl);
    else setEnabled((prev) => new Map(prev).set(impl.id, true));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" /> Module を追加
        </Button>
      </div>

      <div ref={containerRef} onKeyDown={onKeyDown} className="flex flex-col gap-3">
        {roles.map((role) => (
          <div key={role.id} id={`anchor-role-${role.id}`} className="rounded-lg border border-border">
            <button
              type="button"
              data-roving-item
              onClick={() => toggleExpanded(role.id)}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
            >
              <ChevronRight
                className={cn(
                  "size-4 shrink-0 text-ink-3 transition-transform",
                  expanded.has(role.id) && "rotate-90",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{role.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {role.implementations.length} 実装
                  </Badge>
                </span>
                <span className="mt-0.5 block text-xs text-ink-3">{role.description}</span>
              </span>
            </button>

            {expanded.has(role.id) ? (
              <div className="border-t border-border px-3 py-2">
                {role.implementations.length === 0 ? (
                  <p className="py-2 text-xs text-ink-3">この role の実装はまだ無い</p>
                ) : (
                  role.implementations.map((impl) => {
                    const implEnabled = isEnabled(impl);
                    return (
                      <div
                        key={impl.id}
                        id={`anchor-impl-${impl.id}`}
                        className="flex items-center justify-between gap-3 rounded-md border-b border-border py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">{impl.name}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                            <Badge variant="outline" className="gap-1 text-xs">
                              {impl.isolation}
                            </Badge>
                            {impl.builtin ? (
                              <Badge variant="outline" className="gap-1 text-xs">
                                <Box className="size-3" />
                                組み込み
                              </Badge>
                            ) : null}
                            {impl.handlesSecrets ? (
                              <Badge variant="outline" className="gap-1 text-xs">
                                <KeyRound className="size-3" />
                                秘匿情報を扱う
                              </Badge>
                            ) : null}
                            <span>·</span>
                            <span className={implEnabled ? undefined : "text-turn"}>
                              {implEnabled ? "有効" : "無効"}
                            </span>
                          </div>
                          {impl.dependsOn.length > 0 ? (
                            <p className="mt-1 text-xs text-ink-3">
                              依存：
                              {impl.dependsOn
                                .map((d) => `${roleName(d.role)}（${d.required ? "必須" : "任意"}）`)
                                .join("、")}
                            </p>
                          ) : null}
                          {impl.tools.length > 0 ? (
                            <p className="mt-1 truncate text-xs text-ink-3">
                              tool：{impl.tools.map((t) => `${t.name}（${t.visibility}）`).join("、")}
                            </p>
                          ) : null}
                          {getIsolationViolation(impl) ? (
                            <p className="mt-1 text-xs text-stop">
                              起動できない——{getIsolationViolation(impl)}
                            </p>
                          ) : null}
                          {!implEnabled ? (
                            <p className="mt-1 text-xs text-turn">
                              {getBreaksIfDisabled(impl, isEnabled).length > 0
                                ? `無効化中——「${getBreaksIfDisabled(impl, isEnabled).join("」「")}」が動かなくなります`
                                : "無効化中——これを必須として依存している Module は無い"}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Switch
                            checked={implEnabled}
                            onCheckedChange={(next) => requestToggle(impl, next)}
                            aria-label={`${impl.name} を${implEnabled ? "無効化" : "有効化"}`}
                          />
                          {!impl.builtin ? (
                            <button
                              type="button"
                              aria-label={`${impl.name} の設定を変える`}
                              onClick={() => setEditTarget(impl)}
                              className="flex size-7 items-center justify-center rounded text-ink-3 hover:bg-accent"
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          ) : null}
                          {!impl.builtin ? (
                            <button
                              type="button"
                              aria-label={`${impl.name} を削除`}
                              onClick={() => setRemoveTarget(impl)}
                              className="flex size-7 items-center justify-center rounded text-ink-3 hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <DisableImpactDialog
        open={disableTarget !== null}
        onOpenChange={(o) => !o && setDisableTarget(null)}
        targetName={disableTarget?.name ?? ""}
        breaks={disableTarget ? getBreaksIfDisabled(disableTarget, isEnabled) : []}
        onConfirm={() => {
          if (!disableTarget) return;
          setEnabled((prev) => new Map(prev).set(disableTarget.id, false));
          setDisableTarget(null);
        }}
      />

      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{removeTarget?.name} を削除しますか</AlertDialogTitle>
            <AlertDialogDescription>
              instance の一覧から取り除く——繋いでいる Project があれば、そちらの接続も外れる。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removeTarget) removeImplementation(removeTarget.id);
                setRemoveTarget(null);
              }}
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddModuleDialog open={addOpen} onOpenChange={setAddOpen} />
      <EditModuleDialog
        implementation={editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      />
    </div>
  );
}
