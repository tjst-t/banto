"use client";

// **Thread ごとの「AI が動いている」と「バックグラウンドで動いているもの」**（モック・2026-10-03、ユーザー「どの Thread で
// サブエージェントが動いているか UI で見たい」）。
//
// 本物では、どちらも host が自分で持っている事実から作る——core は Module の中身を知らない：
// - 動いている：ターンが走っている間（今の §6.33 の回る輪と同じもの）
// - バックグラウンド：AI が「終わったら届ける」tool（`dev.banto/deliversLater`）を呼び、Module が「あとで届けます」と
//   約束した札（返信用の札の awaiting）。文は tool が名乗るカード（`dev.banto/card`）の題と説明から作る
//
// ここはその見本の値だけを持つ。

export interface PendingReply {
  id: string;
  /** 約束した Module の表示名 */
  moduleTitle: string;
  /** カードの題（tool が名乗る `{agent} に頼んだ仕事` 等） */
  title: string;
  /** カードの説明（頼んだ内容の頭） */
  description: string;
  /** 頼んでからの分 */
  minutesAgo: number;
}

/** 見本の状態。組み合わせを全部見られるように散らしてある */
const running = new Set<string>([
  "banto-base", // 動いていて、返事も待っている
  "login", // 動いているだけ（「仕様書の整理」は何も無い）
  "home-base", // 別の Project：動いているだけ
]);

const pending: Record<string, PendingReply[]> = {
  "banto-base": [
    {
      id: "r1",
      moduleTitle: "サブエージェント",
      title: "Claude Code に頼んだ仕事",
      description: "E2E の subagent-runs.spec.ts が間欠的に落ちる原因を、まず再現する形に落としてから…",
      minutesAgo: 12,
    },
  ],
  ui: [
    {
      id: "r2",
      moduleTitle: "サブエージェント",
      title: "Claude Code に頼んだ仕事",
      description: "Fable として、サイドバーの未読表示の変更をレビューしてください。見てほしい点は…",
      minutesAgo: 4,
    },
    {
      id: "r3",
      moduleTitle: "サブエージェント",
      title: "OpenCode に頼んだ仕事",
      description: "mock/ の lint の警告を全部洗い出して、直せるものは直す",
      minutesAgo: 27,
    },
  ],
  "hermes-base": [
    {
      id: "r4",
      moduleTitle: "サブエージェント",
      title: "Claude Code に頼んだ仕事",
      description: "埋め込みの次元数を 768 と 1536 で比べる試験を回して、結果を表に…",
      minutesAgo: 41,
    },
  ],
  "hermes-embedding": [
    {
      id: "r5",
      moduleTitle: "サブエージェント",
      title: "Claude Code に頼んだ仕事",
      description: "前回の結果の続き。sessionId を渡すので、表の残りの行を埋める",
      minutesAgo: 8,
    },
    {
      id: "r6",
      moduleTitle: "サブエージェント",
      title: "OpenCode に頼んだ仕事",
      description: "同じ問いを gpt 系のモデルでも答えさせて、違いを並べる",
      minutesAgo: 8,
    },
  ],
};

export function isThreadRunning(threadId: string): boolean {
  return running.has(threadId);
}

export function getPendingReplies(threadId: string): readonly PendingReply[] {
  return pending[threadId] ?? [];
}
