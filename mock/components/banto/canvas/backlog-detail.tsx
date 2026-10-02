"use client";

// Backlog の1件の詳細。この画面でいちばん目に残したいのは依存の並び——「これが待っているもの → これ →
// これを待っているもの」を縦に1本で見せる。ほかの欄は既存の画面と同じく静かに並べる。
//
// 閉じる操作は「終わった」「やめた（理由を書く）」の2つだけ。消す操作は無い（§4.4）。
// ストーリーは子が全部終わっても自動では閉じない——案内を出し、閉じるのは人が押す。
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ChevronLeft, CirclePlay, Hourglass, MessageSquare, Split, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { getThread } from "@/lib/mock/threads";
import {
  childrenOf,
  dependents,
  isActionable,
  isClosed,
  updateItem,
  waitingOn,
  type BacklogFile,
  type BacklogItem,
  type BacklogKind,
  type BacklogPatch,
  type BacklogPriority,
  type BacklogStatus,
} from "@/lib/mock/backlog";
import {
  ItemChip,
  KIND_LABEL,
  KindMark,
  LabelChip,
  MarkdownBody,
  OPEN_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  StatusText,
  formatDate,
} from "./backlog-parts";
import { DependencyPicker } from "./backlog-forms";

const NONE = "none";

export function BacklogDetail({
  projectId,
  file,
  item,
  onOpen,
  onClose,
  onSplit,
}: {
  projectId: string;
  file: BacklogFile;
  item: BacklogItem;
  onOpen: (id: string) => void;
  onClose: () => void;
  onSplit: () => void;
}) {
  const items = file.items;
  const update = (patch: BacklogPatch) => updateItem(projectId, item.id, patch);
  const kids = item.kind === "story" ? childrenOf(item, items) : [];
  const parent = item.parent ? items.find((i) => i.id === item.parent) : undefined;
  const stories = items.filter((i) => i.kind === "story" && i.id !== item.id);

  return (
    <article data-testid="backlog-detail" data-item-id={item.id} className="flex flex-col gap-5 px-4 py-4 @lg:px-5 @lg:py-5">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 @3xl:hidden" onClick={onClose} data-testid="backlog-detail-back">
          <ChevronLeft />
          一覧
        </Button>
        <span className="truncate font-mono text-xs text-ink-3" title="tasks.json の中の名前">
          {item.id}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden @3xl:inline-flex"
          onClick={onClose}
          aria-label="詳細を閉じる"
        >
          <X />
        </Button>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Select
            value={item.kind}
            onValueChange={(v) => update({ kind: v as BacklogKind })}
            // 子を持つストーリーは種類を変えられない（子の親が宙に浮く）
            disabled={kids.length > 0}
          >
            <SelectTrigger size="sm" className="text-xs" aria-label="種類">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["story", "task", "bug"] as const).map((k) => (
                <SelectItem key={k} value={k} className="text-xs">
                  <KindMark kind={k} />
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {parent ? (
            <button
              type="button"
              onClick={() => onOpen(parent.id)}
              className="truncate rounded-sm text-xs text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              「{parent.title}」の下
            </button>
          ) : null}
        </div>
        <TitleEditor key={item.id} title={item.title} onSave={(title) => update({ title })} />
      </header>

      <StatusControl key={`status-${item.id}`} item={item} kids={kids} update={update} />

      <DependencyChain projectId={projectId} file={file} item={item} onOpen={onOpen} />

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-xs">
        <dt className="text-ink-3">優先度</dt>
        <dd>
          <Select value={item.priority} onValueChange={(v) => update({ priority: v as BacklogPriority })}>
            <SelectTrigger size="sm" className="text-xs" aria-label="優先度">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["high", "normal", "low"] as const).map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {PRIORITY_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </dd>
        {file.milestones.length > 0 ? (
          <>
            <dt className="text-ink-3">マイルストーン</dt>
            <dd>
              <Select
                value={item.milestone ?? NONE}
                onValueChange={(v) => update({ milestone: v === NONE ? null : v })}
              >
                <SelectTrigger size="sm" className="max-w-full text-xs" aria-label="マイルストーン">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} className="text-xs">
                    マイルストーン無し
                  </SelectItem>
                  {file.milestones.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>
          </>
        ) : null}
        {item.kind === "task" ? (
          <>
            <dt className="text-ink-3">ストーリー</dt>
            <dd>
              <Select value={item.parent ?? NONE} onValueChange={(v) => update({ parent: v === NONE ? null : v })}>
                <SelectTrigger size="sm" className="max-w-full text-xs" aria-label="どのストーリーの下か">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE} className="text-xs">
                    ストーリーに属さない
                  </SelectItem>
                  {stories.map((s) => (
                    <SelectItem key={s.id} value={s.id} className="text-xs">
                      {s.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>
          </>
        ) : null}
        <dt className="self-start pt-1 text-ink-3">ラベル</dt>
        <dd>
          <LabelEditor key={item.id} labels={item.labels} onChange={(labels) => update({ labels })} />
        </dd>
      </dl>

      {item.kind === "story" ? (
        <Block
          title="タスク"
          aside={
            <Button variant="outline" size="xs" onClick={onSplit} data-testid="backlog-split-open">
              <Split />
              タスクに分ける
            </Button>
          }
        >
          {kids.length === 0 ? (
            <p className="text-xs text-ink-3">まだタスクに分けていません。実装するときに分けます。</p>
          ) : (
            <ul className="flex flex-col gap-1.5" data-testid="backlog-detail-children">
              {kids.map((k) => (
                <li key={k.id}>
                  <ItemChip item={k} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          )}
        </Block>
      ) : null}

      <TextBlock
        key={`done-when-${item.id}`}
        title="完了条件"
        value={item.doneWhen}
        empty="まだ書いていません。「実装した」ではなく、何を測れば終わりかで書きます。"
        rows={3}
        onSave={(doneWhen) => update({ doneWhen })}
      />
      <TextBlock
        key={`body-${item.id}`}
        title="本文"
        value={item.body}
        empty="なぜ・経緯・確かめ方などを Markdown で書けます。"
        rows={8}
        markdown
        onSave={(body) => update({ body })}
      />

      {item.refs.length > 0 ? (
        <Block title="参照">
          <ul className="flex flex-col gap-1">
            {item.refs.map((r) => (
              <li key={r} className="font-mono text-xs break-all text-ink-2">
                {r}
              </li>
            ))}
          </ul>
        </Block>
      ) : null}

      <Block title="取り組んだ Thread">
        {item.threads.length === 0 ? (
          <p className="text-xs text-ink-3">まだどの Thread でも取り組んでいません。</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="backlog-threads">
            {item.threads.map((t) => {
              const thread = getThread(t.threadId);
              const href = thread?.kind === "fork" ? `/p/${t.projectId}?fork=${t.threadId}` : `/p/${t.projectId}`;
              return (
                <li key={`${t.projectId}:${t.threadId}`}>
                  <Link
                    href={href}
                    className="inline-flex items-center gap-1.5 rounded-sm text-xs text-ink-2 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <MessageSquare className="size-3 text-ink-3" />
                    {thread?.title ?? t.threadId}
                    {thread?.kind === "base" ? <span className="text-ink-3">（Base Thread）</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Block>

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-ink-3">
        <dt>作った</dt>
        <dd className="tabular-nums">{formatDate(item.createdAt)}</dd>
        <dt>変えた</dt>
        <dd className="tabular-nums">{formatDate(item.updatedAt)}</dd>
        {item.closedAt ? (
          <>
            <dt>閉じた</dt>
            <dd className="tabular-nums">{formatDate(item.closedAt)}</dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}

function Block({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-ink-2">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function TitleEditor({ title, onSave }: { title: string; onSave: (title: string) => void }) {
  const [draft, setDraft] = useState(title);
  function commit() {
    const t = draft.trim();
    if (t === "" || t === title) setDraft(title);
    else onSave(t);
  }
  return (
    <Textarea
      data-testid="backlog-detail-title"
      aria-label="題"
      value={draft}
      rows={1}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(title);
          e.currentTarget.blur();
        }
      }}
      className="field-sizing-content min-h-0 resize-none border-transparent px-1 -mx-1 py-0.5 text-lg font-semibold text-foreground shadow-none md:text-lg hover:border-border dark:bg-transparent"
    />
  );
}

/**
 * 状態。開いているあいだは「積んだだけ／準備できた／進めている」を選び、閉じるのは別の2つのボタン。
 * 閉じたあとは「開き直す」だけ（状態の欄は出さない）
 */
function StatusControl({
  item,
  kids,
  update,
}: {
  item: BacklogItem;
  kids: readonly BacklogItem[];
  update: (patch: BacklogPatch) => void;
}) {
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState("");
  const closed = isClosed(item);
  const kidsAllClosed = kids.length > 0 && kids.every(isClosed);

  if (closed) {
    return (
      <div
        data-testid="backlog-closed"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <StatusText status={item.status} />
          {item.status === "dropped" ? (
            <p className="text-xs text-ink-2">{item.resolution ? `理由：${item.resolution}` : "理由は書いていません"}</p>
          ) : null}
        </div>
        <Button variant="ghost" size="xs" onClick={() => update({ status: "ready" })}>
          開き直す
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={item.status} onValueChange={(v) => update({ status: v as BacklogStatus })}>
          <SelectTrigger size="sm" className="text-xs" aria-label="状態" data-testid="backlog-detail-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPEN_STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="xs" onClick={() => update({ status: "done" })} data-testid="backlog-close-done">
            終わった
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setDropping(true)}
            disabled={dropping}
            data-testid="backlog-close-dropped"
          >
            やめた
          </Button>
        </div>
      </div>
      {kidsAllClosed && !dropping ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs text-ink-2">
          子のタスクは全部終わりました。このストーリーも閉じますか
          <Button variant="outline" size="xs" onClick={() => update({ status: "done" })}>
            終わったにする
          </Button>
        </div>
      ) : null}
      {dropping ? (
        <form
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update({ status: "dropped", resolution: reason.trim() || null });
          }}
        >
          <label htmlFor="backlog-drop-reason" className="text-xs font-medium text-ink-2">
            やめる理由
          </label>
          <Textarea
            id="backlog-drop-reason"
            data-testid="backlog-drop-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            autoFocus
            placeholder="重複・やらないと決めた、など"
          />
          <div className="flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={() => setDropping(false)}>
              取り消し
            </Button>
            <Button type="submit" size="xs" disabled={reason.trim() === ""} data-testid="backlog-drop-submit">
              やめる
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** 待っているもの → これ → これを待っているもの */
function DependencyChain({
  projectId,
  file,
  item,
  onOpen,
}: {
  projectId: string;
  file: BacklogFile;
  item: BacklogItem;
  onOpen: (id: string) => void;
}) {
  const items = file.items;
  const deps = item.dependsOn.map((id) => items.find((i) => i.id === id)).filter((i): i is BacklogItem => !!i);
  const after = dependents(item, items);
  const waiting = waitingOn(item, items);
  const actionable = isActionable(item, items);
  // 張ると輪になる相手（これを直接・間接に待っているもの）は候補から外す
  const downstream = new Set<string>();
  const queue = [item.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const d of items.filter((i) => i.dependsOn.includes(id))) {
      if (!downstream.has(d.id)) {
        downstream.add(d.id);
        queue.push(d.id);
      }
    }
  }
  const candidates = items.filter((i) => i.id !== item.id && !downstream.has(i.id) && !isClosed(i));
  const addDependency = ([id]: string[]) =>
    id && updateItem(projectId, item.id, { dependsOn: [...item.dependsOn, id] });

  // どちら向きにも無ければ、並びを描かずに1行で言う（空の箱と矢印は飾りになる）
  if (deps.length === 0 && after.length === 0) {
    return (
      <section aria-labelledby="backlog-deps-title" data-testid="backlog-deps" className="flex flex-col gap-2">
        <h4 id="backlog-deps-title" className="text-xs font-medium text-ink-2">
          依存
        </h4>
        <p className="text-xs text-ink-3">待っているものも、これを待っているものもありません。</p>
        <DependencyPicker candidates={candidates} value={[]} onChange={addDependency} />
      </section>
    );
  }

  return (
    <section aria-labelledby="backlog-deps-title" data-testid="backlog-deps" className="flex flex-col gap-2">
      <h4 id="backlog-deps-title" className="text-xs font-medium text-ink-2">
        依存
      </h4>
      <div className="flex flex-col items-stretch gap-1 rounded-md bg-surface-2 p-3">
        <p className="text-xs text-ink-3">これが待っているもの</p>
        {deps.length === 0 ? (
          <p className="text-xs text-ink-3">ありません</p>
        ) : (
          <ul className="flex flex-col gap-1.5" data-testid="backlog-deps-before">
            {deps.map((d) => (
              <li key={d.id} className="flex items-center gap-1">
                <ItemChip item={d} onOpen={onOpen} />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`「${d.title}」を待つのをやめる`}
                  onClick={() => updateItem(projectId, item.id, { dependsOn: item.dependsOn.filter((x) => x !== d.id) })}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="pr-7">
          <DependencyPicker
            candidates={candidates}
            value={[]}
            onChange={addDependency}
          />
        </div>

        <ArrowDown aria-hidden className="mx-auto my-1 size-4 text-ink-3" />

        <div
          data-testid="backlog-deps-self"
          className="flex flex-col gap-1 rounded-md border border-foreground bg-background px-3 py-2"
        >
          <span className="flex items-start gap-2">
            <KindMark kind={item.kind} className="mt-1" />
            <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-foreground">{item.title}</span>
            <StatusText status={item.status} className="mt-0.5" />
          </span>
          {isClosed(item) ? null : actionable ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
              <CirclePlay className="size-3" />
              待つものは全部終わっています。着手できます
            </span>
          ) : waiting.length > 0 ? (
            <span data-testid="backlog-deps-waiting" className="inline-flex items-center gap-1 text-xs text-ink-2">
              <Hourglass className="size-3 text-warn" />
              まだ {waiting.length} 件が終わっていません
            </span>
          ) : item.status === "backlog" ? (
            <span className="text-xs text-ink-3">待つものはありません。準備ができたら「準備できた」に</span>
          ) : null}
        </div>

        <ArrowDown aria-hidden className="mx-auto my-1 size-4 text-ink-3" />

        <p className="text-xs text-ink-3">これを待っているもの</p>
        {after.length === 0 ? (
          <p className="text-xs text-ink-3">ありません</p>
        ) : (
          <ul className="flex flex-col gap-1.5 pr-7" data-testid="backlog-deps-after">
            {after.map((d) => (
              <li key={d.id}>
                <ItemChip item={d} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function LabelEditor({ labels, onChange }: { labels: readonly string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <LabelChip key={l} onRemove={() => onChange(labels.filter((x) => x !== l))}>
          {l}
        </LabelChip>
      ))}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            const l = draft.trim();
            if (l !== "" && !labels.includes(l)) onChange([...labels, l]);
            setDraft("");
          }
        }}
        placeholder="ラベルを足す"
        aria-label="ラベルを足す"
        className="h-6 w-28 px-1.5 text-xs"
      />
    </div>
  );
}

function TextBlock({
  title,
  value,
  empty,
  rows,
  markdown = false,
  onSave,
}: {
  title: string;
  value: string;
  empty: string;
  rows: number;
  markdown?: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  return (
    <Block
      title={title}
      aside={
        editing ? null : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            {value ? "直す" : "書く"}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={rows}
            autoFocus
            aria-label={title}
            className={cn("text-xs", markdown && "font-mono")}
          />
          <div className="flex justify-end gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              取り消し
            </Button>
            <Button
              size="xs"
              onClick={() => {
                onSave(draft.trim());
                setEditing(false);
              }}
            >
              保存
            </Button>
          </div>
        </div>
      ) : value ? (
        markdown ? (
          <MarkdownBody source={value} />
        ) : (
          <p className="text-sm text-ink-2">{value}</p>
        )
      ) : (
        <p className="text-xs text-ink-3">{empty}</p>
      )}
    </Block>
  );
}
