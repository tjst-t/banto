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

import { getRealThread, type RealThread } from "./client";
import { onRealAppEvent } from "./app-events";
import {
  applyThreadRecord,
  followRunningTurn,
  hasLiveRealRun,
  onRuntimeIdle,
  onStreamOutcome,
  restoredSyncVersion,
} from "./adapter";
import { getThread, realThreadExtraOf, updateRealThreadMarks } from "../mock/threads";
import { withoutReplayedReply } from "./replayed-turn";

/** いま画面に開いている会話（実 Thread）と、開いている面の数 */
const openThreads = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
/** 取っている最中にまた頼まれた——終わったらもう1回 */
const again = new Set<string>();
/** この画面が流れを読んでいた・会話が走っていたので引き返した——会話が走り終えたらやり直す */
const deferred = new Set<string>();
/** 流れが途中で切れた——記録から組み直す（途中まで流れた吹き出しを残さない） */
const needsRebuild = new Set<string>();
/** 流れを最後まで読んだ——会話はもう最新なので組み直さない（下の `shownThrough` を進めるだけ） */
const readToEnd = new Set<string>();
/**
 * **組み直さずに見せている記録**。流れを最後まで読んだ会話は、組み立てたときの記録＋流れたターンを
 * 見せている——記録の写しは組み直すときにしか書き換えないので、どこまで見せているかをここで覚える。
 * 組み直したら（`build` が変わったら）捨てる。
 *
 * **長さだけでなく記録そのものを持つ**（改訂・2026-09-28、ユーザー報告「最新のメッセージが消える、リロードで
 * 直る」）。以前は長さだけを覚えていた。そのあと面が作り直される（設定へ行って戻る・Fork と Canvas を両方
 * 開く・Canvas を全画面にする）と、新しい面は**古い写し**から組み立てられるのに、ここは「もう最新を見せた」
 * と答えるので取り直しもしなかった——流れたターンが画面から消えたまま戻らない（実測・
 * `thread-view-persist.spec.ts`）。写しを揃える材料として、見せている記録を持っておく
 */
const shownThrough = new Map<string, { build: number; record: RealThread }>();

/**
 * **見せている記録の印**。件数だけではなく最後の発言の中身も見る（改訂・2026-10-15、ユーザー報告「終わったのに最新が
 * 出ない」）——host は同じターンの AI の発言を書き終えるごとに1件にまとめて足すので、ターンの途中で組み直した
 * 会話は、終わったあとも件数が同じまま中身だけ伸びる。件数だけで比べると「もう最新」と見て取りこぼしていた
 */
interface SignedMessage {
  seq: number;
  role: string;
  text: string;
  uiToolCalls?: readonly unknown[];
  judgments?: readonly unknown[];
  turnSummary?: unknown;
}

export function recordSignature(messages: readonly SignedMessage[] | undefined): string {
  if (!messages || messages.length === 0) return "0";
  const last = messages[messages.length - 1]!;
  return [
    messages.length,
    last.seq,
    last.role,
    last.text.length,
    last.uiToolCalls?.length ?? 0,
    last.judgments?.length ?? 0,
    last.turnSummary ? 1 : 0,
  ].join(":");
}

/**
 * **会話のランタイムがどの記録から組み立てられたか**（直し・2026-10-15、ユーザー報告「終わったのに最新が出ず、リロードで
 * 直る」、`e2e/specs/thread-latest-on-return.spec.ts`）。版（`restoredSyncVersion`）ごとに、組み立てたときの写しの印。
 *
 * 以前は「いまの写し」を見せているものとみなしていた。だが写しは組み直しを通らずに書き換わることがある——Project を
 * 開くと開いている会話の記録を取り直して写しだけ書き換える（`refreshRealProjectThreads`）。それがこちらの取得より先に
 * 返ると、ランタイムは古い写しから作られたままなのに「写し＝記録＝もう最新」と見て組み直さず、別の Project から
 * 戻った会話が留守の間のやり取りを欠いたまま止まっていた。同じ版で印の違う面が2つあれば、必ず組み直す印にする
 */
const builtFrom = new Map<string, { build: number; signature: string }>();
const CONFLICTING = "conflicting";

/** 会話のランタイムが、その版をこの写しから組み立てた（作ったとき・記録を流し込んだとき） */
export function noteRuntimeBuilt(threadId: string, build: number, signature: string): void {
  const known = builtFrom.get(threadId);
  if (known && known.build === build && known.signature !== signature) {
    builtFrom.set(threadId, { build, signature: CONFLICTING });
    return;
  }
  builtFrom.set(threadId, { build, signature });
}

function shownSignature(threadId: string): string {
  const build = restoredSyncVersion(threadId);
  const shown = shownThrough.get(threadId);
  if (shown && shown.build === build) return recordSignature(shown.record.messages);
  const built = builtFrom.get(threadId);
  if (built && built.build === build) return built.signature;
  return recordSignature(getThread(threadId)?.realMessages);
}

/**
 * **写しを、見せている記録に揃える**。組み直さずに見せていた分（流れたターン）があるときだけ、写しをその
 * 記録で書き換えて組み直す。面が作り直される前後で呼ぶ——作り直された面が古い写しを描かないように
 */
