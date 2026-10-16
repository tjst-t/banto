"use client";

// **Project を眠らせる**（決定・2026-10-16、v4-frontend.md §6.43「スリープ」）。行の「…」の「スリープにする」・
// 「スリープ中」へのドラッグ・グループの見出しの「中の Project を全部スリープに」が同じ手順を通る（規則3）：
//
//   1. 止まるもの（`sleep-preview`）を聞く。眠らせられない理由（AI が動いている・裏の仕事が残っている・移している）が
//      あれば、その理由をそのまま知らせて眠らせない
//   2. 止まるもの（動いている Service・公開中のもの・Terminal のセッション）があれば小窓で並べて確かめる。無ければすぐ眠る
//   3. 眠らせる。確かめてから押すまでの間に断られたら（ターンが始まった等）、その理由をそのまま知らせる
//
// 断られた理由は Project ごとに1行ずつ（黙らない、規則2）。
//
// 出来事を待たれている Module（`keeps`）は止まらないので、確かめの小窓に「〈Module〉は自動化のため止めません」を足す。
// Service の Module が待たれていれば（`servicesKept`）Service と公開中の URL は止まらないので、その文は出さない（§6.43）。
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import { getRealSleepPreview, ProjectSleepRefusedError } from "@/lib/backend/client";
import { sleepProject } from "@/lib/mock/projects";
import type { MockProject } from "@/lib/mock/types";
import { describeFailure } from "@/lib/report-failure";

interface Stop {
  project: MockProject;
  labels: string[];
  /** 自動化のため止めない Module の名前 */
  keeps: string[];
  servicesKept: boolean;
}

function refused(project: MockProject, reasons: readonly string[]) {
  toast(`「${project.name}」をスリープにできませんでした：${reasons.join("／")}`, { id: `sleep-refused-${project.id}` });
}

async function sleepNow(project: MockProject): Promise<void> {
  try {
    await sleepProject(project.id);
  } catch (err) {
    if (err instanceof ProjectSleepRefusedError) refused(project, err.reasons);
    else toast(`「${project.name}」をスリープにできませんでした：${describeFailure(err)}`, { id: `sleep-refused-${project.id}` });
  }
}

/**
 * `requestSleep(projects)`：上の手順で眠らせる（1件でも、グループの中の全部でも）。`dialog` は呼ぶ側が描く
 */
export function useSleepProjects(): { requestSleep: (projects: readonly MockProject[]) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ stops: Stop[]; sleep: MockProject[] } | null>(null);

  async function requestSleep(projects: readonly MockProject[]) {
    const checked = await Promise.all(
      projects.map(async (project) => {
        try {
          return { project, preview: await getRealSleepPreview(project.id) };
        } catch (err) {
          toast(`「${project.name}」をスリープにできませんでした：${describeFailure(err)}`, { id: `sleep-refused-${project.id}` });
          return null;
        }
      }),
    );
    const sleep: MockProject[] = [];
    const stops: Stop[] = [];
    for (const c of checked) {
      if (!c) continue;
      if (c.preview.blockers.length > 0) {
        refused(c.project, c.preview.blockers);
        continue;
      }
      sleep.push(c.project);
      if (c.preview.stops.length > 0) {
        stops.push({
          project: c.project,
          labels: c.preview.stops.map((s) => s.label),
          keeps: c.preview.keeps.map((k) => k.module),
          servicesKept: c.preview.servicesKept,
        });
      }
    }
    if (sleep.length === 0) return;
    if (stops.length === 0) {
      await Promise.all(sleep.map(sleepNow));
      return;
    }
    setPending({ stops, sleep });
  }

  const many = (pending?.sleep.length ?? 0) > 1;
  // Service が止まる Project が1つでもあれば、止まることの説明を出す
  const servicesStop = pending?.stops.some((s) => !s.servicesKept) ?? false;
  const dialog = (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
      <AlertDialogContent data-testid="sleep-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {many ? `${pending?.sleep.length} 件の Project をスリープにしますか` : `「${pending?.sleep[0]?.name}」をスリープにしますか`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {servicesStop ? "眠っている間は止まります。公開中の URL には届きません。起こすと Service はまた動きます" : "眠っている間は止まります"}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-64 space-y-1 overflow-y-auto text-sm text-ink-2" data-testid="sleep-confirm-stops">
          {pending?.stops.flatMap(({ project, labels }) =>
            labels.map((label, i) => (
              <li key={`${project.id}-${i}`} className="truncate">
                {many ? <span className="text-ink-3">{project.name}：</span> : null}
                {label}
              </li>
            )),
          )}
        </ul>
        {pending?.stops.some((s) => s.keeps.length > 0) ? (
          <ul className="space-y-1 text-sm text-ink-3" data-testid="sleep-confirm-keeps">
            {pending.stops.flatMap(({ project, keeps }) =>
              keeps.map((module) => (
                <li key={`${project.id}-${module}`} className="truncate">
                  {many ? <span>{project.name}：</span> : null}
                  {module}は自動化のため止めません
                </li>
              )),
            )}
          </ul>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>やめる</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              const targets = pending?.sleep ?? [];
              setPending(null);
              void Promise.all(targets.map(sleepNow));
            }}
          >
            スリープにする
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { requestSleep: (projects) => void requestSleep(projects), dialog };
}
