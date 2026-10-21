"use client";

// **チャットを Project にする**（追加・2026-10-21、v4-frontend.md §6.53「『Project にする』の小窓」、アーキ仕様 §2.2
// 「Project にする」。見本はモック `fork/draft-projects` の `mock/components/banto/project/promote-dialog.tsx`）。
//
// 中身は初めから普通の Project なので、ここで決めるのは呼び方と置き場だけ——名前・フォルダとリポジトリの名前・グループ・
// フォルダ（置き場へ移す／今の場所のまま）・リポジトリ。会話・Memory・フォルダの中身はそのまま残る。
// **リポジトリの欄は Module が名乗った画面**（`folder-adopter`、`lib/backend/canvas-folder-adopter.ts`）を枠の中に出したもの
// ——core は Repositories を名指ししない。名乗る Module が無ければ欄を出さない。
//
// 押したら：host で Project にする（フォルダを移すならここで移る。断られたら理由を出して小窓は開いたまま）→ 移したあとの
// フォルダでリポジトリの画面に頼む → その Project の画面へ。リポジトリにできなかったときは、Project にはなっているので
// そう言う（黙って「できた」にしない、規則2）
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
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
import { ModuleCanvas } from "@/components/banto/canvas/module-canvas";
import { listRealFolderAdopters, type RealFolderProvider } from "@/lib/backend/client";
import type { AdoptedFolder, FolderAdopterState, FolderAdopterTarget } from "@/lib/backend/canvas-folder-adopter";
import { useProjectGroups } from "@/lib/backend/project-groups";
import { getProject, promoteChat } from "@/lib/mock/projects";
import { describeFailure } from "@/lib/report-failure";
import { ChoicePills } from "./choice-pills";

const NO_GROUP = "__none";

/** フォルダとリポジトリの名前に使える形（host の `promotedRootOf` と同じ） */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** 名前から英小文字の案を作る。英数字が無ければ今のフォルダの名前（`<日付>-<短い id>`） */
function slugOf(name: string, root: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return ascii || (root.split("/").filter(Boolean).at(-1) ?? "project");
}

