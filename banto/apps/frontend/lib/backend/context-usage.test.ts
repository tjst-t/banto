// 残量メーターの Skill の行（決定・2026-09-23、アーキ仕様 §5.7）。
//
// MCP の `instructions` は SDK が **Messages の中の添付（`mcp_instructions_delta`）** として
// 数える（実測・2026-09-23——system prompt の値は有無で変わらなかった）。banto で
// `instructions` を載せるのは Skill だけなので、その分を Messages から切り出して1行にする。

import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_CATEGORY_ID, realContextUsageToDisplay, SKILL_CATEGORY_ID, withMemorySplit } from "./context-usage.ts";

function usage(attachments: { name: string; tokens: number }[]) {
  return {
    totalTokens: 10_000,
    rawMaxTokens: 200_000,
    categories: [
      { name: "System prompt", tokens: 2_000 },
      { name: "Messages", tokens: 8_000 },
    ],
    mcpTools: [],
    memoryFiles: [],
    messageBreakdown: { attachmentsByType: attachments },
  };
}

test("instructions の添付を Messages から切り出し、Skill の行にする（二重に数えない）", () => {
  const shown = realContextUsageToDisplay(
    usage([
      { name: "mcp_instructions_delta", tokens: 300 },
      { name: "total_tokens_reminder", tokens: 20 },
    ]),
  )!;
  const byId = new Map(shown.categories.map((c) => [c.id, c.tokens]));
  assert.equal(byId.get(SKILL_CATEGORY_ID), 300);
  assert.equal(byId.get("Messages"), 7_700);
  const content = shown.categories.filter((c) => c.kind === "content").reduce((s, c) => s + c.tokens, 0);
  assert.equal(content, 10_000, "切り出したぶん合計が変わった");
});

test("instructions の添付が無ければ Skill の行は出さない", () => {
  const shown = realContextUsageToDisplay(usage([{ name: "total_tokens_reminder", tokens: 20 }]))!;
  assert.equal(
    shown.categories.some((c) => c.id === SKILL_CATEGORY_ID),
    false,
  );
  assert.equal(shown.categories.find((c) => c.id === "Messages")?.tokens, 8_000);
});

// **Memory の分を System prompt から切り出す**（2026-10-20、ユーザー要望。v4-frontend.md §6.50）——core が返す節ごとの
// 文字数で SDK の値を按分する。合計は変えない（System prompt から引いた分が Memory になる）
test("withMemorySplit carves Memory out of the system prompt by character share", () => {
  const base = {
    windowTokens: 100_000,
    categories: [
      { id: "System prompt", label: "System prompt", tokens: 10_000, kind: "content" as const },
      { id: "Messages", label: "Messages", tokens: 5_000, kind: "content" as const },
    ],
    deferred: [],
  };
  const out = withMemorySplit(base, {
    parts: [
      { kind: "core", chars: 2_000 },
      { kind: "global-memory", chars: 1_000 },
      { kind: "project-memory", chars: 6_000 },
      { kind: "instruction", chars: 1_000 },
    ],
    totalChars: 10_000,
    projectMemoryLines: 42,
  });
  const memory = out.categories.find((c) => c.id === MEMORY_CATEGORY_ID)!;
  assert.equal(memory.tokens, 8_000);
  assert.deepEqual(memory.items, [
    { name: "Project Memory（42 行）", tokens: 6_000 },
    { name: "Global Memory", tokens: 1_000 },
    { name: "この Project の AI への指示", tokens: 1_000 },
  ]);
  assert.equal(out.categories.find((c) => c.id === "System prompt")!.tokens, 2_000);
  assert.equal(out.categories.reduce((n, c) => n + c.tokens, 0), 15_000, "合計は変わらない");
  // 按分の材料が無ければそのまま
  assert.deepEqual(withMemorySplit(base, null), base);
});
