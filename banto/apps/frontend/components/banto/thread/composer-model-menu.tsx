"use client";

// 入力欄の下の、**モデルと reasoning effort の選択**（決定・2026-09-23、ユーザー要望）。
// permissionMode の選択（composer-permission-mode-menu.tsx）と並べる。
//
// - 選べる一覧は host が CLI に聞いたもの（`GET /api/models`）——こちらで持たない（規則3）
// - effort の段はモデルごと（Haiku のように選べないモデルもある）
// - **会話の途中で変えてよい**が、変えた次の1ターンはそれまでの会話を読み直すぶん
//   高くつく（キャッシュが効かない。実測・2026-09-23：effort だけ変えても読み取り 0）。
//   **会話が始まっていたら、変える前にそれを見せて確かめる**（アーキ仕様 §3）
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RealEffort } from "@/lib/backend/client";
import {
  getModelChoices,
  getThreadModel,
  refreshModelChoices,
  setThreadModel,
} from "@/lib/backend/thread-model";
import { useMockStoreVersion } from "@/lib/mock/store-events";
import { ChevronDownIcon, Cpu } from "lucide-react";

/** CLI の一覧で「選んでいない」を表す行。 */
const DEFAULT_MODEL = "default";
/** effort を選んでいない（そのモデルの既定）を表す、ラジオの値。 */
const DEFAULT_EFFORT = "__default";

export function ComposerModelMenu({ threadId }: { threadId: string }) {
  useMockStoreVersion();
  const { model, effort } = getThreadModel(threadId);
  const { models, error } = getModelChoices();
  const started = useAuiState((s) => s.thread.messages.length > 0);
  const [pending, setPending] = useState<{ model: string | null; effort: RealEffort | null } | null>(null);

  // 名前を出すのに一覧が要る——開く前から取りに行く
  useEffect(() => {
    if (!models && !error) void refreshModelChoices();
  }, [models, error]);

  const current = models?.find((m) => m.value === (model ?? DEFAULT_MODEL));
  const label = current?.displayName ?? model ?? "既定のモデル";
  const efforts = current?.efforts ?? [];

  function choose(nextModel: string | null, nextEffort: RealEffort | null) {
    // 次のモデルに無い段は外す（Haiku へ移ったら effort は選べない）
    const target = models?.find((m) => m.value === (nextModel ?? DEFAULT_MODEL));
    const effortOk = nextEffort && target?.efforts.includes(nextEffort) ? nextEffort : null;
    if ((nextModel ?? null) === (model ?? null) && effortOk === (effort ?? null)) return;
    if (started) {
      setPending({ model: nextModel, effort: effortOk });
      return;
    }
    setThreadModel(threadId, nextModel, effortOk);
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          // 開いたら取り直す（アカウントや CLI の版で一覧は変わる。host が少し覚えている）
          if (open) void refreshModelChoices();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`この会話のモデル（現在：${label}${effort ? ` · ${effort}` : ""}）`}
            data-testid="composer-model"
            // 狭いときは permissionMode より先に縮む（shrink-[3]）——危ない設定の印のほうを読めるまま残す
            className="text-ink-3 hover:text-foreground hover:bg-muted-foreground/15 flex h-7 min-w-0 max-w-56 shrink-[3] items-center gap-1 rounded-full px-2 text-xs"
          >
            <Cpu className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
            {effort ? (
              <>
                <span className="shrink-0 text-ink-3/70">·</span>
                <span className="shrink-0">{effort}</span>
              </>
            ) : null}
            <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel>この会話のモデル</DropdownMenuLabel>
          {error ? (
            <p className="px-2 py-1.5 text-xs text-stop" data-testid="composer-model-error">
              モデルの一覧を取れませんでした：{error}
            </p>
          ) : !models ? (
            <p className="px-2 py-1.5 text-xs text-ink-3">一覧を読み込んでいます…</p>
          ) : (
            <DropdownMenuRadioGroup
              value={model ?? DEFAULT_MODEL}
              onValueChange={(v) => choose(v === DEFAULT_MODEL ? null : v, effort ?? null)}
            >
              {models.map((m) => (
                <DropdownMenuRadioItem key={m.value} value={m.value} className="items-start">
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm">{m.displayName}</span>
                    <span className="text-xs text-ink-3">{m.description}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
          {efforts.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>reasoning effort</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={effort ?? DEFAULT_EFFORT}
                onValueChange={(v) => choose(model ?? null, v === DEFAULT_EFFORT ? null : (v as RealEffort))}
              >
                <DropdownMenuRadioItem value={DEFAULT_EFFORT}>既定</DropdownMenuRadioItem>
                {efforts.map((e) => (
                  <DropdownMenuRadioItem key={e} value={e}>
                    {e}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          ) : null}
          <p className="px-2 py-1.5 text-xs text-ink-3">
            この会話にだけ、次のターンから効く。途中で変えると、その1ターンは高くつく。
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogContent data-testid="composer-model-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>会話の途中でモデル・effort を変えますか</AlertDialogTitle>
            <AlertDialogDescription>
              次の1ターンは、これまでの会話をすべて読み直すので、いつもより高くつきます（プロンプトキャッシュが効かない）。その次のターンからは元に戻ります。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) setThreadModel(threadId, pending.model, pending.effort);
                setPending(null);
              }}
            >
              変える
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