/** 置き場へ移した先（チャットの置き場の親の下、host の `promotedRootOf` と同じ）。根が置き場の形でなければ undefined */
function movedRootOf(root: string, slug: string): string | undefined {
  const parts = root.split("/");
  if (parts.length < 3) return undefined;
  return `${parts.slice(0, -2).join("/")}/${slug}`;
}

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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" data-testid="promote-dialog">
        {open ? <PromoteBody key={projectId} projectId={projectId} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PromoteBody({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const router = useRouter();
  const project = getProject(projectId);
  const groups = useProjectGroups();
  // 開いたときの根。押すと host で移り、手元の写しも新しい根になる——リポジトリの画面に渡す「どのフォルダか」は替えない
  // （替えると画面が調べ直し、人が選んだものが既定に戻る）。押したときに頼むのは移したあとの根
  const [root] = useState(project.basePath);
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(() => slugOf(project.name, project.basePath));
  const [groupId, setGroupId] = useState<string>(NO_GROUP);
  const [folder, setFolder] = useState<"move" | "keep">("move");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // リポジトリの欄：名乗った画面（無ければ欄を出さない）・画面が言う「押せるか」・押したときに頼む口
  const [adopters, setAdopters] = useState<RealFolderProvider[] | null>(null);
  const [adoptersError, setAdoptersError] = useState<string | null>(null);
  const [adopterState, setAdopterState] = useState<FolderAdopterState | null>(null);
  const adoptFolderRef = useRef<((target: FolderAdopterTarget) => Promise<AdoptedFolder>) | null>(null);
  useEffect(() => {
    let cancelled = false;
    listRealFolderAdopters().then(
      (list) => !cancelled && setAdopters(list),
      (err: unknown) => !cancelled && setAdoptersError(describeFailure(err)),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const adopter = adopters?.[0];

  const trimmed = name.trim();
  const slugOk = SLUG.test(slug) && slug !== "chats";
  const movedRoot = movedRootOf(root, slug);
  // 画面が「押せない」と言っている間は押せない（言ってくるまでも）
  const adopterBlocks = adopter !== undefined && adopterState?.ready !== true;
  const canSubmit = !busy && trimmed !== "" && slugOk && (folder === "keep" || movedRoot !== undefined) && !adopterBlocks;

  async function submit() {
    setBusy(true);
    setError(null);
    let promoted;
    try {
      promoted = await promoteChat(projectId, {
        name: trimmed,
        groupId: groupId === NO_GROUP ? null : groupId,
        ...(folder === "move" ? { folder: slug } : {}),
      });
    } catch (err) {
      // 断られた（ターンが走っている等）——理由を出して小窓は開いたまま
      setError(describeFailure(err));
      setBusy(false);
      return;
    }
    let repoSummary: string | undefined;
    let repoError: string | undefined;
    if (adopter) {
      const adopt = adoptFolderRef.current;
      if (!adopt) repoError = "リポジトリの画面がまだ繋がっていません";
      else {
        try {
          repoSummary = (await adopt({ path: promoted.basePath, name: slug })).summary;
        } catch (err) {
          repoError = describeFailure(err);
        }
      }
    }
    onDone();
    if (repoError) {
      toast.error(`「${promoted.name}」を Project にしましたが、リポジトリにできませんでした`, { description: repoError });
    } else {
      toast(`「${promoted.name}」を Project にしました`, {
        description: repoSummary ? `${repoSummary}。会話はそのまま続けられます` : "会話はそのまま続けられます",
      });
    }
    router.push(`/p/${projectId}`);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Project にする</DialogTitle>
        <DialogDescription>このチャットの会話・決まったこと（Memory）・フォルダの中身は、そのまま引き継ぎます。</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-5 py-1">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-name">名前</Label>
          <Input id="promote-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-slug">フォルダとリポジトリの名前</Label>
          <Input
            id="promote-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono"
            disabled={busy}
            aria-invalid={!slugOk}
          />
          <p className="text-xs text-ink-3" data-testid="promote-slug-note">
            {slugOk ? "英小文字・数字・. _ - で、英小文字か数字で始めます。" : "英小文字・数字・. _ - の100字までで、英小文字か数字で始めてください（chats は使えません）。"}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="promote-group">グループ</Label>
          <Select value={groupId} onValueChange={setGroupId} disabled={busy}>
            <SelectTrigger id="promote-group" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_GROUP}>グループに入れない</SelectItem>
              {groups.map((g) => (
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
            disabled={busy}
            testId="promote-folder-choice"
            choices={[
              { value: "move", label: "置き場へ移す" },
              { value: "keep", label: "今の場所のまま" },
            ]}
          />
          <p className="text-xs text-ink-3 break-all" data-testid="promote-folder-note">
            {folder === "keep" ? (
              <>
                <code>{root}</code> のまま使います。
              </>
            ) : movedRoot ? (
              <>
                <code>{root}</code> から <code>{movedRoot}</code> へ移します。
              </>
            ) : (
              <>今のフォルダ（{root}）は置き場の形でないので、移せません。</>
            )}
          </p>
        </div>

        {adoptersError ? (
          <p className="text-xs text-destructive" data-testid="promote-repo-error">
            リポジトリの画面を読み込めませんでした（{adoptersError}）。リポジトリは作らずに Project にします。
          </p>
        ) : adopter ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">リポジトリ</span>
            <AdopterSurface
              adopter={adopter}
              target={{ path: root, name: slug }}
              onState={setAdopterState}
              adoptFolderRef={adoptFolderRef}
            />
            {adopterState && !adopterState.ready && adopterState.reason ? (
              <p className="text-xs text-ink-3" data-testid="promote-repo-reason">
                {adopterState.reason}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert" data-testid="promote-error">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          やめる
        </Button>
        <Button onClick={() => void submit()} disabled={!canSubmit} data-testid="promote-submit">
          {busy ? "Project にしています…" : "Project にする"}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Module の画面——core の画面の中の「よそ様の画面」。点線の枠と出所（新しい Project の画面の枠と同じ形） */
function AdopterSurface({
  adopter,
  target,
  onState,
  adoptFolderRef,
}: {
  adopter: RealFolderProvider;
  target: FolderAdopterTarget;
  onState: (state: FolderAdopterState) => void;
  adoptFolderRef: MutableRefObject<((target: FolderAdopterTarget) => Promise<AdoptedFolder>) | null>;
}) {
  return (
    <div data-testid="module-surface" data-module={adopter.server} className="rounded-lg border border-dashed border-border bg-surface-2/60">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 pt-2 pb-1.5 text-xs text-ink-3">
        <ShieldCheck className="size-3.5 shrink-0" />
        <span data-testid="module-surface-by">「{adopter.server}」の画面</span>
        <code className="ml-auto font-mono break-all">{adopter.resourceUri}</code>
      </div>
      <div className="mx-1.5 mb-1.5 rounded-md border border-border bg-card p-2">
        <ModuleCanvas
          owner={{ kind: "instance" }}
          server={adopter.server}
          resourceUri={adopter.resourceUri}
          displayMode="inline"
          folderAdopter={target}
          onFolderAdopterState={onState}
          adoptFolderRef={adoptFolderRef}
        />
      </div>
    </div>
  );
}
