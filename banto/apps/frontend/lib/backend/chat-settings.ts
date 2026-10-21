"use client";

// **チャットを眠らせるまで・閉じるまで**（追加・2026-10-21、v4-frontend.md §6.53「設定の『チャット』」、banto 全体の設定
// `chat.sleepAfterMinutes`・`chat.closeAfterDays`）。記録は host にあり、画面は写しを持つだけ（規則3）。設定の面と
// 「閉じたチャット」の小窓の下の端（何日で自動で閉じるか）が同じ写しを読む——保存したら両方が新しい値になる。
import { useEffect, useSyncExternalStore } from "react";
import { getBackendConfig, getRealChatSettings, setRealChatSettings, type RealChatSettings } from "./client";

let settings: RealChatSettings | undefined;
let loadError: string | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function load(): Promise<void> {
  if (!getBackendConfig()) return Promise.resolve();
  if (!loading) {
    loading = getRealChatSettings()
      .then((s) => {
        settings = s;
        loadError = undefined;
      })
      .catch((err: unknown) => {
        loadError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        loading = null;
        notify();
      });
  }
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

interface Snapshot {
  settings: RealChatSettings | undefined;
  error: string | undefined;
}
let snapshot: Snapshot = { settings: undefined, error: undefined };
function getSnapshot(): Snapshot {
  if (snapshot.settings !== settings || snapshot.error !== loadError) snapshot = { settings, error: loadError };
  return snapshot;
}
const SERVER_SNAPSHOT: Snapshot = { settings: undefined, error: undefined };

/** いまの値（取れるまでは undefined）と、取れなかった理由。開くたびに取り直す */
export function useChatSettings(): Snapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    void load();
  }, []);
  return snap;
}

/** 渡したものだけ保存する。保存できたら host が返した値を写す。失敗は呼んだ側へ */
export async function saveChatSettings(patch: Partial<RealChatSettings>): Promise<void> {
  settings = await setRealChatSettings(patch);
  loadError = undefined;
  notify();
}

/** 「閉じたチャット」の小窓の下の端の1行 */
export function closeAfterSentence(s: RealChatSettings): string {
  return s.closeAfterDays === "off" ? "触らなくなったチャットは自動では閉じません" : `${s.closeAfterDays}日触らなかったチャットは自動で閉じます`;
}
