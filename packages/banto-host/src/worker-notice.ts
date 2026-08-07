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

/** スレッド宛の起動元名の区切り。 */
const ORIGIN_SEPARATOR = ":";

/**
 * スレッド宛の起動元名（決定35a）。
 *
 * 職人の報告は**起こしたスレッド**へ返る必要がある。決定29 の `origin` はもともと
 * 「起動元＝報告の宛先」なので、そこをスレッド粒度にするだけで機構はそのまま使える
 * ——Worker Pool 側の改修は要らない。
 */
export function threadOrigin(threadId: string): string {
  return `${BANTO_ORIGIN}${ORIGIN_SEPARATOR}${threadId}`;
}

/**
 * 起動元名からスレッドを引く。番頭が起こしたものでなければ undefined。
 *
 * `banto`（スレッド以前の名乗り）は既定スレッド宛として扱う——過去に起こした職人の
 * 報告が宛先不明で消えないようにするため。Kobo 等、別の起動元の分は拾わない。
 */
export function threadIdOfOrigin(origin: string): string | undefined {
  if (origin === BANTO_ORIGIN) return undefined;
  const prefix = `${BANTO_ORIGIN}${ORIGIN_SEPARATOR}`;
  return origin.startsWith(prefix) ? origin.slice(prefix.length) : undefined;
}

/** 番頭が起こした職人か（他の起動元＝Kobo 等の分は番頭の会話に入れない）。 */
export function isBantoOrigin(origin: string): boolean {
  return origin === BANTO_ORIGIN || origin.startsWith(`${BANTO_ORIGIN}${ORIGIN_SEPARATOR}`);
}

/**
 * 番頭に知らせるイベントかどうか。
 *
 * 起動・停止・回答は**番頭自身がやったこと**なので知らせない。知らせると、番頭の操作が
 * そのまま番頭への入力に戻り、ターンが際限なく回る。番頭が知りたいのは
 * 「自分が起こしていないこと」——職人が言ってきたことと、プロセスが終わったこと。
 *
 * **畳んだこと（`worker_closed`）は知らせない**（PO裁定 2026-08-06）。職人が1人終わるたびに
 * 「畳みました」と「プロセスが終わりました」の2通が並んで届いていた——同じ出来事を2度
 * 読ませている。プロセスが終わったことは `worker_exited` で届くので、番頭が取り落とすものは無い。
 *
 * 決定30b（安全弁が働いたことに気づけるように）は**イベントログ側で保つ**——`reason` は
 * 今までどおり記録され、`worker.list` / `worker.events` と職人ビューアから引ける（決定30e）。
 * 会話へ押し込まないだけで、見えなくはしない。
 */
export function isNoticeworthy(event: WorkerEvent): boolean {
  return (
    event.type === "worker_reported" ||
    event.type === "worker_asked" ||
    event.type === "worker_exited"
  );
}

/** 1行目に出す見出し。UI は畳んだ状態でここだけを見せるので、短く・中身が分かるように。 */
function headline(event: WorkerEvent): string {
  // UI 側は「職人」の札を別に出すので、ここでは繰り返さない（畳んだ1行は狭い）
  const who = event.taskId;
  switch (event.type) {
    case "worker_asked":
      return `${who}から質問：${firstLine(String(event.data["question"] ?? ""))}`;
    case "worker_reported":
      // 自動報告は職人が書いたものではない。見出しで区別する（I1：出所を偽らない）
      return event.data["auto"] === true
        ? `${who}が報告せずに手を止めました：${firstLine(String(event.data["summary"] ?? ""))}`
        : `${who}から報告：${firstLine(String(event.data["summary"] ?? ""))}`;
    default: {
      const signal = event.data["signal"];
      const code = event.data["exitCode"];
      const how =
        signal !== null && signal !== undefined
          ? `シグナル ${String(signal)} で落ちました`
          : code === 0
            ? "正常に終了しました"
            : `終了コード ${String(code)} で終わりました`;
      return `${who}のプロセスが${how}`;
    }
  }
}

/**
 * 見出し用に1行へ潰す。Markdownの記号は畳んだ表示では邪魔になる。
 *
 * 見出し行（`## 完了報告` 等）は中身を語らないので、本文があればそちらを優先する
 * ——「完了報告」とだけ出ても、何が起きたか分からない。
 */
function firstLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const clean = (l: string): string => l.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
  const body = lines.find((l) => !l.startsWith("#"));
  return clean(body ?? lines[0] ?? "") || "(内容なし)";
}

/**
 * イベントを番頭への知らせに言い換える。知らせないイベントなら undefined。
 *
 * **1行目が見出し**で、以降が詳細。UI は畳んだ状態で1行目だけを見せるため、
 * sessionId のような機械向けの情報は下に置く——畳んだときに中身が見えなくなる。
 */
export function renderWorkerNotice(event: WorkerEvent): string | undefined {
  if (!isNoticeworthy(event)) return undefined;
  const lines = [headline(event), "", `sessionId: ${event.sessionId}`];

  if (event.type === "worker_asked") {
    lines.push(
      "",
      `> ${String(event.data["question"] ?? "")}`,
      "",
      "答えが来るまでこの職人は待っています。答えられるなら worker.steer で返してください。" +
        "不可逆な選択や PO の意向が要る話（D1）なら、あなたの判断で PO に上げてください。"
    );
  } else if (event.type === "worker_reported") {
    lines.push("", `> ${String(event.data["summary"] ?? "")}`, "");
    lines.push(
      event.data["auto"] === true
        ? "**これは職人が書いた報告ではありません。** 報告しないまま手を止めたので、" +
            "最後の発話を安全弁が代わりに送っています——作業が本当に終わったのかも含めて" +
            "自分で確かめてください（I1）。続きが要るなら worker.steer、良ければ worker.close。"
        : "**これは職人の主張であって完了の証明ではありません**——必要なら成果を自分で確かめてください（I1）。" +
            "確かめて良ければ worker.close で畳んでください。"
    );
  }

  return lines.join("\n");
}
