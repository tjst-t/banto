"use client";

// 新規 Project の作成（§2.2）——**core（banto 本体）の画面**。改訂・2026-10-01（ユーザー決定）：
// core は Module を名指しで知らない／Module を足すのに core を触らない。Repositories を無効にした banto でもこの画面は壊れない。
//
// この画面が持つのは2つだけ：
//   - **手元のフォルダ**——core の基本の形（Root パスを打つか「選ぶ」）
//   - **Module が中身を持ち込む空きの場所**——Module が `_meta` で「フォルダを用意できる」と名乗り
//     （`folderProviders`、設定面・launcher と同じ仕組み）、その画面（MCP Apps の `ui://<id>/<viewId>`）を差し出す。
//     core はそれを始め方のタブとして並べる。**タブの名前・説明・アイコンは Module が名乗ったもの**
//     （core は「clone」という言葉を持たない）。中は Module の画面で、core の画面の中の「よそ様の画面」だと
//     分かるように、設定面（`module-config-pane.tsx`）と同じ点線の枠と出所（`ui://…`・誰が描いているか）を付ける
// Module の画面が「このフォルダを用意した」（`MockPreparedFolder`）と返したら、core が下の段（Project 名・Advanced）を
// 出して、そのフォルダを Root に Project を作る。**Project を作るのは core**。そのフォルダをもう Project が使っているかは
// core が自分で調べ、使っていれば新しく作らずにそれを開く（手元のフォルダでも同じ）。
//
// Advanced（Configuration の上書き）は始め方によらず共通。§2.2「設定のカスケード」の
// 対象は全部出す——一部だけ出すと「他はここでは上書きできない」と読まれる
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleCheck, ChevronRight, FolderOpen, Server, ShieldCheck } from "lucide-react";
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
import { FolderProviderContent } from "@/components/banto/canvas/canvas-content";
import { cn } from "@/lib/utils";
import { createProject, getAllProjects, reopenProject } from "@/lib/mock/projects";
import { getFolderProviders, getRoles, mockCredentials, mockRuntimeDefaults } from "@/lib/mock/settings";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import type { MockPreparedFolder, MockProjectOverrides } from "@/lib/mock/types";
import { moveChoiceByKey } from "./choice-pills";
import { ModuleIcon } from "./module-icon";
import { PathPicker, WideRootWarning, type FolderSource } from "./path-picker";
import {
  HOST_CONTAINER,
  getRuntime,
  remoteFolderSource,
  runtimeIdOfProject,
  runtimeUnavailableReason,
  setProjectRuntime,
  sshTarget,
  useRuntimes,
} from "@/lib/mock/runtimes";

type Overrides = Omit<MockProjectOverrides, "projectId" | "securityRoot">;

/** `folder`（core の手元のフォルダ）か、Module が名乗った始め方 `<implementationId>:<providerId>` */
export type StartMethod = string;

/** 開くときの初期状態（URL の `RepoDemoParams`・リポジトリの一覧の「Project を始める」など） */
export interface NewProjectPreset {
  method?: StartMethod;
  /** Module の画面に最初に入れておく値（モックの見せ方のためだけ。URL の `&repo=`） */
  input?: string;
  /** 手元のフォルダの Root パス */
  folder?: string;
  /** Project 名の初期値 */
  name?: string;
  /** 実行場所（`lib/mock/runtimes.ts` の id）。無ければこの機械のコンテナ */
  runtimeId?: string;
}

/** 始め方の1つ。core の分は「手元のフォルダ」だけで、あとは Module が名乗ったもの */
interface Method {
  key: StartMethod;
  label: string;
  description: string;
  icon: React.ReactNode;
  provider?: ReturnType<typeof getFolderProviders>[number];
}

/** Advanced の「使う Vault 接続」で上書きを始めたときの初期値 */
const DEFAULT_VAULT = "banto.vault-local";

