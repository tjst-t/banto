"use client";

// **Project を別の実行場所へ移す**（決定・2026-10-11、ユーザー。`docs/specs/v4-security.md` §1「Project を別の実行場所へ移す」
// の流れ 1・3・8、Backlog `runtime-move-ui`）。画面はモックの `MoveRuntimeDialog`（f7251863・0d22d225）の形で決定。
//
// 段：①移す先と移す先のフォルダを選ぶ → ②押す前に読む（host の見積もり：写す大きさ・会話の記録の件数・移らないもの・
// 作り直しが要るもの・閉じ込めの注意・動いているもの）→ ③写している（進み具合。閉じない）→ 終わり（root と元の場所）。
// 押せるかどうかは host が言う（`blockers`）——画面は判断しない。動いているものがあれば押せない（banto は止めて回らない）。
// 元は消さない
import { useEffect, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PathPicker, type FolderSource } from "@/components/banto/settings/path-picker";
import { sshTarget } from "@/components/banto/settings/runtimes-panel";
import {
  HOST_CONTAINER_RUNTIME,
  estimateRealRuntimeMove,
  fetchRealRuntimeMoveStatus,
  listRealRuntimeDirectories,
  listRealRuntimes,
  remoteRuntimeName,
  startRealRuntimeMove,
  type RealMoveEstimate,
  type RealMoveProgress,
  type RealRemoteRuntime,
} from "@/lib/backend/client";
import { getProject, refreshRealProjectLocation } from "@/lib/mock/projects";
import { formatMoveBytes } from "@/lib/backend/runtime-moves";
import { describeFailure } from "@/lib/report-failure";

type Step = "choose" | "review" | "copying" | "done" | "failed";

/** 進み具合を聞く間隔 */
const POLL_MS = 1000;

const PHASE_LABEL: Record<RealMoveProgress["phase"], string> = {
  preparing: "用意しています",
  stopping: "Service を止めて、Module を畳んでいます",
  copying: "写しています",
  verifying: "写したものを確かめています",
  finishing: "切り替えています",
  done: "終わりました",
  failed: "移せませんでした",
};

function runtimeLabel(runtime: string): string {
  const name = remoteRuntimeName(runtime);
  return name ?? "この機械のコンテナ";
}

