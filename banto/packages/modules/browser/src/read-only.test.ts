// **読むだけの回ではブラウザを起こさない**（追加・2026-10-20、アーキ仕様 §4.4「同梱の Module に最初に付ける印」）。
// browserSnapshot・browserTabs の list は、host が読むだけの回だと刻んだ呼び出しでは `session.ensure()` を呼ばず、動いていなければ
// 「ブラウザは動いていません」を返す。browserTabs の select・close は断る。印の付いた道具は4本だけ（開く・操作する・getNetworkRequest には付けない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { BROWSER_NOT_RUNNING, TOOLS, callTool, type ToolContext } from "./tools.js";

function stubContext(): { ctx: ToolContext; ensured: number[] } {
  const ensured: number[] = [];
  const session = {
    running: false,
    touch() {},
    async ensure() {
      ensured.push(Date.now());
      throw new Error("試験：起こしてはいけない");
    },
  };
  return { ctx: { session, log: {}, state: { get: () => ({ aiBlocked: false }) } } as unknown as ToolContext, ensured };
}

const readOnly = { "dev.banto/restriction": "read-only" };
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

test("読むだけの印は browserSnapshot・browserTabs・listNetwork・browserConsole だけ", () => {
  const marked = TOOLS.filter((t) => (t._meta as Record<string, unknown>)["dev.banto/effect"] === "read").map((t) => t.name).sort();
  assert.deepEqual(marked, ["browserConsole", "browserSnapshot", "browserTabs", "listNetwork"]);
});

test("読むだけの回の browserSnapshot・browserTabs list は、動いていないブラウザを起こさない", async () => {
  const { ctx, ensured } = stubContext();
  const snap = await callTool(ctx, "browserSnapshot", {}, undefined, readOnly);
  assert.equal(textOf(snap), BROWSER_NOT_RUNNING);
  const tabs = await callTool(ctx, "browserTabs", { action: "list" }, undefined, readOnly);
  assert.equal(textOf(tabs), BROWSER_NOT_RUNNING);
  assert.equal(ensured.length, 0, "読むだけの回でブラウザを起こそうとした");
});

test("読むだけの回の browserTabs は select・close を断る。印の無い呼び出しは今までどおり起こしに行く", async () => {
  const { ctx, ensured } = stubContext();
  const refused = await callTool(ctx, "browserTabs", { action: "close", tab: "t1" }, undefined, readOnly);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /見回りの回では使えません/);
  assert.equal(ensured.length, 0);
  await assert.rejects(() => callTool(ctx, "browserSnapshot", {}, undefined, {}), /起こしてはいけない/);
  assert.equal(ensured.length, 1, "印の無い呼び出しで起こしに行っていない");
});
