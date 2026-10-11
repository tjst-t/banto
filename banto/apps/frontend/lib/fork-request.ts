"use client";

// **Fork を作るダイアログを、会話の面の外から頼む口**（追加・2026-10-11、ユーザー要望。v4-frontend.md §6.32）。
//
// ダイアログと Fork を作る手順は会話の面（project-panels.tsx）が持つ——ヘッダの「Fork を開く」・発言の下の
// 「ここから Fork」と同じものを使う（規則3）。サイドバーは外枠（AppShell）にあるので、ここに頼みを置き、
// その Project の会話の面が受け取ってダイアログを開く。別の Project の行から頼んだときは、サイドバーが
// その Project へ移り、移った先の面が置いてあった頼みを受け取る。

import { useEffect, useState } from "react";

export type ForkStartMode = "choose" | "continue" | "fresh";

export interface ForkRequest {
  projectId: string;
  /** 親の Thread（Base でも Fork でもよい） */
  parentThreadId: string;
  /** 発言の下から分けるとき、その発言の seq */
  fromSeq?: number;
  /** choose＝始め方を選ばせる（ヘッダ）／continue＝会話を引き継ぐ／fresh＝まっさら */
  start: ForkStartMode;
}

let pending: ForkRequest | null = null;
const listeners = new Set<() => void>();

/** ダイアログを頼む。受け取るのはその Project の会話の面 */
export function requestForkDialog(request: ForkRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/**
 * この Project 宛ての頼みを受け取る。受け取ったら置き場から消す（2回開かない）。
 * 別の Project 宛てのものには触らない——移った先の面が受け取る
 */
export function useIncomingForkRequest(projectId: string, onRequest: (request: ForkRequest) => void): void {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (pending && pending.projectId === projectId) {
      const request = pending;
      pending = null;
      onRequest(request);
    }
    // onRequest は毎回作り直される関数——頼みが来たとき・Project が替わったときだけ見る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, projectId]);
}
