import { test } from "node:test";
import assert from "node:assert/strict";
import { describeJournal } from "./describe.js";
import type { StepRecord } from "./journal.js";

const at = "2026-10-07T00:00:00.000Z";
const step = (n: number, key: string, end?: StepRecord["end"], launched?: StepRecord["launched"]): StepRecord => ({
  n, key, startedAt: at, ...(end ? { end } : {}), ...(launched ? { launched } : {}),
});
const ok = (value: unknown) => ({ ok: true as const, value, at });

test("段の記録を人が読む文にする——段の印は行にせず、後ろの行の段になる", () => {
  const lines = describeJournal(
    [
      step(1, "stage:始める", ok("始める")),
      step(2, "backlog:in-progress", ok(true)),
      step(3, "worktree", ok(".worktrees/factory-a")),
      step(4, "stage:実装", ok("実装")),
      step(5, "agent:implementer", ok({ text: "", sessionId: "s" })),
      step(6, "commits-ahead", ok(1)),
      step(7, "stage:テスト", ok("テスト")),
      step(8, "test", ok({ ok: false, code: 1, tail: "" })),
      step(9, "ask", ok({ action: "continue", instruction: "直して" })),
      step(10, "stage:レビュー", ok("レビュー")),
      step(11, "agent:reviewer", ok({ structured: { verdict: "changes", items: [{}, {}] } })),
      step(12, "agent:implementer", undefined, { replyId: "rid_1" }),
    ],
    at,
    "factory/a",
    "main",
  );
  assert.deepEqual(
    lines.map((l) => [l.stage, l.kind, l.text]),
    [
      ["始める", "backlog", "Backlog を「進めている」に"],
      ["始める", "git", "worktree を作った（factory/a）"],
      ["実装", "agent", "実装役が終えた"],
      ["テスト", "test-fail", "テストが落ちた（終了コード 1）"],
      ["テスト", "ask", "止まって、頼んだ会話に知らせた"],
      ["テスト", "answer", "答え：指示を足して続ける——直して"],
      ["レビュー", "review-changes", "レビュー：直すことが 2 つ——実装役へ戻した"],
      ["レビュー", "running", "実装役に頼んで、返事を待っている"],
    ],
  );
});
