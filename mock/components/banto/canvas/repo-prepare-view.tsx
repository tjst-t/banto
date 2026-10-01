"use client";

// Repositories が core の新しい Project の画面に差し出す画面（2026-10-01、作り直し）——本物は `ui://banto.repositories/prepare-clone`・
// `ui://banto.repositories/prepare-create`（MCP Apps）。core はこれを始め方のタブの中に埋め込むだけで、中身を知らない。
//
// **Repositories の仕事はフォルダを用意するところまで**。用意できたら `host.onPrepared({ path, suggestedName, summary })` で
// core に返す——Project を作るのは core（Project 名・Advanced・作るボタンは core の画面の下の段）。
// そのフォルダをもう Project が使っているかも core が調べる（ここでは聞かない）。
// 中身は一覧のダイアログと同じ本体（`RepoCloneForm`・`RepoCreateForm`）。ボタンは枠の中、右下に1つ。
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MockFolderProviderHost } from "@/lib/mock/types";
import { RepoCloneForm } from "./repo-clone-form";
import { RepoCreateForm } from "./repo-create-form";

export function RepoPrepareCloneView({ host }: { host: MockFolderProviderHost }) {
  // 帯の次の手はどれも「そのフォルダを Root にする」こと——core に返せば、core が名前を聞く・既にある Project を開く
  const handOver = (path: string, summary: string) =>
    host.onPrepared({ path, suggestedName: path.split("/").pop(), summary });
  return (
    <RepoCloneForm
      picker="search"
      initialInput={host.initialInput}
      onCloned={(f) =>
        host.onPrepared({
          path: f.path,
          suggestedName: f.suggestedName,
          summary: f.recloned ? `${f.label} を ${f.path} に clone し直しました` : `${f.label} を ${f.path} に clone しました`,
        })
      }
      onUseAsFolder={(path) => handOver(path, `${path} をそのまま使います（clone はしていません）`)}
      onOpenAt={(path) => handOver(path, `${path} をそのまま使います（clone はしていません）`)}
      renderActions={(step) => (
        <div className="flex justify-end">
          {step.kind === "have" ? (
            <Button
              type="button"
              size="sm"
              data-testid="repo-prepare-submit"
              onClick={() =>
                host.onPrepared({
                  path: step.repo.path,
                  suggestedName: step.repo.name,
                  summary: `もう手元にある ${step.repo.path} を使います（clone はしていません）`,
                })
              }
            >
              この場所を使う
            </Button>
          ) : step.kind === "clone" ? (
            <Button type="button" size="sm" data-testid="repo-prepare-submit" onClick={step.start}>
              {step.failed ? "もう一度 " : ""}
              {step.recloning ? "clone し直す" : "clone する"}
            </Button>
          ) : step.kind === "busy" ? (
            <Button type="button" size="sm" data-testid="repo-prepare-submit" disabled>
              clone しています…
            </Button>
          ) : step.kind === "blocked" ? (
            <Button type="button" size="sm" data-testid="repo-prepare-submit" disabled>
              clone する
            </Button>
          ) : null}
        </div>
      )}
    />
  );
}

export function RepoPrepareCreateView({ host }: { host: MockFolderProviderHost }) {
  // 「GitHub に同じ名前がある——clone で始める」は Repositories の画面の中の移動（core のタブは替えない）
  const [cloneFrom, setCloneFrom] = useState<string | null>(null);
  if (cloneFrom) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => setCloneFrom(null)}
          data-testid="repo-prepare-back"
          className="flex w-fit items-center gap-1 rounded-sm text-xs text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-3.5" />
          新しく作るほうに戻る
        </button>
        <RepoPrepareCloneView host={{ ...host, initialInput: cloneFrom }} />
      </div>
    );
  }
  const handOver = (path: string) =>
    host.onPrepared({
      path,
      suggestedName: path.split("/").pop(),
      summary: `${path} をそのまま使います（作ってはいません）`,
    });
  return (
    <RepoCreateForm
      initialName={host.initialInput?.split("/").pop() ?? ""}
      onCreated={({ path, name }) =>
        host.onPrepared({ path, suggestedName: name, summary: `${path} を作りました（git init）` })
      }
      onUseAsFolder={handOver}
      onOpenAt={handOver}
      onSwitchToClone={setCloneFrom}
      renderActions={({ ready, create }) => (
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={!ready} onClick={create} data-testid="repo-prepare-submit">
            リポジトリを作る
          </Button>
        </div>
      )}
    />
  );
}
