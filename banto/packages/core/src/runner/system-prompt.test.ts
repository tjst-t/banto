// docs/specs/v4-architecture.md §2.3 の決定を固定する試験。
// 「claude_code プリセットを使わない」「層の順序と境界の位置」「ターンごとに
// 変わるものを system prompt に入れない」は、どれも破ると静かに壊れる
// （キャッシュが崩れる・AIに無いtoolの説明が入る）ので、ここで押さえる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
import { buildSystemPrompt, BANTO_SYSTEM_PROMPT_CORE } from "./system-prompt.js";
import { buildTurnContext } from "./turn-context.js";

const project = { name: "demo", root: "/tmp/demo" };

test("the skeleton comes first and the dynamic boundary separates it from the Project context", () => {
  const blocks = buildSystemPrompt({ project, memory: [] });

  assert.equal(blocks[0], BANTO_SYSTEM_PROMPT_CORE);
  const boundary = blocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.ok(boundary > 0, "境界が入っている");
  // 境界より後にProjectの文脈——前は全Projectで前方一致する（§3）
  assert.ok(blocks.slice(boundary + 1).some((b) => b.includes("/tmp/demo")));
});

test("Global Memory sits before the boundary so the cache prefix is shared across Projects", () => {
  const blocks = buildSystemPrompt({
    project,
    memory: [],
    globalMemory: ["人の名前は たくみ"],
  });
  const boundary = blocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.ok(blocks.slice(0, boundary).some((b) => b.includes("たくみ")));
});

test("the skeleton does not name built-in tools (that list lives in the Runner options, 規則3)", () => {
  for (const name of ["WebSearch", "WebFetch", "Bash", "TodoWrite", "CLAUDE.md"]) {
    assert.ok(
      !BANTO_SYSTEM_PROMPT_CORE.includes(name),
      `骨格が ${name} を名指ししている——設定の写しになり、変えた瞬間に嘘になる`,
    );
  }
});

test("nothing that changes per turn leaks into the system prompt", () => {
  const blocks = buildSystemPrompt({
    project,
    memory: [{ seq: 1, text: "決まったこと", invalidated: false }],
  }).join("\n");
  // 日付・Base/Forkの別は system prompt に入れない（入れると走行中の枝の
  // 先頭が変わり、Forkが親から引き継げるキャッシュも失う、§3）
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(blocks), "日付が入っている");
  assert.ok(!blocks.includes("Fork Thread（Base Thread から分岐"), "いまいるThreadが入っている");
});

test("invalidated memory stays visible as withdrawn, not silently removed", () => {
  const blocks = buildSystemPrompt({
    project,
    memory: [{ seq: 1, text: "古い決定", invalidated: true }],
  }).join("\n");
  assert.ok(blocks.includes("古い決定"));
  assert.ok(blocks.includes("取り消し済み"));
});

test("the turn context carries the four things that change per turn", () => {
  const text = buildTurnContext({
    thread: { kind: "fork", parentThreadId: "parent" },
    pendingMemory: [
      { kind: "appended", seq: 9, text: "別の枝で決まった", changedAtSeq: 9, originThreadId: "base" },
      { kind: "invalidated", seq: 3, text: "取り消された決定", changedAtSeq: 11 },
    ],
    openJudgments: [{ message: "この操作を承認しますか" }],
    startedAt: new Date("2026-09-05T09:03:12Z"),
  });

  assert.ok(text.startsWith("<banto-turn-context>"));
  assert.ok(text.includes("このターンの開始時刻："), "「今日は〜」と断定しない書き方");
  assert.ok(text.includes("Fork Thread"));
  assert.ok(text.includes("別の枝で決まった"));
  assert.ok(text.includes("取り消された決定"));
  assert.ok(text.includes("この操作を承認しますか"));
});

test("the turn context is always present, even with nothing pending", () => {
  const text = buildTurnContext({
    thread: { kind: "base" },
    pendingMemory: [],
    openJudgments: [],
    startedAt: new Date("2026-09-05T09:03:12Z"),
  });
  assert.ok(text.includes("Base Thread"));
  assert.ok(text.includes("このターンの開始時刻："));
});

// **いま動いているモデルを AI に伝える**（決定・2026-09-24、ユーザー要望）。モデルは自分の
// 名前を知らない——書かなければ古い名前を名乗る。境界より後（Project の層）に置く：
// キャッシュはモデルごとなので、この行が変わるときはどのみち全損している。

test("動いているモデルの名前と ID は、境界より後に入る（無ければ書かない）", () => {
  const withModel = buildSystemPrompt({ project, memory: [], model: { name: "Opus 5 with 1M context", id: "claude-opus-5[1m]" } });
  const boundary = withModel.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  const at = withModel.findIndex((b) => b.includes("claude-opus-5[1m]"));
  assert.ok(at > boundary, "モデルの行が境界より前にある（全 Project で共有する前半を崩す）");
  assert.match(withModel[at]!, /あなたは Opus 5 with 1M context で動いている。モデル ID は claude-opus-5\[1m\]。/);

  const without = buildSystemPrompt({ project, memory: [] });
  assert.ok(!without.some((b) => b.includes("モデル ID")), "分からないのに書いている");
});

