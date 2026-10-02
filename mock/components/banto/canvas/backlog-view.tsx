"use client";

// Backlog の入口（launcher「Backlog」、`banto.backlog:items`）の画面（v4-modules.md §4.4、2026-10-02）。
// 人がここで知りたいのは2つ：**次に何をやるか**と、**まとまりと依存**。
//   - 次に何をやるか：並びはファイルの中の順＝優先順。「着手できる」（準備できた かつ 待つものが全部終わった）を
//     行に印で出し、「着手できるものだけ」で絞れる（AI の listItems の「いま着手できるもの」と同じ条件）
//   - まとまり：マイルストーンごとに区切り、ストーリーの下に子のタスクを字下げで並べる
//   - 依存：行には「待ち n 件」だけ。中身は詳細で「待っているもの → これ → これを待っているもの」と縦に見せる
// 行を押すと右に詳細（コンテナ 48rem 以上）。狭い幅では一覧と入れ替わり、「一覧」で戻る。
// Backlog は Project ごとにつける（§4.4）ので、出どころは開いている Project の根の中の tasks.json。
import { useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getProjectOverrides } from "@/lib/mock/settings";
import { getBacklog, isActionable, type BacklogFile, type BacklogItem, type BacklogKind } from "@/lib/mock/backlog";
import { KIND_LABEL, KindMark } from "./backlog-parts";
import { BacklogList, buildSections } from "./backlog-list";
import { BacklogDetail } from "./backlog-detail";
import { AddItemDialog, SplitStoryDialog } from "./backlog-forms";

type KindFilter = "all" | BacklogKind;
type StatusFilter = "open" | "done" | "dropped" | "all";
const ALL = "all";
const NO_MILESTONE = "none";

export function BacklogView() {
  useMockStoreVersion();
  const params = useParams<{ projectId?: string }>();
  // 別タブの Canvas（/canvas-window）には Project が無い——そのときは banto の見本を出す
  const projectId = params.projectId ?? "banto";
  const file = getBacklog(projectId);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-ink-3">
        この Project には Backlog の tasks.json がありません
      </div>
    );
  }
  return <BacklogScreen key={projectId} projectId={projectId} file={file} />;
}

