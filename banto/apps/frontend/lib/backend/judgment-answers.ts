"use client";

// **ターンの流れの外で届いた、判断待ちの答え**（追加・2026-10-05、docs/notes/2026-10-05-relay-card-followups.md）。
//
// 会話のカードは、答えをターンの流れ（`answered`）で受け取る。ところがターンが先に終わってから host が畳んだもの
// （中継の承認を聞いた呼び出しが終わった）は、流れがもう無いので届かず、カードは答えられるように見えたまま残った。
// host はどの道で答えが付いても `judgment.answered` を流す（`app-events.ts`）——それをここに写し、カードが読む。
// 真実は host の受信箱。ここは「画面がもう知っている答え」を覚えるだけ（描き直しのたびに host へ聞きに行かない）

import { useSyncExternalStore } from "react";

const answers = new Map<string, string>();
const listeners = new Set<() => void>();

export function noteJudgmentAnswered(judgmentId: string, answer: string): void {
  if (answers.get(judgmentId) === answer) return;
  answers.set(judgmentId, answer);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** その判断待ちに付いた答え（まだ知らなければ undefined） */
export function useJudgmentAnswer(judgmentId: string | undefined): string | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (judgmentId ? answers.get(judgmentId) : undefined),
    () => undefined,
  );
}
