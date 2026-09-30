"use client";

// まだこのマシンにだけあるリポジトリを GitHub に公開する（2026-09-29）。
// Repo Module の Canvas（`banto.repo:publish`）。**入口は2つ**（改訂・2026-09-30）：
// - Project の中の入口「この Project を GitHub に公開」——その Project の Root のリポジトリ
// - リポジトリの一覧の「GitHub に公開」——一覧の中で開く（`folder`・`onBack` を渡す）
// 対象は**フォルダ**で決まる（Project ではない）。リポジトリの状態の真実は
// `lib/mock/github.ts` のフォルダ1つずつ（規則3）。**公開してもフォルダは動かさない**
// （2026-09-30、ユーザー——置き場は GitHub の持ち主や名前に縛られないので、ずれという考えが無い）。
//
// 決めること：どのアカウント・名前・公開／非公開・最初の push。
// いちばん上に **どこから、どこへ**（手元のフォルダ → github.com/<owner>/<name>）を
// 置く——新しい Project の画面の Root パスの帯と同じ見た目で、打つたびに行き先が変わる。
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  Ban,
  CircleAlert,
  CircleCheck,
  Circle,
  GitBranch,
  Globe,
  LoaderCircle,
  Lock,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { getProject } from "@/lib/mock/projects";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import {
  useGithubAccounts,
  readFolderRepo,
  gitInitFolder,
  repoExistsOnGithub,
  setRepoRemote,
  type KnownRepo,
} from "@/lib/mock/github";
import { ChoicePills } from "@/components/banto/project/choice-pills";
import {
  GithubAccountChooser,
  NoGithubAccount,
} from "@/components/banto/project/github-account-chooser";

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

/** Project の中の入口から開いたとき——その Project の Root を対象にする */
export function RepoPublishView() {
  const params = useParams<{ projectId?: string }>();
  if (!params.projectId) {
    return <p className="p-6 text-sm text-ink-3">Project の中で開くか、リポジトリの一覧から開いてください。</p>;
  }
  return <RepoPublishPanel folder={getProject(params.projectId).basePath} />;
}

