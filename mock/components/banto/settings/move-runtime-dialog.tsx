"use client";

// Project を別の実行場所へ移す（決定・2026-10-11、ユーザー。`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」、
// Backlog の runtime-move-ui）。本物では Project の設定「一般」の実行場所の欄から開く（モックはセキュリティ境界の欄に置く）。
//
// 段は3つ：①移す先と移す先のフォルダを選ぶ → ②押す前に読む（写す大きさ・移らないもの・作り直しが要るもの・動いているもの・
// 閉じ込めの注意）→ ③写している（進み具合）→ 終わり（元の場所を出す）。動いているものがあれば②で押せない——banto は止めて
// 回らない。元は消さない
import { useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, CircleX, Server, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PathPicker } from "@/components/banto/project/path-picker";
import { getProject } from "@/lib/mock/projects";
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
import { notifyMockStoreChange } from "@/lib/mock/store-events";

type Step = "choose" | "review" | "copying" | "done";

/** モックの見積もり（本物は移す前に host が数える） */
const ESTIMATE = {
  folder: "1.8 GB（12,431 ファイル）",
  modules: "84 MB（Module の置き場 6 つ、ホームとソケットは除く）",
  records: "会話の記録 9 件（Base と Fork 8 本）",
};

/** 動いているもの（モック：?running=1 で出す） */
const RUNNING_DEMO = [
  { what: "Service「web」", where: "ポート 3000 で動いています" },
  { what: "裏で流しているコマンド「E2E を 20 回」", where: "Fork「間欠的に落ちる試験」" },
];

