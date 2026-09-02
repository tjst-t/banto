"use client";

// VaultUI の管理画面（v4-modules.md §2.1 C節、決定・2026-09-02）。banto の
// Configuration ではなく VaultUI という別 Module が描く——複数の vault役割
// 実装（SOPS 組み込み・HashiCorp 等）を横断して alias を確認・編集する。
//
// ここで見せる CRUD 操作はすべて「admin 可視性」——AI には公開せず、host 中継
// 経由で backend の tool を呼ぶ想定（§2.1 C節）。新規登録の「値」はこの画面の
// 入力欄から backend へ渡るだけで、banto のどのストアにも残らない（D3・§2.5の
// 中継規律）——このモックでも値をフォームの外に一切保持しない形で再現する。
import { useMemo, useState } from "react";
import { FolderCog, KeyRound, Pencil, Plus, Search, ShieldCheck, Trash2 } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getAllProjects, getProject } from "@/lib/mock/projects";
import {
  createVaultAlias,
  createVaultGroup,
  deleteVaultAlias,
  getAllVaultAliases,
  getImplementation,
  getVaultGroupBinding,
  getVaultGroups,
  getVaultImplementations,
  setVaultGroupBinding,
  updateVaultAliasNote,
} from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockVaultAlias, MockVaultAliasKind } from "@/lib/mock/types";
import type { ProjectId } from "@/lib/mock/types";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<MockVaultAliasKind, string> = {
  secret: "汎用シークレット",
  "ssh-identity": "SSH 身元",
  file: "ファイル",
};

