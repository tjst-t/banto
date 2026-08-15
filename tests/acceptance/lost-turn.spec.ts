/**
 * **失われたターンの判定**（`lost-turn.ts` の純関数。inc: thread-104）。
 *
 * 実際に起きた形は「`thread.open` の seed を渡した1秒後にホストが SIGKILL で落ちた」で、
 * 会話には**知らせの行だけ**が残り、番頭のターンは1本も回らなかった。既にある2つの回収
 * （`resumeInterruptedTurn`＝最後が toolResult ／ `resumeAfterRestart`＝`system.restart` を
 * 自分で呼んだ会話）は、どちらもこの形を拾えない。
 *
 * ここで見るのは**境目**だけ——プロセスもハーネスも要らない。配線（畳んだ会話を外す・
 * 二重に起こさない）は `branch-seed-turn.spec.ts` で見る。
 *
 * imp-0061 で**道具で終わっている会話**を足した。番頭が `system.restart` を自分で撃った
 * thread-105 は、記録が `道具 system.restart（ok）` で止まったまま黙り続けた——
 * `settleInterrupted` は `state:"running"` を探すが、`restart-tool.ts` は結果を返してから
 * 落ちるので `ok` で残る。ここの判定も末尾の `tool` を「番頭が動いた証拠」に数えていた。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findLostTurn,
  INTERRUPTED_TOOL_PREFIX,
  LOST_TURN_PREFIX,
  RESTART_RESUME_NOTICE,
  type TranscriptEntry,
} from "@banto/host";

/** 外から入った一言（`thread.open` の seed・`thread.steer`・他の幹からの言伝）。 */
function seed(text: string): TranscriptEntry {
  return { role: "notice", source: "thread", text };
}

