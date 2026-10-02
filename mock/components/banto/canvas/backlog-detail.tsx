"use client";

// Backlog の1件の詳細（一覧の右に出す「のぞき見」。Linear の Peek と同じく、一覧を離れずに中身を見る）。
// 入力フォームにしない——読み物として上から：どこの下か／題／性質の1行／依存の流れ／完了条件／本文／子／参照・Thread。
// 性質（状態・優先度・マイルストーン・ストーリー・ラベル）は押すとその場で小窓が開いて変わる（Linear の
// プロパティと同じ）。閉じる操作は下に固定：「終わったにする」「やめる（理由を書く）」。消す操作は無い（§4.4）。
// ストーリーは子が全部閉じても自動では閉じない——案内を出し、閉じるのは人が押す。
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, MessageSquare, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getThread } from "@/lib/mock/threads";
import {
  childrenOf,
  dependents,
  isClosed,
  updateItem,
  type BacklogFile,
  type BacklogItem,
  type BacklogPriority,
  type BacklogStatus,
} from "@/lib/mock/backlog";
import {
  KIND_LABEL,
  LabelChip,
  MarkdownBody,
  PRIORITY_LABEL,
  RANK_STATE_LABEL,
  RankMark,
  STATUS_LABEL,
  formatDate,
  rankState,
} from "./backlog-parts";
import { ItemPicker, SplitComposer } from "./backlog-forms";

