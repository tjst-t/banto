// docs/specs/v4-architecture.md §4.3「自動化」の台帳（決定・2026-10-15）。
//
// **project-thread の fold には入れない**——`automation.fired` は一番よく増える出来事なので、全 Thread の読み直しを
// 重くしない。`runtime-config` と同じく独立した fold と snapshot を持つ。Configuration（`config/runtime.ts`）は平らな
// 鍵と値で、履歴を持つ構造は載らない。

import type { EventFieldValue, EventWhere } from "@banto/module-contract";
import type { StoredEvent } from "../event-store/log.js";
import type { Fold } from "../event-store/snapshot.js";

/** 直近の回は1件の自動化につき、これだけ fold に持つ。古いものは events.jsonl にだけ残る */
export const AUTOMATION_RUNS_KEPT = 50;

/**
 * **専用の Fork はこの回数届けたら乗り換える**（アーキ仕様 §4.3「乗り換え」。仮置きの値・2026-10-15——困ったら変える）。
 * 毎回まっさらでも Clear のたびに会話の記録・印・手放したセッションが1本の Fork に積もる。1時間ごとなら2日で1本
 */
export const AUTOMATION_FORK_RUNS = 48;

/** 時刻の繰り返し。`time` は "H:MM"（24時間）、`day` は 0＝日曜 */
export type AutomationRepeat =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "interval"; hours: number }
  | { kind: "cron"; expr: string };

/** Webhook の署名の確かめ方。`header` の値を、Vault の `alias` の値を鍵にした HMAC-SHA256 で確かめる */
export interface AutomationSignature {
  header: string;
  alias: string;
}

/**
 * きっかけの出どころ。`webhook`（アーキ仕様 §4.3「Webhook」）の受け口の印は欄に入れない——台帳には印のハッシュだけを
 * `Automation.webhookTokenHash` に持つ（人・AI が直す欄ではない）
 */
export type AutomationSource =
  | { kind: "time"; repeat: AutomationRepeat; timeZone: string }
  | {
      kind: "webhook";
      /** 無ければ確かめない（URL を知っていれば誰でも動かせる） */
      signature?: AutomationSignature;
      /** 続けて届いたものをまとめる待ち時間（秒）。0 は1件ずつ */
      batchSeconds: number;
      /** この Project のコンテナから来た要求を受ける（既定は断る——コンテナはどの Project のものでも core に届く） */
      allowProjectContainer: boolean;
    }
  | {
      /**
       * **Module が名乗る出来事**（アーキ仕様 §4.3「段2」）。`event` は `<出どころ>.<名前>`、`where` は属性の「等しい／どれか」
       * （作るときに宣言の `fields` と照らす）
       */
      kind: "event";
      event: string;
      where?: EventWhere;
      /** 続けて届いたものをまとめる待ち時間（秒）。0 は1件ずつ */
      batchSeconds: number;
      /**
       * **この自動化自身の回のターンが起こした出来事でも動く**（既定 false——自分の回が起こした出来事では起こさない）。
       * 回数の歯止め（60分に6回）はこれに依らず効く
       */
      allowSelfTriggered: boolean;
    };

/**
 * 届け先。`dedicated`＝自動化専用の Fork（`threadId` は Fork を立てたあとに入る——立てるのは Backlog
 * `automation-deliver`）。`thread`＝既存の Thread に Clear せずに
 */
export type AutomationTarget =
  | { kind: "dedicated"; mode: "fresh" | "continue"; threadId?: string }
  | { kind: "thread"; threadId: string };

export type AutomationCreatedBy = { kind: "human" } | { kind: "ai"; threadId: string };

/** 1回分の結果。`running` はターンを始めたところ（同じ `runId` の後の記録で置き換わる） */
export type AutomationRunResult = "running" | "done" | "failed" | "waiting" | "skipped" | "rejected";

/** 何で動いたか。`manual`＝今すぐ動かす */
export type AutomationRunCause = "clock" | "manual" | "webhook" | "event";

