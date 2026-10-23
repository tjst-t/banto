"use client";

// メタ Project（v4-architecture.md §4.6）自身の設定——複数の管理対象 Project を
// 横断してオーケストレーションする特別な Project だけが持つ、カスケードの
// 上書きとは別の正式な設定（§6.1 とは別の階層）。
//
// レビュー指摘（決定・2026-10-23）で、Backlog のバックエンドと release の扱いは
// どちらも「使うことを強制しない、メタ Project ごとに選べる」形にした——この
// パネルはその選び方を固める最初のモック。専用 Fork を実際に作る操作はまだ無い
// （「作る前にモックで考える」段階、v4-architecture.md §4.6「まだ決めていないこと」）。
import { GitBranch, Network, Rocket } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  getManageableProjects,
  getMetaProjectSettings,
  setMetaProjectSettings,
} from "@/lib/mock/meta-project";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockBacklogBackendKind, MockReleasePolicy } from "@/lib/mock/types";

const BACKLOG_BACKEND_LABEL: Record<MockBacklogBackendKind, string> = {
  "tasks-json": "tasks.json（リポジトリの専用ブランチ）",
  gist: "GitHub Gist（非公開）",
};

export function MetaProjectPanel({ projectId }: { projectId: string }) {
  useMockStoreVersion();
  const settings = getMetaProjectSettings(projectId);
  const candidates = getManageableProjects(projectId);

  function patch(next: Partial<typeof settings>) {
    setMetaProjectSettings({ ...settings, ...next });
  }

  function toggleManaged(targetId: string, on: boolean) {
    const next = on
      ? [...settings.managedProjectIds, targetId]
      : settings.managedProjectIds.filter((id) => id !== targetId);
    patch({ managedProjectIds: next });
  }

  return (
    <div>
      <h1 className="mb-0.5 flex items-center gap-1.5 text-lg font-semibold text-foreground">
        <Network className="size-4 text-ink-3" />
        メタ Project の設定
      </h1>
      <p className="mb-4 text-xs text-ink-3">
        複数の管理対象 Project を横断してオーケストレーションする、この Project だけの設定
        （v4-architecture.md §4.6、下書き段階）。
      </p>

      {/* 管理対象 Project——それぞれに専用 Fork が1本対応する */}
      <section className="mb-5 rounded-md border border-border px-3">
        <h2 className="flex items-center gap-1.5 py-2.5 text-sm font-semibold text-foreground">
          <Network className="size-3.5 text-ink-3" />
          管理対象の Project
        </h2>
        <p className="mb-2 text-xs text-ink-3">
          選んだ Project ごとに専用 Fork を1本持ち、やり取りはその Fork 経由で行う
          （書くのは新規メッセージ送信のみ・読みは Thread 全体）。
        </p>
        <div className="flex flex-col divide-y divide-border">
          {candidates.map((p) => {
            const on = settings.managedProjectIds.includes(p.id);
            return (
              <div key={p.id} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-ink-2">
                    {p.initial}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">{p.name}</p>
                    <p className="truncate text-xs text-ink-3">
                      {on ? "専用 Fork を1本持つ" : "管理していない"}
                    </p>
                  </div>
                </div>
                <Switch
                  id={`meta-managed-${p.id}`}
                  checked={on}
                  onCheckedChange={(v) => toggleManaged(p.id, v)}
                  aria-label={`${p.name} を管理対象にする`}
                />
              </div>
            );
          })}
          {candidates.length === 0 ? (
            <p className="py-3 text-xs text-ink-3">他に選べる Project が無い。</p>
          ) : null}
        </div>
      </section>

      {/* Backlog バックエンド——強制しない、メタ Project ごとに選べる（決定・2026-10-23） */}
      <section className="mb-5 rounded-md border border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label
              htmlFor="meta-backlog-backend"
              className="flex items-center gap-1.5 text-sm font-medium text-foreground"
            >
              <GitBranch className="size-3.5 text-ink-3" />
              Backlog のバックエンド
            </Label>
            <p className="mt-0.5 text-xs text-ink-3">
              複数 Project をまたぐ計画を持つ場所。Backlog Module の「窓口1本・バックエンドは複数」
              の作りをそのまま使う——どちらも dependsOn・parent を含む今のモデルを持ち込む。
            </p>
          </div>
          <Select
            value={settings.backlogBackend}
            onValueChange={(v) => patch({ backlogBackend: v as MockBacklogBackendKind })}
          >
            <SelectTrigger id="meta-backlog-backend" className="h-8 w-56 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gist">{BACKLOG_BACKEND_LABEL.gist}</SelectItem>
              <SelectItem value="tasks-json">{BACKLOG_BACKEND_LABEL["tasks-json"]}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      {/* release の扱い——既定は「任せる」（決定・2026-10-23、番頭の既定「人に残す」とは違う） */}
      <section className="rounded-md border border-border px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label
              htmlFor="meta-release-policy"
              className="flex items-center gap-1.5 text-sm font-medium text-foreground"
            >
              <Rocket className="size-3.5 text-ink-3" />
              release（main → release の取り込み）
            </Label>
            <p className="mt-0.5 text-xs text-ink-3">
              {settings.releasePolicy === "delegate"
                ? "このメタ Project に任せる——既定。番頭の既定（人に残す）とは違う。"
                : "人に残す——release への取り込みは、このメタ Project からは行わない。"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-ink-3">
              {settings.releasePolicy === "delegate" ? "任せる" : "人に残す"}
            </span>
            <Switch
              id="meta-release-policy"
              checked={settings.releasePolicy === "delegate"}
              onCheckedChange={(v) =>
                patch({ releasePolicy: (v ? "delegate" : "human") as MockReleasePolicy })
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}
