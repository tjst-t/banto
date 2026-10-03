"use client";

// Backlog の入口（launcher「Backlog」、`banto.backlog:items`）の画面（v4-modules.md §4.4）。
// よく使われる課題管理（Linear・GitHub Projects・Jira・Plane・Shortcut）を調べて決めた形
// （docs/notes/2026-10-02-backlog-ui-survey.md）：
//   - 上の段は1行。絞り込みの札を並べず、**見方**（次にやる／すべて／バグ／閉じたもの）を切り替える
//     ——Linear の保存した見方・My Issues と同じ。マイルストーン・ラベルは「絞り込み」の小窓に畳む
//   - 一覧は1項目1行。左端の印：タスク・バグは状態の輪、ストーリーは子の進みで満ちるひし形。
//     「次にやる」ではタスクの題の頭にストーリー名を薄く付ける
//   - 行を押す／Enter で右に詳細（Linear の Peek）。↑↓（j/k）で選び、Esc で閉じる、C で足す
//   - 足すのは一覧の中でその場に打つ。ダイアログは使わない
// Backlog は Project ごとにつける（§4.4）。出どころは開いている Project の根の中の tasks.json。
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useParams } from "next/navigation";
import { ListFilter, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { getProjectOverrides } from "@/lib/mock/settings";
import {
  childrenOf,
  getBacklog,
  isClosed,
  type BacklogFile,
  type BacklogItem,
} from "@/lib/mock/backlog";
import {
  BacklogList,
  flattenIds,
  type ListGroup,
  type ListNode,
} from "./backlog-list";
import { BacklogDetail } from "./backlog-detail";
import { InlineComposer } from "./backlog-forms";
import { formatDate, rankState } from "./backlog-parts";

type ViewId = "next" | "all" | "bugs" | "closed";

const VIEWS: readonly { id: ViewId; label: string }[] = [
  { id: "next", label: "次にやる" },
  { id: "all", label: "すべて" },
  { id: "bugs", label: "バグ" },
  { id: "closed", label: "閉じたもの" },
];

export function BacklogView() {
  useMockStoreVersion();
  const params = useParams<{ projectId?: string }>();
  // 別タブの Canvas（/canvas-window）には Project が無い——そのときは banto の見本を出す
  const projectId = params.projectId ?? "banto";
  const file = getBacklog(projectId);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-md text-ink-3">
        この Project には Backlog の tasks.json がありません
      </div>
    );
  }
  return <BacklogScreen key={projectId} projectId={projectId} file={file} />;
}

interface Filters {
  milestones: ReadonlySet<string>;
  labels: ReadonlySet<string>;
}

function matches(item: BacklogItem, f: Filters): boolean {
  if (f.milestones.size > 0 && !f.milestones.has(item.milestone ?? "none"))
    return false;
  if (f.labels.size > 0 && !item.labels.some((l) => f.labels.has(l)))
    return false;
  return true;
}

/** 見方ごとに区切りと行を組む。数字は段の中の順番（閉じたものは持たない） */
function buildGroups(view: ViewId, file: BacklogFile, f: Filters): ListGroup[] {
  const items = file.items;
  const open = items.filter((i) => !isClosed(i) && matches(i, f));
  const storyTitle = (i: BacklogItem) =>
    i.parent ? items.find((p) => p.id === i.parent)?.title : undefined;

  if (view === "next") {
    // 動かせるものだけ：進めている、と、着手できる。ストーリーは子で動くので出さない
    const work = open.filter((i) => i.kind !== "story");
    const doing = work.filter((i) => i.status === "in-progress");
    const actionable = work.filter((i) => rankState(i, items) === "actionable");
    const rest =
      open.filter((i) => i.kind !== "story").length -
      doing.length -
      actionable.length;
    const toNode = (i: BacklogItem): ListNode => ({
      item: i,
      story: storyTitle(i),
    });
    return [
      {
        id: "doing",
        title: "進めている",
        nodes: doing.map(toNode),
        sortable: true,
      },
      {
        id: "actionable",
        title: "着手できる",
        hint:
          rest > 0
            ? `ほかに待っているもの・積んだだけのものが ${rest} 件（「すべて」で見る）`
            : undefined,
        nodes: actionable.map(toNode),
        sortable: true,
      },
    ].filter((g) => g.nodes.length > 0 || g.id === "actionable");
  }

  if (view === "bugs") {
    const bugs = open.filter((i) => i.kind === "bug");
    return [
      {
        id: "bugs",
        title: "バグ",
        nodes: bugs.map((i) => ({ item: i })),
        composerMilestone: null,
        sortable: true,
      },
    ];
  }

  if (view === "closed") {
    const closed = items
      .filter((i) => isClosed(i) && matches(i, f))
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
    return [
      {
        id: "closed",
        title: "閉じたもの",
        hint: "閉じた日の新しい順",
        nodes: closed.map((i) => ({
          item: i,
          note:
            i.status === "dropped" && i.resolution
              ? `やめた：${i.resolution}`
              : undefined,
          context: i.closedAt ? formatDate(i.closedAt) : undefined,
        })),
        sortable: false,
      },
    ];
  }

  // すべて：マイルストーンごと。ストーリーの下に子（終わっていないもの）、閉じた子は畳む
  const top = open.filter(
    (i) => i.parent === null || !open.some((p) => p.id === i.parent),
  );
  const toNode = (i: BacklogItem): ListNode => {
    if (i.kind !== "story")
      return { item: i, story: i.parent ? storyTitle(i) : undefined };
    const kids = childrenOf(i, items);
    return {
      item: i,
      children: kids
        .filter((k) => !isClosed(k) && matches(k, f))
        .map((k) => ({ item: k })),
      closedKids: kids.filter(isClosed),
    };
  };
  const groups: ListGroup[] = file.milestones
    .filter((m) => m.status === "open")
    .map((m) => ({
      id: m.id,
      title: m.title,
      nodes: top.filter((i) => i.milestone === m.id).map(toNode),
      composerMilestone: m.id,
      sortable: true,
    }));
  groups.push({
    id: "none",
    title: "マイルストーン無し",
    nodes: top
      .filter(
        (i) =>
          i.milestone === null ||
          !file.milestones.some(
            (m) => m.id === i.milestone && m.status === "open",
          ),
      )
      .map(toNode),
    composerMilestone: null,
    sortable: true,
  });
  return groups.filter((g) => g.nodes.length > 0 || g.id === "none");
}

