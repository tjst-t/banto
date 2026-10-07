// 段の記録を、人が読む「何が起きたか」に書き直す（画面の詳細・v4-modules.md §4.5「人の画面」）。
// 記録の鍵（`journal.ts`）は機械のためのもの——ここで1行ずつ文にする。段（`stage:<名前>`）の印は行にせず、
// 後ろの行の「どの段か」に使う。

import type { StepRecord } from "./journal.js";

export interface ItemCounts {
  /** 落ちたテストの回数 */
  testFails: number;
  /** 直すことがあったレビューの回数 */
  reviewChanges: number;
}

export type JournalKind =
  | "backlog"
  | "git"
  | "agent"
  | "test-ok"
  | "test-fail"
  | "review-pass"
  | "review-changes"
  | "ask"
  | "answer"
  | "fail"
  | "running";

export interface JournalLineForPeople {
  at: string;
  stage: string;
  kind: JournalKind;
  text: string;
}

const ROLE: Record<string, string> = { "agent:implementer": "実装役", "agent:reviewer": "レビュー役" };

function answerText(v: Record<string, unknown>): string {
  switch (v.action) {
    case "continue":
      return typeof v.instruction === "string" && v.instruction.trim() ? `答え：指示を足して続ける——${v.instruction}` : "答え：このまま続ける";
    case "accept":
      return "答え：指摘を承知で取り込む";
    case "retry":
      return `答え：${typeof v.stage === "string" ? `${v.stage}から` : "いまの段から"}やり直す`;
    case "drop":
      return `答え：やめる${typeof v.reason === "string" && v.reason ? `——${v.reason}` : ""}`;
    default:
      return "答えた";
  }
}

export function describeJournal(steps: StepRecord[], _runCreatedAt: string, branch: string, target: string): JournalLineForPeople[] {
  const out: JournalLineForPeople[] = [];
  let stage = "始める";
  const push = (at: string, kind: JournalKind, text: string) => out.push({ at, stage, kind, text });
  for (const s of steps) {
    if (s.key.startsWith("stage:")) {
      stage = s.key.slice("stage:".length);
      continue;
    }
    const end = s.end;
    const v = end?.ok ? ((end.value ?? {}) as Record<string, unknown>) : undefined;
    const at = end?.at ?? s.startedAt;
    if (end && !end.ok) {
      const what = ROLE[s.key] ?? (s.key === "test" ? "テスト" : s.key === "prepare" ? "準備のコマンド" : s.key);
      push(at, "fail", `${what}で失敗：${end.error.slice(0, 300)}`);
      continue;
    }
    switch (s.key) {
      case "backlog:in-progress":
        push(at, "backlog", "Backlog を「進めている」に");
        break;
      case "backlog:done":
        push(at, "backlog", "Backlog を「終わった」に");
        break;
      case "worktree":
        push(at, "git", `worktree を作った（${branch}）`);
        break;
      case "prepare":
        push(at, "git", "準備のコマンドを走らせた");
        break;
      case "agent:implementer":
      case "agent:reviewer": {
        const role = ROLE[s.key]!;
        if (!end) {
          push(s.startedAt, "running", s.launched ? `${role}に頼んで、返事を待っている` : `${role}に頼んでいる`);
          break;
        }
        const verdict = (v?.structured as { verdict?: string; items?: unknown[] } | undefined)?.verdict;
        if (s.key === "agent:reviewer" && verdict === "pass") push(at, "review-pass", "レビュー：このまま取り込んでよい");
        else if (s.key === "agent:reviewer" && verdict === "changes") {
          const n = ((v?.structured as { items?: unknown[] }).items ?? []).length;
          push(at, "review-changes", `レビュー：直すことが ${n} つ——実装役へ戻した`);
        } else push(at, "agent", `${role}が終えた`);
        break;
      }
      case "commits-ahead":
        if (end && Number(v) === 0) push(at, "fail", "コミットが無かった——実装役へ戻した");
        break;
      case "test":
        if (!end) push(s.startedAt, "running", "テストを走らせている");
        else if (v?.ok) push(at, "test-ok", "テストが通った");
        else push(at, "test-fail", `テストが落ちた（終了コード ${String(v?.code)}）`);
        break;
      case "ask":
        push(s.startedAt, "ask", "止まって、頼んだ会話に知らせた");
        if (end && v) push(at, "answer", answerText(v));
        break;
      case "rebase":
        if (end) push(at, v?.ok ? "git" : "fail", v?.ok ? `${target} に rebase した` : `${target} に rebase できなかった（競合）`);
        break;
      case "fast-forward":
        if (end) push(at, v?.ok ? "git" : "fail", v?.ok ? `${target} に取り込んだ` : `${target} に取り込めなかった`);
        break;
      case "rebase-leftover":
        if (end && v?.aborted) push(at, "fail", "実装役が rebase を途中で残した——畳んだ");
        break;
      case "cleanup":
        push(at, "git", "worktree とブランチを消した");
        break;
    }
  }
  return out;
}