export interface AutomationRun {
  runId: string;
  at: string;
  cause: AutomationRunCause;
  result: AutomationRunResult;
  /** 飛ばした・断った・失敗した理由（人が読める文） */
  reason?: string;
  /** 届けた Thread */
  threadId?: string;
  /** この回で専用の Fork を乗り換えたなら、閉じた前の Fork（境目の記録） */
  rotatedFrom?: string;
  /** 時計で動いた回の、予定の時刻（`at` は実際に動いた時刻。ずらした・止まっていた間を取り戻した回は違う） */
  scheduledFor?: string;
  /** 同時に動いている自動化が多くてずらした理由（ずらした回だけ） */
  delayed?: string;
  /** Webhook・出来事で受けたもののうち、この回にまとめて届けた件数 */
  received?: number;
}

/** Webhook・出来事で受けて、まだ届けていないもの（`automation.received`） */
export type AutomationReceived = AutomationReceivedWebhook | AutomationReceivedEvent;

/** Webhook で受けたもの（`kind` は前からある記録には無い） */
export interface AutomationReceivedWebhook {
  kind?: "webhook";
  receivedId: string;
  at: string;
  /** AI に渡す本文（先頭 `WEBHOOK_BODY_MAX_BYTES` まで） */
  body: string;
  /** 本文を切ったなら、もとのバイト数 */
  truncatedFrom?: number;
}

/**
 * **Module が知らせた出来事**（アーキ仕様 §4.3「段2」）。属性・`text` は申告。ホップと起こした Thread・自動化の回は、
 * `causedBy` の呼び出しの印から host が引いたもの（引けなければホップ 0）
 */
export interface AutomationReceivedEvent {
  kind: "event";
  receivedId: string;
  at: string;
  /** `<出どころ>.<名前>` */
  name: string;
  /** 名乗りの題（受けた時点のもの） */
  title: string;
  eventId: string;
  occurredAt: string;
  fields: Record<string, EventFieldValue>;
  /** 本文（先頭 `EVENT_TEXT_MAX_BYTES` まで） */
  text?: string;
  /** 本文を切ったなら、もとのバイト数 */
  truncatedFrom?: number;
  /** この出来事で起こすターンのホップ（起こしたターンのホップ＋1。引けなければ 0） */
  hop: number;
  /** 起こした Thread とターン（引けたときだけ） */
  causedBy?: { threadId: string; turnId?: string };
}

/** 人と AI が作り・直せる欄 */
export interface AutomationFields {
  name: string;
  instruction: string;
  source: AutomationSource;
  target: AutomationTarget;
  /** 完了した回を受信箱に出すか（既定 true）。判断待ち・決めること・失敗した回は、これに依らずいつも出す。見回りはいつも false */
  reviewOnDone: boolean;
  /**
   * **見回り**（追加・2026-10-20、アーキ仕様 §4.4「見回り」）。無ければふつうの自動化。作ったあと変えない。見回りの届け先は
   * 専用の Fork・毎回まっさらに固定し、その Fork は読むだけの回になる
   */
  mode?: "patrol" | "supervisor";
  /**
   * **番頭**（追加・2026-10-21、アーキ仕様 §4.5「番頭の作り」）。`mode: "supervisor"` の自動化だけが持つ。同じ値の自動化（きっかけごとに
   * 1件）が番頭1件で、届け先の専用の Fork は同じもの。一時停止・再開・消すは番頭の単位で一緒（`supervisor/supervisors.ts`）。
   * 人・AI の入力（`parseAutomationFields`）からは作れない
   */
  supervisorId?: string;
  /** 見回りが1日に出せる気づきの上限（見回りだけ。既定 `PATROL_DAILY_LIMIT_DEFAULT`、1日は自動化のタイムゾーンで数える） */
  dailyFindingLimit?: number;
}

/** 見回りの手帳の1行の状態。`notified`＝知らせた・`muted`＝今後知らせない・`dismissed`＝片づけた */
export type PatrolNoteStatus = "notified" | "muted" | "dismissed";

/** **見回りの手帳**の1行（アーキ仕様 §4.4「手帳」）。`key` ごとに1行 */
export interface PatrolNote {
  key: string;
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 最後に受信箱へ出した時刻（出し直さない7日はここから数える） */
  notifiedAt?: string;
  status: PatrolNoteStatus;
}

