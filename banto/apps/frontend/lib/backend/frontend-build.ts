"use client";

// **画面の版が古くなったかを知る**（追加・2026-10-05、ユーザー報告「更新したけど何も変わってなさそう」）。
//
// 画面から banto を更新しても、開いていたページは読み込み直されず、古い画面のプログラムが動き続けていた
// （host は新しい・画面は古い）。ページは組み立てたときの印（`NEXT_PUBLIC_BANTO_BUILD`、next.config.ts）を持ち、
// 画面のサーバは自分の印を `/banto-build` で返す。違えば「新しい版の画面があります」を出す（`NewBuildBanner`）。
//
// 確かめるのは、host に繋ぎ直したとき（hello。起こし直しのあとは必ず来る）と、タブに戻ったとき。
// 画面のサーバは host より遅れて起きることがあるので、繋ぎ直したあとはしばらく間をあけて何度か確かめる。
// ポーリングはしない（app-events.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { onRealAppEvent, startRealAppEvents } from "./app-events";
import { isNewerBuild } from "./frontend-build-compare";

/** このページが組み立てられたときの印。dev や印の無い組み立てでは null（比べない） */
export const PAGE_BUILD: string | null = process.env.NEXT_PUBLIC_BANTO_BUILD ?? null;

/** 繋ぎ直したあとに確かめる間合い（ミリ秒）。画面のサーバの起き上がりを待つ。計測した値ではない */
export const RECHECK_DELAYS_MS = [0, 3_000, 10_000, 30_000, 60_000, 120_000] as const;


/** 新しい版の印（見つかったら）。見つかったあとは確かめない——読み込み直すまでこのまま */
let newBuild: string | null = null;
const listeners = new Set<() => void>();
let wired = false;
let timers: ReturnType<typeof setTimeout>[] = [];

async function check(): Promise<boolean> {
  if (newBuild !== null) return true;
  try {
    const res = await fetch("/banto-build", { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { build?: unknown };
    if (!isNewerBuild(PAGE_BUILD, body.build)) return false;
    newBuild = body.build as string;
    for (const listener of listeners) listener();
    return true;
  } catch {
    // 画面のサーバが起こし直しの最中——次の間合いでまた確かめる
    return false;
  }
}

function checkSeveralTimes(): void {
  for (const t of timers) clearTimeout(t);
  timers = RECHECK_DELAYS_MS.map((delay) =>
    setTimeout(() => {
      void check().then((found) => {
        if (found) for (const t of timers) clearTimeout(t);
      });
    }, delay),
  );
}

function wire(): void {
  if (wired || typeof window === "undefined" || PAGE_BUILD === null) return;
  wired = true;
  onRealAppEvent((event) => {
    if (event.type === "hello") checkSeveralTimes();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  startRealAppEvents();
  // 聞き始めたときにも確かめる——流れは先に読み始められていて（real-projects-bootstrap.tsx）、繋いだときの hello を
  // 取り逃すことがある（E2E で踏んだ）
  checkSeveralTimes();
}

function subscribe(listener: () => void): () => void {
  wire();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 新しい版の画面の印。無ければ null */
export function useNewFrontendBuild(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => newBuild,
    () => null,
  );
}

const RELOADED_FOR_KEY = "banto-reloaded-for-build";

/**
 * その版のために、まだ自動で読み込み直していなければ読み込み直す（更新した本人の画面、update-panel.tsx）。
 * 読み込み直しても同じ印が古いと出る（画面のサーバが古いものを返した等）なら繰り返さず、帯に任せる
 */
export function reloadOnceFor(build: string): boolean {
  try {
    if (sessionStorage.getItem(RELOADED_FOR_KEY) === build) return false;
    sessionStorage.setItem(RELOADED_FOR_KEY, build);
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}
