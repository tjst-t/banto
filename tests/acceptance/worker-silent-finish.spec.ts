/**
 * 報告せずに手を止める職人を拾う安全弁（PO報告・2026-07-31）。
 *
 * **プロンプトでは解けなかった。** 職人には「作業が終わったら報告してください」が
 * 二重に書かれている（`WORKER_SYSTEM_PROMPT` と `WORKER_REPORT_PROMPT`）のに、
 * 報告せずに手を止めることがある。文面を足しても同じなので機構で拾う（P4：同種の失敗が
 * 繰り返されるならプロンプト層ではなく機構化）。
 *
 * 拡張は職人プロセスの中で動くので、ここでは pi のやりとり（messages）を模した入力に対して
 * 判定と抽出が正しいかを見る。拡張が本物の pi に載ること自体は
 * `worker-web-tools.spec.ts` と同じ経路で別途確かめている。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  calledToolNames,
  endedWithoutReporting,
  lastAssistantText,
} from "../../packages/banto-worker-pool/src/pi-extension/worker-report.js";
import { isNoticeworthy, renderWorkerNotice } from "@banto/host";
import type { WorkerEvent } from "@banto/worker-pool";

/** pi のメッセージ列を組み立てる小道具。 */
const assistant = (...texts: string[]) => ({
  role: "assistant",
  content: texts.map((text) => ({ type: "text", text })),
});
const toolResult = (toolName: string) => ({ role: "toolResult", toolName, content: [] });
const user = (text: string) => ({ role: "user", content: text });

describe("[silent-finish] 黙って終えたかどうかの判定", () => {
  it("[silent-finish] 報告も質問もせずにターンが終わったら拾う", () => {
    const messages = [user("READMEを直して"), assistant("直しました。")];
    assert.equal(endedWithoutReporting(messages), true);
  });

  it("[silent-finish] 報告していれば拾わない", () => {
    const messages = [
      user("READMEを直して"),
      assistant("直します"),
      toolResult("worker__report"),
      assistant("報告しました"),
    ];
    assert.equal(endedWithoutReporting(messages), false);
  });

  it("[silent-finish] 質問して待っているなら拾わない（黙って終えたのではない）", () => {
    // 番頭には既に質問が届いており、職人は答え待ちで止まっているだけ。
    // ここで報告を重ねると、待ちの職人の分だけ番頭の会話が二重に埋まる
    const messages = [user("直して"), toolResult("worker__ask"), assistant("答えを待ちます")];
    assert.equal(endedWithoutReporting(messages), false);
  });

  it("[silent-finish] 他の Tool をいくら使っても報告の代わりにはならない", () => {
    const messages = [
      user("調べて"),
      toolResult("read"),
      toolResult("grep"),
      toolResult("bash"),
      assistant("調べ終わりました"),
    ];
    assert.equal(endedWithoutReporting(messages), true);
  });

  it("[silent-finish] 数えるのは実行まで至った Tool（toolResult）だけ", () => {
    // 呼ぼうとして失敗したものを「報告した」に数えない（I2）
    const attemptedButNoResult = [
      user("直して"),
      { role: "assistant", content: [{ type: "toolCall", name: "worker__report" }] },
    ];
    assert.deepEqual([...calledToolNames(attemptedButNoResult)], []);
    assert.equal(endedWithoutReporting(attemptedButNoResult), true);
  });
});

describe("[silent-finish] 代わりに送る中身", () => {
  it("[silent-finish] 最後の発話を要約に使う", () => {
    const messages = [
      user("直して"),
      assistant("まず読みます"),
      toolResult("read"),
      assistant("README を直しました。", "テストは動かしていません。"),
    ];
    assert.equal(
      lastAssistantText(messages),
      "README を直しました。\nテストは動かしていません。"
    );
  });

  it("[silent-finish] 発話が無ければ空（呼び出し側が言い換える）", () => {
    assert.equal(lastAssistantText([user("直して"), toolResult("bash")]), "");
    assert.equal(lastAssistantText([]), "");
  });

  it("[silent-finish] 中身の無い assistant は飛ばして、その前の発話を採る", () => {
    const messages = [assistant("直しました"), { role: "assistant", content: [] }];
    assert.equal(lastAssistantText(messages), "直しました");
  });
});

