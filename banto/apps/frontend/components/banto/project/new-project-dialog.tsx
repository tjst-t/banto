"use client";

// 新規 Project の作成（§2.2）。既定で見せるのは名前・Root パスだけ、
// Advanced に開くと Configuration の上書き——§2.2「設定のカスケード」の
// 対象になる項目は全部出す（Project 設定画面の階層2と同じ集合・同じ
// CascadeRow）。一部だけ出すと「他の項目はここでは上書きできない」という
// 誤解を生む
//
// **Root にするフォルダの始め方**（段階4・2026-10-03、`docs/specs/v4-modules.md` §2.4「core との境目」、モックの
// `new-project-dialog.tsx`）：core が持つのは「手元のフォルダ」だけ。ほかのタブは、banto 全体の Module が
// 「フォルダを用意できる」と名乗った画面（資源の `_meta["dev.banto/canvas"] = "folder-provider"`）——**タブの名前・
// 説明・アイコンは Module が名乗ったもの**（core は「clone」という言葉を持たない）。中は Module の画面で、core の
// 画面の中の「よそ様の画面」と分かるように点線の枠と出所を付ける。Module の画面が `dev.banto/folder-prepared` で
// フォルダを返したら、core が下の段（Project 名・Advanced）を出して作る。そのフォルダをもう Project が使っていれば、
// 新しくは作らずにそれを開く（core が自分で調べる）。名乗る Module が無ければ、タブは出ない
//
// **どこで動かすか**（決定・2026-10-08、`docs/specs/v4-security.md` §1「登録と選び方」。画面はモックの `RuntimeStep` の形で
// 決定・2026-10-10）：一番上で選ぶ。既定はこの機械のコンテナ。登録した別のサーバのうち選べないものは、host が言う理由を
// 添えて薄く出す（隠すと「登録したのに出てこない」になる）。別のサーバでは、Root は向こうのフォルダ（host が SSH で名前
// だけを引く）で、Module が名乗る始め方（clone 等）は出さない——向こうのフォルダは Repositories が扱わない（最初の版）。
// 実行場所は作ったあとに変えられない
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, CircleCheck, FolderOpen, Server, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CascadeRow } from "@/components/banto/settings/cascade-row";
import { cn } from "@/lib/utils";
import { HOST_SOURCE_WITH_CREATE, PathPicker, type FolderSource } from "@/components/banto/settings/path-picker";
import { sshTarget } from "@/components/banto/settings/runtimes-panel";
import {
  WideRootWarning,
  useRootScope,
} from "@/components/banto/settings/wide-root-warning";
import { createRealProject, getAllProjects, reopenProject } from "@/lib/mock/projects";
import {
  HOST_CONTAINER_RUNTIME,
  listRealFolderProviders,
  createRealRuntimeDirectory,
  listRealRuntimeDirectories,
  listRealRuntimes,
  remoteRuntimeName,
  type RealFolderProvider,
  type RealRemoteRuntime,
} from "@/lib/backend/client";
import { CONNECTED_FEATURES } from "@/lib/feature-flags";
import type { PreparedFolder } from "@/lib/backend/canvas-folder-prepared";
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { getRoles, mockCredentials, mockRuntimeDefaults } from "@/lib/mock/settings";
import type { MockProjectOverrides } from "@/lib/mock/types";

type Overrides = Omit<MockProjectOverrides, "projectId" | "securityRoot">;

const EMPTY_OVERRIDES: Overrides = {};