function BacklogScreen({
  projectId,
  file,
}: {
  projectId: string;
  file: BacklogFile;
}) {
  const [view, setView] = useState<ViewId>("next");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [peek, setPeek] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filters, setFilters] = useState<Filters>({
    milestones: new Set(),
    labels: new Set(),
  });
  const [adding, setAdding] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const items = file.items;
  const root = getProjectOverrides(projectId).securityRoot;
  const groups = buildGroups(view, file, filters);
  const order = flattenIds(groups, collapsed);
  const selected =
    peek && selectedId ? items.find((i) => i.id === selectedId) : undefined;
  const labels = useMemo(
    () =>
      [...new Set(items.flatMap((i) => i.labels))].sort((a, b) =>
        a.localeCompare(b, "ja"),
      ),
    [items],
  );
  const filterCount = filters.milestones.size + filters.labels.size;

  const counts: Record<ViewId, number> = {
    next: items.filter(
      (i) =>
        i.kind !== "story" &&
        (i.status === "in-progress" || rankState(i, items) === "actionable"),
    ).length,
    all: items.filter((i) => !isClosed(i)).length,
    bugs: items.filter((i) => i.kind === "bug" && !isClosed(i)).length,
    closed: items.filter(isClosed).length,
  };

  // 選んだ行が見えるところへ
  useEffect(() => {
    if (!selectedId) return;
    rootRef.current
      ?.querySelector(
        `[data-item-id="${CSS.escape(selectedId)}"] > [data-testid="backlog-row"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  function step(delta: -1 | 1) {
    if (order.length === 0) return;
    const at = selectedId ? order.indexOf(selectedId) : -1;
    const next =
      at < 0
        ? delta === 1
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + delta));
    setSelectedId(order[next]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target as HTMLElement;
    if (
      t.closest(
        "input, textarea, [contenteditable=true], [role=menu], [role=dialog], [cmdk-root]",
      )
    )
      return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter" && selectedId && !t.closest("button, a")) {
      e.preventDefault();
      setPeek(true);
    } else if (e.key === "Escape" && peek) {
      e.preventDefault();
      setPeek(false);
    } else if (e.key === "c") {
      e.preventDefault();
      setAdding(true);
    }
  }

  function toggle(set: ReadonlySet<string>, v: string): Set<string> {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="@container flex h-full min-h-0 bg-card outline-none"
      data-testid="backlog-view"
    >
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          selected && "hidden @3xl:flex",
        )}
        data-testid="backlog-list-pane"
      >
        <header className="shrink-0 border-b border-border">
          <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pt-4 @lg:px-6">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-foreground">Backlog</h2>
              <span
                data-testid="backlog-source"
                className="min-w-0 truncate font-mono text-xs text-ink-3"
                title={`${root}/${file.path}`}
              >
                {file.path}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="backlog-filter"
                      className="text-md"
                    >
                      <ListFilter />
                      絞り込み
                      {filterCount > 0 ? (
                        <span className="text-primary tabular-nums">
                          {filterCount}
                        </span>
                      ) : null}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {file.milestones.length > 0 ? (
                      <>
                        <DropdownMenuLabel className="text-xs text-ink-3">
                          マイルストーン
                        </DropdownMenuLabel>
                        {[
                          ...file.milestones,
                          { id: "none", title: "マイルストーン無し" },
                        ].map((m) => (
                          <DropdownMenuCheckboxItem
                            key={m.id}
                            checked={filters.milestones.has(m.id)}
                            onCheckedChange={() =>
                              setFilters((f) => ({
                                ...f,
                                milestones: toggle(f.milestones, m.id),
                              }))
                            }
                            onSelect={(e) => e.preventDefault()}
                            className="text-md"
                          >
                            {m.title}
                          </DropdownMenuCheckboxItem>
                        ))}
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    <DropdownMenuLabel className="text-xs text-ink-3">
                      ラベル
                    </DropdownMenuLabel>
                    {labels.map((l) => (
                      <DropdownMenuCheckboxItem
                        key={l}
                        checked={filters.labels.has(l)}
                        onCheckedChange={() =>
                          setFilters((f) => ({
                            ...f,
                            labels: toggle(f.labels, l),
                          }))
                        }
                        onSelect={(e) => e.preventDefault()}
                        className="text-md"
                      >
                        {l}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  size="sm"
                  onClick={() => setAdding(true)}
                  data-testid="backlog-add-open"
                  className="text-md"
                >
                  <Plus />
                  足す
                </Button>
              </div>
            </div>
            <nav
              aria-label="見方"
              className="-mb-px flex gap-4"
              data-testid="backlog-views"
            >
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  aria-current={view === v.id ? "page" : undefined}
                  data-testid={`backlog-view-${v.id}`}
                  onClick={() => {
                    setView(v.id);
                    setAdding(false);
                  }}
                  className={cn(
                    "flex shrink-0 items-baseline gap-1.5 border-b-2 pb-2 text-md whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ring",
                    view === v.id
                      ? "border-foreground font-semibold text-foreground"
                      : "border-transparent text-ink-3 hover:text-ink-2",
                  )}
                >
                  {v.label}
                  <span className="text-xs font-normal text-ink-3 tabular-nums">
                    {counts[v.id]}
                  </span>
                </button>
              ))}
            </nav>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 pt-4 pb-10 @lg:px-6">
            {filterCount > 0 ? (
              <p className="flex items-center gap-2 text-xs text-ink-3">
                絞り込み中
                <button
                  type="button"
                  onClick={() =>
                    setFilters({ milestones: new Set(), labels: new Set() })
                  }
                  className="rounded-sm text-ink-2 underline underline-offset-2 hover:text-foreground"
                >
                  外す
                </button>
              </p>
            ) : null}
            {adding ? (
              <InlineComposer
                projectId={projectId}
                milestone={null}
                initialKind={view === "bugs" ? "bug" : "task"}
                onClose={() => {
                  setAdding(false);
                  rootRef.current?.focus();
                }}
              />
            ) : null}
            {groups.every((g) => g.nodes.length === 0) ? (
              <EmptyView
                view={view}
                onAdd={() => setAdding(true)}
                onAll={() => setView("all")}
              />
            ) : null}
            <BacklogList
              projectId={projectId}
              groups={groups.filter(
                (g) => g.nodes.length > 0 || g.composerMilestone !== undefined,
              )}
              items={items}
              selectedId={selectedId}
              collapsed={collapsed}
              onToggle={(id) => setCollapsed((c) => toggle(c, id))}
              onSelect={setSelectedId}
              onOpen={(id) => {
                setSelectedId(id);
                setPeek(true);
              }}
            />
            <p className="hidden pt-2 text-xs text-ink-3 @lg:block">
              ↑↓ で選ぶ　Enter で開く　Esc で閉じる　C
              で足す　行はつかんで並べ替え（上ほど先にやる）
            </p>
          </div>
        </div>
      </div>

      {selected ? (
        <aside
          aria-label={`「${selected.title}」の詳細`}
          className="min-h-0 w-full shrink-0 border-border @3xl:w-[25rem] @3xl:border-l @5xl:w-[28rem]"
        >
          <BacklogDetail
            projectId={projectId}
            file={file}
            item={selected}
            onOpen={(id) => setSelectedId(id)}
            onClose={() => {
              setPeek(false);
              rootRef.current?.focus();
            }}
            onStep={step}
          />
        </aside>
      ) : null}
    </div>
  );
}

function EmptyView({
  view,
  onAdd,
  onAll,
}: {
  view: ViewId;
  onAdd: () => void;
  onAll: () => void;
}) {
  if (view === "next") {
    return (
      <div className="flex flex-col items-start gap-2 py-6 text-md text-ink-2">
        いま着手できるものはありません。待っているものと積んだだけのものは「すべて」にあります。
        <Button variant="outline" size="sm" onClick={onAll}>
          すべてを見る
        </Button>
      </div>
    );
  }
  if (view === "bugs") {
    return (
      <p className="py-6 text-md text-ink-2">開いているバグはありません。</p>
    );
  }
  if (view === "closed") {
    return (
      <p className="py-6 text-md text-ink-2">まだ閉じたものはありません。</p>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2 py-6 text-md text-ink-2">
      まだ何も積んでいません。
      <Button size="sm" onClick={onAdd}>
        <Plus />
        足す
      </Button>
    </div>
  );
}
