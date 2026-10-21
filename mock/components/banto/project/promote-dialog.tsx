"use client";

// 相談を Project にする（モック・2026-10-21、Fork「Project 作成前の検討」）。
//
// 中身は初めから普通の Project なので、ここで決めるのは「呼び方と置き場」だけ。会話・Memory・試作の
// ファイルはそのまま残る——それを1行で言い、決めることは4つに絞る：名前・グループ・フォルダ・リポジトリ。
// AI が「Project にしましょう」と言うときも、この画面を開くだけ（作るのは人が押したとき）。
import { useState } from "react";
import { useRouter } from "next/navigation";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getProject } from "@/lib/mock/projects";
import { getGroups } from "@/lib/mock/project-org";
import { useGithubAccounts } from "@/lib/mock/github";
import { folderNameOf, getDraft, promoteDraft, suggestedNameOf, suggestedSlugOf, type RepoChoice } from "@/lib/mock/drafts";
import { ChoicePills } from "./choice-pills";
import { GithubAccountChooser } from "./github-account-chooser";

const NO_GROUP = "__none";

export function PromoteDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <PromoteBody key={projectId} projectId={projectId} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PromoteBody({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const router = useRouter();
  const project = getProject(projectId);
  const draft = getDraft(projectId);
  const accounts = useGithubAccounts();
  const [name, setName] = useState(suggestedNameOf(projectId));
  const [slug, setSlug] = useState(suggestedSlugOf(projectId));
  const [groupId, setGroupId] = useState<string>("g-dev");
  const [folder, setFolder] = useState<"keep" | "move">("move");
  const [repo, setRepo] = useState<RepoChoice>("github");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const movedPath = `~/banto/${slug}`;
  const files = draft?.files ?? 0;

  function submit() {
    promoteDraft(projectId, { name, slug, groupId: groupId === NO_GROUP ? null : groupId, folder, repo, visibility });
    onDone();
    toast(`「${name}」を Project にしました`, {
      description:
        repo === "github"
          ? `GitHub に${visibility === "private" ? "非公開" : "公開"}で上げました。会話はそのまま続けられます`
          : "会話はそのまま続けられます",
    });
    router.push(`/p/${projectId}`);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Project にする</DialogTitle>
        <DialogDescription>
          この相談の会話・決まったこと（Memory）・{files > 0 ? `試作のファイル ${files} 個` : "フォルダ"}は、そのまま引き継ぎます。
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5 py-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-name">名前</Label>
          <Input id="promote-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-slug">フォルダとリポジトリの名前</Label>
          <Input
            id="promote-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono"
          />
          <p className="text-xs text-ink-3">どちらも相談の中身から AI が付けた名前です。</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-group">グループ</Label>
          <Select value={groupId} onValueChange={setGroupId}>
            <SelectTrigger id="promote-group" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GROUP}>グループに入れない</SelectItem>
              {getGroups().map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <span id="promote-folder" className="text-sm font-medium">
            フォルダ
          </span>
          <ChoicePills
            labelledBy="promote-folder"
            value={folder}
            onChange={setFolder}
            choices={[
              { value: "move", label: "置き場へ移す" },
              { value: "keep", label: "今の場所のまま" },
            ]}
          />
          <p className="text-xs text-ink-3">
            {folder === "move" ? (
              <>
                <code>{project.basePath}</code> から <code>{movedPath}</code> へ移します。
              </>
            ) : (
              <>
                <code>{project.basePath}</code> のまま使います。
              </>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span id="promote-repo" className="text-sm font-medium">
            リポジトリ
          </span>
          <ChoicePills
            labelledBy="promote-repo"
            value={repo}
            onChange={setRepo}
            choices={[
              { value: "github", label: "GitHub に上げる" },
              { value: "local", label: "手元だけ（git init）" },
              { value: "none", label: "作らない" },
            ]}
          />
          {repo === "github" ? (
            <div className="mt-1 flex flex-col gap-2 rounded-md bg-surface-2 p-3">
              <GithubAccountChooser
                id="promote-account"
                accounts={accounts}
                value={account}
                onChange={setAccount}
                singleNote="で作ります"
              />
              <ChoicePills
                label="公開範囲"
                value={visibility}
                onChange={setVisibility}
                choices={[
                  { value: "private", label: "非公開" },
                  { value: "public", label: "公開" },
                ]}
              />
              <p className="text-xs text-ink-3">
                リポジトリ「{slug}」を作り、今あるファイルを最初のコミットにして上げます。
              </p>
            </div>
          ) : repo === "local" ? (
            <p className="text-xs text-ink-3">GitHub にはあとで Repositories から上げられます。</p>
          ) : (
            <p className="text-xs text-ink-3">git を使わない Project にします（調べもの・書きものなど）。</p>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          やめる
        </Button>
        <Button onClick={submit} disabled={!name.trim() || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)}>
          Project にする
        </Button>
      </DialogFooter>
    </>
  );
}
