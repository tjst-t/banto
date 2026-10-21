// **小さいモデルを1回だけ呼ぶ口**（Backlog #497、v4-architecture.md §2.2「チャット——Project を作る前の相談」の「題は AI が付ける」）。
//
// 道具なし・1ターン（`maxTurns: 1`）・会話の記録を残さない（`persistSession: false`）。会話の本体（`adapter.ts` の `runTurn`）と
// 同じく、人の設定・MCP・plugin は混ぜない。**本体の Claude のログイン**で呼ぶ——環境は呼び元が `ClaudeLoginRelay.runnerEnvFor`
// （Thread の印なし）で組んで渡す。アカウントの選び方は会話の本体と同じ（上から順に・均す）。
//
// 失敗は投げる。代わりの値（題なら書き込みの最初の文を縮めたもの）にするのは呼び元。
//
// 呼び元は2つ：会話の題（`http/chat-title.ts`）と、裏の仕事の要約（`delivery/background-summaries.ts`——Module が host の口
// `relaySummarizeBackgroundWork` で頼む、アーキ仕様 §4.2、Backlog #489）。どちらも指示（system prompt）は呼び元の core が持ち、
// モデルはここの `SMALL_MODEL`。Module から中継へ `/v1/messages` を直に送らせる形は採らない（指示とモデルの版の写しが Module に
// 増える。`docs/notes/2026-10-20-background-visibility.md`「レビューで直したこと」）。

import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { NONESSENTIAL_TRAFFIC_ENV } from "../claude-login/relay.js";
import { claudeExecutablePath } from "./adapter.js";

/** 小さいモデル。版を決めて書く（上げるときはここを直す） */
export const SMALL_MODEL = "claude-haiku-4-5-20251001";

export interface OneShotOptions {
  /** 指示（system prompt の全文） */
  systemPrompt: string;
  prompt: string;
  /** 無ければ `SMALL_MODEL` */
  model?: string;
  /**
   * CLI の環境（SDK の `env`——process.env を置き換える）。会話の本体と同じログインの中継を通すとき呼び元が組む。
   * 渡さなければ process.env に付随の通信を止める印だけを足す
   */
  env?: Record<string, string | undefined>;
  /** 中継で均すときの固定の鍵になる id（SDK の `sessionId`）。呼び元が `runnerEnvFor` に渡したものと同じにする。無ければ作る */
  sessionId?: string;
  cwd?: string;
  signal?: AbortSignal;
}

/** SDK の `query()` の差し替え口（試験用）。流れてくるメッセージだけを使う */
export type OneShotQuery = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

/**
 * 1回呼んで、答えの最初の空でない行を返す（前後の空白を落とす）。答えが無い・空・エラーで終わったら投げる
 */
export async function askSmallModel(opts: OneShotOptions, run: OneShotQuery = query): Promise<string> {
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (opts.signal?.aborted) abortController.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  let result: SDKMessage | undefined;
  try {
    for await (const message of run({
      prompt: opts.prompt,
      options: {
        model: opts.model ?? SMALL_MODEL,
        systemPrompt: opts.systemPrompt,
        tools: [],
        maxTurns: 1,
        persistSession: false,
        sessionId: opts.sessionId ?? randomUUID(),
        settingSources: [],
        strictMcpConfig: true,
        env: opts.env ?? { ...process.env, ...NONESSENTIAL_TRAFFIC_ENV },
        abortController,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(claudeExecutablePath() ? { pathToClaudeCodeExecutable: claudeExecutablePath() } : {}),
      },
    })) {
      if (message.type === "result") result = message;
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (!result || result.type !== "result") throw new Error("小さいモデルから答え（result）が届きませんでした");
  if (result.subtype !== "success" || result.is_error) {
    const detail = result.subtype === "success" ? result.result : (result.errors ?? []).join(" / ");
    throw new Error(`小さいモデルの呼び出しが失敗しました（${result.subtype}）${detail ? `: ${detail}` : ""}`);
  }
  const line = result.result
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error("小さいモデルの答えが空でした");
  return line;
}