describe("[silent-finish] 番頭にどう見えるか（出所を偽らない・I1）", () => {
  const reported = (data: Record<string, unknown>): WorkerEvent =>
    ({
      id: 1,
      at: "2026-07-31T00:00:00.000Z",
      type: "worker_reported",
      kind: "claim",
      origin: "banto",
      projectTag: "test",
      taskId: "task-0042",
      sessionId: "s-1",
      data,
    }) as WorkerEvent;

  it("[silent-finish] 自動報告は「職人が書いた報告」として見せない", () => {
    const notice = renderWorkerNotice(reported({ summary: "直しました", auto: true }))!;

    assert.match(notice.split("\n")[0]!, /報告せずに手を止めました/, "見出しで区別する");
    assert.match(notice, /これは職人が書いた報告ではありません/);
    assert.doesNotMatch(notice, /職人の主張であって完了の証明ではありません/);
  });

  it("[silent-finish] 職人が自分で出した報告はこれまで通り", () => {
    const notice = renderWorkerNotice(reported({ summary: "直しました", done: true }))!;

    assert.match(notice.split("\n")[0]!, /から報告：/);
    assert.match(notice, /職人の主張であって完了の証明ではありません/);
    assert.doesNotMatch(notice, /職人が書いた報告ではありません/);
  });
});

/**
 * **ターンの終わりに、番頭の判断が要るのはどのときか**（PO指摘 2026-08-11）。
 *
 * 「毎ターン知らせるとうるさい」で切り捨てていたが、それは雑だった。ターンの終わり方は
 * 4つあり、3つは既に何かが番頭へ届いている——抜けていたのは**進捗だけ報告して手を止めた**
 * とき。番頭は「着手しました」を読んで work in progress と思うが、職人は止まっている。
 */
describe("[PO指摘 2026-08-11] 手が空いたことを、伝わっていないときだけ知らせる", () => {
  const turnEnded = (data: Record<string, unknown>): WorkerEvent =>
    ({
      id: 9,
      at: "2026-08-11T00:00:00.000Z",
      type: "worker_turn_ended",
      kind: "fact",
      origin: "banto",
      projectTag: "test",
      taskId: "task-0042",
      sessionId: "s-1",
      data,
    }) as WorkerEvent;

  it("進捗だけ報告して止まったら知らせる（番頭は動いていると思っている）", () => {
    const event = turnEnded({ text: "着手しました", reported: true, settled: false });
    assert.equal(isNoticeworthy(event), true);

    const notice = renderWorkerNotice(event)!;
    assert.match(notice.split("\n")[0]!, /手が空きました/u);
    assert.match(notice, /着手しました/u, "最後の発話が手がかりとして出る");
    assert.match(notice, /worker\.steer/u, "続けるか畳むかを決められるように書く（D8）");
    assert.match(notice, /worker\.close/u);
  });

  it("完了を報告済み・質問して待ち・黙って終えた（代理報告済み）は知らせない", () => {
    // どれも**そのターンで既に何かが番頭へ届いている**——二重に読ませない
    assert.equal(isNoticeworthy(turnEnded({ settled: true, reported: true })), false);
    assert.equal(
      isNoticeworthy(turnEnded({ settled: true, waiting: true, reported: true })),
      false
    );
  });

  it("発話が無くても知らせる（何も言わずに止まったことが分かる）", () => {
    const notice = renderWorkerNotice(turnEnded({ reported: true, settled: false }))!;
    assert.match(notice.split("\n")[0]!, /発話なし/u);
  });
});

/**
 * **自分で畳んだ職人の「終わりました」は要らない**（PO要望 2026-08-11）。
 *
 * `worker.close` は kill してから畳むので `worker_exited` が必ず先に積まれる。番頭から
 * 見ると「自分で畳んだのに、そのあとプロセス終了を知らされる」——実測で 356人中 315人が
 * この形だった。**起動・停止は番頭自身がやったことなので知らせない**という元からの決めに
 * 揃える。予期していない死だけを残す（作業中に落ちたのは番頭がやっていないことなので）。
 */
describe("[PO要望 2026-08-11] 畳んだ結果の終了は知らせない", () => {
  const exited = (data: Record<string, unknown>): WorkerEvent =>
    ({
      id: 7,
      at: "2026-08-11T00:00:00.000Z",
      type: "worker_exited",
      kind: "fact",
      origin: "banto",
      projectTag: "test",
      taskId: "task-0042",
      sessionId: "s-1",
      data,
    }) as WorkerEvent;

  it("番頭が畳んだ結果の終了は知らせない（自分でやったこと）", () => {
    assert.equal(isNoticeworthy(exited({ exitCode: 0, signal: null, expected: true })), false);
    assert.equal(renderWorkerNotice(exited({ exitCode: 0, signal: null, expected: true })), undefined);
  });

  it("予期していない死は今までどおり知らせる（気づけなくなる）", () => {
    const notice = renderWorkerNotice(exited({ exitCode: null, signal: "SIGKILL" }))!;
    assert.match(notice.split("\n")[0]!, /シグナル SIGKILL で落ちました/u);
  });
});