describe("[inc] 失われたターンの判定", () => {
  it("知らせで終わっていれば、そのターンは失われている", () => {
    const lost = findLostTurn([seed("起票の置き場を設計してください")]);
    assert.equal(lost?.original, "起票の置き場を設計してください");
    // 投げ直す文には断りが付く（番頭は自分が落ちたことを知らない）
    assert.ok(lost?.message.startsWith(LOST_TURN_PREFIX));
    assert.match(lost.message, /起票の置き場を設計してください/u);
  });

  it("PO の発話で終わっていても拾う", () => {
    assert.equal(findLostTurn([{ role: "po", text: "よろしく！" }])?.original, "よろしく！");
  });

  it("職人・工房・検証環境の知らせも拾う", () => {
    for (const source of ["worker", "kobo", "env"]) {
      const lost = findLostTurn([{ role: "notice", source, text: `${source} からの報告` }]);
      assert.equal(lost?.original, `${source} からの報告`, `${source} が拾えていません`);
    }
  });

  it("枝からの相談は、道具が組み立てていた形で投げ直す", () => {
    const lost = findLostTurn([
      {
        role: "branch_note",
        branchId: "thread-42",
        title: "計測の枝",
        kind: "question",
        text: "前提だった計測が無い",
        at: "2026-08-15T00:00:00.000Z",
      },
    ]);
    // 札の本文をそのまま投げると「どの枝からの何なのか」が落ちる
    assert.match(lost?.original ?? "", /枝「計測の枝」からの問いです/u);
    assert.match(lost?.original ?? "", /前提だった計測が無い/u);
    assert.match(lost?.original ?? "", /thread-42/u);
  });

  // ── 道具で終わっている会話（imp-0061）──

  it("自分で撃った再起動で終わっていれば、再起動用の文で起こし直す", () => {
    // 実際に起きた形（thread-105）。`restart-tool.ts` は結果を返してから落ちるので、
    // 記録は **ok** で残る——`settleInterrupted` が探す running はもう発生しない
    const lost = findLostTurn([
      seed("反映してください"),
      { role: "banto", text: "再起動します" },
      { role: "tool", name: "system.restart", state: "ok" },
    ]);
    assert.equal(lost?.kind, "restart");
    // 意図した中断なので、他の回収とは文言を分ける（番頭は自分が撃った再起動を知っている）
    assert.equal(lost?.message, RESTART_RESUME_NOTICE);
    assert.equal(lost?.notice, RESTART_RESUME_NOTICE);
  });

  it("普通の道具で終わっていれば、中断されたものとして起こし直す（ok・failed・running）", () => {
    for (const state of ["ok", "failed", "running"] as const) {
      const lost = findLostTurn([
        seed("調べてください"),
        { role: "tool", name: "worker.delegate", state },
      ]);
      assert.equal(lost?.kind, "tool", `state:${state} を拾えていません`);
      assert.ok(lost?.message.startsWith(INTERRUPTED_TOOL_PREFIX), `state:${state} の文が違います`);
      // どの道具で切れたのかが番頭に見える（やり直すかどうかの判断材料）
      assert.match(lost.message, /worker\.delegate/u);
      // 再起動用の文とは分ける
      assert.notEqual(lost.message, RESTART_RESUME_NOTICE);
    }
  });

  it("器（canvas.show）で終わっていても同じ扱い", () => {
    const lost = findLostTurn([
      seed("一覧を出して"),
      {
        role: "utsuwa",
        utsuwa: {
          kind: "facts",
          title: "職人の一覧",
          at: "2026-08-15T00:00:00.000Z",
          from: { module: "worker", tool: "worker.list", artifact: "a-0001" },
          facts: [["名", "値"]],
        },
      },
    ]);
    assert.equal(lost?.kind, "tool");
    assert.ok(lost?.message.startsWith(INTERRUPTED_TOOL_PREFIX));
    // 器に載せた道具の名が名指しできる（決定81(d) の `from`）
    assert.equal(lost.original, "worker.list");
  });

  it("道具のあとに印だけ積まれていても、道具で終わっているものとして拾う", () => {
    // `settleInterrupted` が足した知らせ・章の区切りは読み飛ばす
    const lost = findLostTurn([
      seed("反映してください"),
      { role: "tool", name: "system.restart", state: "ok" },
      { role: "notice", source: "system", text: "再起動が完了しました。中断した続きを進めてください。" },
    ]);
    assert.equal(lost?.kind, "restart");
  });

  // ── ここから「拾わない」側 ──

  it("番頭が何か返していれば拾わない", () => {
    for (const answered of [
      { role: "banto", text: "承知しました" },
      { role: "reasoning", text: "考え中" },
      { role: "error", text: "落ちました" },
      { role: "branch", branchId: "thread-9" },
    ] satisfies TranscriptEntry[]) {
      assert.equal(
        findLostTurn([seed("調べてください"), answered]),
        undefined,
        `${answered.role} のあとで拾ってしまっています`
      );
    }
  });

  it("道具のあとに番頭が答えていれば拾わない（普通に終わったターン）", () => {
    assert.equal(
      findLostTurn([
        seed("調べてください"),
        { role: "tool", name: "file.read", state: "ok" },
        { role: "banto", text: "読みました" },
      ]),
      undefined
    );
  });

  it("記録が空なら拾わない（開いただけの会話）", () => {
    assert.equal(findLostTurn([]), undefined);
  });

  it("ホスト自身の書き置き（system の知らせ）では起こさない", () => {
    // 章を畳んでいる断り・開き直しの印・`thread.open_trunk` の理由など
    assert.equal(
      findLostTurn([{ role: "notice", source: "system", text: "この幹を起こしました。理由：…" }]),
      undefined
    );
  });

  it("章の区切りと回収の印は読み飛ばす（その手前の一言を拾い直せる）", () => {
    const lost = findLostTurn([
      seed("設計してください"),
      { role: "notice", source: "system", text: "前回の再起動で…起こし直します" },
      { role: "chapter", chapter: 2, topic: "設計", at: "2026-08-15T00:00:00.000Z" },
    ]);
    assert.equal(lost?.original, "設計してください");
  });

  it("答えたあとに印が積まれただけなら、やはり拾わない", () => {
    assert.equal(
      findLostTurn([
        seed("設計してください"),
        { role: "banto", text: "こうしましょう" },
        { role: "chapter", chapter: 2, topic: "設計", at: "2026-08-15T00:00:00.000Z" },
      ]),
      undefined
    );
  });
});
