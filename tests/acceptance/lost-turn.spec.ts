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
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findLostTurn, LOST_TURN_PREFIX, type TranscriptEntry } from "@banto/host";

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

  // ── ここから「拾わない」側 ──

  it("番頭が何か返していれば拾わない", () => {
    for (const answered of [
      { role: "banto", text: "承知しました" },
      { role: "reasoning", text: "考え中" },
      { role: "tool", name: "file.read", state: "ok" },
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

  it("道具の途中で落ちた形は拾わない（そちらは resumeInterruptedTurn の担当）", () => {
    assert.equal(
      findLostTurn([seed("調べてください"), { role: "tool", name: "file.read", state: "running" }]),
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
