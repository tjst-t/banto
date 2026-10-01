"use client";

// **Root パスと、そこで何が起きるか**を1つの帯で言う（2026-09-29、改訂・2026-09-30）。
//
// clone と「新しいリポジトリ」の Root は**既定の置き場の下**（`~/banto/<名前>`、置き場は
// Repo の設定で変えられる）。人が決めるのはフォルダ名だけなので、**入力欄は帯の中の
// 最後の1段にだけ置く**——置き場は打たせない。名前がぶつかったら `<名前>-2` を先に入れておき、
// 人が変えられる。フォルダを用意するのは Repo なので、文は「Repo が〜します」で言う。
// 何があるかの判断は `inspectTargetFolder`・`inspectCloneSource` が持つ（規則3）——
// この部品は言い方だけを持つ。
//
// 色は状態に1つずつ：そのまま使う＝ok の地、断る＝turn の地（人の手が要る）。
// 既にある Project へ行く＝地は塗らず、印だけ accent（行き先を示すだけで、止めてはいない）。
// 何も無い（普通に clone する・作る）ときは塗らない。
import type { ReactNode } from "react";
import {
  ArrowRight,
  Ban,
  CircleAlert,
  CircleCheck,
  CloudDownload,
  FolderPlus,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KnownRepo, MissingRepo, ProjectSummary, RepoRemote, TargetFolderState } from "@/lib/mock/github";
import { remoteHost } from "@/lib/mock/github";

export type RootPreviewStatus =
  /** 置き場の下に作る——そこに何があるか */
  | { kind: "target"; state: TargetFolderState }
  /** clone しようとしたリポジトリを、もう持っている（どこにあっても） */
  | { kind: "have"; repo: KnownRepo; project?: ProjectSummary }
  /** clone しようとしたリポジトリを台帳が覚えているのに、フォルダが見つからない——元の場所に clone し直す */
  | { kind: "reclone"; repo: MissingRepo; project?: ProjectSummary }
  | { kind: "cloning"; received: number; total: number }
  | { kind: "clone-failed"; reason: string };

type Tone = "plain" | "ok" | "go" | "stop";