export function NewProjectDialog({
  open,
  onOpenChange,
  initialName = "",
  initialBasePath = "",
  requestedBy,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Module の画面が「このフォルダで」と頼んできたとき（`dev.banto/open-new-project`、
   * `lib/backend/canvas-new-project.ts`）だけ入る。人が確かめて変えられる——作るのは人が押したとき
   */
  initialName?: string;
  initialBasePath?: string;
  /** 頼んできた Module の名前（出所を見せる——作るのは人が確かめて押したとき） */
  requestedBy?: string;
  /** 作った（か、既にある Project を開いた）——閉じる前に呼ぶ。頼まれて開いたとき、断ったのかを見分ける */
  onCreated?: () => void;
}) {
  const router = useRouter();
  /** 人が打った名前。打つまでは、用意されたフォルダの名前の既定に合わせる */
  const [typedName, setName] = useState<string | null>(initialName ? initialName : null);
  // 始め方：`folder`（core の手元のフォルダ）か、Module が名乗った `<server>|<resourceUri>`
  const [providers, setProviders] = useState<RealFolderProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [method, setMethod] = useState<string>("folder");
  const [prepared, setPrepared] = useState<{ method: string; folder: PreparedFolder } | null>(null);
  /** 「別のフォルダにする」で Module の画面を初めからにする */
  const [surfaceKey, setSurfaceKey] = useState(0);
  // どこで動かすか：`host-container` か `remote:<名前>`
  const [runtime, setRuntime] = useState<string>(HOST_CONTAINER_RUNTIME);
  const [runtimes, setRuntimes] = useState<RealRemoteRuntime[] | null>(null);
  const [runtimesError, setRuntimesError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRealFolderProviders().then(
      (list) => !cancelled && setProviders(list),
      (err: unknown) => !cancelled && setProvidersError(err instanceof Error ? err.message : String(err)),
    );
    if (CONNECTED_FEATURES.remoteRuntimes) {
      listRealRuntimes().then(
        (list) => !cancelled && setRuntimes(list),
        (err: unknown) => !cancelled && setRuntimesError(err instanceof Error ? err.message : String(err)),
      );
    }
    return () => {
      cancelled = true;
    };
  }, [open]);
  const remoteName = remoteRuntimeName(runtime);
  // 「選ぶ」の画面の「新しいフォルダ」はその場で作る（この機械も別のサーバも。追加・2026-10-20、ユーザー）。引き方は実行場所が
  // 替わったときだけ作り直す（描くたびに作ると、一覧の読み込みが描くたびに走る）
  const folderSource: FolderSource = useMemo(
    () =>
      remoteName
        ? {
            list: (path?: string) => listRealRuntimeDirectories(remoteName, path),
            create: (parent: string, name: string) => createRealRuntimeDirectory(remoteName, parent, name),
            where: remoteName,
          }
        : HOST_SOURCE_WITH_CREATE,
    [remoteName],
  );
  const providerKey = (p: RealFolderProvider) => `${p.server}|${p.resourceUri}`;
  // 別のサーバでは、フォルダを用意する Module（Repositories の clone など）は使えない——向こうのフォルダを選ぶだけ
  const visibleProviders = remoteName ? [] : (providers ?? []);
  const provider = visibleProviders.find((p) => providerKey(p) === method);
  // **初期値は入れない**（改訂・2026-09-11、ユーザー指摘）——`~/worktrees/` を
  // 置いていたが、その場所を使うかどうかは人が決めること。空にしておけば、
  // 「選ぶ」は home から始まる（host の既定、`resolveBrowsePath`）。Module の画面から頼まれたときだけ入る
  const [basePath, setBasePath] = useState(initialBasePath);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>(EMPTY_OVERRIDES);

  function patch(next: Partial<Overrides>) {
    setOverrides((prev) => ({ ...prev, ...next }));
  }

  function reset() {
    setName(null);
    setRuntime(HOST_CONTAINER_RUNTIME);
    setBasePath("");
    setShowAdvanced(false);
    setOverrides(EMPTY_OVERRIDES);
    setMethod("folder");
    setPrepared(null);
  }

  const ready = provider && prepared?.method === method ? prepared.folder : null;
  const root = provider ? (ready?.path ?? "") : basePath.trim();
  // **Module が用意したフォルダにも広い根の警告を出す**（2026-10-03、レビュー）——第三者の Module が `/home/u` や `/` を
  // 返すことはありうる。手元のフォルダと同じ判断（host の `/api/config/root-scope`）で
  const rootScope = useRootScope(root, remoteName);
  const name = typedName ?? (ready ? (ready.suggestedName ?? ready.path.split("/").pop() ?? "") : "");
  // そのフォルダを、もう Project が Root にしているか——core が自分で調べる（Module に聞かない）。
  // **実行場所が違えば、同じパスでも別のフォルダ**（向こうの /home/dev/x と、この機械の同じ文字列は別物）
  const existing = root
    ? getAllProjects().find((p) => p.basePath === root && (p.runtime ?? HOST_CONTAINER_RUNTIME) === runtime)
    : undefined;
  const showProjectStep = !provider || !!ready;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (existing) {
      // 新しくは作らず、それを開く（閉じていれば再開）
      setSubmitting(true);
      setError(null);
      try {
        if (existing.status === "closed") await reopenProject(existing.id);
        onCreated?.();
        onOpenChange(false);
        reset();
        router.push(`/p/${existing.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (!name.trim() || !root) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createRealProject({
        name: name.trim(),
        basePath: root,
        overrides,
        ...(remoteName ? { runtime } : {}),
      });
      onCreated?.();
      onOpenChange(false);
      reset();
      router.push(`/p/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className={visibleProviders.length > 0 || (runtimes && runtimes.length > 0) ? "sm:max-w-xl" : "sm:max-w-md"}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>新しい Project</DialogTitle>
            <DialogDescription>
              Project は仕事の入れ物。Module 集合は後から足せる。
            </DialogDescription>
            {requestedBy ? (
              // 出所を見せる——Module の画面が開かせた。作るのは、確かめて押したとき
              <p data-testid="new-project-requested-by" className="text-xs text-ink-2">
                「{requestedBy}」の画面から頼まれて開きました。Root パスと名前を確かめて作成してください。
              </p>
            ) : null}
          </DialogHeader>

          <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto py-4 [&>*]:shrink-0">
            {CONNECTED_FEATURES.remoteRuntimes && !requestedBy ? (
              <RuntimeStep
                runtimes={runtimes}
                error={runtimesError}
                value={runtime}
                onChange={(next) => {
                  setRuntime(next);
                  // フォルダは実行場所ごとに別物——選び直したら空にする
                  setBasePath("");
                  setMethod("folder");
                  setPrepared(null);
                }}
                onAdd={() => {
                  onOpenChange(false);
                  reset();
                  router.push("/settings?section=runtimes");
                }}
              />
            ) : null}
            {/* 始め方が1つ（手元のフォルダだけ）なら、選ぶものは無い——タブを出さない */}
            {visibleProviders.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div
                  role="tablist"
                  aria-label="Root にするフォルダ"
                  data-testid="start-method"
                  className="grid border-b border-border"
                  style={{ gridTemplateColumns: `repeat(${visibleProviders.length + 1}, minmax(0, 1fr))` }}
                >
                  {[{ key: "folder", label: "手元のフォルダ", icon: undefined as string | undefined }, ...visibleProviders.map((p) => ({ key: providerKey(p), label: p.name ?? p.resourceUri, icon: p.icon }))].map((m) => {
                    const active = method === m.key;
                    return (
                      <button
                        key={m.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid="start-method-tab"
                        data-method={m.key}
                        onClick={() => setMethod(m.key)}
                        className={cn(
                          "flex items-center justify-center gap-1.5 rounded-t-md px-1.5 py-2 text-xs transition-colors",
                          active ? "bg-surface-2 font-medium text-foreground" : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2",
                        )}
                      >
                        {m.key === "folder" ? (
                          <FolderOpen className="size-3.5 shrink-0" />
                        ) : m.icon ? (
                          // Module が名乗ったアイコン（data: の画像だけ——core が確かめて渡す）
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.icon} alt="" className="size-3.5 shrink-0" />
                        ) : null}
                        <span className="text-center leading-tight">{m.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p data-testid="start-method-description" className="text-xs text-ink-2">
                  {provider ? (provider.description ?? "") : "あるフォルダを、そのまま使います。"}
                </p>
              </div>
            ) : null}
            {providersError ? (
              <p className="text-xs text-ink-3">Module の始め方を読めませんでした（手元のフォルダは選べます）：{providersError}</p>
            ) : null}

            {provider && ready ? (
              // Module が用意したフォルダ——ここから先は core の仕事。Module が言った1行をそのまま添える
              <div data-testid="new-project-prepared" className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5">
                <CircleCheck className="mt-1 size-4 shrink-0 text-ok" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p data-testid="new-project-prepared-path" className="font-mono text-sm break-all text-foreground">{ready.path}</p>
                  <p data-testid="new-project-prepared-summary" className="text-xs text-ink-3">
                    {provider.server}：{ready.summary}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => {
                    setPrepared(null);
                    setName(null);
                    setSurfaceKey((k) => k + 1);
                  }}
                >
                  別のフォルダにする
                </Button>
              </div>
            ) : null}
            {provider && ready ? (
              <WideRootWarning scope={rootScope} />
            ) : provider ? (
              // Module の画面——core の画面の中の「よそ様の画面」。点線の枠と出所（誰が描いているか・ui://…）
              <div data-testid="module-surface" data-module={provider.server} className="rounded-lg border border-dashed border-border bg-surface-2/60">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2 pb-1.5 text-xs text-ink-3">
                  <ShieldCheck className="size-3.5 shrink-0" />
                  <span data-testid="module-surface-by">「{provider.server}」の画面</span>
                  <code className="ml-auto font-mono break-all">{provider.resourceUri}</code>
                </div>
                <div className="mx-1.5 mb-1.5 rounded-md border border-border bg-card p-2">
                  <ModuleCanvas
                    key={`${method}:${surfaceKey}`}
                    owner={{ kind: "instance" }}
                    server={provider.server}
                    resourceUri={provider.resourceUri}
                    displayMode="inline"
                    onFolderPrepared={(folder) => setPrepared({ method, folder })}
                  />
                </div>
              </div>
            ) : null}

            {showProjectStep && existing ? (
              <p data-testid="new-project-existing" className="text-sm text-ink-2">
                このフォルダは Project「{existing.name}」が Root にしています。新しくは作らず、それを
                {existing.status === "closed" ? "再開" : "開き"}ます。
              </p>
            ) : null}
            {showProjectStep && !existing ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-project-name">Project 名</Label>
                <Input
                  id="new-project-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
            ) : null}
            {!provider ? (
              <div className="flex flex-col gap-1.5">
                {/* **呼び名は Root にそろえる**（改訂・2026-09-11、ユーザー指摘
                    ——作る画面と設定画面で「Base」「Root」が混ざっていた、規則11） */}
                <Label htmlFor="new-project-path">Root パス{remoteName ? `（${remoteName} の上）` : ""}</Label>
                <PathPicker id="new-project-path" value={basePath} onChange={setBasePath} source={folderSource} allowNewFolder />
                <p className="text-xs text-ink-3">
                  {remoteName
                    ? "向こうのサーバのフォルダです。この機械には置きません。リポジトリの clone は、Project を作ったあと AI に頼んでください。"
                    : "Shell・FileSystem などの Module は、この Root パスの中のみアクセス可能"}
                </p>
                {/* **広い根は止めない。選ぶ前に見せる**（決定・2026-09-11、ユーザー） */}
                <WideRootWarning scope={rootScope} />
              </div>
            ) : null}

            {/* **Advanced は `settings` の旗で隠す**（Backlog #272・2026-10-12、ユーザー決定）——選択肢は lib/mock/settings の見本で、
                選んだ値は host に送られない（POST /api/projects は name・root・runtime だけ）。Project の設定の「既定値の上書き」と
                同じ旗。繋いだら旗を true に戻すだけで出る（規則13） */}
            {CONNECTED_FEATURES.settings && showProjectStep && !existing ? (<button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs text-ink-3 hover:text-foreground"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", showAdvanced && "rotate-90")} />
              Advanced——Configuration の上書き
            </button>) : null}
            {CONNECTED_FEATURES.settings && showAdvanced && showProjectStep && !existing ? (
              <div className="rounded-md border border-border px-3">
                <CascadeRow
                  id="new-project-model"
                  label="既定モデル"
                  inheritedLabel={mockRuntimeDefaults.model}
                  overridden={overrides.model !== undefined}
                  onToggle={(on) => patch({ model: on ? mockRuntimeDefaults.model : undefined })}
                >
                  <Select value={overrides.model} onValueChange={(v) => patch({ model: v })}>
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="claude-opus-5">claude-opus-5</SelectItem>
                      <SelectItem value="claude-sonnet-5">claude-sonnet-5</SelectItem>
                      <SelectItem value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</SelectItem>
                    </SelectContent>
                  </Select>
                </CascadeRow>

                <CascadeRow
                  id="new-project-effort"
                  label="既定 reasoning effort"
                  inheritedLabel={mockRuntimeDefaults.effort}
                  overridden={overrides.effort !== undefined}
                  onToggle={(on) => patch({ effort: on ? mockRuntimeDefaults.effort : undefined })}
                >
                  <Select
                    value={overrides.effort}
                    onValueChange={(v) => patch({ effort: v as Overrides["effort"] })}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">low</SelectItem>
                      <SelectItem value="medium">medium</SelectItem>
                      <SelectItem value="high">high</SelectItem>
                    </SelectContent>
                  </Select>
                </CascadeRow>

                <CascadeRow
                  id="new-project-memory"
                  label="Memory 上限文字数"
                  inheritedLabel={`${mockRuntimeDefaults.memoryLimitChars.toLocaleString()} 文字`}
                  overridden={overrides.memoryLimitChars !== undefined}
                  onToggle={(on) =>
                    patch({ memoryLimitChars: on ? mockRuntimeDefaults.memoryLimitChars : undefined })
                  }
                >
                  <Input
                    type="number"
                    className="h-8"
                    value={overrides.memoryLimitChars ?? mockRuntimeDefaults.memoryLimitChars}
                    onChange={(e) => patch({ memoryLimitChars: Number(e.target.value) })}
                  />
                </CascadeRow>

                <CascadeRow
                  id="new-project-credential"
                  label="使う資格情報"
                  inheritedLabel="自動選択（使用率の低いものへ自動で移る）"
                  overridden={overrides.credentialId !== undefined}
                  onToggle={(on) => patch({ credentialId: on ? mockCredentials[0].id : undefined })}
                >
                  <Select value={overrides.credentialId} onValueChange={(v) => patch({ credentialId: v })}>
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mockCredentials.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                          {c.usagePercent !== undefined ? `（${c.usagePercent}% 使用）` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CascadeRow>

                <CascadeRow
                  id="new-project-vault"
                  label="使う Vault 接続"
                  inheritedLabel="instance 既定接続（組み込みローカル）"
                  overridden={overrides.vaultImplementationId !== undefined}
                  onToggle={(on) =>
                    patch({ vaultImplementationId: on ? "banto.vault-local" : undefined })
                  }
                >
                  <Select
                    value={overrides.vaultImplementationId}
                    onValueChange={(v) => patch({ vaultImplementationId: v })}
                  >
                    <SelectTrigger className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {getRoles()
                        .find((r) => r.id === "vault")
                        ?.implementations.map((i) => (
                          <SelectItem key={i.id} value={i.id}>
                            {i.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </CascadeRow>
              </div>
            ) : null}
          </div>

          {error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              やめる
            </Button>
            {/* Module の画面を使っているあいだは、次の手は枠の中にある——core の作るボタンは、返ってきてから出す */}
            {showProjectStep ? (
              <Button type="submit" data-testid="new-project-submit" disabled={submitting || (!existing && (!name.trim() || !root))}>
                {submitting ? "作成中…" : existing ? `「${existing.name}」を${existing.status === "closed" ? "再開" : "開く"}` : "作成する"}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * どこで動かすか（決定・2026-10-08、ユーザー。モックの `RuntimeStep`）。既定はこの機械のコンテナ。登録した別のサーバの
 * うち、選べないもの（ほかの Project が使っている・host 鍵が変わった・前提が足りない）は host が言う理由を添えて出す
 */
function RuntimeStep({
  runtimes,
  error,
  value,
  onChange,
  onAdd,
}: {
  runtimes: RealRemoteRuntime[] | null;
  error: string | null;
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
}) {
  const remote = runtimes?.find((r) => r.runtime === value);
  return (
    <div className="flex flex-col gap-1.5" data-testid="new-project-runtime">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="new-project-runtime">どこで動かすか</Label>
        <button
          type="button"
          onClick={onAdd}
          data-testid="new-project-runtime-add"
          className="text-xs text-ink-3 underline-offset-2 hover:text-foreground hover:underline"
        >
          別のサーバを登録する
        </button>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="new-project-runtime" className="h-9 w-full" data-testid="new-project-runtime-select">
          <SelectValue />
        </SelectTrigger>
        {/* 引き金の下に出す（「別の実行場所へ移す」の移す先と同じ。Backlog #291） */}
        <SelectContent position="popper" align="start">
          <SelectItem value={HOST_CONTAINER_RUNTIME}>
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 shrink-0 text-ink-3" />
              この機械のコンテナ
            </span>
          </SelectItem>
          {(runtimes ?? []).map((r) => (
            <SelectItem
              key={r.name}
              value={r.runtime}
              disabled={!!r.unavailableReason}
              data-testid="new-project-runtime-option"
              data-runtime={r.name}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span className="flex items-center gap-2">
                  <Server className="size-3.5 shrink-0 text-ink-3" />
                  {r.name}
                  <span className="font-mono text-xs text-ink-3">{sshTarget(r)}</span>
                  {r.mode === "containers" ? <span className="text-xs text-ink-3">Project ごとのコンテナ</span> : null}
                </span>
                {r.unavailableReason ? (
                  <span className="pl-5.5 text-xs text-ink-3" data-testid="new-project-runtime-reason">
                    {r.unavailableReason}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-xs text-stop">別のサーバの一覧を読めませんでした（この機械のコンテナは選べます）：{error}</p> : null}
      <p className="text-xs text-ink-3" data-testid="new-project-runtime-note">
        {remote?.mode === "containers"
          ? `${remote.name} の中に、この Project 専用の Incus のコンテナを立てて動かします（同じサーバに Project を複数置けます）。` +
            "コンテナから banto への道（中継・SSH 鍵・公開）はまだ作っていないので、それを使う機能は繋がりません。根は home の下で、ほかの Project と重ならない場所にしてください。作ったあとで変えられません。"
          : remote
          ? `${remote.name} のサーバ丸ごとが、この Project の箱になります。AI はそこで ${remote.user} ができることを全部できます。作ったあとで変えられません。`
          : "banto と同じ機械の、この Project 専用のコンテナで動かします。作ったあとで変えられません。"}
      </p>
    </div>
  );
}
