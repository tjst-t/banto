"use client";

// **Root パスと、そこで何が起きるか**を1つの帯で言う（2026-09-29）。
//
// clone と「新しいリポジトリ」の Root は人が打たない——`~/ghq/github.com/<owner>/<repo>`
// に決まる。だから画面の仕事は入力欄ではなく、**決まった場所と、そこに既に何があるか**を
// 押す前に見せること。フォルダを用意するのは Repo なので、文は「Repo が〜します」で言う。
// 置き場の状態は6つ（`RepoFolderState`）で、判断は
// `inspectRepoFolder` の1箇所が持つ（規則3）——この部品は言い方だけを持つ。
//
// 色は状態に1つずつ：そのまま使う＝ok の地、断る＝turn の地（人の手が要る）。
// 既にある Project へ行く＝地は塗らず、印だけ accent（行き先を示すだけで、止めてはいない）。
// 何も無い（普通に clone する）ときは塗らない。
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
import { GHQ_ROOT, type RepoFolderState } from "@/lib/mock/github";

export type RootPreviewStatus =
  | { kind: "folder"; state: RepoFolderState }
  | { kind: "cloning"; received: number; total: number }
  | { kind: "clone-failed"; reason: string };

type Tone = "plain" | "ok" | "go" | "stop";

export function RepoRootPreview({
  mode,
  owner,
  name,
  status,
  takenOnGithub,
  onUseAsFolder,
  onSwitchToClone,
  onOpenProject,
}: {
  mode: "clone" | "create";
  owner: string;
  name: string;
  status: RootPreviewStatus;
  /** 「新しいリポジトリ」で、GitHub の同じアカウントに同じ名前が既にある */
  takenOnGithub?: boolean;
  /** 断ったときの次の手——そのフォルダを「フォルダを選ぶ」でそのまま Root にする */
  onUseAsFolder: () => void;
  onSwitchToClone: () => void;
  /** そのフォルダを Root にした Project が、もうあるとき——新しく作らずそれを開く */
  onOpenProject: (projectId: string, closed: boolean) => void;
}) {
  const { tone, icon, message, next } = describe(mode, owner, name, status, {
    onUseAsFolder,
    onSwitchToClone,
    onOpenProject,
  });

  return (
    <section
      aria-labelledby="repo-root-label"
      data-testid="repo-root-preview"
      data-state={status.kind === "folder" ? status.state.kind : status.kind}
      className="overflow-hidden rounded-md border border-border"
    >
      <div className="flex flex-col gap-0.5 bg-surface-2 px-3 py-2.5">
        <p id="repo-root-label" className="text-xs text-ink-3">
          Root パス
        </p>
        <p
          data-testid="repo-root-path"
          className="font-mono text-lg leading-snug break-words text-ink-3"
        >
          {/* 折り返すなら / の後で（名前の途中で切らない） */}
          {GHQ_ROOT}/<wbr />
          <span className="text-ink-2">{owner}/</span>
          <wbr />
          <span className="font-medium text-foreground">{name}</span>
        </p>
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
          <p data-testid="repo-root-message" className="text-foreground">
            {message}
          </p>
          {next}
        </div>
      </div>
      {takenOnGithub && mode === "create" && status.kind === "folder" && status.state.kind === "empty" ? (
        <div className="flex items-start gap-2 border-t border-border px-3 py-2 text-xs">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <p className="text-ink-2">
            GitHub の {owner} には、もう {name} があります。あとで公開するときは別の名前が要ります。
            その {name} で作業するなら{" "}
            <button type="button" onClick={onSwitchToClone} className="font-medium text-foreground underline">
              clone で始める
            </button>
          </p>
        </div>
      ) : null}
    </section>
  );
}

