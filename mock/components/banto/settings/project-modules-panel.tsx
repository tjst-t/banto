"use client";

// **この Project で、AI が使える道具を選ぶ**（Phase 2 の入口、決定・2026-09-11）。
//
// 宣言は banto 全体の既定なので、Module を1本足すと**全 Project に繋がる**
// ——本数が増えるほど、使わない Project にも tool が載り、プロセスが増える。
// 増やす前に「この Project では何を使うか」を選べるようにする。
//
// ここで決めたいこと（モックで見るための3点）：
//   1. 繋がっているもの／繋げるものを、どう並べて見せるか
//   2. 繋ぐ・外すの因果が見えるか（tool が増える／減る・プロセスが立つ）
//   3. 依存（Shell は Vault が要る）と、全体で1本のもの（Vault）の見せ方
import { useState } from "react";
import { Boxes, Lock, Plus, Puzzle, Trash2, TriangleAlert } from "lucide-react";
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
import {
  getBreaksIfUnlinked,
  getLinkableModules,
  getMissingDependencies,
  getProjectModuleLinks,
  getRole,
  linkProjectModule,
  unlinkProjectModule,
} from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockModuleImplementation } from "@/lib/mock/types";

function roleName(roleId: string): string {
  return getRole(roleId)?.name ?? roleId;
}

/** AI から見える tool の数——「繋ぐと何が増えるか」はこれで数える */
function agentToolCount(impl: MockModuleImplementation): number {
  return impl.tools.filter((t) => t.visibility === "agent").length;
}

/** その Module が「どこに1本立つか」。閉じ込めの有無も、ここで一緒に示す */
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
            <Puzzle className="size-3" /> この Project に1本
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
  const linked = getProjectModuleLinks(projectId);
  const linkable = getLinkableModules(projectId);
  const [unlinkTarget, setUnlinkTarget] = useState<MockModuleImplementation | null>(null);
  const [linkTarget, setLinkTarget] = useState<MockModuleImplementation | null>(null);

  const missing = linkTarget ? getMissingDependencies(projectId, linkTarget) : [];
  const breaks = unlinkTarget ? getBreaksIfUnlinked(projectId, unlinkTarget) : [];

  function confirmLink() {
    if (!linkTarget) return;
    // **要るものは一緒に繋ぐ**——「繋いだのに動かない」を作らない
    for (const dep of missing) {
      if (dep.required && dep.candidates[0]) linkProjectModule(projectId, dep.candidates[0].id);
    }
    linkProjectModule(projectId, linkTarget.id);
    setLinkTarget(null);
  }

  function confirmUnlink() {
    if (!unlinkTarget) return;
    unlinkProjectModule(projectId, unlinkTarget.id);
    setUnlinkTarget(null);
  }

  return (
    <div>
      <h1 className="mb-0.5 text-lg font-semibold text-foreground">この Project の Module</h1>
      <p className="mb-4 text-xs text-ink-3">
        この Project の会話で AI が使える道具。外したものは消えない——他の Project では
        動いたままで、いつでも繋ぎ直せる。変更は次のターンから効く。
      </p>

      <div className="flex flex-col gap-2">
        {linked.map((impl) => {
          const deps = impl.dependsOn.filter((d) => d.required);
          return (
            <div
              key={impl.id}
              data-testid="linked-module"
              id={`anchor-project-impl-${impl.id}`}
              className="rounded-md border border-border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{impl.name}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {roleName(impl.roleId)}・
                    {agentToolCount(impl) > 0
                      ? `AI から使える tool ${agentToolCount(impl)} 個`
                      : "AI からは使わない（人が開く画面だけ）"}
                    {deps.length > 0
                      ? `・${deps.map((d) => roleName(d.role)).join("・")} が要る`
                      : ""}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs text-ink-3"
                  aria-label={`${impl.name} をこの Project から外す`}
                  onClick={() => setUnlinkTarget(impl)}
                >
                  <Trash2 className="size-3.5" /> 外す
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <ScopeBadges impl={impl} />
              </div>
            </div>
          );
        })}
        {linked.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-ink-3">
            この Project には Module が1つも繋がっていない——AI は会話しかできない
          </p>
        ) : null}
      </div>

      {linkable.length > 0 ? (
        <>
          <h2 className="mt-6 mb-0.5 text-sm font-semibold text-foreground">繋げる Module</h2>
          <p className="mb-2 text-xs text-ink-3">
            banto が知っている Module のうち、この Project では使っていないもの。
          </p>
          <div className="flex flex-col gap-1.5">
            {linkable.map((impl) => (
              <div
                key={impl.id}
                data-testid="linkable-module"
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">{impl.name}</p>
                  <p className="mt-0.5 text-xs text-ink-3">
                    {roleName(impl.roleId)}・
                    {agentToolCount(impl) > 0
                      ? `tool が ${agentToolCount(impl)} 個増える`
                      : "人が開く画面だけ（tool は増えない）"}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs"
                  onClick={() => setLinkTarget(impl)}
                >
                  <Plus className="size-3.5" /> 繋ぐ
                </Button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* 繋ぐ——要るものが繋がっていなければ、一緒に繋ぐことを先に言う */}
      <AlertDialog open={linkTarget !== null} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{linkTarget?.name} を繋ぎますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm text-ink-2">
                <p>
                  次のターンから、AI は {linkTarget ? agentToolCount(linkTarget) : 0} 個の tool を
                  使えるようになります。
                </p>
                <p className="text-xs text-ink-3">
                  {linkTarget?.scope === "instance"
                    ? "banto 全体で1つのものに繋ぎます（他の Project と同じものを共有）。"
                    : "この Project 用に1つ立ち上がります（他の Project とは別のプロセス）。"}
                </p>
                {missing.filter((d) => d.required).length > 0 ? (
                  <p className="rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
                    {missing
                      .filter((d) => d.required)
                      .map((d) => d.candidates[0]?.name ?? `${roleName(d.role)}（候補なし）`)
                      .join("・")}
                    も一緒に繋ぎます——これが無いと {linkTarget?.name} は動きません。
                  </p>
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLink}>繋ぐ</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 外す——何が使えなくなるかを、件数ではなく中身で出す */}
      <AlertDialog open={unlinkTarget !== null} onOpenChange={(o) => !o && setUnlinkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{unlinkTarget?.name} を外しますか</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-2 text-sm text-ink-2">
                <p>
                  次のターンから、AI は
                  {unlinkTarget
                    ? unlinkTarget.tools
                        .filter((t) => t.visibility === "agent")
                        .map((t) => t.name)
                        .join("・")
                    : ""}
                  を使えなくなります。
                </p>
                {breaks.length > 0 ? (
                  <p className="flex items-start gap-1.5 rounded-md bg-turn-soft px-2.5 py-2 text-xs text-foreground">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {breaks.map((b) => `「${b.name}」`).join("・")}
                      も動かなくなります——これが要ると言っているためです。
                    </span>
                  </p>
                ) : null}
                <p className="text-xs text-ink-3">
                  {unlinkTarget?.scope === "instance"
                    ? "banto 全体のものは止まりません——この Project から使わなくなるだけです。"
                    : "Module そのものは消えません。他の Project では動いたままで、いつでも繋ぎ直せます。"}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction onClick={confirmUnlink}>外す</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