function BacklogScreen({ projectId, file }: { projectId: string; file: BacklogFile }) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [milestone, setMilestone] = useState<string>(ALL);
  const [label, setLabel] = useState<string>(ALL);
  const [actionableOnly, setActionableOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState<BacklogKind | null>(null);
  const [splitting, setSplitting] = useState<string | null>(null);

  const root = getProjectOverrides(projectId).securityRoot;
  const items = file.items;
  const labels = [...new Set(items.flatMap((i) => i.labels))].sort((a, b) => a.localeCompare(b, "ja"));
  const selected = selectedId ? items.find((i) => i.id === selectedId) : undefined;
  const splittingStory = splitting ? items.find((i) => i.id === splitting) : undefined;

  const shown = items.filter(
    (i) =>
      (kind === "all" || i.kind === kind) &&
      (status === "all" ||
        (status === "open" ? i.status !== "done" && i.status !== "dropped" : i.status === status)) &&
      (milestone === ALL || (milestone === NO_MILESTONE ? i.milestone === null : i.milestone === milestone)) &&
      (label === ALL || i.labels.includes(label)) &&
      (!actionableOnly || isActionable(i, items)),
  );
  const sections = buildSections(file, shown);
  const actionableCount = items.filter((i) => isActionable(i, items)).length;
  const filtered = kind !== "all" || status !== "open" || milestone !== ALL || label !== ALL || actionableOnly;

  function clearFilters() {
    setKind("all");
    setStatus("open");
    setMilestone(ALL);
    setLabel(ALL);
    setActionableOnly(false);
  }

  return (
    <div className="@container flex h-full min-h-0" data-testid="backlog-view">
      <div
        className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto", selected && "hidden @3xl:block")}
        data-testid="backlog-list-pane"
      >
        <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-5 @lg:px-5 @lg:py-8">
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-xl font-semibold text-foreground">Backlog</h2>
              <p data-testid="backlog-source" className="text-sm break-all text-ink-2">
                この Project の今後やることとバグ。{" "}
                <span className="font-mono text-xs">
                  {root}/{file.path}
                </span>{" "}
                を読み書きしています
              </p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-8" data-testid="backlog-add-open">
                  <Plus />
                  追加
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(["story", "task", "bug"] as const).map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => setAdding(k)} data-testid={`backlog-add-${k}`}>
                    <KindMark kind={k} />
                    {KIND_LABEL[k]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          <div className="flex flex-col gap-2" data-testid="backlog-filters">
            <div className="flex flex-wrap items-center gap-2">
              <ChoicePills
                label="種類"
                testId="backlog-filter-kind"
                value={kind}
                onChange={setKind}
                choices={[
                  { value: "all", label: "すべて" },
                  { value: "story", label: "ストーリー" },
                  { value: "task", label: "タスク" },
                  { value: "bug", label: "バグ" },
                ]}
              />
              <ChoicePills
                label="状態"
                testId="backlog-filter-status"
                value={status}
                onChange={setStatus}
                choices={[
                  { value: "open", label: "終わっていない" },
                  { value: "done", label: "終わった" },
                  { value: "dropped", label: "やめた" },
                  { value: "all", label: "すべて" },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {file.milestones.length > 0 ? (
                <FilterSelect label="マイルストーン" value={milestone} onChange={setMilestone} testId="backlog-filter-milestone">
                  <SelectItem value={ALL} className="text-xs">
                    すべてのマイルストーン
                  </SelectItem>
                  {file.milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.title}
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_MILESTONE} className="text-xs">
                    マイルストーン無し
                  </SelectItem>
                </FilterSelect>
              ) : null}
              {labels.length > 0 ? (
                <FilterSelect label="ラベル" value={label} onChange={setLabel} testId="backlog-filter-label">
                  <SelectItem value={ALL} className="text-xs">
                    すべてのラベル
                  </SelectItem>
                  {labels.map((l) => (
                    <SelectItem key={l} value={l} className="text-xs">
                      {l}
                    </SelectItem>
                  ))}
                </FilterSelect>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-ink-2">
                <Switch
                  size="sm"
                  checked={actionableOnly}
                  onCheckedChange={setActionableOnly}
                  data-testid="backlog-filter-actionable"
                />
                着手できるものだけ
                <span className="text-ink-3 tabular-nums">{actionableCount}</span>
              </label>
            </div>
          </div>

          {sections.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border p-5 text-sm text-ink-2">
              条件に合う項目はありません
              {filtered ? (
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  絞り込みを外す
                </Button>
              ) : null}
            </div>
          ) : (
            <BacklogList
              projectId={projectId}
              file={file}
              sections={sections}
              shown={shown}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
      </div>

      {selected ? (
        <aside
          aria-label={`「${selected.title}」の詳細`}
          className="min-h-0 w-full shrink-0 overflow-y-auto border-border @3xl:w-96 @3xl:border-l @5xl:w-md"
        >
          <BacklogDetail
            key={selected.id}
            projectId={projectId}
            file={file}
            item={selected}
            onOpen={setSelectedId}
            onClose={() => setSelectedId(null)}
            onSplit={() => setSplitting(selected.id)}
          />
        </aside>
      ) : null}

      {adding ? (
        <AddItemDialog
          projectId={projectId}
          file={file}
          initialKind={adding}
          onClose={() => setAdding(null)}
          onCreated={(item: BacklogItem) => {
            setAdding(null);
            setSelectedId(item.id);
          }}
        />
      ) : null}
      {splittingStory ? (
        <SplitStoryDialog projectId={projectId} story={splittingStory} onClose={() => setSplitting(null)} />
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  testId,
  children,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="text-xs" aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
