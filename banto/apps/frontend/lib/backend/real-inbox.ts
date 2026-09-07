"use client";

// 受信箱（アーキ仕様§2.4）を実banto hostに繋ぐ（Stage 4、決定・2026-09-05）。
//
// **判断待ち（judgment）だけを扱う**——レビュー待ち（review）は生成元がまだ
// 無いので、空の区画を画面に残さない（規則13）。
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
import { listRealInbox, getBackendConfig, type RealInboxJudgment } from "./client";

let items: readonly RealInboxJudgment[] = [];
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

/** hostから取り直す。ポーリングの間隔を待たずに反映したいとき（ターン中に
 *  判断待ちが発生した直後など）に呼ぶ。 */
export async function refreshRealInbox(): Promise<void> {
  if (!getBackendConfig()) return;
  try {
    const all = await listRealInbox();
    const next = all.filter(
      (i): i is RealInboxJudgment => i.kind === "judgment" && i.liveness === "live",
    );
    // 同じ内容なら通知しない——毎5秒の再描画で入力中のフォーム等を揺らさない
    if (sameIds(items, next)) return;
    items = next;
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
