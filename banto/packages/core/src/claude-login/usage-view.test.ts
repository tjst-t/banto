import { test } from "node:test";
import assert from "node:assert/strict";
import { describeClaudeUsage } from "./usage-view.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const LATER = "2026-10-22T00:00:00Z";

function store(order: string[]) {
  const accounts = [
    { id: "host", kind: "host" as const, label: "~/.claude", subscriptionType: "max", rateLimitTier: "default_claude_max_20x", addedAt: "x", usage: { readAt: "x", fiveHour: { utilization: 0.1, resetsAt: LATER }, sevenDay: { utilization: 0.97, resetsAt: LATER } } },
    { id: "b", kind: "banto" as const, label: "b@example.com", subscriptionType: "max", rateLimitTier: "default_claude_max_5x", addedAt: "x", usage: { readAt: "x", fiveHour: { utilization: 0.18, resetsAt: LATER }, sevenDay: { utilization: 0.37, resetsAt: LATER } } },
    { id: "c", kind: "banto" as const, label: "c@example.com", addedAt: "x" },
    { id: "d", kind: "banto" as const, label: "d@example.com（並びに無い）", addedAt: "x" },
  ];
  return {
    list: () => accounts,
    orderFor: () => order,
    thresholds: () => ({ fiveHour: 0.95, sevenDay: 0.95 }),
    modeFor: () => "balance" as const,
  };
}

test("claude_usage：その Project の並びの全部のアカウント（並びに無いものは出さない）・閾値越え・この会話のもの・要約", () => {
  const text = describeClaudeUsage({ store: store(["host", "b", "c"]), pinnedOfThread: () => "host", now: () => NOW }, "p1", "t1");
  const v = JSON.parse(text);
  assert.deepEqual(v.accounts.map((a: { name: string }) => a.name), ["このマシンの Claude Code のログイン", "b@example.com", "c@example.com"]);
  const [host, b, c] = v.accounts;
  assert.equal(host.usable, false);
  assert.match(host.why, /週の使用率が閾値を越えています/);
  assert.equal(host.thisConversation, true);
  assert.equal(host.plan, "Max 20x");
  assert.deepEqual(b.fiveHour, { percent: 18, resetsAt: LATER });
  assert.equal(b.usable, true);
  assert.equal(c.fiveHour, null);
  assert.equal(c.usable, true);
  assert.deepEqual(v.thresholdsPercent, { fiveHour: 95, sevenDay: 95 });
  // いまの会話のアカウントが越えていても、ほかで続けられることを先頭の要約で言う
  assert.match(v.summary, /3 個のうち 2 個/);
  assert.match(v.summary, /次のアカウントに移して続けます/);
  assert.match(v.summary, /一番余裕があるのは「c@example.com」/);
  assert.doesNotMatch(text, /headroom/);
});

test("claude_usage：全部が閾値を越えていればそう言う。並びが空ならそう言う", () => {
  const over = store(["host"]);
  assert.match(JSON.parse(describeClaudeUsage({ store: over, now: () => NOW }, "p1", "t1")).summary, /どれも閾値を越えています/);
  assert.match(JSON.parse(describeClaudeUsage({ store: store([]), now: () => NOW }, "p1", "t1")).summary, /アカウントがありません/);
});
