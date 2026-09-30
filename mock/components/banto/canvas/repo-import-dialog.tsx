"use client";

// フォルダを Import（2026-09-30、ユーザー決定）——好きな場所のリポジトリを、**今の場所のまま**
// Repo の台帳に足す（移さない）。人が**フォルダを1つずつ**選ぶ——まとめて取り込む入口は作らない。
//
// 形は「フォルダを選ぶ」（path-picker）と同じたどり方で、下に **いま開いているフォルダを
// Import すると何が起きるか**の帯を置く——たどるたびに答えが変わる。押す前に言う、は
// 新しい Project の Root パスの帯と同じ作法。判断は `inspectImport` の1箇所（規則3）。
//
// 失敗（git でない・もう一覧にある・worktree・リポジトリの中のフォルダ・無いパス）は
// どれも理由と次の手を1つずつ言う。一覧の中のフォルダには、git のリポジトリかどうか・
// もう一覧にあるかを先に印で出す（入る前に、どこへ行けばよいかが分かる）。
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowRight,
  Ban,
  Check,
  ChevronRight,
  CircleCheck,
  CornerLeftUp,
  Folder,
  FolderGit2,
  GitBranch,
  Globe,
  HardDrive,
  Link2,
  Lock,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  folderName,
  getGithubAccounts,
  gitInitFolder,
  importFolder,
  inspectImport,
  listChildFolders,
  nearestExistingFolder,
  normalizeFolderPath,
  parentFolder,
  remoteHost,
  type ImportCheck,
} from "@/lib/mock/github";
import { AccountMark } from "@/components/banto/project/github-account-chooser";

