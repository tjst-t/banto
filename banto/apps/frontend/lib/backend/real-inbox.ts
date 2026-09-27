"use client";

// 受信箱（アーキ仕様§2.4）を実banto hostに繋ぐ（Stage 4、決定・2026-09-05）。
//
// 判断待ち・お知らせ・**レビュー待ち**を扱う。レビュー待ちは「ターンが終わった」（決定・2026-09-27、
// ユーザー）——**開いて見ている Thread のものは、ここで自分で「見た」にする**（見ている人に知らせは要らない）。
//
// **定期ポーリングはしない**（決定・2026-09-05、実測に基づく）。5秒間隔で
// 取り直すと、その再描画が tool 呼び出し待ちの Thread を壊した
// （`Duplicate key toolCallId-… in useResources`——assistant-ui のランタイムが
// 判断待ちの最中の再描画で resource を二重登録する）。間隔を延ばすと再現
// しなくなることで、再描画が引き金だと確かめた。
//
// 代わりに**出来事で取り直す**：起動時・ターンで判断待ちが発生した時・
// 答えた時・受信箱を開いた時。判断待ちは必ずこのブラウザが走らせている
// ターンから生まれるので、これで取りこぼさない（別のブラウザが走らせた
// ターンの分は、受信箱を開いた時に入る）。
//
// 状態は**1箇所**——複数のコンポーネント（受信箱・レールのバッジ・
// モバイルのバッジ）が同じものを見るので、mock/store-events.ts と同じ
// subscribe パターンに集める（規則3）。

import { useSyncExternalStore } from "react";
import {
  listRealInbox,
  getBackendConfig,
  acknowledgeRealNotice,
  type RealInboxJudgment,
  type RealInboxNotice,
  type RealInboxReview,
} from "./client";

let items: readonly RealInboxJudgment[] = [];
let notices: readonly RealInboxNotice[] = [];
let reviews: readonly RealInboxReview[] = [];
/** いま画面に開いている Thread（`useViewingThread`）。**購読しない**——Thread の画面を受信箱の変化で
 *  描き直さない（上の「定期ポーリングはしない」と同じ理由） */
const viewing = new Map<string, number>();
let snapshotVersion = 0;
const listeners = new Set<() => void>();
function emit(): void {
  snapshotVersion++;
  for (const listener of listeners) listener();
}

/** いま開いている判断待ち。**答え済み・期限切れは出さない**——決着したものを
 *  状態として持たない（§2.4.1、Event Storeの射影）。 */
export function getRealJudgments(): readonly RealInboxJudgment[] {
  return items;
}

/** いま出ているお知らせ（決定・2026-09-07）。判断待ちと違い、答えるものではない
 *  ——「見た」と言えば消える。 */
export function getRealNotices(): readonly RealInboxNotice[] {
  return notices;
}

/** 出ているレビュー待ち（ターンが終わった Thread、決定・2026-09-27）。開いて見ている Thread のものは除く */
export function getRealReviews(): readonly RealInboxReview[] {
  return reviews;
}

function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/** 見ている Thread のレビュー待ちを「見た」にする。**返り値は残すもの** */
function acknowledgeViewed(list: readonly RealInboxReview[]): readonly RealInboxReview[] {
  if (!isVisible()) return list;
  const seen = list.filter((r) => viewing.has(r.threadId));
  for (const r of seen) {
    void acknowledgeRealNotice(r.id).catch(() => {
      // 次に取り直したときにまた試す
    });
  }
  return seen.length === 0 ? list : list.filter((r) => !viewing.has(r.threadId));
}

/**
 * **この Thread を開いている**と知らせる（Thread の画面で呼ぶ）。開いている間に終わったターンは、
 * 受信箱に積まずに「見た」にする
 */
export function markThreadViewing(threadId: string): () => void {
  viewing.set(threadId, (viewing.get(threadId) ?? 0) + 1);
  const next = acknowledgeViewed(reviews);
  if (next !== reviews) {
    reviews = next;
    emit();
  }
  return () => {
    const n = (viewing.get(threadId) ?? 1) - 1;
    if (n <= 0) viewing.delete(threadId);
    else viewing.set(threadId, n);
  };
}

if (typeof document !== "undefined") {
  // 裏のタブで終わったものは、戻ってきたときに「見た」にする
  document.addEventListener("visibilitychange", () => {
    if (!isVisible()) return;
    const next = acknowledgeViewed(reviews);
    if (next !== reviews) {
      reviews = next;
      emit();
    }
  });
}

/** hostから取り直す。ポーリングの間隔を待たずに反映したいとき（ターン中に
 *  判断待ちが発生した直後など）に呼ぶ。 */
export async function refreshRealInbox(): Promise<void> {
  if (!getBackendConfig()) return;
  try {
    const all = await listRealInbox();
    const next = all.filter(
      (i): i is RealInboxJudgment => i.kind === "judgment" && i.liveness === "live",
    );
    const nextNotices = all.filter(
      (i): i is RealInboxNotice => i.kind === "notice" && !i.acknowledged,
    );
    const nextReviews = acknowledgeViewed(
      all.filter((i): i is RealInboxReview => i.kind === "review" && !i.acknowledged),
    );
    // 同じ内容なら通知しない——毎5秒の再描画で入力中のフォーム等を揺らさない
    const noticesChanged =
      nextNotices.length !== notices.length ||
      nextNotices.some((n, i) => n.id !== notices[i]!.id);
    const reviewsChanged =
      nextReviews.length !== reviews.length || nextReviews.some((r, i) => r.id !== reviews[i]!.id);
    if (sameIds(items, next) && !noticesChanged && !reviewsChanged) return;
    items = next;
    notices = nextNotices;
    reviews = nextReviews;
    emit();
  } catch {
    // hostが落ちている・トークンが違う等。**受信箱を空にしない**——直前に
    // 見えていたものを消すと「解決した」ように見える（規則2、黙って別の
    // 経路へ落ちない）。次のポーリングで取り直す
  }
}

function sameIds(a: readonly RealInboxJudgment[], b: readonly RealInboxJudgment[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i]!.id && item.liveness === b[i]!.liveness);
}

let loadedOnce = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 最初の購読者が現れたときだけ取りに行く（起動時の1回）
  if (!loadedOnce) {
    loadedOnce = true;
    void refreshRealInbox();
  }
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return snapshotVersion;
}

/** 判断待ちを見るコンポーネントで呼ぶ。返り値はバージョン（中身は
 *  `getRealJudgments()`で引く——mock/store-events.tsと同じ形）。 */
export function useRealInboxVersion(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