export function RepoPublishPanel({ folder, onBack }: { folder: string; onBack?: () => void }) {
  useMockStoreVersion();
  // 台帳ではなくフォルダから読む——一覧から外したフォルダでも公開できる
  const repo = readFolderRepo(folder);
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-testid="repo-publish">
      <div className="mx-auto flex max-w-xl flex-col gap-6 px-5 py-8">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-mb-3 flex w-fit items-center gap-1 rounded-sm text-xs text-ink-3 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ArrowLeft className="size-3.5" />
            リポジトリの一覧
          </button>
        ) : null}
        {!repo ? (
          <NotGit folder={folder} />
        ) : repo.remote.kind === "none" ? (
          <PublishForm folder={folder} repo={repo} />
        ) : repo.remote.kind === "github" ? (
          <Published folder={folder} remote={repo.remote} />
        ) : (
          <>
            <Heading
              title="GitHub の外にあります"
              lead="このリポジトリの origin は GitHub ではありません。ここからは公開しません。"
            />
            <p className="font-mono text-xs break-all text-ink-2">origin：{repo.remote.url}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Heading({ title, lead }: { title: string; lead: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-ink-2">{lead}</p>
    </header>
  );
}

/** どこから、どこへ。新しい Project の Root パスの帯と同じ見た目 */
function Route({
  folder,
  owner,
  name,
  isPrivate,
  published,
}: {
  folder: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  published: boolean;
}) {
  return (
    <div data-testid="publish-route" className="overflow-hidden rounded-md border border-border">
      <div className="flex flex-col gap-0.5 px-3 py-2.5">
        <p className="text-xs text-ink-3">このマシンの中</p>
        <p className="font-mono text-md break-all text-ink-2">{folder}</p>
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-surface-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="flex items-center gap-1 text-xs text-ink-3">
            <ArrowDown className="size-3" />
            {published ? "GitHub（origin）" : "GitHub に作る"}
          </p>
          <p data-testid="publish-target" className="font-mono text-md break-all text-ink-3">
            github.com/<span className="text-ink-2">{owner}/</span>
            <span className="font-medium text-foreground">{name || "…"}</span>
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-xs text-ink-2">
          {isPrivate ? <Lock className="size-3" /> : <Globe className="size-3" />}
          {isPrivate ? "非公開" : "公開"}
        </span>
      </div>
    </div>
  );
}

type Step = { label: string; state: "waiting" | "running" | "done" };

function PublishForm({ folder, repo }: { folder: string; repo: KnownRepo }) {
  const accounts = useGithubAccounts();
  // 台帳がアカウントを覚えていれば、それを先に選んでおく
  const [accountChoice, setAccountChoice] = useState<string | null>(repo.accountId ?? null);
  const account = accounts.find((a) => a.id === accountChoice) ?? accounts[0];
  const [name, setName] = useState(repo.name);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [pushAll, setPushAll] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const invalid = name !== "" && (!REPO_NAME.test(name) || /^\.+$/.test(name));
  const taken = !!account && !!name && !invalid && repoExistsOnGithub(account.login, name);
  const hasCommits = repo.commits > 0;
  const running = steps !== null;
  const canPublish = !!account && !!name && !invalid && !taken && !running;
  const branches = pushAll ? [repo.branch, ...repo.otherBranches] : [repo.branch];

  function publish() {
    if (!account || !canPublish) return;
    const plan: Step[] = [
      { label: `GitHub に ${account.login}/${name} を作る（${visibility === "private" ? "非公開" : "公開"}）`, state: "waiting" },
      { label: "origin に設定する", state: "waiting" },
      ...(hasCommits
        ? [{ label: `${branches.join("・")} を push する（${repo.commits} コミット）`, state: "waiting" as const }]
        : []),
    ];
    let i = 0;
    const advance = () => {
      setSteps(plan.map((s, j) => ({ ...s, state: j < i ? "done" : j === i ? "running" : "waiting" })));
      if (i === plan.length) {
        setRepoRemote(
          repo.path,
          { kind: "github", owner: account.login, name, private: visibility === "private" },
          account.id,
        );
        toast(`github.com/${account.login}/${name} に公開しました`);
        return;
      }
      i += 1;
      timer.current = setTimeout(advance, 700);
    };
    advance();
  }

  return (
    <>
      <Heading
        title="GitHub に公開"
        lead="このリポジトリは、まだこのマシンの中にだけあります。GitHub にリポジトリを作って、push します。"
      />

      {account ? (
        <Route
          folder={folder}
          owner={account.login}
          name={name}
          isPrivate={visibility === "private"}
          published={false}
        />
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-3">ブランチ</dt>
        <dd className="flex items-center gap-1 text-ink-2">
          <GitBranch className="size-3 text-ink-3" />
          <span className="font-mono">{repo.branch}</span>
          {hasCommits ? <span>· {repo.commits} コミット</span> : <span>· まだコミットがありません</span>}
        </dd>
        {hasCommits ? (
          <>
            <dt className="text-ink-3">最後のコミット</dt>
            <dd className="text-ink-2">
              {repo.lastCommit} <span className="text-ink-3">（{repo.lastCommitAt}）</span>
            </dd>
          </>
        ) : null}
      </dl>

      {!account ? (
        <NoGithubAccount reason="登録したアカウントに、リポジトリを作ります。" />
      ) : (
        <fieldset disabled={running} className="flex flex-col gap-5">
          <GithubAccountChooser
            id="publish-account"
            accounts={accounts}
            value={account.id}
            onChange={setAccountChoice}
            singleNote="に作ります"
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="publish-name">リポジトリ名</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value.trim())}
              aria-invalid={invalid || taken || undefined}
              aria-describedby="publish-name-help"
              className="font-mono text-xs"
            />
            <div id="publish-name-help" aria-live="polite">
              {invalid ? (
                <p className="text-xs text-turn">使えるのは英数字と - _ . だけです</p>
              ) : taken ? (
                <div
                  data-testid="publish-name-taken"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-turn-soft px-2.5 py-1.5 text-xs text-foreground"
                >
                  <Ban className="size-3.5 shrink-0 text-turn" />
                  <span>{account.login} には、もう {name} があります。</span>
                  <button
                    type="button"
                    onClick={() => setName(`${name}-2`)}
                    className="font-medium underline"
                  >
                    {name}-2 にする
                  </button>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <p id="publish-visibility-label" className="text-xs font-medium text-foreground">
              公開範囲
            </p>
            <ChoicePills
              labelledBy="publish-visibility-label"
              testId="publish-visibility"
              value={visibility}
              onChange={setVisibility}
              choices={[
                { value: "private", label: <><Lock className="size-3" />非公開</> },
                { value: "public", label: <><Globe className="size-3" />公開</> },
              ]}
            />
            {visibility === "private" ? (
              <p className="text-xs text-ink-3">{account.login} と、招いた人だけが見られます。</p>
            ) : (
              <p className="flex items-start gap-1.5 text-xs text-ink-2">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
                誰でも読めます。これまでの{hasCommits ? ` ${repo.commits} コミットの` : ""}履歴も、すべて公開されます。
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-medium text-foreground">最初の push</p>
            {hasCommits ? (
              <>
                <p className="text-xs text-ink-2">
                  <span className="font-mono">{repo.branch}</span> を push して、以後は{" "}
                  <span className="font-mono">origin/{repo.branch}</span> を追います。
                </p>
                {repo.otherBranches.length > 0 ? (
                  <label className="flex items-center gap-2 text-xs text-ink-2">
                    <Switch checked={pushAll} onCheckedChange={setPushAll} />
                    <span>
                      ほかのブランチ（<span className="font-mono">{repo.otherBranches.join("・")}</span>）も push する
                    </span>
                  </label>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-ink-2">
                まだコミットが無いので、リポジトリを作って origin を設定するところまでにします。
                最初の push は、コミットしてから。
              </p>
            )}
          </div>
        </fieldset>
      )}

      {steps ? (
        <ol data-testid="publish-steps" aria-live="polite" className="flex flex-col gap-1.5 text-xs">
          {steps.map((s) => (
            <li key={s.label} className={cn("flex items-center gap-2", s.state === "waiting" ? "text-ink-3" : "text-foreground")}>
              {s.state === "done" ? (
                <CircleCheck className="size-3.5 shrink-0 text-ok" />
              ) : s.state === "running" ? (
                <LoaderCircle className="size-3.5 shrink-0 text-ink-3 motion-safe:animate-spin" />
              ) : (
                <Circle className="size-3.5 shrink-0" />
              )}
              {s.label}
            </li>
          ))}
        </ol>
      ) : null}

      {account ? (
        <div>
          <Button type="button" disabled={!canPublish} onClick={publish} data-testid="publish-submit">
            {running ? "公開しています…" : hasCommits ? "GitHub に作って push" : "GitHub に作る"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Published({
  folder,
  remote,
}: {
  folder: string;
  remote: Extract<KnownRepo["remote"], { kind: "github" }>;
}) {
  return (
    <>
      <Heading
        title="GitHub にあります"
        lead={`このリポジトリは github.com/${remote.owner}/${remote.name} を origin にしています。`}
      />
      <Route folder={folder} owner={remote.owner} name={remote.name} isPrivate={remote.private} published />
      <p data-testid="publish-done" className="flex items-center gap-1.5 text-xs text-ink-2">
        <CircleCheck className="size-3.5 text-ok" />
        公開済みです。
      </p>
    </>
  );
}

function NotGit({ folder }: { folder: string }) {
  return (
    <>
      <Heading
        title="GitHub に公開"
        lead="このフォルダは、git のリポジトリではありません。"
      />
      <p className="font-mono text-md break-all text-ink-2">{folder}</p>
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-ink-2">git init すると、ここから GitHub に公開できます。</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => gitInitFolder(folder)}
        >
          git init する
        </Button>
      </div>
    </>
  );
}