function ScopeBadge({ alias }: { alias: MockVaultAlias }) {
  if (alias.scope === "instance") {
    return (
      <Badge variant="outline" className="text-xs">
        instance 全体
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs">
      {alias.projectId ? getProject(alias.projectId).name : "(不明な Project)"}
    </Badge>
  );
}

function NoteEditor({ alias }: { alias: MockVaultAlias }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(alias.note ?? "");

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(alias.note ?? "");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${alias.name} の note を編集`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-accent"
        >
          <Pencil className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Label htmlFor={`note-${alias.id}`} className="text-xs text-ink-3">
          何用か——値ではないので AI にも見せてよい（§2.1 A節）
        </Label>
        <Textarea
          id={`note-${alias.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          className="text-sm"
        />
        <div className="flex justify-end gap-1.5">
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            やめる
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              updateVaultAliasNote(alias.id, draft);
              setOpen(false);
            }}
          >
            保存
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NewAliasDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const vaultImpls = getVaultImplementations();
  const projects = getAllProjects();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<MockVaultAliasKind>("secret");
  const [implementationId, setImplementationId] = useState(vaultImpls[0]?.id ?? "");
  const [scope, setScope] = useState<"instance" | "project">("project");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [note, setNote] = useState("");
  // 値はこのフォームの外に出さない——保存も送信もしない（下記コメント参照）
  const [value, setValue] = useState("");

  function reset() {
    setName("");
    setKind("secret");
    setNote("");
    setValue("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>alias を新規登録</DialogTitle>
          <DialogDescription>
            値はこの画面から host 中継を経由して backend へ渡るだけ——banto はどこにも保存しない（D3）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alias-name">名前</Label>
            <Input id="alias-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github-token" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>種別</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as MockVaultAliasKind)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(KIND_LABEL) as MockVaultAliasKind[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>backend</Label>
              <Select value={implementationId} onValueChange={setImplementationId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {vaultImpls.map((impl) => (
                    <SelectItem key={impl.id} value={impl.id}>
                      {impl.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>対象</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as "instance" | "project")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">この Project だけ</SelectItem>
                  <SelectItem value="instance">instance 全体</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {scope === "project" ? (
              <div className="flex flex-col gap-1.5">
                <Label>どの Project か</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alias-note">note（何用か。任意）</Label>
            <Textarea id="alias-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="alias-value">値</Label>
            <Input
              id="alias-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="•••••••••"
              autoComplete="off"
            />
            <p className="text-xs text-ink-3">
              入力しても banto には残らない——このモックでは送信先が無いので、フォームを閉じると同時に消える
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            やめる
          </Button>
          <Button
            type="button"
            disabled={!name || !implementationId || (scope === "project" && !projectId)}
            onClick={() => {
              createVaultAlias({
                name,
                kind,
                implementationId,
                scope,
                projectId: scope === "project" ? projectId : undefined,
                path: `${kind}/${name}`,
                note: note || undefined,
              });
              reset();
              onOpenChange(false);
            }}
          >
            登録する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AUTO_GROUP_VALUE = "__auto__";
const CREATE_GROUP_VALUE = "__create__";

/**
 * Project（または instance 全体）↔ backend グループの紐付け（v4-modules.md
 * §2.1「Project ↔ backend グループの紐付け」）。既存グループから選ぶだけでなく、
 * その場で新しいグループを作る導線も持つ——「既定は自動生成された専用グループ」
 * は Project 作成時の暗黙の1回きりの作成にすぎず、人がいつでも明示的に切り替え
 * られる必要がある
 */
function GroupManageDialog({
  implementationId,
  open,
  onOpenChange,
}: {
  implementationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useMockStoreVersion();
  const impl = getImplementation(implementationId);
  const groups = getVaultGroups(implementationId);
  const projects = getAllProjects();
  const [creatingFor, setCreatingFor] = useState<"instance" | ProjectId | null>(null);
  const [newGroupName, setNewGroupName] = useState("");

  const targets: { key: "instance" | ProjectId; label: string }[] = [
    { key: "instance", label: "instance 全体" },
    ...projects.map((p) => ({ key: p.id, label: p.name })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setCreatingFor(null);
        setNewGroupName("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{impl?.name ?? implementationId} のグループを管理</DialogTitle>
          <DialogDescription>
            Project（または instance 全体）ごとに、この backend のどのグループを使うか紐付ける。2台のホストで
            同じ backend・同じグループを割り当てれば、それが共有の合図になる（v4-modules.md §2.1）。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {targets.map((t) => {
            const binding = getVaultGroupBinding(implementationId, t.key);
            const isCreating = creatingFor === t.key;
            return (
              <div key={t.key} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-sm text-foreground">{t.label}</span>
                {isCreating ? (
                  <div className="flex flex-1 items-center gap-1.5">
                    <Input
                      autoFocus
                      value={newGroupName}
                      onChange={(e) => setNewGroupName(e.target.value)}
                      placeholder="新しいグループ名"
                      className="h-8 flex-1 text-sm"
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={!newGroupName}
                      onClick={() => {
                        createVaultGroup(implementationId, newGroupName);
                        setVaultGroupBinding(implementationId, t.key, newGroupName);
                        setCreatingFor(null);
                        setNewGroupName("");
                      }}
                    >
                      作る
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setCreatingFor(null)}>
                      やめる
                    </Button>
                  </div>
                ) : (
                  <Select
                    value={binding?.groupName ?? AUTO_GROUP_VALUE}
                    onValueChange={(v) => {
                      if (v === CREATE_GROUP_VALUE) {
                        setCreatingFor(t.key);
                        return;
                      }
                      setVaultGroupBinding(implementationId, t.key, v);
                    }}
                  >
                    <SelectTrigger className="h-8 flex-1 text-sm">
                      <SelectValue placeholder="(未設定・自動生成の専用グループ)" />
                    </SelectTrigger>
                    <SelectContent>
                      {!binding ? (
                        <SelectItem value={AUTO_GROUP_VALUE} disabled>
                          (未設定・自動生成の専用グループ)
                        </SelectItem>
                      ) : null}
                      {groups.map((g) => (
                        <SelectItem key={g.name} value={g.name}>
                          {g.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={CREATE_GROUP_VALUE}>＋ 新しいグループを作る…</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            );
          })}
        </div>

        <p className="border-t border-border pt-3 text-xs text-ink-3">
          backend によっては、グループの作成自体に事前の API 呼び出しが要る（例：Infisical の Folder）。
          事前作成が不要な backend（HashiCorp Vault の path プレフィックス等）では、ここでの「作る」は
          単に一覧に加わるだけで実質なにもしない（v4-modules.md §2.1 D節 `createGroup`）
        </p>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VaultManageView() {
  useMockStoreVersion();
  const aliases = getAllVaultAliases();
  const vaultImpls = getVaultImplementations();
  const [newOpen, setNewOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MockVaultAlias | null>(null);
  const [groupManageFor, setGroupManageFor] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | MockVaultAliasKind>("all");
  const [targetFilter, setTargetFilter] = useState("all");
  const [backendFilter, setBackendFilter] = useState("all");

  function targetKeyAndLabel(a: MockVaultAlias): { key: string; label: string } {
    if (a.scope === "instance") return { key: "instance", label: "instance 全体" };
    return { key: a.projectId ?? "", label: a.projectId ? getProject(a.projectId).name : "(不明な Project)" };
  }

  // フィルタの選択肢は、いま実際にある alias から導出する——存在しない選択肢を出さない
  const targetOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of aliases) {
      const { key, label } = targetKeyAndLabel(a);
      map.set(key, label);
    }
    return Array.from(map.entries());
  }, [aliases]);

  const filteredAliases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return aliases.filter((a) => {
      if (kindFilter !== "all" && a.kind !== kindFilter) return false;
      if (backendFilter !== "all" && a.implementationId !== backendFilter) return false;
      if (targetFilter !== "all" && targetKeyAndLabel(a).key !== targetFilter) return false;
      if (q) {
        const impl = vaultImpls.find((i) => i.id === a.implementationId);
        const haystack = [a.name, KIND_LABEL[a.kind], targetKeyAndLabel(a).label, impl?.name ?? "", a.note ?? ""]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [aliases, query, kindFilter, targetFilter, backendFilter, vaultImpls]);

  const filtersActive = query !== "" || kindFilter !== "all" || targetFilter !== "all" || backendFilter !== "all";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-ink-3" />
          <p className="text-sm font-medium text-foreground">Vault を管理</p>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          複数の Vault 実装を横断して確認・編集する（v4-modules.md §2.1）。ここに出るのは alias の存在・種別・
          用途・使用状況だけ——値はどの実装にも表示せず、banto にも残らない
        </p>
      </div>

      <div className="shrink-0 border-b border-border px-4 py-3">
        <p className="mb-2 text-xs font-medium text-ink-3">接続している実装</p>
        <div className="flex flex-wrap gap-2">
          {vaultImpls.map((impl) => (
            <div
              key={impl.id}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs"
            >
              <span className="text-foreground">{impl.name}</span>
              <Badge variant="outline" className="text-xs">
                {impl.isolation}
              </Badge>
              <span className="text-ink-3">{aliases.filter((a) => a.implementationId === impl.id).length} alias</span>
              <button
                type="button"
                onClick={() => setGroupManageFor(impl.id)}
                className="flex items-center gap-1 rounded text-ink-3 hover:text-foreground"
                title="Project ↔ グループの紐付けを管理"
              >
                <FolderCog className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-medium text-ink-3">
            alias 一覧（{filtersActive ? `${filteredAliases.length} / ${aliases.length}` : aliases.length}）
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => setNewOpen(true)}>
            <Plus className="size-3.5" /> alias を新規登録
          </Button>
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名前・種別・対象・backend・note を横断して検索"
              className="h-8 pl-7 text-sm"
            />
          </div>
          <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as "all" | MockVaultAliasKind)}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">種別：すべて</SelectItem>
              {(Object.keys(KIND_LABEL) as MockVaultAliasKind[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={targetFilter} onValueChange={setTargetFilter}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">対象：すべて</SelectItem>
              {targetOptions.map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={backendFilter} onValueChange={setBackendFilter}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">backend：すべて</SelectItem>
              {vaultImpls.map((impl) => (
                <SelectItem key={impl.id} value={impl.id}>
                  {impl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtersActive ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setKindFilter("all");
                setTargetFilter("all");
                setBackendFilter("all");
              }}
            >
              フィルタを解除
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="border-b border-border text-left text-ink-3">
                <th className="px-2.5 py-2 font-medium">名前</th>
                <th className="px-2.5 py-2 font-medium">種別</th>
                <th className="px-2.5 py-2 font-medium">対象</th>
                <th className="px-2.5 py-2 font-medium">backend</th>
                <th className="px-2.5 py-2 font-medium">note</th>
                <th className="px-2.5 py-2 font-medium">最終使用</th>
                <th className="px-2.5 py-2 font-medium">期限</th>
                <th className="px-2.5 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filteredAliases.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-2.5 py-6 text-center text-ink-3">
                    条件に合う alias がありません
                  </td>
                </tr>
              ) : null}
              {filteredAliases.map((a) => {
                const impl = vaultImpls.find((i) => i.id === a.implementationId);
                return (
                  <tr key={a.id} className="border-b border-border last:border-b-0">
                    <td className="px-2.5 py-2">
                      <span className="flex items-center gap-1.5 font-mono text-ink-2">
                        <KeyRound className="size-3 shrink-0 text-ink-3" />${a.name}
                      </span>
                    </td>
                    <td className="px-2.5 py-2">
                      <Badge variant="outline" className="text-xs">
                        {KIND_LABEL[a.kind]}
                      </Badge>
                    </td>
                    <td className="px-2.5 py-2">
                      <ScopeBadge alias={a} />
                    </td>
                    <td className={cn("px-2.5 py-2 text-ink-3", !impl && "text-stop")}>
                      {impl?.name ?? "(不明な backend)"}
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate text-ink-3">{a.note ?? "—"}</span>
                        <NoteEditor alias={a} />
                      </div>
                    </td>
                    <td className="px-2.5 py-2 text-ink-3">{a.lastUsedAt ?? "—"}</td>
                    <td className="px-2.5 py-2 text-ink-3">{a.expiresAt ?? "—"}</td>
                    <td className="px-2.5 py-2">
                      <button
                        type="button"
                        aria-label={`${a.name} を削除`}
                        onClick={() => setDeleteTarget(a)}
                        className="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-4 py-2.5 text-xs text-ink-3">
        VaultUI Module が描く、Vault 実装を横断する管理画面（admin 可視性——AI には見せない）
      </div>

      <NewAliasDialog open={newOpen} onOpenChange={setNewOpen} />

      {groupManageFor ? (
        <GroupManageDialog
          implementationId={groupManageFor}
          open={groupManageFor !== null}
          onOpenChange={(o) => !o && setGroupManageFor(null)}
        />
      ) : null}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteTarget?.name} を削除しますか</AlertDialogTitle>
            <AlertDialogDescription>
              値も含めて backend から削除する——値そのものはこの画面にもともと出ていない。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) deleteVaultAlias(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