function settleShownRecord(threadId: string): void {
  const shown = shownThrough.get(threadId);
  shownThrough.delete(threadId);
  if (!shown || shown.build !== restoredSyncVersion(threadId)) return;
  // 走っている最中は組み直さない（流れている表示を壊す）——走り終えたら最新を出す道が別にある
  if (hasLiveRealRun(threadId)) return;
  applyThreadRecord(threadId, shown.record);
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
  // 前の面が流れを最後まで読んで見せていたなら、新しい面は古い写しから作られている——見せていた記録に揃える
  // （同じ描画で古い面が消えて新しい面が立つとき——Fork と Canvas を両方開いた等——はここで気づく）
  settleShownRecord(threadId);
  void showLatest(threadId);
  return () => {
    const count = (openThreads.get(threadId) ?? 1) - 1;
    if (count > 0) {
      openThreads.set(threadId, count);
      return;
    }
    openThreads.delete(threadId);
    clearRetry(threadId);
    // **誰も見なくなったら、写しを見せていた記録に揃える**——次に開く面（設定から戻った等）が、
    // 最初から最新で組み立てられる（取り直しを待つ間、古い会話が一瞬出ることもない）
    settleShownRecord(threadId);
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
    deferred.delete(threadId);
    return;
  }
  // この画面が流れを読んでいる・会話が走っている——それがいちばん新しい。走り終えたらやり直す
  // （流れが切れた直後は、まだ run の後片づけの途中で「走っている」——引き返したままにしない）
  if (hasLiveRealRun(threadId)) {
    deferred.add(threadId);
    return;
  }
  // **先に乗ってから記録を取る**——乗る前に取ると、その間に終わったターンの返事を取りこぼす
  const following = await followRunningTurn(threadId);
  const record = await getRealThread(threadId);
  // **取り終えた時点でもう一度見る**（追加・2026-09-28、レビュー指摘）——取りに行っている間に人が送り始めて
  // いたら、ここで組み直すと送った発言ごと会話が作り直されて消える。走り終えたらやり直す
  if (!following && hasLiveRealRun(threadId)) {
    deferred.add(threadId);
    return;
  }
  const rebuild = needsRebuild.delete(threadId);
  const readThrough = readToEnd.delete(threadId);
  if (following || rebuild) {
    // 記録から組み直し、走っていれば新しいランタイムがその流れを描き始める。**流し直すターンの AI の発言は記録から
    // 外す**（追加・2026-10-05）——host は書き終えるごとに記録に入れるので、そのまま描くと流し直しと2回出る
    applyThreadRecord(threadId, following ? withoutReplayedReply(record, following.startedSeq) : record);
  } else if (readThrough) {
    // 最後まで読んだ会話は描き直さない（流れた吹き出しがそのまま最新——描き直すと tool のカードが消える）
    shownThrough.set(threadId, { build: restoredSyncVersion(threadId), record });
    // 流れに載らない会話の中の印（§6.46）だけは足す——描き直さずに
    addMarksWithoutRebuild(threadId, record);
  } else if (recordSignature(record.messages) !== shownSignature(threadId)) {
    applyThreadRecord(threadId, record);
  }
}

/** 会話ごとの、画面にいま出ている最後の人の発言の id を答える口（`thread-panel.tsx` が会話のランタイムから答える） */
const lastShownUserMessage = new Map<string, () => string | undefined>();

/** 画面の最後の人の発言の id を答える口を付ける。外すときは返り値を呼ぶ */
export function registerLastShownUserMessage(threadId: string, read: () => string | undefined): () => void {
  lastShownUserMessage.set(threadId, read);
  return () => {
    if (lastShownUserMessage.get(threadId) === read) lastShownUserMessage.delete(threadId);
  };
}

/**
 * **流れに載らない会話の中の印を、組み直さずに足す**（Claude のアカウントの切り替えの1行・上限で止まった帯、v4-frontend.md §6.46）。
 * 印は記録にだけある。最後まで読んだ会話は組み直さない（流れた tool のカードを消さない、`docs/notes/2026-09-28-thread-view-persist.md`）
 * ——発言の写しは古いままなので、写しの最後の発言より後に起きた切り替えは、**画面のそのターンの人の発言の後**に置く。
 * 切り替えは人の発言のあと AI の返事より前に起きるので、記録から組み直したとき（`anchorOf(seq)`）と同じ場所——開き直しても
 * 動かない。ここはターンが終わってから走るので、その時点の最後の人の発言がそのターンのもの。上限で止まった帯は会話の一番下
 */
function addMarksWithoutRebuild(threadId: string, record: RealThread): void {
  const shown = getThread(threadId);
  if (!shown) return;
  const next = realThreadExtraOf(record);
  const known = new Set((shown.realAccountSwitches ?? []).map((s) => s.seq));
  const added = (next.realAccountSwitches ?? []).filter((s) => !known.has(s.seq));
  if (added.length === 0 && shown.realRateLimit === next.realRateLimit) return;
  const lastCopied = shown.realMessages?.at(-1)?.seq ?? -1;
  const lastId = lastShownUserMessage.get(threadId)?.();
  const anchors: Record<number, string> = {};
  if (lastId) for (const s of added) if (s.seq > lastCopied) anchors[s.seq] = lastId;
  updateRealThreadMarks(threadId, next, anchors);
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

  onRuntimeIdle((threadId) => {
    if (deferred.delete(threadId)) void showLatest(threadId);
  });

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