export function NewProjectDialog({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: NewProjectPreset;
}) {
  // 中身は DialogContent の中に置く——閉じると Radix が中身ごと外すので、
  // 次に開いたときは初期状態から始まる（reset を手で書かない）
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="new-project-dialog">
        <NewProjectForm preset={preset} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function NewProjectForm({ preset, onDone }: { preset?: NewProjectPreset; onDone: () => void }) {
  useMockStoreVersion();
  const router = useRouter();
  const runtimes = useRuntimes();
  // **実行場所は作るときに決め、あとから変えない**（v4-security.md §1「Project の実行場所——別のサーバ」）
  const [runtimeId, setRuntimeId] = useState<string>(preset?.runtimeId ?? HOST_CONTAINER);
  const remote = runtimeId === HOST_CONTAINER ? undefined : getRuntime(runtimeId);
  const allMethods: Method[] = [
    {
      key: "folder",
      label: "手元のフォルダ",
      description: "あるフォルダを、そのまま使います。",
      icon: <FolderOpen className="size-4 shrink-0 sm:size-3.5" />,
    },
    ...getFolderProviders().map((p) => ({
      key: `${p.implementationId}:${p.id}`,
      label: p.label,
      description: p.description,
      icon: <ModuleIcon name={p.icon} className="size-4 shrink-0 sm:size-3.5" />,
      provider: p,
    })),
  ];
  // 別のサーバでは、フォルダを用意する Module（Repositories の clone など）はまだ使えない——向こうのフォルダは
  // host の Repositories が扱わない（最初の版）。手元のフォルダ＝向こうのフォルダを選ぶ、だけにする
  const methods = remote ? allMethods.slice(0, 1) : allMethods;
  const folderSource: FolderSource | undefined = remote
    ? { ...remoteFolderSource(remote.id), where: remote.name }
    : undefined;
  const [methodChoice, setMethod] = useState<StartMethod>(preset?.method ?? "folder");
  // 名乗っていた Module が外れたら（`?modules=none`）、手元のフォルダに戻る
  const current = methods.find((m) => m.key === methodChoice) ?? methods[0];
  const method = current.key;
  const [basePath, setBasePath] = useState(preset?.folder ?? "");
  /** Module が「用意した」と返したフォルダ（どの始め方で用意したか） */
  const [prepared, setPrepared] = useState<{ method: StartMethod; folder: MockPreparedFolder } | null>(null);
  /** 「別のフォルダにする」で Module の画面を初めからにする */
  const [surfaceKey, setSurfaceKey] = useState(0);
  const ready = current.provider && prepared?.method === method ? prepared.folder : null;
  const root = current.provider ? (ready?.path ?? "") : basePath.trim();
  /** null＝用意できたフォルダの名前の既定に合わせる（人が打ったら、以後はその値） */
  const [projectName, setProjectName] = useState<string | null>(preset?.name ?? null);
  const name = projectName ?? (ready ? (ready.suggestedName ?? ready.path.split("/").pop() ?? "") : "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>({});
  // そのフォルダを、もう Project が Root にしているか——core が自分で調べる（Module に聞かない）
  // 実行場所が違えば、同じパスでも別のフォルダ（向こうの /home/dev/x と、この機械の同じ文字列は別物）
  const existing = root
    ? getAllProjects().find((p) => p.basePath === root && runtimeIdOfProject(p.id) === runtimeId)
    : undefined;
  const showProjectStep = !current.provider || !!ready;

  function changeMethod(next: StartMethod) {
    setMethod(next);
  }

  function openProject(projectId: string, closed: boolean) {
    if (closed) reopenProject(projectId);
    onDone();
    router.push(`/p/${projectId}`);
  }

  const primary: { label: string; action: "create" | "open" | null } = existing
    ? { label: `「${existing.name}」を${existing.status === "closed" ? "再開" : "開く"}`, action: "open" }
    : { label: "Project を作る", action: root && name.trim() ? "create" : null };

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (primary.action === "open" && existing) {
      openProject(existing.id, existing.status === "closed");
      return;
    }
    if (primary.action !== "create") return;
    const project = createProject({ name: name.trim(), basePath: root, overrides });
    setProjectRuntime(project.id, runtimeId);
    onDone();
    router.push(`/p/${project.id}`);
    if (remote) toast(`Project「${project.name}」を作りました——${remote.name}（${sshTarget(remote)}）で動かします`);
    // Module が用意したなら、誰が何をしたかも添える（Module が返した1行をそのまま）
    if (ready && current.provider) {
      toast(`Project「${project.name}」を作りました——${current.provider.roleName}：${ready.summary}`);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>新しい Project</DialogTitle>
        <DialogDescription>Root にするフォルダを決めて、そこに Project を作ります。</DialogDescription>
      </DialogHeader>

      <RuntimeStep
        runtimes={runtimes}
        value={runtimeId}
        onChange={(next) => {
          setRuntimeId(next);
          // フォルダは実行場所ごとに別物——選び直したら空にする
          setBasePath("");
          setMethod("folder");
          setPrepared(null);
        }}
        onAdd={() => {
          onDone();
          router.push("/settings?section=runtimes");
        }}
      />

      <div className="flex flex-col gap-2">
        <h3 id="new-project-folder-step" className="text-sm font-semibold text-foreground">
          Root にするフォルダ
        </h3>
        {/* 始め方が1つ（手元のフォルダだけ）なら、選ぶものは無い——タブを出さない */}
        {methods.length > 1 ? (
          <>
            {/* 本実装の SegmentedTabs と同じ形（全幅・下線・選んだものに地）。数は名乗った Module しだい */}
            <div
              role="tablist"
              aria-labelledby="new-project-folder-step"
              data-testid="start-method"
              onKeyDown={(e) =>
                moveChoiceByKey(
                  e,
                  methods.map((m) => m.key),
                  method,
                  changeMethod,
                )
              }
              className="grid border-b border-border"
              style={{ gridTemplateColumns: `repeat(${methods.length}, minmax(0, 1fr))` }}
            >
              {methods.map((m) => {
                const active = method === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="tab"
                    data-choice
                    id={`start-${m.key}`}
                    aria-selected={active}
                    aria-controls="start-panel"
                    tabIndex={active ? 0 : -1}
                    data-testid={`start-method-${m.key}`}
                    onClick={() => changeMethod(m.key)}
                    className={cn(
                      "flex flex-col items-center justify-center gap-1 rounded-t-md px-1.5 py-2 text-xs transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:flex-row sm:gap-1.5",
                      active
                        ? "bg-surface-2 font-medium text-foreground"
                        : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2",
                    )}
                  >
                    {m.icon}
                    <span className="text-center leading-tight">{m.label}</span>
                  </button>
                );
              })}
            </div>
            <p data-testid="start-method-description" className="text-xs text-ink-2">
              {current.description}
            </p>
          </>
        ) : null}
      </div>

      <div
        id="start-panel"
        role={methods.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={methods.length > 1 ? `start-${method}` : undefined}
        // 中身は縮めない——縮むと Module の画面の下（断る理由・次の手）が切れる（実測で踏んだ）
        className="flex max-h-[60vh] min-w-0 flex-col gap-4 overflow-y-auto [&>*]:shrink-0"
      >
        {!current.provider ? (
          <FolderField
            basePath={basePath}
            onBasePathChange={setBasePath}
            autoFocus={!preset?.folder}
            source={folderSource}
          />
        ) : ready ? (
          <PreparedFolder
            folder={ready}
            by={current.provider.roleName}
            onChange={() => {
              setPrepared(null);
              setProjectName(null);
              setSurfaceKey((k) => k + 1);
            }}
          />
        ) : (
          <ModuleSurface provider={current.provider}>
            <FolderProviderContent
              key={`${method}:${surfaceKey}`}
              implementationId={current.provider.implementationId}
              viewId={current.provider.viewId}
              host={{
                initialInput: surfaceKey === 0 && preset?.method === method ? preset.input : undefined,
                onPrepared: (folder) => setPrepared({ method, folder }),
              }}
            />
          </ModuleSurface>
        )}

        {/* 下の段：Project。core の仕事——用意できたフォルダを Root にして作る */}
        {showProjectStep ? (
          <section
            aria-labelledby="new-project-project-step"
            data-testid="new-project-project-step"
            className="flex flex-col gap-4 border-t border-border pt-4"
          >
            <h3 id="new-project-project-step" className="text-sm font-semibold text-foreground">
              Project
            </h3>
            {existing ? (
              <p data-testid="new-project-existing" className="text-sm text-ink-2">
                このフォルダは Project「{existing.name}」が Root にしています。新しくは作らず、それを
                {existing.status === "closed" ? "再開" : "開き"}ます。
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-project-name">Project 名</Label>
                  <Input
                    id="new-project-name"
                    value={name}
                    onChange={(e) => setProjectName(e.target.value)}
                    // Module がフォルダを返した直後は、次に決めることへ焦点を移す
                    autoFocus={!!ready || (!!preset?.folder && !current.provider)}
                  />
                </div>
                <AdvancedOverrides
                  open={showAdvanced}
                  onToggle={() => setShowAdvanced((v) => !v)}
                  overrides={overrides}
                  patch={(next) => setOverrides((prev) => ({ ...prev, ...next }))}
                />
              </>
            )}
          </section>
        ) : null}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          やめる
        </Button>
        {/* Module の画面を使っているあいだは、次の手は枠の中にある——core の作るボタンは、返ってきてから出す
            （押せない「Project を作る」と枠の中のボタンが並ぶと、どちらを押すのか迷う） */}
        {showProjectStep ? (
          <Button type="submit" disabled={primary.action === null} data-testid="new-project-submit">
            {primary.label}
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}

/**
 * Module の画面を入れる枠——core の画面の中の「よそ様の画面」。設定面（`module-config-pane.tsx`）と同じ
 * 点線・薄い地・出所（誰が描いているか・`ui://…`・sandboxed）。中の質感は Module のもの
 */
function ModuleSurface({
  provider,
  children,
}: {
  provider: NonNullable<Method["provider"]>;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="module-surface"
      data-module={provider.implementationId}
      className="rounded-lg border border-dashed border-border bg-surface-2/60"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2 pb-1.5 text-xs text-ink-3">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span data-testid="module-surface-by">{provider.implementationName}の画面</span>
        <code className="ml-auto font-mono break-all">
          ui://{provider.implementationId}/{provider.viewId}
        </code>
      </div>
      <div className="mx-1.5 mb-1.5 rounded-md border border-border bg-card p-3">{children}</div>
    </div>
  );
}

/** Module が「用意した」と返したフォルダ——ここから先は core の仕事。Module が言った1行をそのまま添える */
function PreparedFolder({
  folder,
  by,
  onChange,
}: {
  folder: MockPreparedFolder;
  by: string;
  onChange: () => void;
}) {
  return (
    <div
      data-testid="new-project-prepared"
      className="flex items-start gap-2.5 rounded-md border border-border bg-surface-2 px-3 py-2.5"
    >
      <CircleCheck className="mt-1 size-4 shrink-0 text-ok" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p data-testid="new-project-prepared-path" className="font-mono text-md break-all text-foreground">
          {folder.path}
        </p>
        <p data-testid="new-project-prepared-summary" className="text-xs text-ink-3">
          {by}：{folder.summary}
        </p>
      </div>
      <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={onChange}>
        別のフォルダにする
      </Button>
    </div>
  );
}

function FolderField({
  basePath,
  onBasePathChange,
  autoFocus,
  source,
}: {
  basePath: string;
  onBasePathChange: (next: string) => void;
  autoFocus: boolean;
  source?: FolderSource;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="new-project-path">Root パス{source?.where ? `（${source.where} の上）` : ""}</Label>
      <PathPicker
        id="new-project-path"
        value={basePath}
        onChange={onBasePathChange}
        autoFocus={autoFocus}
        source={source}
        pickerDescription={
          source?.where
            ? `${source.where} のフォルダです。いま開いている場所を、この Project の Root にします。`
            : undefined
        }
      />
      <p className="text-xs text-ink-3">
        {source?.where
          ? "向こうのサーバのフォルダです。この機械には置きません。リポジトリの clone は、Project を作ったあと AI に頼んでください。"
          : "Shell・FileSystem などの Module は、この Root パスの中のみアクセス可能"}
      </p>
      <WideRootWarning path={basePath} />
    </div>
  );
}

function AdvancedOverrides({
  open,
  onToggle,
  overrides,
  patch,
}: {
  open: boolean;
  onToggle: () => void;
  overrides: Overrides;
  patch: (next: Partial<Overrides>) => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-fit items-center gap-1 text-xs text-ink-3 hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        Advanced——Configuration の上書き
      </button>
      {open ? (
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
            <Select value={overrides.effort} onValueChange={(v) => patch({ effort: v as Overrides["effort"] })}>
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
            onToggle={(on) => patch({ vaultImplementationId: on ? DEFAULT_VAULT : undefined })}
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
    </>
  );
}

/**
 * どこで動かすか（決定・2026-10-08、ユーザー）。既定はこの機械のコンテナ。登録した別のサーバのうち、
 * 選べないもの（ほかの Project が使っている・host 鍵が変わった・前提が足りない）は理由を添えて出す——隠すと
 * 「登録したのに出てこない」になる。実行場所は作ったあとに変えられない
 */
function RuntimeStep({
  runtimes,
  value,
  onChange,
  onAdd,
}: {
  runtimes: ReturnType<typeof useRuntimes>;
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
}) {
  const remote = value === HOST_CONTAINER ? undefined : runtimes.find((r) => r.id === value);
  return (
    <div className="flex flex-col gap-1.5" data-testid="new-project-runtime">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="new-project-runtime">どこで動かすか</Label>
        <button
          type="button"
          onClick={onAdd}
          className="text-xs text-ink-3 underline-offset-2 hover:text-foreground hover:underline"
        >
          別のサーバを登録する
        </button>
      </div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="new-project-runtime" className="h-9 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={HOST_CONTAINER}>
            <span className="flex items-center gap-2">
              <ShieldCheck className="size-3.5 shrink-0 text-ink-3" />
              この機械のコンテナ
            </span>
          </SelectItem>
          {runtimes.map((r) => {
            const reason = runtimeUnavailableReason(r);
            return (
              <SelectItem key={r.id} value={r.id} disabled={!!reason}>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="flex items-center gap-2">
                    <Server className="size-3.5 shrink-0 text-ink-3" />
                    {r.name}
                    <span className="font-mono text-xs text-ink-3">{sshTarget(r)}</span>
                  </span>
                  {reason ? <span className="pl-5.5 text-xs text-ink-3">{reason}</span> : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-ink-3" data-testid="new-project-runtime-note">
        {remote
          ? `${remote.name} のサーバ丸ごとが、この Project の箱になります。AI はそこで ${remote.user} ができることを全部できます。作ったあとで変えられません。`
          : "banto と同じ機械の、この Project 専用のコンテナで動かします。作ったあとで変えられません。"}
      </p>
    </div>
  );
}