export function MoveRuntimeDialog({
  projectId,
  open,
  onOpenChange,
  reason,
  onMoved,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** なぜ開いたか（閉じた Project の再開を、実行場所が使われていて断られた——その理由） */
  reason?: string;
  /** 移し終わったあとの次の一手（閉じた Project なら「再開する」）。渡せば終わりの画面に出す */
  onMoved?: () => Promise<void>;
}) {
  const project = getProject(projectId);
  const fromRuntime = project.runtime ?? HOST_CONTAINER_RUNTIME;
  const [step, setStep] = useState<Step>("choose");
  const [runtimes, setRuntimes] = useState<RealRemoteRuntime[] | null>(null);
  const [runtimesError, setRuntimesError] = useState<string | null>(null);
  const [toRuntime, setToRuntime] = useState("");
  const [toRoot, setToRoot] = useState("");
  const [estimate, setEstimate] = useState<RealMoveEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<RealMoveProgress | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  /** 移す前の場所（終わりの画面に出す。移したあとの Project はもう新しい場所を指す） */
  const [moved, setMoved] = useState<{ from: { runtime: string; root: string }; to: { runtime: string; root: string } } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // 開くたびに初めから（前に開いたときの選択や結果を持ち越さない）
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setStep("choose");
    setToRuntime("");
    setToRoot("");
    setEstimate(null);
    setError(null);
    setProgress(null);
    setPollError(null);
    setMoved(null);
    setFailure(null);
  }
  if (!open && wasOpen) setWasOpen(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listRealRuntimes().then(
      (list) => !cancelled && setRuntimes(list),
      (err: unknown) => !cancelled && setRuntimesError(describeFailure(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 写している間：進み具合を聞く。終わったら host から根と実行場所を読み直す
  useEffect(() => {
    if (step !== "copying") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = async (ok: boolean, reason?: string) => {
      try {
        await refreshRealProjectLocation(projectId);
      } catch (err) {
        if (!cancelled) setPollError(`Project を読み直せませんでした：${describeFailure(err)}`);
      }
      if (cancelled) return;
      if (ok) setStep("done");
      else {
        setFailure(reason ?? "移せませんでした");
        setStep("failed");
      }
    };
    const tick = async () => {
      try {
        const status = await fetchRealRuntimeMoveStatus(projectId);
        if (cancelled) return;
        setPollError(null);
        if (status.progress) setProgress(status.progress);
        if (status.progress?.phase === "done") return void finish(true);
        if (status.progress?.phase === "failed") return void finish(false, status.progress.reason);
        // 進み具合が無く、移している途中の記録も無い：host が起き直した（起き直したときに片づけて元のまま）
        if (!status.progress && !status.move) {
          return void finish(
            false,
            "banto が移している途中で止まりました。切り替えていません（元の場所のまま）。片づけた結果は受信箱に出ています",
          );
        }
      } catch (err) {
        // 聞けなかっただけで、host では移し続けている——理由を出して聞き続ける（黙って待たない）
        if (!cancelled) setPollError(`進み具合を聞けませんでした：${describeFailure(err)}`);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [step, projectId]);

  const remoteName = remoteRuntimeName(toRuntime);
  const remote = runtimes?.find((r) => r.runtime === toRuntime);
  const folderSource: FolderSource | undefined = remoteName
    ? { list: (path) => listRealRuntimeDirectories(remoteName, path), where: remoteName }
    : undefined;

  async function review() {
    setBusy(true);
    setError(null);
    try {
      setEstimate(await estimateRealRuntimeMove(projectId, { runtime: toRuntime, root: toRoot.trim() }));
      setStep("review");
    } catch (err) {
      setError(`見積もれませんでした：${describeFailure(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const started = await startRealRuntimeMove(projectId, { runtime: toRuntime, root: toRoot.trim() });
      const to = started.move?.to ?? { runtime: toRuntime, root: toRoot.trim() };
      setMoved({ from: { runtime: fromRuntime, root: project.basePath }, to });
      setProgress(null);
      setStep("copying");
    } catch (err) {
      setError(`移し始められませんでした：${describeFailure(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const blocked = (estimate?.blockers.length ?? 0) > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (step === "copying") return; // 写している間は閉じない
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="move-runtime-dialog" showCloseButton={step !== "copying"}>
        <DialogHeader>
          <DialogTitle>別の実行場所へ移す</DialogTitle>
          <DialogDescription>
            Project「{project.name}」のフォルダと Module の状態を写して、動かす場所を切り替えます。元は消しません。
          </DialogDescription>
        </DialogHeader>

        {step === "choose" && reason ? (
          <Block tone="stop" title="再開できませんでした" testId="move-reason">
            <p>{reason}</p>
          </Block>
        ) : null}

        {step === "choose" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="move-to">移す先</Label>
              <Select
                value={toRuntime}
                onValueChange={(v) => {
                  setToRuntime(v);
                  setToRoot("");
                  setError(null);
                }}
              >
                <SelectTrigger id="move-to" className="h-9 w-full" data-testid="move-to-select">
                  <SelectValue placeholder="選んでください" />
                </SelectTrigger>
                <SelectContent>
                  {fromRuntime !== HOST_CONTAINER_RUNTIME ? (
                    <SelectItem value={HOST_CONTAINER_RUNTIME} data-testid="move-to-option" data-runtime={HOST_CONTAINER_RUNTIME}>
                      <span className="flex items-center gap-2">
                        <ShieldCheck className="size-3.5 shrink-0 text-ink-3" />
                        この機械のコンテナ
                      </span>
                    </SelectItem>
                  ) : null}
                  {(runtimes ?? [])
                    .filter((r) => r.runtime !== fromRuntime)
                    .map((r) => (
                      <SelectItem
                        key={r.name}
                        value={r.runtime}
                        disabled={!!r.unavailableReason}
                        data-testid="move-to-option"
                        data-runtime={r.runtime}
                      >
                        <span className="flex min-w-0 flex-col items-start">
                          <span className="flex items-center gap-2">
                            <Server className="size-3.5 shrink-0 text-ink-3" />
                            {r.name}
                            <span className="font-mono text-xs text-ink-3">{sshTarget(r)}</span>
                          </span>
                          {r.unavailableReason ? (
                            <span className="pl-5.5 text-xs text-ink-3" data-testid="move-to-reason">
                              {r.unavailableReason}
                            </span>
                          ) : null}
                        </span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {runtimesError ? <p className="text-xs text-stop">別のサーバの一覧を読めませんでした：{runtimesError}</p> : null}
              {runtimes && runtimes.filter((r) => r.runtime !== fromRuntime).length === 0 && fromRuntime === HOST_CONTAINER_RUNTIME ? (
                <p className="text-xs text-ink-3">移す先の別のサーバがありません。設定の「実行場所」で登録してください。</p>
              ) : null}
            </div>
            {toRuntime ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="move-path">移す先のフォルダ（{runtimeLabel(toRuntime)} の上。まだ無いか空のフォルダ）</Label>
                <PathPicker
                  id="move-path"
                  value={toRoot}
                  onChange={setToRoot}
                  source={folderSource}
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

        {step === "review" && estimate ? (
          <div className="flex flex-col gap-3 text-sm" data-testid="move-review">
            <p className="flex flex-wrap items-center gap-1.5 text-foreground" data-testid="move-route">
              <span>{runtimeLabel(estimate.from.runtime)}</span>
              <span className="font-mono text-xs text-ink-3">{estimate.from.root}</span>
              <ArrowRight className="size-3.5 text-ink-3" />
              <span>{runtimeLabel(estimate.to.runtime)}</span>
              <span className="font-mono text-xs text-ink-3">{estimate.to.root}</span>
            </p>

            {blocked ? (
              <Block tone="stop" title="まだ移せません" testId="move-blockers">
                <ul className="flex flex-col gap-1">
                  {estimate.blockers.map((b) => (
                    <li key={b} data-testid="move-blocker">
                      {b}
                    </li>
                  ))}
                </ul>
                {estimate.running.length > 0 ? (
                  <>
                    <p className="mt-1.5 font-medium text-foreground">動いているもの</p>
                    <ul className="flex flex-col gap-1" data-testid="move-running">
                      {estimate.running.map((r) => (
                        <li key={`${r.kind}:${r.label}`} data-testid="move-running-item">
                          {r.label}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-ink-3">止めてから、もう一度開いてください。banto は止めて回りません。</p>
                  </>
                ) : null}
              </Block>
            ) : null}

            <Block tone="ok" title="写すもの" testId="move-copies">
              <ul className="flex flex-col gap-1">
                <li data-testid="move-size">
                  Project のフォルダと Module の状態：{formatMoveBytes(estimate.size.bytes)}（{estimate.size.files.toLocaleString()}{" "}
                  ファイル）——.git ごと、未コミットの変更も
                </li>
                <li data-testid="move-records">
                  {estimate.copiesClaudeRecords
                    ? `会話の記録 ${estimate.claudeRecords} 件——続きから話せます`
                    : "会話の記録は写さずに、そのまま続きから話せます"}
                </li>
              </ul>
            </Block>

            <Block tone="warn" title="移らないもの・作り直しが要るもの" testId="move-not-moved">
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {estimate.notMoved.map((n) => (
                  <li key={n}>{n}</li>
                ))}
                <li>Service は止めた状態で移ります。移った先で確かめてから起こしてください</li>
                {estimate.rebuild.length > 0 ? (
                  <li data-testid="move-rebuild">
                    作り直しが要るかもしれないもの（絶対パスを持つもの）：{estimate.rebuild.join("・")}
                  </li>
                ) : null}
              </ul>
            </Block>

            {estimate.confinementNote ? (
              <Block tone="warn" title={`${runtimeLabel(estimate.to.runtime)} では閉じ込めがありません`} testId="move-confinement">
                <p>
                  {estimate.confinementNote}
                  {remote ? `（${remote.user} ができることを全部できます）` : ""}
                </p>
              </Block>
            ) : null}

            <p className="text-xs text-ink-3">
              元のフォルダと Module の状態は残します（{runtimeLabel(estimate.from.runtime)} の {estimate.from.root}）。要らなくなったら
              消してください。移している間、この Project の会話は止まります。
            </p>
          </div>
        ) : null}

        {step === "copying" ? (
          <div className="flex flex-col gap-2" data-testid="move-copying">
            <p className="text-sm text-foreground" data-testid="move-phase">
              {progress ? PHASE_LABEL[progress.phase] : PHASE_LABEL.preparing}…
              {progress && progress.totalBytes > 0
                ? ` ${formatMoveBytes(Math.min(progress.copiedBytes, progress.totalBytes))} / ${formatMoveBytes(progress.totalBytes)}`
                : ""}
            </p>
            {progress?.current ? <p className="text-xs text-ink-3">いま：{progress.current}</p> : null}
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full bg-turn transition-[width]"
                style={{
                  width: `${progress && progress.totalBytes > 0 ? Math.min(100, (progress.copiedBytes / progress.totalBytes) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="text-xs text-ink-3">この Project の会話は、終わるまで止まっています。届いたものは終わってから届きます。</p>
            {pollError ? <p className="text-xs text-stop">{pollError}</p> : null}
          </div>
        ) : null}

        {step === "done" && moved ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="move-done">
            <p className="flex flex-wrap items-center gap-1.5 text-foreground">
              <CircleCheck className="size-4 shrink-0 text-ok" />
              {runtimeLabel(moved.to.runtime)} へ移しました。root は{" "}
              <span className="font-mono text-xs" data-testid="move-done-root">
                {moved.to.root}
              </span>{" "}
              です。
            </p>
            <p className="text-xs text-ink-3" data-testid="move-done-previous">
              各会話に「移した」ことを知らせました。元は {runtimeLabel(moved.from.runtime)} の{" "}
              <span className="font-mono">{moved.from.root}</span> に残っています。要らなくなったら消してください。
            </p>
            {pollError ? <p className="text-xs text-stop">{pollError}</p> : null}
          </div>
        ) : null}

        {step === "failed" ? (
          <div className="flex flex-col gap-2 text-sm" data-testid="move-failed">
            <p className="flex items-center gap-1.5 text-foreground">
              <CircleX className="size-4 shrink-0 text-stop" />
              移せませんでした
            </p>
            <p className="text-xs text-ink-2" data-testid="move-failed-reason">
              {failure}
            </p>
            {pollError ? <p className="text-xs text-stop">{pollError}</p> : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-stop" data-testid="move-error">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {step === "choose" ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                やめる
              </Button>
              <Button disabled={!toRuntime || !toRoot.trim() || busy} onClick={() => void review()} data-testid="move-next">
                {busy ? "見積もっています…" : "次へ"}
              </Button>
            </>
          ) : step === "review" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  setStep("choose");
                }}
              >
                戻る
              </Button>
              <Button disabled={blocked || busy} onClick={() => void start()} data-testid="move-start">
                {runtimeLabel(toRuntime)} へ移す
              </Button>
            </>
          ) : step === "done" && onMoved ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="move-close">
                閉じる
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onMoved().finally(() => setBusy(false));
                }}
                data-testid="move-reopen"
              >
                再開する
              </Button>
            </>
          ) : step === "done" || step === "failed" ? (
            <Button onClick={() => onOpenChange(false)} data-testid="move-close">
              閉じる
            </Button>
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