export function RepoRootPreview({
  mode,
  home,
  folder,
  onFolderChange,
  folderInvalid,
  renamedFrom,
  status,
  takenOnGithub,
  onUseAsFolder,
  onSwitchToClone,
  onOpenProject,
  failedNext,
}: {
  mode: "clone" | "create";
  /** 既定の置き場（`~/banto`） */
  home: string;
  /** フォルダ名。「新しいリポジトリ」ではリポジトリ名も兼ねる */
  folder: string;
  onFolderChange: (next: string) => void;
  folderInvalid: boolean;
  /** clone で、元の名前がぶつかったので `-2` にしたとき、元の名前 */
  renamedFrom?: string;
  status: RootPreviewStatus;
  /** 「新しいリポジトリ」で、登録したアカウントの GitHub に同じ名前が既にある——その持ち主 */
  takenOnGithub?: string;
  /** 断ったときの次の手——そのフォルダを「手元のフォルダ」でそのまま Root にする */
  onUseAsFolder: (path: string) => void;
  onSwitchToClone: () => void;
  /** そのフォルダを Root にした Project が、もうあるとき——新しく作らずそれを開く */
  onOpenProject: (projectId: string, closed: boolean) => void;
  /** clone できなかったときの次の手（入口ごとに違う。無ければ「読めるアカウントを登録して、もう一度選ぶ」） */
  failedNext?: ReactNode;
}) {
  const { tone, icon, message, next } = describe({
    mode,
    home,
    folder,
    folderInvalid,
    renamedFrom,
    status,
    onFolderChange,
    onUseAsFolder,
    onOpenProject,
    failedNext,
  });
  const cloning = status.kind === "cloning";

  return (
    <section
      aria-labelledby="repo-root-label"
      data-testid="repo-root-preview"
      data-state={status.kind === "target" ? status.state.kind : status.kind}
      className="overflow-hidden rounded-md border border-border"
    >
      <div className="flex flex-col gap-1 bg-surface-2 px-3 py-2.5">
        <p id="repo-root-label" className="text-xs text-ink-3">
          Root パス
        </p>
        {status.kind === "have" || status.kind === "reclone" ? (
          <p data-testid="repo-root-path" className="font-mono text-lg leading-snug break-all text-foreground">
            {status.repo.path}
          </p>
        ) : (
          // 置き場は字のまま、フォルダ名だけが打てる——どこまでが決まっていて、どこを変えられるかを形で言う
          <div
            data-testid="repo-root-path"
            className="flex flex-wrap items-center gap-x-0.5 gap-y-1 font-mono text-lg leading-snug"
          >
            <span className="break-all text-ink-3">{home}/</span>
            <input
              id="repo-root-folder"
              data-testid="repo-root-folder"
              value={folder}
              onChange={(e) => onFolderChange(e.target.value.trim())}
              disabled={cloning}
              placeholder={mode === "create" ? "名前" : undefined}
              aria-label={mode === "create" ? "リポジトリ名（フォルダ名）" : "フォルダ名"}
              aria-invalid={folderInvalid || (status.kind === "target" && status.state.kind !== "free") || undefined}
              aria-describedby="repo-root-message"
              autoComplete="off"
              spellCheck={false}
              autoFocus={mode === "create"}
              className="min-w-32 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 font-medium text-foreground placeholder:font-normal placeholder:text-ink-3 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-turn disabled:opacity-60"
            />
          </div>
        )}
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
          <p id="repo-root-message" data-testid="repo-root-message" className="text-foreground">
            {message}
          </p>
          {next ? <div className="flex flex-wrap gap-1.5">{next}</div> : null}
        </div>
      </div>
      {takenOnGithub && mode === "create" && status.kind === "target" && status.state.kind === "free" ? (
        <div className="flex items-start gap-2 border-t border-border px-3 py-2 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <p className="text-ink-2">
            GitHub の {takenOnGithub} には、もう {folder} があります。あとで公開するときは別の名前が要ります。
            その {folder} で作業するなら{" "}
            <button
              type="button"
              onClick={onSwitchToClone}
              className="rounded-sm font-medium text-foreground underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              clone で始める
            </button>
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** そのリポジトリがどこのものか（かっこの中に添える短い言い方） */
function remoteText(remote: RepoRemote): ReactNode {
  if (remote.kind === "github") {
    return (
      <>
        GitHub の <span className="font-mono break-all">{remote.owner}/{remote.name}</span>
      </>
    );
  }
  if (remote.kind === "elsewhere") return <>{remoteHost(remote.url)}</>;
  return <>このマシンにだけ</>;
}

function describe({
  mode,
  home,
  folder,
  folderInvalid,
  renamedFrom,
  status,
  onFolderChange,
  onUseAsFolder,
  onOpenProject,
  failedNext,
}: {
  mode: "clone" | "create";
  home: string;
  folder: string;
  folderInvalid: boolean;
  renamedFrom?: string;
  status: RootPreviewStatus;
  onFolderChange: (next: string) => void;
  onUseAsFolder: (path: string) => void;
  onOpenProject: (projectId: string, closed: boolean) => void;
  failedNext?: ReactNode;
}): { tone: Tone; icon: ReactNode; message: ReactNode; next?: ReactNode } {
  if (status.kind === "cloning") {
    return {
      tone: "plain",
      icon: <LoaderCircle className="motion-safe:animate-spin" />,
      message: (
        <>
          Repo が clone しています…{" "}
          <span className="font-mono text-ink-3 tabular-nums">
            {status.received.toLocaleString()} / {status.total.toLocaleString()}
          </span>
        </>
      ),
    };
  }
  if (status.kind === "clone-failed") {
    return {
      tone: "stop",
      icon: <Ban />,
      message: <>clone できませんでした：{status.reason}</>,
      next: failedNext ?? (
        <p className="text-ink-2">
          非公開のリポジトリなら、読めるアカウントを Repo の設定に登録してから、もう一度選んでください。
        </p>
      ),
    };
  }
  if (status.kind === "have") {
    const { repo, project } = status;
    const what = repo.remote.kind === "github" ? `${repo.remote.owner}/${repo.remote.name}` : repo.name;
    return project
      ? {
          tone: "go",
          icon: <ArrowRight />,
          message: (
            <>
              {what} は、もうこのマシンにあり、Project「{project.name}」が使っています。新しくは作らず、それを
              {project.closed ? "再開" : "開き"}ます。
            </>
          ),
        }
      : {
          tone: "ok",
          icon: <CircleCheck />,
          message: <>{what} は、もうこのマシンにあります。clone せず、このフォルダをそのまま使います。</>,
        };
  }
  if (status.kind === "reclone") {
    const { project } = status;
    return {
      tone: "plain",
      icon: <CloudDownload />,
      message: (
        <>
          Repo の一覧にありますが、フォルダが見つかりません。Repo が元の場所に clone し直します
          {project ? <>——Project「{project.name}」はこのフォルダを Root にしたまま{project.closed ? "再開し" : "開き"}ます</> : null}。
        </>
      ),
    };
  }

  if (folder === "") {
    return {
      tone: "plain",
      icon: mode === "clone" ? <CloudDownload /> : <FolderPlus />,
      message: mode === "clone" ? "フォルダ名を入れてください。" : `名前を入れると、${home} の下に作ります。`,
    };
  }
  if (folderInvalid) {
    return { tone: "stop", icon: <Ban />, message: "使えるのは英数字と - _ . だけです。" };
  }

  const { state } = status;
  const path = `${home}/${folder}`;
  if (state.kind === "free") {
    return mode === "clone"
      ? {
          tone: "plain",
          icon: <CloudDownload />,
          message: renamedFrom ? (
            <>
              Repo がここに clone します。<span className="font-mono">{home}/{renamedFrom}</span>{" "}
              は、もう使っているので {folder} にしました。
            </>
          ) : (
            "Repo がここに clone します。"
          ),
        }
      : {
          tone: "plain",
          icon: <FolderPlus />,
          message: "Repo がここに空のリポジトリを作ります（git init）。GitHub には、まだ作りません。",
        };
  }

  const rename = (
    <NextStep
      key="rename"
      testId="repo-root-rename"
      label={`${state.suggestion} にする`}
      onClick={() => onFolderChange(state.suggestion)}
    />
  );
  const verb = mode === "clone" ? "clone" : "作成";
  switch (state.kind) {
    case "taken-repo": {
      const { repo, project } = state;
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            ここには、もう {repo.name} があります（{remoteText(repo.remote)}
            {project ? <>・Project「{project.name}」が使っています</> : null}）。上書きしないので、{verb}できません。
          </>
        ),
        // 使っている Project があるなら、同じフォルダに2つ目を作るより、それを開く
        next: [
          rename,
          project ? (
            <NextStep
              key="open"
              label={`「${project.name}」を${project.closed ? "再開" : "開く"}`}
              onClick={() => onOpenProject(project.id, project.closed)}
            />
          ) : (
            <NextStep key="use" label="このフォルダで Project を作る" onClick={() => onUseAsFolder(path)} />
          ),
        ],
      };
    }
    case "taken-missing":
      // 見つからなくても、一覧のその行の場所——clone し直す先として空けておく
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            ここは Repo の一覧にある {state.repo.name} の場所です（フォルダは見つかりません）。一覧から外すまで、ここには
            {verb}しません。
          </>
        ),
        next: rename,
      };
    case "taken-unknown-repo":
      return {
        tone: "stop",
        icon: <Ban />,
        message: <>ここには、Repo がまだ知らない git のリポジトリがあります。上書きしないので、{verb}できません。</>,
        next: [rename, <NextStep key="use" label="このフォルダで Project を作る" onClick={() => onUseAsFolder(path)} />],
      };
    case "taken-folder":
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            ここには git でないフォルダがあります（{state.entries} 項目）。上書きしないので、{verb}できません。
          </>
        ),
        next: rename,
      };
  }
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
