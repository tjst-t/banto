"use client";

// アプリ起動時に1回、実bantoホストの既存Project一覧を読み込む
// （決定・2026-09-03）。lib/mock/projects.tsの`projects`はページのフルロード
// のたびに初期値へ戻る、純粋にクライアント側だけのメモリ状態——直接その
// ProjectのURLへ来た（一覧画面を経由していない）場合でも実データを引ける
// ようにする。何も描画しない。
import { useEffect } from "react";
import { hydrateRealProjects } from "@/lib/mock/projects";

export function RealProjectsBootstrap() {
  useEffect(() => {
    void hydrateRealProjects();
  }, []);
  return null;
}
