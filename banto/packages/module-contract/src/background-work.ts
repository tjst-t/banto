// **裏の仕事の見え方を Module があとから足す**（追加・2026-10-21、アーキ仕様 §4.2「札の手がかりを Module があとから足す・
// 結果で画面を名乗る」、Backlog #489）。
//
// 1. 結果で名乗る画面：「あとで届ける」と言う結果（`dev.banto/pendingReply`）の `_meta` に `dev.banto/backgroundView` を載せると、
//    host が札の手がかりに写し、サイドバーの1件を押したときにその Module の入口（launcher）を `select` で開く
// 2. 要約：host の口 `relaySummarizeBackgroundWork` に材料を渡すと、core が小さいモデルで1行の要約を作って返す。札（`replyTo`）を
//    添えると、サイドバーの1件にも「要約：…」が出る

import { VENDOR_PREFIX } from "./meta.js";

/**
 * **その仕事を見る画面**（結果の `_meta` に `{ resourceUri, select? }`）。`resourceUri` はその Module の入口の資源（`ui://`）、
 * `select` はその画面に「見ている場所」（`dev.banto/view-state`）として渡すもの——中身は画面の Module が決める（Shell なら
 * `{ commandId }`）。tool の定義に `ui.resourceUri` があれば、そちらが先（会話のカードと同じ画面を開く）
 */
export const BACKGROUND_VIEW_META_KEY = `${VENDOR_PREFIX}/backgroundView`;

export interface BackgroundView {
  resourceUri: string;
  select?: unknown;
}

/** 画面の資源の長さの上限 */
export const BACKGROUND_VIEW_URI_MAX = 500;
/** `select` を JSON にしたときの長さの上限（画面が URL の `canvasView` に載せられる大きさ） */
export const BACKGROUND_VIEW_SELECT_MAX = 2000;

/**
 * 名乗った画面を読む。`resourceUri` が `ui://` で始まり、`select` が上限までの JSON にできるときだけ（ほかは名乗っていない）。
 * 写すのは JSON にして戻したもの（記録に残すので、値でないものを持ち込まない）
 */
export function backgroundViewOf(meta: Record<string, unknown> | undefined): BackgroundView | undefined {
  const raw = meta?.[BACKGROUND_VIEW_META_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { resourceUri, select } = raw as Record<string, unknown>;
  if (typeof resourceUri !== "string" || !resourceUri.startsWith("ui://") || resourceUri.length > BACKGROUND_VIEW_URI_MAX) return undefined;
  if (select === undefined) return { resourceUri };
  let json: string | undefined;
  try {
    json = JSON.stringify(select);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length > BACKGROUND_VIEW_SELECT_MAX) return undefined;
  return { resourceUri, select: JSON.parse(json) as unknown };
}

/** host の中継で裏の仕事の要約を頼む tool の名前 */
export const RELAY_SUMMARIZE_BACKGROUND_WORK_TOOL = "relaySummarizeBackgroundWork";

/** 材料の上限（字）。超えた分は core が切る */
export const BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS = 24_000;
/** 同じ札（無ければ Module＋`workId`）で、前の要約から空ける時間 */
export const BACKGROUND_SUMMARY_INTERVAL_MS = 10_000;
/** `workId` の長さの上限 */
export const BACKGROUND_SUMMARY_WORK_ID_MAX = 200;

/** `relaySummarizeBackgroundWork` の引数 */
export interface SummarizeBackgroundWorkInput {
  /**
   * その仕事を頼んだ呼び出しで host が渡した札（`dev.banto/replyTo`）。添えると、まだ返事待ちで宛先が Thread ならサイドバーの
   * 1件にも要約が出る。無くても要約は作って返す
   */
  replyTo?: string;
  material: {
    /** Module の中のその仕事の id（札が無いとき、回数を数える鍵になる） */
    workId: string;
    /** 要約の材料（banto 側から見えたこと。頼んだ文・やること一覧・経過など） */
    text: string;
  };
}

/** `relaySummarizeBackgroundWork` の答え（断ったら isError で理由の文） */
export interface SummarizeBackgroundWorkReply {
  /** 1行・2文までの要約 */
  summary: string;
}
