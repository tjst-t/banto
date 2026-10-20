"use client";

// **画面から banto を更新する**（決定・2026-10-04、アーキ仕様 §2.5「画面から banto を更新する」）。host の
// `/api/admin/update`（形は `packages/core/src/self-update/self-update.ts`）と、すぐ更新の前に今動いているものを
// 見る `/api/admin/activity`（`packages/core/src/http/activity.ts`）を呼ぶ。
//
// 起こし直しの間は host が居ない——**繋がらないことを、ほかの失敗と分けて投げる**（`HostUnreachableError`）。
// 画面はそれを「繋がり直すのを待つ」に使い、失敗にはしない

import { hostFetch } from "./client";
import { StepUpRequiredError } from "./auth";

export type UpdatePhase = "fetch" | "build" | "wait" | "restart" | "verify" | "done" | "failed" | "rolled-back" | "cancelled";

export interface UpdateCommit {
  commit: string;
  subject: string;
  /** ISO 8601 */
  date: string;
  author: string;
}

export interface ActivityThreadRef {
  projectId?: string;
  projectName?: string;
  threadId: string;
  threadTitle?: string;
}

/**
 * 起こし直しで待つもの・待たないものの1件（`packages/core/src/http/activity.ts` の `ActivityItem`）。`turn` は起き直したあと
 * 続くもの（待つものに出るのは、`restartable` を返さない古い host に `update.mjs` が全部を待ったときだけ）
 */
export type ActivityItem =
  /** `reason`：待つほうに回した理由（続けて切れた回数が上限に達するターン） */
  | (ActivityThreadRef & { kind: "turn"; startedAt: string; waitingOnHuman: boolean; reason?: string })
  | (ActivityThreadRef & { kind: "reply"; module: string; since: string })
  | { kind: "moduleReply"; projectId?: string; projectName?: string; module: string; caller: string; since: string }
  | (Partial<ActivityThreadRef> & { kind: "call"; connName: string; origin: string; waitingOnHuman?: boolean });

/**
 * 今動いているもの（`GET /api/admin/activity`）。画面が使うのは、起こし直しで待つもの（`blocking`：切れると結果が
 * 分からなくなる）と、起き直したあと続くもの（`continuesAfterRestart`）だけ
 */
export interface UpdateActivity {
  idle?: boolean;
  /** 待つもの・待たないものを分けて返さない古い host（2026-10-05 より前）には無い——そのときは下の前の形だけ */
  restartable?: boolean;
  blocking?: ActivityItem[];
  continuesAfterRestart?: ActivityItem[];
  turns?: Array<ActivityThreadRef & { startedAt: string; waitingOnHuman: boolean }>;
  awaitingReplies?: Array<ActivityThreadRef & { module: string; since: string }>;
  moduleCalls?: Array<Partial<ActivityThreadRef> & { connName: string; origin: string }>;
}

/** 待つ段の残り（`update.mjs` が `state.waiting` に書く）：待つものと、起き直したあと続くものの数 */
export interface UpdateWaiting {
  blocking: ActivityItem[];
  continuing: number;
}

/** `update.mjs` が書く進み具合 */
export interface UpdateRunState {
  id: string;
  /** 更新か、前の版に戻すか。2026-10-19 より前の `update.mjs` は書かない（更新） */
  kind?: "update" | "rollback";
  phase: UpdatePhase;
  mode?: "wait" | "now";
  from: string | null;
  to: string | null;
  startedAt: string;
  updatedAt: string;
  waiting?: UpdateWaiting;
  /** いま止まっている理由（例「host が答えません…答えるまで待ちます」） */
  note?: string;
  result?: string;
  error?: string;
  /** 失敗した段。**始める前に断ったとき（頼みが読めない・設定が無い等）は無い** */
  failedPhase?: UpdatePhase;
  logFile?: string;
  /** 誰が頼んだか（名前だけ） */
  requestedBy?: { label?: string };
  /** 組み立て済みを使ったか（`scripts/prebuilt.mjs` が書く。アーキ仕様 §2.5「組み立て済みのものを使う」） */
  prebuilt?: {
    status: "checking" | "waiting" | "downloading" | "used" | "skipped";
    run?: string;
    reason?: string;
    bytes?: { done: number; total: number };
  };
}

/** 最新の commit の組み立て済みの様子（host が `check` のときに GitHub に聞いてメモリに持つ） */
export interface PrebuiltAvailability {
  status: "available" | "building" | "tests-failed" | "cancelled" | "none" | "unknown";
  /** Actions の実行の URL（host が `https://github.com/<o>/<r>/actions/runs/<数字>` の形だけ通す） */
  run?: string;
  detail?: string;
  checkedAt: string | null;
}

