/**
 * 職人のイベントを番頭の会話へ写す（ADR-0010 決定29d）。
 *
 * Worker Pool は中立な事実と主張を並べるだけで、**意味は起動元が与える**。これは番頭側の
 * 解釈——Kobo は同じイベントを自分のステートマシンへ写す（task-0024）。だからこの翻訳は
 * Worker Pool ではなく banto-host に置く。
 *
 * D5: 判断は無い。何を番頭に見せるかの選別と、日本語への言い換えだけ。
 * I1: 職人の報告は**主張**として渡す。「終わったと言っている」を「終わった」に翻訳しない。
 */

import type { WorkerEvent } from "@banto/worker-pool";

/** 番頭が起動元として名乗る名前（決定29の宛先）。 */
export const BANTO_ORIGIN = "banto";

/**
 * 番頭に知らせるイベントかどうか。
 *
 * 起動・停止・回答は**番頭自身がやったこと**なので知らせない。知らせると、番頭の操作が
 * そのまま番頭への入力に戻り、ターンが際限なく回る。番頭が知りたいのは
 * 「自分が起こしていないこと」——職人が言ってきたことと、プロセスが終わったこと。
 */
export function isNoticeworthy(event: WorkerEvent): boolean {
  return (
    event.type === "worker_reported" ||
    event.type === "worker_asked" ||
    event.type === "worker_exited"
  );
}

/** イベントを番頭への知らせに言い換える。知らせないイベントなら undefined。 */
export function renderWorkerNotice(event: WorkerEvent): string | undefined {
  if (!isNoticeworthy(event)) return undefined;
  const who = `職人「${event.taskId}」(sessionId: ${event.sessionId})`;

  if (event.type === "worker_asked") {
    return [
      `${who} から質問が届きました。答えが来るまでこの職人は待っています。`,
      "",
      `> ${String(event.data["question"] ?? "")}`,
      "",
      "答えられるなら worker.steer で返してください。" +
        "不可逆な選択や PO の意向が要る話（D1）なら、あなたの判断で PO に上げてください。",
    ].join("\n");
  }

  if (event.type === "worker_reported") {
    return [
      `${who} から報告が届きました。**これは職人の主張であって完了の証明ではありません**` +
        "——必要なら成果を自分で確かめてください（I1）。",
      "",
      `> ${String(event.data["summary"] ?? "")}`,
    ].join("\n");
  }

  const code = event.data["exitCode"];
  const signal = event.data["signal"];
  const how =
    signal !== null && signal !== undefined
      ? `シグナル ${String(signal)} で落ちました`
      : code === 0
        ? "正常に終了しました"
        : `終了コード ${String(code)} で終わりました`;
  return `${who} のプロセスが${how}。`;
}
