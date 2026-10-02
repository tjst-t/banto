"use client";

// Backlog の2つのフォーム：「追加」（createItem、1件）と「タスクに分ける」（splitStory、ストーリーの下に複数を
// タスク間の依存つきで1回で）。モックなのでメモリ上の見本データに足すだけ。
import { useState, type FormEvent, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import { cn } from "@/lib/utils";
import {
  createItem,
  isClosed,
  splitStory,
  type BacklogFile,
  type BacklogItem,
  type BacklogKind,
  type BacklogPriority,
  type BacklogStatus,
} from "@/lib/mock/backlog";
import { KIND_LABEL, KindMark, LabelChip, PRIORITY_LABEL, STATUS_LABEL } from "./backlog-parts";

const NONE = "none";

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
      </label>
      {children}
    </div>
  );
}

/** 依存の相手を1つずつ選んで足す。選んだものは札で並べ、× で外す */
export function DependencyPicker({
  candidates,
  value,
  onChange,
  triggerLabel = "待つものを足す",
}: {
  candidates: readonly BacklogItem[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  triggerLabel?: string;
}) {
  const left = candidates.filter((c) => !value.includes(c.id));
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => {
            const item = candidates.find((c) => c.id === id);
            return (
              <LabelChip key={id} onRemove={() => onChange(value.filter((v) => v !== id))}>
                {item?.title ?? id}
              </LabelChip>
            );
          })}
        </div>
      ) : null}
      <Select value="" onValueChange={(id) => onChange([...value, id])} disabled={left.length === 0}>
        <SelectTrigger size="sm" className="w-full text-xs" aria-label={triggerLabel}>
          <SelectValue placeholder={triggerLabel} />
        </SelectTrigger>
        <SelectContent>
          {left.map((c) => (
            <SelectItem key={c.id} value={c.id} className="text-xs">
              <KindMark kind={c.kind} />
              <span className="truncate">{c.title}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AddItemDialog({
  projectId,
  file,
  initialKind,
  initialParent,
  onClose,
  onCreated,
}: {
  projectId: string;
  file: BacklogFile;
  initialKind: BacklogKind;
  initialParent?: string;
  onClose: () => void;
  onCreated: (item: BacklogItem) => void;
}) {
  const [kind, setKind] = useState<BacklogKind>(initialKind);
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState<string>(initialParent ?? NONE);
  const [milestone, setMilestone] = useState<string>(NONE);
  const [priority, setPriority] = useState<BacklogPriority>("normal");
  const [status, setStatus] = useState<BacklogStatus>("backlog");
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [doneWhen, setDoneWhen] = useState("");
  const [body, setBody] = useState("");

  const stories = file.items.filter((i) => i.kind === "story" && !isClosed(i));
  const hasParent = kind === "task" && parent !== NONE;
  const ready = title.trim() !== "";

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const item = createItem(projectId, {
      kind,
      title: title.trim(),
      status,
      parent: hasParent ? parent : null,
      milestone: milestone === NONE ? null : milestone,
      priority,
      dependsOn,
      doneWhen: doneWhen.trim(),
      body: body.trim(),
    });
    toast(`${KIND_LABEL[kind]}「${item.title}」を足しました`);
    onCreated(item);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-testid="backlog-add-dialog">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>項目を足す</DialogTitle>
            <DialogDescription>{file.path} の末尾（いちばん低い優先）に足します。並び順はあとで動かせます。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field label="種類">
              <ChoicePills
                label="種類"
                testId="backlog-add-kind"
                value={kind}
                onChange={setKind}
                choices={(["story", "task", "bug"] as const).map((k) => ({
                  value: k,
                  label: (
                    <>
                      <KindMark kind={k} />
                      {KIND_LABEL[k]}
                    </>
                  ),
                }))}
              />
            </Field>
            <Field label="題" htmlFor="backlog-add-title">
              <Input
                id="backlog-add-title"
                data-testid="backlog-add-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
                placeholder={kind === "bug" ? "何が起きるか" : "何をするか"}
              />
            </Field>
            {kind === "task" ? (
              <Field label="どのストーリーの下か">
                <Select value={parent} onValueChange={setParent}>
                  <SelectTrigger className="w-full" aria-label="どのストーリーの下か">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>ストーリーに属さない</SelectItem>
                    {stories.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {hasParent || file.milestones.length === 0 ? null : (
                <Field label="マイルストーン">
                  <Select value={milestone} onValueChange={setMilestone}>
                    <SelectTrigger className="w-full" aria-label="マイルストーン">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>マイルストーン無し</SelectItem>
                      {file.milestones.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
              <Field label="状態">
                <ChoicePills
                  label="状態"
                  value={status}
                  onChange={setStatus}
                  choices={(["backlog", "ready"] as const).map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
                />
              </Field>
              <Field label="優先度">
                <ChoicePills
                  label="優先度"
                  value={priority}
                  onChange={setPriority}
                  choices={(["high", "normal", "low"] as const).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
                />
              </Field>
            </div>
            <Field label="これが終わるまで始められないもの">
              <DependencyPicker
                candidates={file.items.filter((i) => !isClosed(i))}
                value={dependsOn}
                onChange={setDependsOn}
              />
            </Field>
            <Field label="完了条件" htmlFor="backlog-add-done-when">
              <Textarea
                id="backlog-add-done-when"
                value={doneWhen}
                onChange={(e) => setDoneWhen(e.target.value)}
                rows={2}
                placeholder="何を測れば終わったと言えるか"
              />
            </Field>
            <Field label="本文（Markdown）" htmlFor="backlog-add-body">
              <Textarea
                id="backlog-add-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder="なぜ・経緯・確かめ方など"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取り消し
            </Button>
            <Button type="submit" disabled={!ready} data-testid="backlog-add-submit">
              足す
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Draft {
  key: number;
  title: string;
  doneWhen: string;
  waitsFor: number[];
}

/**
 * ストーリーをタスクに分ける（splitStory）。行ごとに題・完了条件と、同じ回に作る前の行のうち
 * どれを待つかを選ぶ——一番よく使う「順に積む」は、行を足すと前の行を待つ形で入れておく
 */
export function SplitStoryDialog({
  projectId,
  story,
  onClose,
}: {
  projectId: string;
  story: BacklogItem;
  onClose: () => void;
}) {
  const [drafts, setDrafts] = useState<Draft[]>([
    { key: 0, title: "", doneWhen: "", waitsFor: [] },
    { key: 1, title: "", doneWhen: "", waitsFor: [0] },
  ]);
  const filled = drafts.filter((d) => d.title.trim() !== "");

  function patch(index: number, next: Partial<Draft>) {
    setDrafts((ds) => ds.map((d, i) => (i === index ? { ...d, ...next } : d)));
  }

  function remove(index: number) {
    setDrafts((ds) =>
      ds
        .filter((_, i) => i !== index)
        .map((d) => ({
          ...d,
          waitsFor: d.waitsFor.filter((w) => w !== index).map((w) => (w > index ? w - 1 : w)),
        })),
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (filled.length === 0) return;
    // 題が空の行は飛ばす——飛ばした行を待っていた分は、詰めた番号へ付け替える
    const kept = drafts.map((d, i) => ({ d, i })).filter(({ d }) => d.title.trim() !== "");
    const renumber = new Map(kept.map(({ i }, n) => [i, n]));
    const created = splitStory(
      projectId,
      story.id,
      kept.map(({ d }) => ({
        title: d.title.trim(),
        doneWhen: d.doneWhen.trim(),
        waitsFor: d.waitsFor.map((w) => renumber.get(w)).filter((w): w is number => w !== undefined),
      })),
    );
    toast(`「${story.title}」の下に ${created.length} 件のタスクを作りました`);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="sm:max-w-2xl" data-testid="backlog-split-dialog">
        <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>タスクに分ける</DialogTitle>
            <DialogDescription>
              「{story.title}」の下に、まとめてタスクを作ります。作ったタスクは「準備できた」で入ります。
            </DialogDescription>
          </DialogHeader>
          <ol className="flex flex-col gap-3">
            {drafts.map((d, i) => (
              <li
                key={d.key}
                data-testid="backlog-split-row"
                className="flex flex-col gap-2 rounded-md border border-border p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-xs text-ink-3 tabular-nums">{i + 1}</span>
                  <Input
                    value={d.title}
                    onChange={(e) => patch(i, { title: e.target.value })}
                    placeholder="タスクの題"
                    aria-label={`${i + 1} 番目の題`}
                    autoFocus={i === 0}
                    className="h-8 text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(i)}
                    disabled={drafts.length === 1}
                    aria-label={`${i + 1} 番目を外す`}
                  >
                    <X />
                  </Button>
                </div>
                <div className="flex flex-col gap-2 pl-7">
                  <Input
                    value={d.doneWhen}
                    onChange={(e) => patch(i, { doneWhen: e.target.value })}
                    placeholder="完了条件（なくてもよい）"
                    aria-label={`${i + 1} 番目の完了条件`}
                    className="h-8 text-xs"
                  />
                  {i > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                      <span>待つもの</span>
                      {drafts.slice(0, i).map((_, j) => {
                        const on = d.waitsFor.includes(j);
                        return (
                          <button
                            key={j}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              patch(i, { waitsFor: on ? d.waitsFor.filter((w) => w !== j) : [...d.waitsFor, j] })
                            }
                            className={cn(
                              "rounded-sm border px-1.5 tabular-nums focus-visible:outline-2 focus-visible:outline-ring",
                              on ? "border-foreground text-foreground" : "border-border text-ink-3 hover:text-ink-2",
                            )}
                          >
                            {j + 1} 番目
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() =>
              setDrafts((ds) => [
                ...ds,
                { key: (ds.at(-1)?.key ?? 0) + 1, title: "", doneWhen: "", waitsFor: ds.length > 0 ? [ds.length - 1] : [] },
              ])
            }
          >
            <Plus />
            行を足す
          </Button>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              取り消し
            </Button>
            <Button type="submit" disabled={filled.length === 0} data-testid="backlog-split-submit">
              {filled.length > 0 ? `${filled.length} 件のタスクを作る` : "タスクを作る"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