function describe(
  mode: "clone" | "create",
  owner: string,
  name: string,
  status: RootPreviewStatus,
  actions: {
    onUseAsFolder: () => void;
    onSwitchToClone: () => void;
    onOpenProject: (projectId: string, closed: boolean) => void;
  },
): { tone: Tone; icon: ReactNode; message: ReactNode; next?: ReactNode } {
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
      next: (
        <p className="text-ink-2">
          非公開のリポジトリなら、読めるアカウントを Repo の設定に登録してから、もう一度選んでください。
        </p>
      ),
    };
  }

  const useAsFolder = (
    <NextStep label="このフォルダをそのまま Root にする" onClick={actions.onUseAsFolder} />
  );

  switch (status.state.kind) {
    case "empty":
      return mode === "clone"
        ? { tone: "plain", icon: <CloudDownload />, message: "Repo がここに clone します。" }
        : {
            tone: "plain",
            icon: <FolderPlus />,
            message: "Repo がここに空のリポジトリを作ります（git init）。GitHub には、まだ作りません。",
          };
    case "same-repo":
      return mode === "clone"
        ? {
            tone: "ok",
            icon: <CircleCheck />,
            message: (
              <>
                {owner}/{name} は、もうここに clone してあります。clone せず、このフォルダをそのまま使います。
              </>
            ),
          }
        : {
            tone: "stop",
            icon: <Ban />,
            message: (
              <>
                ここには、もう {owner}/{name} の clone があります。新しくは作りません。
              </>
            ),
            next: <NextStep label="GitHub から clone で開く" onClick={actions.onSwitchToClone} />,
          };
    case "same-repo-project":
      return mode === "clone"
        ? {
            tone: "go",
            icon: <ArrowRight />,
            message: (
              <>
                このフォルダを Root にした Project「{status.state.projectName}」が、もうあります。
                新しくは作らず、それを{status.state.closed ? "再開" : "開き"}ます。
              </>
            ),
          }
        : {
            tone: "stop",
            icon: <Ban />,
            message: (
              <>
                ここには、もう {owner}/{name} があり、Project「{status.state.projectName}」の Root です。
                新しくは作りません。
              </>
            ),
            next: <NextStep label="GitHub から clone で開く" onClick={actions.onSwitchToClone} />,
          };
    case "local-only": {
      const { project } = status.state;
      const usedBy = project ? <>（Project「{project.name}」の Root）</> : null;
      // 使っている Project があるなら、同じフォルダに2つ目を作るより、それを開く
      const next = project ? (
        <NextStep
          label={`「${project.name}」を${project.closed ? "再開" : "開く"}`}
          onClick={() => actions.onOpenProject(project.id, project.closed)}
        />
      ) : (
        useAsFolder
      );
      return mode === "clone"
        ? {
            tone: "stop",
            icon: <Ban />,
            message: (
              <>
                ここには、まだ GitHub に上げていない {name} があります{usedBy}。上書きしないので、clone できません。
              </>
            ),
            next,
          }
        : {
            tone: "stop",
            icon: <Ban />,
            message: (
              <>
                ここには、もう {name} があります{usedBy}。新しくは作りません。
              </>
            ),
            next,
          };
    }
    case "other-repo":
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            ここには別のリポジトリがあります（origin：
            <span className="font-mono break-all">{status.state.origin}</span>
            ）。上書きしないので、{mode === "clone" ? "clone" : "作成"}できません。
          </>
        ),
        next: useAsFolder,
      };
    case "not-git":
      return {
        tone: "stop",
        icon: <Ban />,
        message: (
          <>
            ここには git でないフォルダがあります（{status.state.entries} 項目）。上書きしないので、
            {mode === "clone" ? "clone" : "作成"}できません。
          </>
        ),
        next: (
          <>
            <p className="text-ink-2">中身を移すか消してから、もう一度選んでください。</p>
            {useAsFolder}
          </>
        ),
      };
  }
}

function NextStep({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-7 w-fit gap-1 bg-background text-xs"
    >
      {label}
      <ArrowRight className="size-3" />
    </Button>
  );
}
