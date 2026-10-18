"use client";

// アプリ起動時に1回、実bantoホストの既存Project一覧を読み込む
// （決定・2026-09-03）。lib/mock/projects.tsの`projects`はページのフルロード
// のたびに初期値へ戻る、純粋にクライアント側だけのメモリ状態——直接その
// ProjectのURLへ来た（一覧画面を経由していない）場合でも実データを引ける
// ようにする。何も描画しない。
import { useEffect } from "react";
import { hydrateRealProjects, refreshRealProjectLocation, registerNewRealForks } from "@/lib/mock/projects";
import { getThread, markThreadClosed } from "@/lib/mock/threads";
import { onRealAppEvent, startRealAppEvents } from "@/lib/backend/app-events";
import { wireRunningThreads } from "@/lib/backend/running-threads";
import { wireBackgroundWork } from "@/lib/backend/background-work";
import { wireRateLimitWaits } from "@/lib/backend/rate-limit-waits";
import { wireResourcesBusy } from "@/lib/backend/resources-busy";
import { wireUnreachableRuntimes } from "@/lib/backend/unreachable-runtimes";
import { wireRuntimeMoves } from "@/lib/backend/runtime-moves";
import { wireCodeTransfers } from "@/lib/backend/code-transfers";
import { reportFailure } from "@/lib/report-failure";

export function RealProjectsBootstrap() {
  useEffect(() => {
    // **黙って落とさない**（改訂・2026-09-10）——以前は `void` で捨てていたので、
    // host に届かないことが画面のどこにも出なかった（ホーム以外の画面でも起きる）
    hydrateRealProjects().catch((err: unknown) => {
      reportFailure("banto に繋がりません（Project 一覧を読み込めませんでした）", err);
    });
    // AI が動いている Thread の写し（§6.33）。最初の hello を取り逃さないよう、読み始める前に聞き手を付ける
    wireRunningThreads();
    // バックグラウンドで動いているものの写し（§6.33）。同じ理由で読み始める前に
    wireBackgroundWork();
    // 上限が戻るのを待っている Thread（§6.46）。同じ理由で読み始める前に
    wireRateLimitWaits();
    // 混んでいる Project とこの機械（§6.36）。同じ理由で読み始める前に
    wireResourcesBusy();
    // 繋がらない別のサーバ（Backlog #383）。同じ理由で読み始める前に
    wireUnreachableRuntimes();
    // 別の実行場所へ移している Project（追加・2026-10-12、Backlog #270）。同じ理由で読み始める前に
    wireRuntimeMoves();
    // 別のサーバへコードを送っている途中のもの（Backlog #269）。同じ理由で読み始める前に
    wireCodeTransfers();
    // host からの知らせ（host が始めたターン・受信箱の変化）を読み始める（決定・2026-09-25）
    startRealAppEvents();
    // **AI が立てた Fork を一覧に出す**（決定・2026-09-27）——host が作った Fork は、その最初のターンが
    // 始まった知らせで初めて分かる。知らない Thread なら、その Project の一覧を取り直して足す
    return onRealAppEvent((event) => {
      // **Fork が閉じた**（追加・2026-10-08、アーキ仕様 §2.2「AI が自分の Fork を閉じる」）——AI が閉じた・別の画面で
      // 閉じた。サイドバーの開いている一覧から外れ、その Fork を開いている画面は帯を出す（Base へは飛ばさない）
      // **移し終えたら、その Project の根と実行場所を読み直す**（追加・2026-10-12、Backlog #270）——移す画面を閉じて
      // いても、サイドバーの行の title（根）や設定の欄が古い場所のままにならないように
      if (event.type === "runtime_move.changed" && !event.move && !event.failed) {
        refreshRealProjectLocation(event.projectId).catch((err: unknown) => {
          reportFailure("移した Project の新しい場所を読み直せませんでした", err);
        });
        return;
      }
      if (event.type === "thread.closed") {
        if (getThread(event.threadId)?.kind === "fork") {
          markThreadClosed(event.threadId, { by: event.by, ...(event.reason ? { reason: event.reason } : {}) });
        }
        return;
      }
      if (event.type !== "turn.started" || !event.projectId || getThread(event.threadId)) return;
      registerNewRealForks(event.projectId).catch((err: unknown) => {
        reportFailure("AI が立てた Fork を一覧に出せませんでした", err);
      });
    });
  }, []);
  return null;
}
