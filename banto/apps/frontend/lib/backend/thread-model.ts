// **Thread 単位のモデルと reasoning effort**（決定・2026-09-23、ユーザー要望）。
//
// 選んだ値は host が持つ（permissionMode と同じ、`lib/mock/permission-mode.ts`）。ここは
// その写しで、起動時の hydrate と Fork を作ったときに seed する。**選んでいない Thread は
// 持たない**——CLI の既定で走る（規則3：導出できる値を保存しない）。
//
// 選べる一覧も持たない——host が CLI に聞いたものを、開いたときに取りに行く。

import { reportFailure } from "@/lib/report-failure";
import { notifyMockStoreChange } from "@/lib/mock/store-events";
import { listRealModels, setRealThreadModel, type RealEffort, type RealModelChoice } from "./client";

export interface ThreadModelChoice {
  model?: string;
  effort?: RealEffort;
}

const byThread = new Map<string, ThreadModelChoice>();

export function getThreadModel(threadId: string): ThreadModelChoice {
  return byThread.get(threadId) ?? {};
}

/** host の値を写す。**無ければ消す**（古い写しを残さない）。 */
export function seedThreadModel(threadId: string, model: string | undefined, effort: RealEffort | undefined): void {
  if (model || effort) byThread.set(threadId, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  else byThread.delete(threadId);
}

/**
 * 選ぶ。画面はすぐ変わり、host に残せなかったら**元に戻して、そう言う**（規則2）
 * ——残らなかったのに残ったように見せると、次のターンが違うモデルで走る。
 */
export function setThreadModel(threadId: string, model: string | null, effort: RealEffort | null): void {
  const before = byThread.get(threadId);
  seedThreadModel(threadId, model ?? undefined, effort ?? undefined);
  notifyMockStoreChange();
  void setRealThreadModel(threadId, model, effort).catch((err: unknown) => {
    if (before) byThread.set(threadId, before);
    else byThread.delete(threadId);
    notifyMockStoreChange();
    reportFailure("モデルの選択を保存できませんでした（元に戻しました）", err);
  });
}

// ---- 選べる一覧（host が CLI に聞いたもの）-------------------------------------

let models: RealModelChoice[] | undefined;
let loading: Promise<void> | undefined;
let loadError: string | undefined;

export function getModelChoices(): { models?: RealModelChoice[]; error?: string } {
  return { models, error: loadError };
}

/** 一覧を取りに行く（開いたとき）。同時に何度呼ばれても1回。 */
export function refreshModelChoices(): Promise<void> {
  loading ??= listRealModels()
    .then((next) => {
      models = next;
      loadError = undefined;
    })
    .catch((err: unknown) => {
      // **取れなかったことを、画面に出す**——空の一覧を「選べるものが無い」と読ませない
      loadError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      loading = undefined;
      notifyMockStoreChange();
    });
  return loading;
}