export function BacklogDetail({
  projectId,
  file,
  item,
  onOpen,
  onClose,
  onStep,
}: {
  projectId: string;
  file: BacklogFile;
  item: BacklogItem;
  onOpen: (id: string) => void;
  onClose: () => void;
  /** 一覧の前後の項目へ（↑↓ と同じ） */
  onStep: (delta: -1 | 1) => void;
}) {
  const items = file.items;
  const parent = item.parent
    ? items.find((i) => i.id === item.parent)
    : undefined;
  const closed = isClosed(item);
  const state = rankState(item, items);
  const kids = item.kind === "story" ? childrenOf(item, items) : [];
  const [dropping, setDropping] = useState(false);
  const [splitting, setSplitting] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="backlog-detail">
      <div className="flex shrink-0 items-center gap-1 px-4 pt-3 pb-1">
        <p className="min-w-0 flex-1 truncate text-xs text-ink-3">
          {parent ? (
            <button
              type="button"
              onClick={() => onOpen(parent.id)}
              className="rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              data-testid="backlog-detail-parent"
            >
              {parent.title}
            </button>
          ) : (
            KIND_LABEL[item.kind]
          )}
          {parent ? <span> のタスク</span> : null}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onStep(-1)}
          aria-label="前の項目"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onStep(1)}
          aria-label="次の項目"
        >
          <ChevronDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="詳細を閉じる"
          data-testid="backlog-detail-close"
        >
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        <EditableTitle key={item.id} projectId={projectId} item={item} />

        <Properties
          projectId={projectId}
          file={file}
          item={item}
          state={state}
        />

        <DependencyFlow
          projectId={projectId}
          item={item}
          items={items}
          onOpen={onOpen}
        />

        {item.kind === "story" ? (
          <section className="mt-6" aria-label="タスク">
            <SectionTitle
              action={
                !closed && !splitting ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setSplitting(true)}
                    data-testid="backlog-split-open"
                  >
                    <Plus />
                    タスクに分ける
                  </Button>
                ) : null
              }
            >
              タスク
            </SectionTitle>
            {splitting ? (
              <SplitComposer
                projectId={projectId}
                story={item}
                onDone={() => setSplitting(false)}
                onCancel={() => setSplitting(false)}
              />
            ) : null}
            {kids.length === 0 && !splitting ? (
              <p className="text-md text-ink-3">
                まだタスクに分けていません。取りかかるときに分けます。
              </p>
            ) : (
              <ul className="flex flex-col" data-testid="backlog-detail-kids">
                {kids.map((k) => (
                  <li key={k.id}>
                    <ItemLine
                      item={k}
                      items={items}
                      n={
                        isClosed(k)
                          ? undefined
                          : kids.filter((x) => !isClosed(x)).indexOf(k) + 1
                      }
                      onOpen={onOpen}
                    />
                  </li>
                ))}
              </ul>
            )}
            {!closed && kids.length > 0 && kids.every(isClosed) ? (
              <p
                data-testid="backlog-story-all-done"
                className="mt-2 text-md text-ink-2"
              >
                タスクは全部閉じました。ストーリーも終わりなら、下の「終わったにする」で閉じます。
              </p>
            ) : null}
          </section>
        ) : null}

        <TextBlock
          key={`done-${item.id}`}
          title="完了条件"
          value={item.doneWhen}
          empty="何を測れたら終わりかを書きます"
          onSave={(v) => updateItem(projectId, item.id, { doneWhen: v })}
          testId="backlog-detail-donewhen"
        />
        <TextBlock
          key={`body-${item.id}`}
          title="本文"
          value={item.body}
          empty="なぜやるか・経緯・確かめ方を書きます"
          markdown
          onSave={(v) => updateItem(projectId, item.id, { body: v })}
          testId="backlog-detail-body"
        />

        {item.refs.length > 0 ? (
          <section className="mt-6">
            <SectionTitle>参照</SectionTitle>
            <ul className="flex flex-col gap-0.5">
              {item.refs.map((r) => (
                <li key={r} className="font-mono text-xs break-all text-ink-2">
                  {r}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-6">
          <SectionTitle>取り組んだ Thread</SectionTitle>
          {item.threads.length === 0 ? (
            <p className="text-md text-ink-3">
              まだどの Thread でも取り組んでいません。
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="backlog-threads">
              {item.threads.map((t) => {
                const thread = getThread(t.threadId);
                const href =
                  thread?.kind === "fork"
                    ? `/p/${t.projectId}?fork=${t.threadId}`
                    : `/p/${t.projectId}`;
                return (
                  <li key={`${t.projectId}:${t.threadId}`}>
                    <Link
                      href={href}
                      className="inline-flex items-center gap-1.5 rounded-sm text-md text-ink-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <MessageSquare className="size-3.5 text-ink-3" />
                      {thread?.title ?? t.threadId}
                      {thread?.kind === "base" ? (
                        <span className="text-ink-3">（Base Thread）</span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="mt-6 text-xs text-ink-3 tabular-nums">
          {formatDate(item.createdAt)}に作成、{formatDate(item.updatedAt)}に更新
          {item.closedAt ? `、${formatDate(item.closedAt)}に閉じた` : ""}。
          <span className="font-mono">{item.id}</span>
        </p>
      </div>

      <footer
        className="shrink-0 border-t border-border bg-card px-4 py-3"
        data-testid="backlog-detail-actions"
      >
        {closed ? (
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-md text-ink-2">
              {item.status === "done" ? "終わりました" : "やめました"}
              {item.resolution ? (
                <span className="text-ink-3">：{item.resolution}</span>
              ) : null}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                updateItem(projectId, item.id, { status: "ready" })
              }
            >
              開き直す
            </Button>
          </div>
        ) : dropping ? (
          <DropForm
            onCancel={() => setDropping(false)}
            onDrop={(reason) => {
              updateItem(projectId, item.id, {
                status: "dropped",
                resolution: reason,
              });
              setDropping(false);
            }}
          />
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => updateItem(projectId, item.id, { status: "done" })}
              data-testid="backlog-close-done"
            >
              終わったにする
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDropping(true)}
              data-testid="backlog-close-drop"
            >
              やめる
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex h-6 items-center justify-between gap-2">
      <h4 className="text-sm font-semibold text-ink-2">{children}</h4>
      {action}
    </div>
  );
}

function EditableTitle({
  projectId,
  item,
}: {
  projectId: string;
  item: BacklogItem;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(item.title);
  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim())
            updateItem(projectId, item.id, { title: value.trim() });
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setValue(item.title);
            setEditing(false);
          }
        }}
        aria-label="題"
        className="h-auto py-1 text-xl font-semibold"
      />
    );
  }
  return (
    <h3
      data-testid="backlog-detail-title"
      className="cursor-text rounded-sm text-xl font-semibold text-foreground hover:bg-surface-2"
      onClick={() => setEditing(true)}
    >
      {item.title}
    </h3>
  );
}

const STATUS_CHOICES: readonly BacklogStatus[] = [
  "backlog",
  "ready",
  "in-progress",
];

/** 性質の1行。押すと小窓が開いてその場で変わる */
function Properties({
  projectId,
  file,
  item,
  state,
}: {
  projectId: string;
  file: BacklogFile;
  item: BacklogItem;
  state: ReturnType<typeof rankState>;
}) {
  const items = file.items;
  const closed = isClosed(item);
  const milestone = file.milestones.find((m) => m.id === item.milestone);
  const stories = items.filter(
    (i) => i.kind === "story" && !isClosed(i) && i.id !== item.id,
  );
  const allLabels = [...new Set(items.flatMap((i) => i.labels))].filter(
    (l) => !item.labels.includes(l),
  );
  const [labelDraft, setLabelDraft] = useState("");

  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-1.5"
      data-testid="backlog-properties"
    >
      <PropertyMenu
        testId="backlog-prop-status"
        disabled={closed}
        trigger={
          <>
            <RankMark state={state} small />
            {state === "actionable" || state === "waiting"
              ? RANK_STATE_LABEL[state]
              : STATUS_LABEL[item.status]}
          </>
        }
      >
        {STATUS_CHOICES.map((s) => (
          <DropdownMenuItem
            key={s}
            disabled={item.status === s}
            onSelect={() => updateItem(projectId, item.id, { status: s })}
            className="text-md"
          >
            {STATUS_LABEL[s]}
          </DropdownMenuItem>
        ))}
      </PropertyMenu>

      <PropertyMenu
        testId="backlog-prop-priority"
        trigger={<>優先度 {PRIORITY_LABEL[item.priority]}</>}
        strong={item.priority === "high"}
      >
        {(
          [
            "high",
            "normal",
            "low",
          ] as const satisfies readonly BacklogPriority[]
        ).map((p) => (
          <DropdownMenuItem
            key={p}
            disabled={item.priority === p}
            onSelect={() => updateItem(projectId, item.id, { priority: p })}
            className="text-md"
          >
            {PRIORITY_LABEL[p]}
          </DropdownMenuItem>
        ))}
      </PropertyMenu>

      {item.parent ? null : (
        <PropertyMenu
          testId="backlog-prop-milestone"
          trigger={<>{milestone ? milestone.title : "マイルストーン無し"}</>}
          quiet={!milestone}
        >
          {file.milestones.map((m) => (
            <DropdownMenuItem
              key={m.id}
              disabled={item.milestone === m.id}
              onSelect={() =>
                updateItem(projectId, item.id, { milestone: m.id })
              }
              className="text-md"
            >
              {m.title}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => updateItem(projectId, item.id, { milestone: null })}
            className="text-md"
          >
            マイルストーン無し
          </DropdownMenuItem>
        </PropertyMenu>
      )}

      {item.kind === "task" ? (
        <ItemPicker
          candidates={stories}
          items={items}
          onPick={(id) =>
            updateItem(projectId, item.id, {
              parent: id,
              milestone: items.find((i) => i.id === id)?.milestone ?? null,
            })
          }
          placeholder="ストーリーを探す"
          testId="backlog-prop-parent"
        >
          <PropertyButton quiet={!item.parent}>
            {item.parent ? "ストーリーを替える" : "ストーリーに入れる"}
          </PropertyButton>
        </ItemPicker>
      ) : null}

      {item.labels.map((l) => (
        <LabelChip
          key={l}
          onRemove={() =>
            updateItem(projectId, item.id, {
              labels: item.labels.filter((x) => x !== l),
            })
          }
        >
          {l}
        </LabelChip>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <PropertyButton quiet testId="backlog-prop-label">
            ラベル
          </PropertyButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <div className="p-1">
            <Input
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter" && labelDraft.trim()) {
                  updateItem(projectId, item.id, {
                    labels: [...item.labels, labelDraft.trim()],
                  });
                  setLabelDraft("");
                }
              }}
              placeholder="新しいラベル"
              aria-label="新しいラベル"
              className="h-7 text-md"
            />
          </div>
          {allLabels.map((l) => (
            <DropdownMenuItem
              key={l}
              onSelect={() =>
                updateItem(projectId, item.id, { labels: [...item.labels, l] })
              }
              className="text-md"
            >
              {l}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PropertyButton({
  children,
  quiet = false,
  strong = false,
  disabled = false,
  testId,
  ...rest
}: {
  children: ReactNode;
  quiet?: boolean;
  strong?: boolean;
  disabled?: boolean;
  testId?: string;
} & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      {...rest}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-sm border border-border px-2 text-md whitespace-nowrap",
        "hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none",
        quiet ? "border-dashed text-ink-3" : "text-ink-2",
        strong && "font-semibold text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function PropertyMenu({
  trigger,
  children,
  quiet,
  strong,
  disabled,
  testId,
}: {
  trigger: ReactNode;
  children: ReactNode;
  quiet?: boolean;
  strong?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <PropertyButton
          quiet={quiet}
          strong={strong}
          disabled={disabled}
          testId={testId}
        >
          {trigger}
        </PropertyButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 依存の相手の1行（順番の印・題・状態）。押すとその項目へ */
function ItemLine({
  item,
  items,
  n,
  onOpen,
  onRemove,
  self = false,
}: {
  item: BacklogItem;
  items: readonly BacklogItem[];
  n?: number;
  onOpen?: (id: string) => void;
  onRemove?: () => void;
  self?: boolean;
}) {
  const state = rankState(item, items);
  const body = (
    <>
      <RankMark state={state} n={n} small />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-md",
          self ? "font-semibold text-foreground" : "text-ink-2",
        )}
      >
        {item.title}
      </span>
      <span className="shrink-0 text-xs text-ink-3">
        {RANK_STATE_LABEL[state]}
      </span>
    </>
  );
  return (
    <div className="group/line flex items-center gap-1">
      {onOpen && !self ? (
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {body}
        </button>
      ) : (
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2.5 px-1.5">
          {body}
        </div>
      )}
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          aria-label={`「${item.title}」を待つのをやめる`}
          className="opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 依存の流れ——この画面の芯。上から「これが待っているもの」→「この項目」→「これを待っているもの」を
 * 1本の線で繋ぐ。待っているものが無ければ「すぐ始められます」と言い切る
 */
function DependencyFlow({
  projectId,
  item,
  items,
  onOpen,
}: {
  projectId: string;
  item: BacklogItem;
  items: readonly BacklogItem[];
  onOpen: (id: string) => void;
}) {
  const before = item.dependsOn
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is BacklogItem => i !== undefined);
  const after = dependents(item, items);
  const excluded = new Set([
    item.id,
    ...item.dependsOn,
    ...after.map((a) => a.id),
  ]);
  const candidates = items.filter((i) => !excluded.has(i.id) && !isClosed(i));
  const open = before.filter((b) => b.status !== "done");

  const picker = (
    <ItemPicker
      candidates={candidates}
      items={items}
      onPick={(id) =>
        updateItem(projectId, item.id, { dependsOn: [...item.dependsOn, id] })
      }
      placeholder="待つ項目を探す"
      testId="backlog-dep-add"
    >
      <Button variant="ghost" size="xs">
        <Plus />
        待つものを足す
      </Button>
    </ItemPicker>
  );

  return (
    <section className="mt-6" aria-label="依存" data-testid="backlog-deps">
      <SectionTitle action={picker}>依存</SectionTitle>
      {before.length === 0 && after.length === 0 ? (
        <p className="text-md text-ink-3" data-testid="backlog-dep-summary">
          待つものも、これを待っているものもありません。
        </p>
      ) : (
        <>
          <div className="relative">
            {/* 1本の線。行の印の中心（左 1.5 + 9px）を通す */}
            <span
              aria-hidden
              className="absolute top-4 bottom-4 left-4 w-px bg-border"
            />
            <ol className="relative flex flex-col">
              {before.map((b) => (
                <li key={b.id} data-testid="backlog-dep-before">
                  <ItemLine
                    item={b}
                    items={items}
                    onOpen={onOpen}
                    onRemove={() =>
                      updateItem(projectId, item.id, {
                        dependsOn: item.dependsOn.filter((x) => x !== b.id),
                      })
                    }
                  />
                </li>
              ))}
              <li
                data-testid="backlog-dep-self"
                className="rounded-md bg-surface-2"
              >
                <ItemLine item={item} items={items} self />
              </li>
              {after.map((a) => (
                <li key={a.id} data-testid="backlog-dep-after">
                  <ItemLine item={a} items={items} onOpen={onOpen} />
                </li>
              ))}
            </ol>
          </div>
          <p
            className="mt-1.5 pl-1.5 text-xs text-ink-3"
            data-testid="backlog-dep-summary"
          >
            {isClosed(item)
              ? after.length > 0
                ? `${after.length} 件がこれを待っていました。`
                : "閉じています。"
              : open.length > 0
                ? `${open.length} 件が終わるまで始められません。`
                : before.length > 0
                  ? "待っていたものは全部終わりました。"
                  : "待つものはありません。"}
            {!isClosed(item) && after.length > 0
              ? `終われば ${after.length} 件が進めます。`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

function TextBlock({
  title,
  value,
  empty,
  markdown = false,
  onSave,
  testId,
}: {
  title: string;
  value: string;
  empty: string;
  markdown?: boolean;
  onSave: (v: string) => void;
  testId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <section className="mt-6" data-testid={testId}>
      <SectionTitle
        action={
          !editing ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setDraft(value);
                setEditing(true);
              }}
            >
              書き直す
            </Button>
          ) : null
        }
      >
        {title}
      </SectionTitle>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            rows={markdown ? 8 : 3}
            className="text-md"
            aria-label={title}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              やめる
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onSave(draft.trim());
                setEditing(false);
              }}
            >
              残す
            </Button>
          </div>
        </div>
      ) : value ? (
        markdown ? (
          <MarkdownBody source={value} />
        ) : (
          <p className="max-w-prose text-md text-foreground">{value}</p>
        )
      ) : (
        <p className="text-md text-ink-3">{empty}</p>
      )}
    </section>
  );
}

function DropForm({
  onCancel,
  onDrop,
}: {
  onCancel: () => void;
  onDrop: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onDrop(reason.trim());
      }}
    >
      <Input
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="やめる理由（例：別の項目と重なっていた）"
        aria-label="やめる理由"
        data-testid="backlog-drop-reason"
        className="text-md"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          戻る
        </Button>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!reason.trim()}
          data-testid="backlog-drop-submit"
        >
          やめる
        </Button>
      </div>
    </form>
  );
}
