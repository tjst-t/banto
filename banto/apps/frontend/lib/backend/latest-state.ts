"use client";

// **戻ってきたら、最新の状況をそのまま出す**（決定・2026-09-26、ユーザー要望）。
//
// AI の応答に時間がかかっている間に、タブを閉じて開き直す・リロードする・別アプリへ移って戻る——どの戻り方でも
// 人が見たいのは「いまどうなっているか」だけ。以前はここで、走っているターンを入力欄の上の帯に要約して出して
// いた（「別の画面で始まったものに繋ぎ直しました」）。それをやめ、**最新を出す道を1つにした**：
//
//   1. host の記録から会話を組み直す（記録が真実——規則3）
//   2. host がまだそのターンを走らせていれば、最初から流し直してもらい、**自分で送ったときと同じ描き方で**
//      本文に流す（`followRunningTurn`）
//
// きっかけ：会話を開いた／他所でターンが始まった・終わった（host の知らせ）／知らせが繋ぎ直った／流れが
// 途中で切れた／画面に戻ってきた・回線が戻った。**ポーリングはしない**（再描画が assistant-ui のランタイムを
// 壊した——受信箱で踏んだ）。取れなかったら、少しずつ間をあけて取り直す。

import { getRealThread } from "./client";
import { onRealAppEvent } from "./app-events";
import { applyThreadRecord, followRunningTurn, hasLiveRealRun, onStreamOutcome, restoredSyncVersion } from "./adapter";
import { getThread } from "../mock/threads";

/** いま画面に開いている会話（実 Thread）と、開いている面の数 */
const openThreads = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
/** 取っている最中にまた頼まれた——終わったらもう1回 */
const again = new Set<string>();
/** 流れが途中で切れた——記録から組み直す（途中まで流れた吹き出しを残さない） */
const needsRebuild = new Set<string>();
/** 流れを最後まで読んだ——会話はもう最新なので組み直さない（下の `shownThrough` を進めるだけ） */
const readToEnd = new Set<string>();
/**
 * **組み直さずに見せている記録の長さ**。流れを最後まで読んだ会話は、組み立てたときの記録＋流れたターンを
 * 見せている——記録の写しは組み直すときにしか書き換えないので、どこまで見せているかをここで覚える。
 * 組み直したら（`build` が変わったら）捨てる
 */
const shownThrough = new Map<string, { build: number; length: number }>();

function shownLength(threadId: string): number {
  const shown = shownThrough.get(threadId);
  if (shown && shown.build === restoredSyncVersion(threadId)) return shown.length;
  return getThread(threadId)?.realMessages?.length ?? 0;
}
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryDelays = new Map<string, number>();
let installed = false;

/** 会話を開いた。開いている間、その会話に最新を出し続ける。閉じるときは返り値を呼ぶ */
export function registerOpenThread(threadId: string): () => void {
  install();
  openThreads.set(threadId, (openThreads.get(threadId) ?? 0) + 1);
  // 開いたばかりの会話は、いまの記録から作られている——「最後まで読んだ」の印は前の面のもの
  readToEnd.delete(threadId);
  void showLatest(threadId);
  return () => {
    const count = (openThreads.get(threadId) ?? 1) - 1;
    if (count > 0) {
      openThreads.set(threadId, count);
      return;
    }
    openThreads.delete(threadId);
    clearRetry(threadId);
  };
}

/** その会話に最新を出す。同時に何度頼まれても、取りに行くのは1本（終わってから、もう1回だけ） */
export function showLatest(threadId: string): Promise<void> {
  const running = inflight.get(threadId);
  if (running) {
    again.add(threadId);
    return running;
  }
  const task = (async () => {
    try {
      await showLatestOnce(threadId);
      clearRetry(threadId);
    } catch (err) {
      // **黙って諦めない**（規則2）——回線が戻っていないだけのことが多い。間をあけて取り直す
      console.warn(`[banto] 会話 ${threadId} の最新を取れませんでした。少しおいて取り直します:`, err);
      scheduleRetry(threadId);
    } finally {
      inflight.delete(threadId);
      if (again.delete(threadId)) void showLatest(threadId);
    }
  })();
  inflight.set(threadId, task);
  return task;
}

async function showLatestOnce(threadId: string): Promise<void> {
  if (!openThreads.has(threadId)) {
    needsRebuild.delete(threadId);
    readToEnd.delete(threadId);
    return;
  }
  // この画面が流れを読んでいる——それがいちばん新しい
  if (hasLiveRealRun(threadId)) return;
  // **先に乗ってから記録を取る**——乗る前に取ると、その間に終わったターンの返事を取りこぼす
  const following = await followRunningTurn(threadId);
  const record = await getRealThread(threadId);
  const rebuild = needsRebuild.delete(threadId);
  const readThrough = readToEnd.delete(threadId);
  if (following || rebuild) {
    // 記録から組み直し、走っていれば新しいランタイムがその流れを描き始める
    applyThreadRecord(threadId, record);
  } else if (readThrough) {
    // 最後まで読んだ会話は描き直さない（流れた吹き出しがそのまま最新——描き直すと tool のカードが消える）
    shownThrough.set(threadId, { build: restoredSyncVersion(threadId), length: record.messages.length });
  } else if (record.messages.length !== shownLength(threadId)) {
    applyThreadRecord(threadId, record);
  }
}

function scheduleRetry(threadId: string): void {
  if (!openThreads.has(threadId) || retryTimers.has(threadId)) return;
  const delay = retryDelays.get(threadId) ?? 1_000;
  retryDelays.set(threadId, Math.min(delay * 2, 15_000));
  retryTimers.set(
    threadId,
    setTimeout(() => {
      retryTimers.delete(threadId);
      void showLatest(threadId);
    }, delay),
  );
}

function clearRetry(threadId: string): void {
  const timer = retryTimers.get(threadId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(threadId);
  retryDelays.delete(threadId);
}

function showLatestEverywhere(): void {
  for (const threadId of openThreads.keys()) {
    // 間をあけて待っている分も、いま取り直す（戻ってきた人を待たせない）
    clearRetry(threadId);
    void showLatest(threadId);
  }
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  onStreamOutcome((threadId, outcome) => {
    if (outcome === "disconnected") needsRebuild.add(threadId);
    else readToEnd.add(threadId);
    void showLatest(threadId);
  });

  onRealAppEvent((event) => {
    // 知らせが（繋ぎ直して）届き始めた——途切れていた間に起きたことを取りこぼさない
    if (event.type === "hello") showLatestEverywhere();
    else if ((event.type === "turn.started" || event.type === "turn.ended") && openThreads.has(event.threadId)) {
      void showLatest(event.threadId);
    }
  });

  // **画面に戻ってきた**（別アプリ・別タブから）。ちょっと目を離しただけ（3秒未満）なら何もしない
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      return;
    }
    if (Date.now() - hiddenAt >= 3_000) showLatestEverywhere();
  });
  window.addEventListener("online", showLatestEverywhere);
  // 戻る・進むでページごと戻ってきた（bfcache）——中の状態は離れたときのまま
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) showLatestEverywhere();
  });
}
