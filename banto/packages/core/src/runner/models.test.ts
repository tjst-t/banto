import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog, modelIdentityOf, toChoices } from "./models.js";

const INFO = [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low", "ultra", "high"] }];

test("一覧は少しのあいだ覚え、過ぎたら聞き直す。知らない effort の段は落とす", async () => {
  let now = 0;
  let asked = 0;
  const catalog = new ModelCatalog(async () => {
    asked += 1;
    return INFO as never;
  }, () => now);
  assert.deepEqual((await catalog.list())[0]!.efforts, ["low", "high"]);
  await catalog.list();
  assert.equal(asked, 1);
  now += 11 * 60 * 1000;
  await catalog.list();
  assert.equal(asked, 2);
});

test("失敗は覚えない——直ったら、次は取れる", async () => {
  let fail = true;
  const catalog = new ModelCatalog(async () => {
    if (fail) throw new Error("CLI が起きない");
    return INFO as never;
  });
  await assert.rejects(() => catalog.list(), /CLI が起きない/);
  fail = false;
  assert.equal((await catalog.list()).length, 1);
});

// CLI の実際の返り値（実測・2026-09-23）を縮めたもの
const REAL = toChoices([
  { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ["low"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
  { value: "odd", displayName: "Odd", description: "説明に区切りが無い" },
] as never);

test("AI に伝える名前と ID：既定のままでも実際のモデルを言う。名前は説明の「·」より前", () => {
  assert.deepEqual(modelIdentityOf(REAL, undefined), { name: "Opus 5 with 1M context", id: "claude-opus-5[1m]" });
  assert.deepEqual(modelIdentityOf(REAL, "sonnet"), { name: "Sonnet 5", id: "claude-sonnet-5" });
  // 区切りが無ければ displayName、別名の行き先が無ければ値そのもの
  assert.deepEqual(modelIdentityOf(REAL, "odd"), { name: "Odd", id: "odd" });
  // 一覧に無いものは言わない（推して名乗らせない）
  assert.equal(modelIdentityOf(REAL, "gpt-5"), undefined);
});