/**
 * 手帳への書き込み。`notified`＝受信箱に出した・`seen`＝同じ key をまた見た（出し直さない）・`muted`／`dismissed`＝人が押した・
 * `unmuted`＝人が「知らせない」を外した
 */
export type PatrolNoteChange = "notified" | "seen" | "muted" | "dismissed" | "unmuted";

/**
 * **番頭がしたこと**の1行（アーキ仕様 §4.5「記録」）。`answered`＝選択肢を選んで届けた・`deferred`＝人に回した・`refused`＝host が
 * 断った（種類・外の文）。指示した（#508）・Factory に流した・答えた（#509）
 */
export interface SupervisorAct {
  at: string;
  /**
   * `answered`＝選んだ・`deferred`＝人に回した・`refused`＝host が断った（`answer_decision` も `instruct_thread` も）・
   * `instructed`＝止まった会話に手順を頼んだ・`dropped`＝頼んだ手順を、始まる前に捨てた（人が発言した等）・
   * `factory-started`＝Factory に流した（`runId`・`items`）・`factory-answered`＝番頭が流した件の止まったものに答えた
   * （`runId`・`item`・`stage`・`action` は answerFactory の action）
   */
  kind: "answered" | "deferred" | "refused" | "instructed" | "dropped" | "factory-started" | "factory-answered";
  /** 相手の会話（Factory の記録は、呼んだ番頭の会話） */
  threadId: string;
  turnId?: string;
  /** 問いの番号（1から） */
  question?: number;
  /** 選んだ選択肢の番号と題（`answered` だけ） */
  choice?: number;
  label?: string;
  /** 問いの種類（まとめに書かれていれば） */
  decisionKind?: string;
  /** 番頭の理由（断ったときは host の理由。捨てたときは捨てた理由） */
  reason: string;
  /** 頼んだ行い（`instruct_thread` の `action`） */
  action?: string;
  /** 番頭が `note` を添えたか（中身は記録に残さない——宛先の会話の届けものにある） */
  hasNote?: boolean;
  /** 指示の id（`instructed`・`dropped`。届けものの `origin.supervisor.actionId`） */
  actionId?: string;
  /**
   * 頼んだときの宛先の止まった理由（`list_stalled_threads` の理由。無ければ action）。同じ理由への指示の回数を数える鍵
   */
  stalledReason?: string;
  /**
   * 頼んだときの宛先の最後のまとめの位置（まとめの発言の seq。無ければ 0）。新しいまとめが出たら同じ理由の回数を数え直す
   */
  summarySeq?: number;
  /** Factory の実行の id（`factory-started`・`factory-answered`・Factory の tool を断ったとき） */
  runId?: string;
  /** 流した項目（`factory-started`。Factory が受けたもの） */
  items?: string[];
  /** 答えた項目と、止まっていた段（`factory-answered`） */
  item?: string;
  stage?: string;
}

/** 番頭の記録は1件の自動化につき、これだけ fold に持つ（届ける文に添えるのは番頭の全部の自動化を合わせた直近 30 件） */
export const SUPERVISOR_ACTS_KEPT = 100;
/**
 * **Factory に流した記録は、上の件数を越えても、新しいものからこれだけ持つ**（Backlog #509）。全体の上限（同時に走っている件）は
 * この記録から番頭が流した実行を引く——長く走る実行の記録が、ほかの記録に押し出されて数えから漏れないように
 */
export const SUPERVISOR_FACTORY_STARTS_KEPT = 50;

/** 手帳は1つの見回りでこれだけ持つ。超えたら最後に見た時刻の古いものから捨てる（「知らせない」は捨てない） */
export const PATROL_NOTEBOOK_MAX = 500;

