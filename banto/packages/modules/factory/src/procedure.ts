// **同梱の手順：Backlog のタスクを1件運ぶ**（v4-modules.md §4.5「1件を運ぶ」）。
//
// Factory が必ず守るもの（Backlog・worktree・マージの列と取り込む直前のテスト）は `engine.ts` が持つ。ここは worktree が
// できてから「マージを頼む」までの段だけ——実装 → テストの関門（落ちたら実装役の同じ会話へ戻す）→ レビュー（別の
// サブエージェント・まっさらな文脈・完了条件で判定。直すことがあれば実装役へ戻す）。上限を越えたら止まって人に聞く。
//
// **決まった順に段を呼ぶ**（流し直しで再開するため）：今の時刻・乱数を使わない。分かれ道はどれも記録した段の結果で決まる。

import type { Procedure, ProcedureContext, TaskSnapshot } from "./engine.js";

export const REVIEW_SCHEMA = {
  type: "object",
  required: ["verdict", "items"],
  properties: {
    verdict: { enum: ["pass", "changes"] },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["what", "why"],
        properties: { what: { type: "string" }, where: { type: "string" }, why: { type: "string" } },
      },
    },
  },
} as const;

interface ReviewVerdict {
  verdict: "pass" | "changes";
  items: Array<{ what: string; where?: string; why: string }>;
}

function taskText(task: TaskSnapshot): string {
  return [
    `## タスク${task.number !== null ? ` #${task.number}` : ""}（${task.id}）：${task.title}`,
    task.body.trim() || "（本文はありません）",
    "## 完了条件",
    task.doneWhen.trim() || "（書かれていません——題と本文から判断してください）",
    ...(task.parent ? [`## 親のストーリー（${task.parent.id}）：${task.parent.title}`, task.parent.body.trim()] : []),
  ].join("\n\n");
}

export function implementPrompt(ctx: ProcedureContext): string {
  const s = ctx.settings;
  return [
    `あなたは Backlog のタスクを1件実装する担当です。作業場所はこのフォルダ（git の worktree、ブランチ ${ctx.branch}）です。`,
    taskText(ctx.task),
    "## 決まり",
    [
      `- このフォルダの中だけで作業する。${s.targetBranch} ブランチやほかのフォルダは触らない。push しない`,
      "- 変更はコミットして終える（git add・git commit）。コミットが無いと終わったことになりません",
      `- テストのコマンド：\`${s.testCommand}\`。終える前に通しておく（通らなければ Factory が戻します）`,
      "- 終わったら、何をしたかを短く書く",
    ].join("\n"),
  ].join("\n\n");
}

export function reviewPrompt(ctx: ProcedureContext): string {
  const target = ctx.settings.targetBranch;
  return [
    "あなたはレビュー役です。別の担当が Backlog のタスクを実装しました。このフォルダ（git の worktree）の変更を確かめ、" +
      "完了条件を満たしているか、取り込んでよいかを判定してください。**ファイルを書き換えない・コミットしない**でください。",
    taskText(ctx.task),
    "## 変更の見方",
    `\`git log --oneline ${target}..HEAD\` と \`git diff ${target}...HEAD\` で見られます。テストは別に通っています。`,
    "## 判定",
    "verdict は pass（このまま取り込んでよい）か changes（直すことがある）。changes のときは items に直すこと" +
      "（what：何を・where：どこ（ファイルや関数）・why：なぜ）を書く。好みの違いだけなら pass にする。",
  ].join("\n\n");
}

/** 同梱の手順 */
export const deliverTask: Procedure = async (ctx) => {
  const limits = ctx.settings.limits;
  await ctx.stage("実装");
  let session = (await ctx.agent("implementer", { prompt: implementPrompt(ctx) })).sessionId;
  let noCommit = 0;
  let testFails = 0;
  let reviews = 0;
  /** 実装役の同じ会話に続きを頼む */
  const followUp = async (prompt: string) => {
    await ctx.stage("実装");
    session = (await ctx.agent("implementer", { prompt, sessionId: session })).sessionId || session;
  };

  for (;;) {
    // コミットがあるか
    if ((await ctx.commitsAhead()) === 0) {
      noCommit++;
      if (noCommit > limits.noCommitRetries) {
        const { instruction } = await ctx.ask(`実装役が ${noCommit} 回続けてコミットを残しませんでした`);
        noCommit = 0;
        await followUp(instruction ? `人からの指示：${instruction}` : "まだコミットがありません。変更をコミットしてください。");
        continue;
      }
      await followUp(`まだコミットがありません（${ctx.settings.targetBranch} より先のコミットが 0 件）。変更をコミットして終えてください。`);
      continue;
    }

    // テストの関門
    await ctx.stage("テスト");
    const t = await ctx.test();
    if (!t.ok) {
      testFails++;
      if (testFails > limits.testRetries) {
        const { instruction } = await ctx.ask(
          `テストが ${testFails} 回続けて落ちました（終了コード ${t.code}）。出力の末尾：\n${t.tail.slice(-1500)}`,
        );
        testFails = 0;
        await followUp(
          `${instruction ? `人からの指示：${instruction}\n\n` : ""}テスト（\`${ctx.settings.testCommand}\`）が落ちています。直してコミットしてください。`,
        );
        continue;
      }
      await followUp(
        `テスト（\`${ctx.settings.testCommand}\`）が落ちました（終了コード ${t.code}）。出力の末尾：\n\`\`\`\n${t.tail.slice(-4000)}\n\`\`\`\n直してコミットしてください。`,
      );
      continue;
    }
    testFails = 0;

    // レビュー（別のサブエージェント・まっさらな文脈）
    await ctx.stage("レビュー");
    const r = await ctx.agent("reviewer", { prompt: reviewPrompt(ctx), schema: REVIEW_SCHEMA as unknown as Record<string, unknown> });
    const verdict = r.structured as ReviewVerdict;
    if (verdict.verdict === "pass") return;
    reviews++;
    const list = verdict.items.map((i) => `- ${i.what}${i.where ? `（${i.where}）` : ""}：${i.why}`).join("\n");
    if (reviews > limits.reviewRounds) {
      const { instruction, accept } = await ctx.ask(`レビューで ${reviews} 回続けて直すことを指摘されました：\n${list}`);
      reviews = 0;
      if (accept) return; // 人が「このまま取り込む」と答えた
      await followUp(`${instruction ? `人からの指示：${instruction}\n\n` : ""}レビューの指摘：\n${list}\n直してコミットしてください。`);
      continue;
    }
    await followUp(`レビューで直すことを指摘されました：\n${list}\n直してコミットしてください。`);
  }
};