/** 戻す先の一覧の1件（この機械で動いた版） */
export interface RollbackTarget {
  commit: string;
  /** `repo.git` に object が無ければ null */
  subject: string | null;
  committedAt: string | null;
  /** 最後に起きた時刻。分からなければ null */
  lastStartedAt: string | null;
  /** この機械にフォルダがある（すぐ戻せる） */
  local: boolean;
  /** 今の版の祖先か */
  ancestor: boolean;
}

/** 戻す前の確かめの小窓の中身。行き先の中身が手元に無ければ null（戻すときに取ってくる） */
export interface RollbackPreview {
  commit: string;
  ancestor: boolean;
  /** 戻すと抜けるコミット（新しい順） */
  leaving: UpdateCommit[] | null;
  /** 戻すと入るコミット（祖先でないときだけ中身がある） */
  entering: UpdateCommit[] | null;
}

export interface UpdateStatus {
  ready: boolean;
  reasons: string[];
  runbook: string;
  releaseDir: string;
  current: UpdateCommit | null;
  latest:
    | (UpdateCommit & {
        checkedAt: string | null;
        fastForward: boolean;
        /** 新しいものが先 */
        commits: UpdateCommit[];
        /** 前の版の host は返さない */
        prebuilt?: PrebuiltAvailability;
      })
    | null;
  /** 戻す先の一覧（今の版を除いた新しい 10 件）。この口を持たない古い host には無い */
  rollbackTargets?: RollbackTarget[];
  state: UpdateRunState | null;
  running: boolean;
  /** 途中の段のまま unit が止まっている回（`update.mjs` が落ちた・止められた） */
  interrupted: { phase: UpdatePhase; reason: string } | null;
  /** 猶予を過ぎても unit が受け取っていない頼み */
  staleRequest: {
    id: string | null;
    mode: string | null;
    commit: string | null;
    requestedAt: string | null;
    requestedBy: { label: string } | null;
    reason: string;
  } | null;
}

/** host に繋がらない（起こし直しの間など）。host が理由を返した失敗とは分ける */
export class HostUnreachableError extends Error {}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await hostFetch(path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new HostUnreachableError(`banto に繋がりません（${err instanceof Error ? err.message : String(err)}）`);
  }
  // 前に置いた中継（Caddy）は、host が居ないと 502・503・504 を返す
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    const text = await res.text().catch(() => "");
    const reason = (() => {
      try {
        return (JSON.parse(text) as { error?: unknown }).error;
      } catch {
        return undefined;
      }
    })();
    // host 自身の 502（release を取ってこられない・unit を起こせない）は理由つきの JSON。それは繋がっている
    if (typeof reason !== "string") throw new HostUnreachableError(`banto に繋がりません（${res.status}）`);
    throw new Error(reason);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    if (data.code === "step-up-required") throw new StepUpRequiredError(data.error ?? "本人の確認が要ります");
    throw new Error(data.error ?? `banto が ${res.status} を返しました`);
  }
  return data as T;
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return call<UpdateStatus>("/api/admin/update");
}

/** GitHub の release を取ってきて、差を出し直す */
export function checkForUpdate(): Promise<UpdateStatus> {
  return call<UpdateStatus>("/api/admin/update/check", { method: "POST" });
}

/** 更新を頼む。`commit` は画面に見せた最新（人が読んだ一覧と違うものは host が断る）。step-up が要る */
export function requestUpdate(commit: string, mode: "wait" | "now"): Promise<{ ok: true; id: string }> {
  return call<{ ok: true; id: string }>("/api/admin/update", { method: "POST", body: { commit, mode } });
}

/** 前の版に戻すのを頼む。`commit` は戻す先の一覧にある版（無ければ host が断る）。step-up が要る */
export function requestRollback(commit: string, mode: "wait" | "now"): Promise<{ ok: true; id: string }> {
  return call<{ ok: true; id: string }>("/api/admin/update/rollback", { method: "POST", body: { commit, mode } });
}

/** 戻す前の確かめの小窓に出す、抜ける・入るコミット */
export function fetchRollbackPreview(commit: string): Promise<RollbackPreview> {
  return call<RollbackPreview>(`/api/admin/update/rollback?commit=${encodeURIComponent(commit)}`);
}

/** 更新をやめる（`cancel` の印）。`update.mjs` は取ってくる・組み立てる・待つの間に受ける */
export function cancelUpdate(): Promise<void> {
  return call<void>("/api/admin/update/cancel", { method: "POST" });
}

/** 待たずにすぐ起こし直す。step-up が要る */
export function forceUpdateNow(): Promise<void> {
  return call<void>("/api/admin/update/force-now", { method: "POST" });
}

/** 最後の更新のログの末尾 */
export function fetchUpdateLog(): Promise<{ id: string; text: string; truncated: boolean }> {
  return call<{ id: string; text: string; truncated: boolean }>("/api/admin/update/log");
}

export function fetchActivity(): Promise<UpdateActivity> {
  return call<UpdateActivity>("/api/admin/activity");
}