export function MoveRuntimeDialog({
  projectId,
  open,
  onOpenChange,
  showRunning,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  showRunning?: boolean;
}) {
  const runtimes = useRuntimes();
  const project = getProject(projectId);
  const fromId = runtimeIdOfProject(projectId);
  const from = fromId === HOST_CONTAINER ? undefined : getRuntime(fromId);
  const fromName = from ? from.name : "この機械のコンテナ";
  const [step, setStep] = useState<Step>("choose");
  const [toId, setToId] = useState<string>("");
  const [toPath, setToPath] = useState("");
  const [progress, setProgress] = useState(0);
  const to = toId === HOST_CONTAINER ? undefined : getRuntime(toId);
  const toName = toId === HOST_CONTAINER ? "この機械のコンテナ" : (to?.name ?? "");
  const running = showRunning ? RUNNING_DEMO : [];
  const intoRemoteFromHost = fromId === HOST_CONTAINER && toId !== HOST_CONTAINER;

  function startCopy() {
    setStep("copying");
    setProgress(0);
    const timer = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(timer);
          setProjectRuntime(projectId, toId);
          notifyMockStoreChange();
          setStep("done");
          return 100;
        }
        return p + 20;
      });
    }, 400);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (step === "copying") return; // 写している間は閉じない
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="move-runtime-dialog">
        <DialogHeader>
          <DialogTitle>別の実行場所へ移す</DialogTitle>
          <DialogDescription>
            Project「{project.name}」のフォルダと Module の状態を写して、動かす場所を切り替えます。元は消しません。
          </DialogDescription>
        </DialogHeader>

        {step === "choose" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="move-to">移す先</Label>
              <Select
                value={toId}
                onValueChange={(v) => {
                  setToId(v);
                  setToPath("");
                }}
              >
                <SelectTrigger id="move-to" className="h-9 w-full">
                  <SelectValue placeholder="選んでください" />
                </SelectTrigger>
                <SelectContent>
                  {fromId !== HOST_CONTAINER ? (
                    <SelectItem value={HOST_CONTAINER}>
                      <span className="flex items-center gap-2">
                        <ShieldCheck className="size-3.5 shrink-0 text-ink-3" />
                        この機械のコンテナ
                      </span>
                    </SelectItem>
                  ) : null}
                  {runtimes
                    .filter((r) => r.id !== fromId)
                    .map((r) => {
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
            </div>
            {toId ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="move-path">移す先のフォルダ（{toName} の上。まだ無いか空のフォルダ）</Label>
                <PathPicker
                  id="move-path"
                  value={toPath}
                  onChange={setToPath}
                  source={to ? { ...remoteFolderSource(to.id), where: to.name } : undefined}
                  pickerDescription="まだ無いか空のフォルダを選ぶか、新しいフォルダを作ってください。"
                  allowNewFolder
                />
                <p className="text-xs text-ink-3">
                  元の根（{project.basePath}）・banto の置き場・ほかの Project の根と重なるフォルダは選べません。
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {step === "review" ? (
          <div className="flex flex-col gap-3 text-sm" data-testid="move-review">
            <p className="flex flex-wrap items-center gap-1.5 text-foreground">
              <span>{fromName}</span>
              <span className="font-mono text-xs text-ink-3">{project.basePath}</span>
              <ArrowRight className="size-3.5 text-ink-3" />
              <span>{toName}</span>
              <span className="font-mono text-xs text-ink-3">{toPath}</span>
            </p>

            {running.length > 0 ? (
              <Block tone="stop" title="動いているものがあるので、まだ移せません" testId="move-running">
                <ul className="flex flex-col gap-1">
                  {running.map((r) => (
                    <li key={r.what}>
                      {r.what}——<span className="text-ink-3">{r.where}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-ink-3">止めてから、もう一度開いてください。banto は止めて回りません。</p>
              </Block>
            ) : null}

            <Block tone="ok" title="写すもの">
              <ul className="flex flex-col gap-1">
                <li>Project のフォルダ：{ESTIMATE.folder}——.git ごと、未コミットの変更も</li>
                <li>Module の状態：{ESTIMATE.modules}</li>
                <li>{ESTIMATE.records}——続きから話せます</li>
              </ul>
            </Block>

            <Block tone="warn" title="移らないもの・作り直しが要るもの">
              <ul className="flex list-disc flex-col gap-1 pl-4">
                <li>入れた道具（apt・ホームの中）と Docker のイメージ。移った先で入れ直してください</li>
                <li>Service は止めた状態で移ります。移った先で確かめてから起こしてください</li>
                <li>絶対パスを持つもの（Python の venv・node_modules の一部）は壊れることがあります</li>
              </ul>
            </Block>

            {intoRemoteFromHost ? (
              <Block tone="warn" title={`${toName} では閉じ込めがありません`}>
                <p>
                  サーバ丸ごとがこの Project の箱になり、AI は {to?.user} ができることを全部できます。向こうで動かしたサービスは LAN
                  から直に届きます。
                </p>
              </Block>
            ) : null}

            <p className="text-xs text-ink-3">
              元のフォルダと Module の状態は残します（{fromName} の {project.basePath}）。要らなくなったら消してください。移している間、
              この Project の会話は止まります。
            </p>
          </div>
        ) : null}

        {step === "copying" ? (
          <div className="flex flex-col gap-2" data-testid="move-copying">
            <p className="text-sm text-foreground">写しています… {Math.round((1.8 * progress) / 100 * 10) / 10} GB / 1.8 GB</p>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-ink-3">この Project の会話は、終わるまで止まっています。届いたものは終わってから届きます。</p>
          </div>
        ) : null}

        {step === "done" ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="move-done">
            <p className="flex items-center gap-1.5 text-foreground">
              <CircleCheck className="size-4 shrink-0 text-ok" />
              {toName} へ移しました。root は <span className="font-mono text-xs">{toPath}</span> です。
            </p>
            <p className="text-xs text-ink-3">
              各会話に「移した」ことを知らせました。元は {fromName} の <span className="font-mono">{project.basePath}</span>{" "}
              に残っています。
            </p>
          </div>
        ) : null}

        <DialogFooter>
          {step === "choose" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                やめる
              </Button>
              <Button disabled={!toId || !toPath.trim()} onClick={() => setStep("review")}>
                次へ
              </Button>
            </>
          ) : step === "review" ? (
            <>
              <Button variant="outline" onClick={() => setStep("choose")}>
                戻る
              </Button>
              <Button disabled={running.length > 0} onClick={startCopy} data-testid="move-start">
                {toName} へ移す
              </Button>
            </>
          ) : step === "done" ? (
            <Button onClick={() => onOpenChange(false)}>閉じる</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Block({
  tone,
  title,
  testId,
  children,
}: {
  tone: "ok" | "warn" | "stop";
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "ok" ? CircleCheck : tone === "warn" ? CircleAlert : CircleX;
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : "text-stop";
  const bg = tone === "stop" ? "bg-stop-soft" : "bg-surface-2";
  return (
    <div className={`rounded-md px-3 py-2.5 text-xs text-ink-2 ${bg}`} data-testid={testId}>
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
        <Icon className={`size-3.5 shrink-0 ${color}`} />
        {title}
      </p>
      {children}
    </div>
  );
}
