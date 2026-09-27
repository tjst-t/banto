"use client";

// アプリ起動時に1回、実bantoホストの既存Project一覧を読み込む
// （決定・2026-09-03）。lib/mock/projects.tsの`projects`はページのフルロード
// のたびに初期値へ戻る、純粋にクライアント側だけのメモリ状態——直接その
// ProjectのURLへ来た（一覧画面を経由していない）場合でも実データを引ける
// ようにする。何も描画しない。
import { useEffect } from "react";
import { hydrateRealProjects, registerNewRealForks } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { onRealAppEvent, startRealAppEvents } from "@/lib/backend/app-events";
import { reportFailure } from "@/lib/report-failure";

export function RealProjectsBootstrap() {
  useEffect(() => {
    // **黙って落とさない**（改訂・2026-09-10）——以前は `void` で捨てていたので、
    // host に届かないことが画面のどこにも出なかった（ホーム以外の画面でも起きる）
    hydrateRealProjects().catch((err: unknown) => {
      reportFailure("banto に繋がりません（Project 一覧を読み込めませんでした）", err);
    });
    // host からの知らせ（host が始めたターン・受信箱の変化）を読み始める（決定・2026-09-25）
    startRealAppEvents();
    // **AI が立てた Fork を一覧に出す**（決定・2026-09-27）——host が作った Fork は、その最初のターンが
    // 始まった知らせで初めて分かる。知らない Thread なら、その Project の一覧を取り直して足す
    return onRealAppEvent((event) => {
      if (event.type !== "turn.started" || !event.projectId || getThread(event.threadId)) return;
      registerNewRealForks(event.projectId).catch((err: unknown) => {
        reportFailure("AI が立てた Fork を一覧に出せませんでした", err);
      });
    });
  }, []);
  return null;
}