export function RepoImportDialog({
  startAt,
  onClose,
  onShow,
}: {
  startAt: string;
  onClose: () => void;
  /** 一覧のその行を見せる（Import した・もう一覧にある） */
  onShow: (path: string) => void;
}) {
  useMockStoreVersion();
  const [at, setAt] = useState(() => normalizeFolderPath(startAt));
  /** パスの欄に打っている途中の値。Enter か欄を離れたときに移る（打つたびに「無い」と言わない） */
  const [draft, setDraft] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const check = inspectImport(at);
  const entries = check.kind === "missing" ? [] : listChildFolders(at);
  const parent = parentFolder(at);

  function go(path: string) {
    setAt(normalizeFolderPath(path));
    setDraft(null);
  }

  function doImport() {
    const repo = importFolder(at);
    if (!repo) return;
    toast(`${repo.name} を一覧に足しました（フォルダは ${repo.path} のまま）`);
    onShow(repo.path);
  }

  function initAndImport() {
    gitInitFolder(at);
    toast(`${folderName(at)} で git init して、一覧に足しました`);
    onShow(at);
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="repo-import-dialog"
        // 開いたらパスの欄へ（「上へ」に焦点があると、最初の Enter で上に移ってしまう）
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          pathRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>フォルダを Import</DialogTitle>
          <DialogDescription>
            手元のリポジトリを、今の場所のまま Repo の一覧に足します。フォルダは移しません。
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 gap-1 px-2 text-xs"
              disabled={!parent}
              onClick={() => parent && go(parent)}
            >
              <CornerLeftUp className="size-3.5" /> 上へ
            </Button>
            <Input
              ref={pathRef}
              aria-label="フォルダのパス"
              data-testid="repo-import-path"
              value={draft ?? at}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => draft !== null && go(draft)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (draft !== null) go(draft);
              }}
              spellCheck={false}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
            />
          </div>

          <div className="max-h-56 min-h-24 overflow-auto rounded-md border border-border">
            {entries.length === 0 ? (
              <p className="p-4 text-center text-xs text-ink-3">この中にフォルダはありません</p>
            ) : (
              <ul className="flex flex-col" aria-label={`${at} の中のフォルダ`}>
                {entries.map((name) => (
                  <li key={name}>
                    <FolderEntry path={`${at}/${name}`} name={name} onOpen={go} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <ImportPreview
          path={at}
          check={check}
          onGo={go}
          onShow={onShow}
          onInitAndImport={initAndImport}
        />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            やめる
          </Button>
          <Button
            type="button"
            disabled={check.kind !== "ready"}
            onClick={doImport}
            data-testid="repo-import-submit"
          >
            Import する
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一覧の1行——入る前に、git のリポジトリか・もう一覧にあるかを印で言う */
function FolderEntry({ path, name, onOpen }: { path: string; name: string; onOpen: (path: string) => void }) {
  const check = inspectImport(path);
  const mark =
    check.kind === "known" ? (
      <span className="flex shrink-0 items-center gap-1 text-ink-3">
        <Check className="size-3.5" />
        一覧にあります
      </span>
    ) : check.kind === "worktree" ? (
      <span className="shrink-0 text-ink-3">{check.repo.name} の worktree</span>
    ) : check.kind === "ready" ? (
      <span className="shrink-0 text-ink-2">git</span>
    ) : null;
  const isRepo = check.kind === "ready" || check.kind === "known" || check.kind === "worktree";
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      data-testid="repo-import-entry"
      data-state={check.kind}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-ink-2 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      {isRepo ? (
        <FolderGit2 className={cn("size-3.5 shrink-0", check.kind === "ready" ? "text-foreground" : "text-ink-3")} />
      ) : (
        <Folder className="size-3.5 shrink-0 text-ink-3" />
      )}
      <span className={cn("min-w-0 flex-1 truncate", check.kind === "ready" && "font-medium text-foreground")}>
        {name}
      </span>
      {mark}
      <ChevronRight className="size-3.5 shrink-0 text-ink-3" />
    </button>
  );
}

type Tone = "plain" | "ok" | "go" | "stop";

/**
 * いま開いているフォルダを Import すると何が起きるか。色は新しい Project の Root パスの帯と同じ：
 * Import できる＝ok の地、断る＝turn の地、一覧のほかの場所へ行く＝印だけ accent
 */
function ImportPreview({
  path,
  check,
  onGo,
  onShow,
  onInitAndImport,
}: {
  path: string;
  check: ImportCheck;
  onGo: (path: string) => void;
  onShow: (path: string) => void;
  onInitAndImport: () => void;
}) {
  const { tone, icon, message, detail } = describe(path, check, { onGo, onShow, onInitAndImport });
  return (
    <section
      aria-labelledby="repo-import-target-label"
      data-testid="repo-import-preview"
      data-state={check.kind}
      className="overflow-hidden rounded-md border border-border"
    >
      <div className="flex flex-col gap-0.5 bg-surface-2 px-3 py-2.5">
        <p id="repo-import-target-label" className="text-xs text-ink-3">
          Import するフォルダ
        </p>
        <p className="font-mono text-md leading-snug break-all text-foreground">{path}</p>
      </div>
      <div
        aria-live="polite"
        className={cn(
          "flex items-start gap-2 border-t border-border px-3 py-2.5 text-xs",
          tone === "ok" && "bg-ok-soft",
          tone === "stop" && "bg-turn-soft",
        )}
      >
        <span
          className={cn(
            "mt-0.5 shrink-0 [&>svg]:size-3.5",
            tone === "plain" && "text-ink-3",
            tone === "ok" && "text-ok",
            tone === "go" && "text-primary",
            tone === "stop" && "text-turn",
          )}
        >
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p data-testid="repo-import-message" className="text-foreground">
            {message}
          </p>
          {detail}
        </div>
      </div>
    </section>
  );
}

function describe(
  path: string,
  check: ImportCheck,
  actions: { onGo: (path: string) => void; onShow: (path: string) => void; onInitAndImport: () => void },
): { tone: Tone; icon: ReactNode; message: ReactNode; detail?: ReactNode } {
  switch (check.kind) {
    case "ready":
      return {
        tone: "ok",
        icon: <CircleCheck />,
        message: "git のリポジトリです。この場所のまま一覧に足します。",
        detail: <RepoFacts check={check} />,
      };
    case "known":
      return {
        tone: "go",
        icon: <ArrowRight />,
        message: <>{check.repo.name} は、もう一覧にあります。</>,
        detail: <NextStep label="一覧で見る" onClick={() => actions.onShow(check.repo.path)} />,
      };
    case "worktree":
      return {
        tone: "go",
        icon: <ArrowRight />,
        message: (
          <>
            これは <span className="font-mono break-all">{check.repo.path}</span> の worktree です。
            {check.repo.name} は、もう一覧にあります。
          </>
        ),
        detail: <NextStep label="一覧で見る" onClick={() => actions.onShow(check.repo.path)} />,
      };
    case "inside":
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            {folderName(check.top)} のリポジトリの中のフォルダです。Import できるのはリポジトリの一番上だけです。
          </>
        ),
        detail: (
          <NextStep
            testId="repo-import-go-top"
            label={`${folderName(check.top)} を選ぶ`}
            onClick={() => actions.onGo(check.top)}
          />
        ),
      };
    case "not-git": {
      const { importable, known } = check.reposInside;
      if (importable > 0) {
        // まとめて取り込む入口は作らない——上の一覧から1つずつ選んでもらう
        return {
          tone: "plain",
          icon: <Folder />,
          message: (
            <>
              ここは git のリポジトリではありません。中に、まだ一覧に無いリポジトリが {importable} つあります——上の一覧から1つずつ選んでください。
            </>
          ),
        };
      }
      if (known > 0) {
        return {
          tone: "plain",
          icon: <Folder />,
          message: <>ここは git のリポジトリではありません。中のリポジトリは、どれももう一覧にあります。</>,
        };
      }
      return {
        tone: "stop",
        icon: <Ban />,
        message: <>git のリポジトリではありません（{check.entries} 項目）。Import できるのは git のリポジトリだけです。</>,
        detail:
          path === "~" ? null : (
            <div className="flex flex-col items-start gap-1.5">
              <p className="text-ink-2">ここを新しいリポジトリにするなら、git init してから足せます。</p>
              <NextStep testId="repo-import-init" label="git init して Import" onClick={actions.onInitAndImport} />
            </div>
          ),
      };
    }
    case "missing":
      return {
        tone: "stop",
        icon: <Ban />,
        message: "このフォルダはありません。",
        detail: (
          <NextStep
            label={`${nearestExistingFolder(path)} へ`}
            onClick={() => actions.onGo(nearestExistingFolder(path))}
          />
        ),
      };
  }
}

/** Import できるリポジトリについて、フォルダから読めたこと */
function RepoFacts({ check }: { check: Extract<ImportCheck, { kind: "ready" }> }) {
  const { remote, branch, commits } = check.facts;
  const account = getGithubAccounts().find((a) => a.id === check.accountId);
  return (
    <dl
      data-testid="repo-import-facts"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-ink-2"
    >
      <dt className="text-ink-3">origin</dt>
      <dd className="flex min-w-0 items-center gap-1">
        {remote.kind === "github" ? (
          <>
            {remote.private ? <Lock className="size-3 shrink-0" /> : <Globe className="size-3 shrink-0" />}
            <span className="font-mono break-all">
              github.com/{remote.owner}/{remote.name}
            </span>
          </>
        ) : remote.kind === "elsewhere" ? (
          <>
            <Link2 className="size-3 shrink-0" />
            {remoteHost(remote.url)}（GitHub の外）
          </>
        ) : (
          <>
            <HardDrive className="size-3 shrink-0" />
            無し——このマシンにだけあります
          </>
        )}
      </dd>
      <dt className="text-ink-3">ブランチ</dt>
      <dd className="flex items-center gap-1">
        <GitBranch className="size-3 shrink-0 text-ink-3" />
        <span className="font-mono">{branch}</span> · {commits} コミット
      </dd>
      {remote.kind === "github" ? (
        <>
          <dt className="text-ink-3">アカウント</dt>
          <dd className="flex items-center gap-1">
            {account ? (
              <>
                <AccountMark login={account.login} />
                {account.login} で push・pull します
              </>
            ) : (
              <span>{remote.owner} は登録していないので、push はできません（読むだけ）</span>
            )}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function NextStep({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      data-testid={testId}
      className="h-7 w-fit gap-1 bg-background text-xs"
    >
      {label}
      <ArrowRight className="size-3" />
    </Button>
  );
}
