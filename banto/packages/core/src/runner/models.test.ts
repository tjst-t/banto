import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalog } from "./models.js";

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
