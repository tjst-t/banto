"use client";

// **人が直接開ける Module の入口**（launcher、§6.2、決定・2026-09-07）。
//
// 「まずファイルを見たい」は AI に頼む用事ではない（要件C3）。Module が
// 「入口である」と名乗った Canvas を、Command Palette から直接開けるようにする。
//
// **自分の索引を持たない**（規則3）——一覧は host が Module 集合から導出したもの。
// ここが持つのは、画面から同期で読むための控えだけ。
//
// 取り直すのは**出来事のとき**（Command Palette を開いた・Project が変わった）
// ——背景ポーリングは足さない（real-inbox.ts と同じ理由）。

import { useSyncExternalStore } from "react";
import { getBackendConfig, listRealLaunchers, type RealUiLauncher } from "./client";

const byProject = new Map<string, readonly RealUiLauncher[]>();
let snapshotVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
  snapshotVersion++;
  for (const listener of listeners) listener();
}

/** その Project の入口。まだ取っていなければ空——**無いのと区別できないので、
 *  呼ぶ側は取り直しを先に呼ぶ**（下の refresh）。 */
export function getRealLaunchers(projectId: string): readonly RealUiLauncher[] {
  return byProject.get(projectId) ?? [];
}

export async function refreshRealLaunchers(projectId: string): Promise<void> {
  if (!getBackendConfig()) return;
  try {
    const next = await listRealLaunchers(projectId);
    const prev = byProject.get(projectId);
    // 同じ内容なら通知しない——開くたびに画面を揺らさない
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    byProject.set(projectId, next);
    emit();
  } catch {
    // host が落ちている・繋がっていない。**前に見えていたものを消さない**
    // （消すと「入口が無くなった」ように見える、規則2）
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRealLaunchersVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => snapshotVersion,
    () => 0,
  );
}
