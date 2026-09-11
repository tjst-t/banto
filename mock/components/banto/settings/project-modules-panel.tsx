"use client";

// **この Project で、AI が使える道具を選ぶ**（Phase 2 の入口、決定・2026-09-11）。
//
// 宣言は banto 全体の既定なので、Module を1本足すと**全 Project に繋がる**
// ——本数が増えるほど、使わない Project にも tool が載り、プロセスが増える。
// 増やす前に「この Project では何を使うか」を選べるようにする。
//
// **その場で繋いだり外したりして、最後に保存する**（改訂・2026-09-11、ユーザー要望
// ——1つ動かすたびに確認が出るのは煩わしい）。確認は**保存のときに1回**、
// 何がどう変わるかを**差分で**見せる。繋ぎ変えは Module のプロセスを立てたり
// 落としたりするので、「押した瞬間に効く」より「まとめて効かせる」ほうが実態に近い。
import { useMemo, useState } from "react";
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
import {
  getAllImplementations,
  getProjectModuleLinks,
  getRole,
  setProjectModuleLinks,
} from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockModuleImplementation } from "@/lib/mock/types";

function roleName(roleId: string): string {
  return getRole(roleId)?.name ?? roleId;
}

/** AI から見える tool——「繋ぐと何が増えるか」はこれで数える */
function agentTools(impl: MockModuleImplementation): readonly string[] {
  return impl.tools.filter((t) => t.visibility === "agent").map((t) => t.name);
}

function ScopeBadges({ impl }: { impl: MockModuleImplementation }) {
  return (
    <>
      <Badge variant="outline" className="gap-1 text-xs font-normal">
        {impl.scope === "instance" ? (
          <>
            <Boxes className="size-3" /> banto 全体で1本
          </>
        ) : (
          <>
            <Plus className="size-3 rotate-45" /> この Project に1本
          </>
        )}
      </Badge>
      {impl.confinement === "landlock" ? (
        <Badge variant="outline" className="gap-1 text-xs font-normal">
          <Lock className="size-3" /> Project の外は読めない
        </Badge>
      ) : null}
    </>
  );
}