export interface Automation extends AutomationFields {
  id: string;
  projectId: string;
  createdBy: AutomationCreatedBy;
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  /** 一時停止した理由（人が押した・専用の Fork を閉じた等）。一時停止している間だけ持つ */
  pausedReason?: string;
  /** 新しい順、最大 `AUTOMATION_RUNS_KEPT` 件 */
  runs: AutomationRun[];
  /** 受けて、まだ届けていないもの（古い順） */
  received: AutomationReceived[];
  /**
   * いまの専用の Fork に届けた回数（乗り換えの数え、`AUTOMATION_FORK_RUNS`）。`runs` は 50 件で切れるので、そこから
   * 数え直さずに fold が数える。専用の Fork が変わると 0 から
   */
  threadRuns?: number;
  /**
   * **時計はこの時刻より後の回から数える**（止まっていた間の取り戻しの起点）。作った・きっかけを変えた・再開した時刻と、
   * 時計で動いた（飛ばした）回の予定の時刻のうち一番後
   */
  clockFrom: string;
  /** Webhook の受け口の印の SHA-256（hex）。印そのものは作ったときに1回だけ人に見せ、どこにも残さない */
  webhookTokenHash?: string;
  /** 見回りの手帳（見回りだけ。最後に見た時刻の新しい順） */
  notebook?: PatrolNote[];
  /** 番頭の記録（番頭の自動化だけ。新しい順、最大 `SUPERVISOR_ACTS_KEPT` 件） */
  supervisorActs?: SupervisorAct[];
}

export interface AutomationReadModel {
  automations: Map<string, Automation>;
}

export type AutomationEvent =
  | {
      type: "automation.created";
      payload: AutomationFields & { id: string; projectId: string; createdBy: AutomationCreatedBy; webhookTokenHash?: string };
    }
  | { type: "automation.updated"; payload: { id: string; changes: Partial<AutomationFields> } }
  | { type: "automation.paused"; payload: { id: string; reason?: string } }
  | { type: "automation.resumed"; payload: { id: string } }
  | { type: "automation.removed"; payload: { id: string } }
  | { type: "automation.received"; payload: { id: string } & AutomationReceived }
  | { type: "automation.patrol_noted"; payload: { id: string; key: string; change: PatrolNoteChange; title?: string } }
  | { type: "automation.supervisor_acted"; payload: { id: string } & SupervisorAct }
  | {
      type: "automation.fired";
      payload: { id: string } & AutomationRun & {
        /** この回で届けた `automation.received`（溜めていたものから外す） */
        receivedIds?: string[];
      };
    };

export const automationFold: Fold<AutomationReadModel> = {
  initial: () => ({ automations: new Map() }),
  apply(state, raw: StoredEvent): AutomationReadModel {
    const event = raw as unknown as AutomationEvent;
    if (!event.type.startsWith("automation.")) return state;
    const automations = new Map(state.automations);
    const current = "id" in event.payload ? automations.get(event.payload.id) : undefined;

    switch (event.type) {
      case "automation.created": {
        const { id, projectId, createdBy, webhookTokenHash, ...fields } = event.payload;
        automations.set(id, {
          ...fields,
          id,
          projectId,
          createdBy,
          ...(webhookTokenHash ? { webhookTokenHash } : {}),
          createdAt: raw.ts,
          updatedAt: raw.ts,
          paused: false,
          clockFrom: raw.ts,
          runs: [],
          received: [],
        });
        break;
      }
      case "automation.updated": {
        if (!current) return state;
        const next = { ...current, ...event.payload.changes, updatedAt: raw.ts };
        if (event.payload.changes.source) next.clockFrom = raw.ts;
        if (next.target.threadId !== current.target.threadId) next.threadRuns = 0;
        automations.set(current.id, next);
        break;
      }
      case "automation.paused": {
        if (!current) return state;
        const { pausedReason: _drop, ...rest } = current;
        automations.set(current.id, {
          ...rest,
          paused: true,
          ...(event.payload.reason ? { pausedReason: event.payload.reason } : {}),
        });
        break;
      }
      case "automation.resumed": {
        if (!current) return state;
        const { pausedReason: _drop, ...rest } = current;
        automations.set(current.id, { ...rest, paused: false, clockFrom: raw.ts });
        break;
      }
      case "automation.removed":
        if (!current) return state;
        automations.delete(current.id);
        break;
      case "automation.received": {
        if (!current) return state;
        const { id: _id, ...received } = event.payload;
        automations.set(current.id, { ...current, received: [...current.received, received] });
        break;
      }
      case "automation.patrol_noted": {
        if (!current) return state;
        automations.set(current.id, { ...current, notebook: notePatrol(current.notebook ?? [], event.payload, raw.ts) });
        break;
      }
      case "automation.supervisor_acted": {
        if (!current) return state;
        const { id: _id, ...act } = event.payload;
        const acts = [act, ...(current.supervisorActs ?? [])];
        const kept = acts.slice(0, SUPERVISOR_ACTS_KEPT);
        const olderStarts = acts.slice(SUPERVISOR_ACTS_KEPT).filter((a) => a.kind === "factory-started");
        const startsInKept = kept.filter((a) => a.kind === "factory-started").length;
        const extra = olderStarts.slice(0, Math.max(0, SUPERVISOR_FACTORY_STARTS_KEPT - startsInKept));
        automations.set(current.id, { ...current, supervisorActs: [...kept, ...extra] });
        break;
      }
      case "automation.fired": {
        if (!current) return state;
        const { id: _id, receivedIds, ...run } = event.payload;
        // 同じ回の後の記録（running → done 等）は置き換える。位置は最初に記録したところのまま
        const at = current.runs.findIndex((r) => r.runId === run.runId);
        const runs =
          at >= 0
            ? current.runs.map((r, i) => (i === at ? run : r))
            : [run, ...current.runs].slice(0, AUTOMATION_RUNS_KEPT);
        const consumed = new Set(receivedIds ?? []);
        const received = consumed.size > 0 ? current.received.filter((r) => !consumed.has(r.receivedId)) : current.received;
        // いまの専用の Fork に届けた回を数える（同じ回の後の記録・飛ばした回・断った回は数えない）
        const deliveredHere =
          at < 0 &&
          run.result !== "skipped" &&
          run.result !== "rejected" &&
          current.target.kind === "dedicated" &&
          run.threadId !== undefined &&
          run.threadId === current.target.threadId;
        const clockFrom = run.scheduledFor && run.scheduledFor > current.clockFrom ? run.scheduledFor : current.clockFrom;
        automations.set(current.id, {
          ...current,
          runs,
          received,
          clockFrom,
          ...(deliveredHere ? { threadRuns: (current.threadRuns ?? 0) + 1 } : {}),
        });
        break;
      }
      default:
        return state;
    }
    return { automations };
  },
};

/** 手帳に1つ書く。新しい順に並べ直し、上限を超えたら「知らせない」以外の古いものから捨てる */
function notePatrol(
  notebook: readonly PatrolNote[],
  change: { key: string; change: PatrolNoteChange; title?: string },
  at: string,
): PatrolNote[] {
  const current = notebook.find((n) => n.key === change.key);
  const rest = notebook.filter((n) => n.key !== change.key);
  let next: PatrolNote;
  switch (change.change) {
    case "notified":
      next = {
        key: change.key,
        title: change.title ?? current?.title ?? change.key,
        firstSeenAt: current?.firstSeenAt ?? at,
        lastSeenAt: at,
        notifiedAt: at,
        status: "notified",
      };
      break;
    case "seen":
      if (!current) return [...notebook];
      next = { ...current, lastSeenAt: at, ...(change.title ? { title: change.title } : {}) };
      break;
    case "muted":
    case "dismissed":
      if (!current) return [...notebook];
      next = { ...current, status: change.change };
      break;
    case "unmuted":
      if (!current || current.status !== "muted") return [...notebook];
      next = { ...current, status: "notified" };
      break;
  }
  const all = [next, ...rest].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  if (all.length <= PATROL_NOTEBOOK_MAX) return all;
  // 古いものから捨てる（「知らせない」は残す——捨てると、また知らせてしまう）
  const kept: PatrolNote[] = [];
  let over = all.length - PATROL_NOTEBOOK_MAX;
  for (let i = all.length - 1; i >= 0; i--) {
    const n = all[i]!;
    if (over > 0 && n.status !== "muted") {
      over--;
      continue;
    }
    kept.unshift(n);
  }
  return kept;
}