export function ProjectModulesPanel({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const saved = getProjectModuleLinks(projectId);
  const all = getAllImplementations();

  // **手元の下書き**——保存するまで、繋ぎ変えはここにだけある
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(saved.map((i) => i.id)));
  const [confirming, setConfirming] = useState(false);

  const savedIds = useMemo(() => new Set(saved.map((i) => i.id)), [saved]);
  const added = all.filter((i) => draft.has(i.id) && !savedIds.has(i.id));
  const removed = all.filter((i) => !draft.has(i.id) && savedIds.has(i.id));
  const dirty = added.length + removed.length > 0;

  /** 下書きの中で、その役割を満たすものが居るか */
  function roleInDraft(roleId: string): boolean {
    return all.some((i) => draft.has(i.id) && i.roleId === roleId);
  }

  /** 要るのに繋がっていない依存（下書きの上で見る） */
  function missingDeps(impl: MockModuleImplementation): readonly string[] {
    return impl.dependsOn.filter((d) => d.required && !roleInDraft(d.role)).map((d) => roleName(d.role));
  }

  function link(impl: MockModuleImplementation) {
    setDraft((prev) => {
      const next = new Set(prev);
      next.add(impl.id);
      // **要るものは黙って一緒に足す**（確認は保存のときに1回）。
      // 足したことは下書きの差分に出るので、要らなければその場で外せる
      for (const dep of impl.dependsOn) {
        if (!dep.required) continue;
        if (all.some((i) => next.has(i.id) && i.roleId === dep.role)) continue;
        const candidate = all.find((i) => i.roleId === dep.role && i.enabled);
        if (candidate) next.add(candidate.id);
      }
      return next;
    });
  }

  function unlink(impl: MockModuleImplementation) {
    setDraft((prev) => {
      const next = new Set(prev);
      next.delete(impl.id);
      return next;
    });
  }

  function toggle(impl: MockModuleImplementation) {
    if (draft.has(impl.id)) unlink(impl);
    else link(impl);
  }

  function discard() {
    setDraft(new Set(saved.map((i) => i.id)));
  }

  function save() {
    setProjectModuleLinks(projectId, [...draft]);
    setConfirming(false);
  }

  /** 保存したら動かなくなるもの（要る役割が下書きから消えている） */
  const breaking = all.filter(
    (i) => draft.has(i.id) && i.dependsOn.some((d) => d.required && !roleInDraft(d.role)),
  );

  function Row({ impl }: { impl: MockModuleImplementation }) {
    const on = draft.has(impl.id);
    const isAdded = on && !savedIds.has(impl.id);
    const isRemoved = !on && savedIds.has(impl.id);
    const missing = on ? missingDeps(impl) : [];
    const tools = agentTools(impl);
    return (
      <div
        data-testid="module-row"
        data-state={isAdded ? "added" : isRemoved ? "removed" : on ? "linked" : "off"}
        id={`anchor-project-impl-${impl.id}`}
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
              {impl.name}
            </p>
            <p className="mt-0.5 text-xs text-ink-3">
              {roleName(impl.roleId)}・
              {tools.length > 0
                ? `AI から使える tool ${tools.length} 個`
                : "AI からは使わない（人が開く画面だけ）"}
              {impl.dependsOn.filter((d) => d.required).length > 0
                ? `・${impl.dependsOn
                    .filter((d) => d.required)
                    .map((d) => roleName(d.role))
                    .join("・")} が要る`
                : ""}
            </p>
          </div>
          <Button
            variant={on ? "ghost" : "outline"}
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            aria-label={on ? `${impl.name} を外す` : `${impl.name} を繋ぐ`}
            onClick={() => toggle(impl)}
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
          <ScopeBadges impl={impl} />
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

  const onRows = all.filter((i) => draft.has(i.id) || savedIds.has(i.id));
  const offRows = all.filter((i) => !draft.has(i.id) && !savedIds.has(i.id));

  return (
    <div className="pb-20">
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">この Project の Module</h1>
      <p className="mb-4 text-xs text-ink-3">
        この Project の会話で AI が使える道具。繋ぐ・外すはその場で選んで、最後に保存する
        ——保存するまで会話には効かない。外しても Module は消えない（他の Project では動いたまま）。
      </p>

      <div className="flex flex-col gap-2">
        {onRows.map((impl) => (
          <Row key={impl.id} impl={impl} />
        ))}
      </div>

      {offRows.length > 0 ? (
        <>
          <h2 className="mt-6 mb-0.5 text-sm font-semibold text-foreground">繋げる Module</h2>
          <p className="mb-2 text-xs text-ink-3">
            banto が知っている Module のうち、この Project では使っていないもの。
          </p>
          <div className="flex flex-col gap-2">
            {offRows.map((impl) => (
              <Row key={impl.id} impl={impl} />
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
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={discard}>
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
                  {added.map((impl) => (
                    <li key={impl.id} className="flex items-start gap-2">
                      <Plus className="mt-0.5 size-3.5 shrink-0 text-accent-ink" />
                      <span>
                        <span className="text-foreground">{impl.name}</span> を繋ぐ
                        <span className="block text-xs text-ink-3">
                          {agentTools(impl).length > 0
                            ? `${agentTools(impl).join("・")} が使えるようになる`
                            : "人が開く画面が増える（tool は増えない）"}
                          {impl.scope === "instance"
                            ? "・banto 全体の1本に繋ぐ"
                            : "・この Project 用に1つ立ち上がる"}
                        </span>
                      </span>
                    </li>
                  ))}
                  {removed.map((impl) => (
                    <li key={impl.id} className="flex items-start gap-2">
                      <Minus className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                      <span>
                        <span className="text-foreground">{impl.name}</span> を外す
                        <span className="block text-xs text-ink-3">
                          {agentTools(impl).length > 0
                            ? `${agentTools(impl).join("・")} が使えなくなる`
                            : "人が開く画面が減る"}
                          {impl.scope === "instance"
                            ? "・banto 全体のものは止まらない（この Project から使わなくなるだけ）"
                            : "・この Project 用の1つが落ちる"}
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
            <AlertDialogAction onClick={save}>保存する</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
