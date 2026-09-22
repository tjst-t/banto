import assert from "node:assert/strict";
import { test } from "node:test";
import { brandLabel, displayLabel, provenanceOf, rankEntries } from "./rank.js";
import type { RegistryEntry } from "./server-json.js";

function entry(name: string, status = "active", title?: string): RegistryEntry {
  return {
    server: { name, description: "", version: "1.0.0", title },
    status,
    isLatest: true,
  };
}

test("名前空間から、ドメインの登録名を取り出す", () => {
  assert.equal(brandLabel("com.stripe/mcp"), "stripe");
  assert.equal(brandLabel("com.googleapis.bigtableadmin/mcp"), "googleapis");
  assert.equal(brandLabel("io.github.codespar/mcp-stripe"), "github");
  assert.equal(brandLabel("ai.smithery/smithery-notion"), "smithery");
});

test("そのドメインの持ち主が出しているものを「ベンダー」と見る", () => {
  // 実データ（2026-09-21）：Stripe の公式は `com.stripe/mcp`
  assert.equal(provenanceOf(entry("com.stripe/mcp"), "stripe"), "vendor");
  assert.equal(provenanceOf(entry("com.notion/mcp"), "notion"), "vendor");
});

test("GitHub アカウントの確認だけのものを、ベンダーと呼ばない", () => {
  // `io.github.*` は「その GitHub アカウントの持ち主」しか保証していない
  assert.equal(provenanceOf(entry("io.github.codespar/mcp-stripe"), "stripe"), "github-account");
});

test("再梱包しているだけのドメインを、その製品のベンダーと呼ばない", () => {
  // `ai.smithery` は smithery.ai の持ち主であって、Notion の持ち主ではない
  assert.equal(provenanceOf(entry("ai.smithery/smithery-notion"), "notion"), "third-party-domain");
  assert.equal(provenanceOf(entry("com.mcparmory/notion"), "notion"), "third-party-domain");
});

test("「google」で `com.googleapis.*` を拾う（前方一致を認める理由）", () => {
  assert.equal(provenanceOf(entry("com.googleapis.firestore/mcp"), "google"), "vendor");
});

test("短い語では前方一致を認めない——無関係なものが公式の顔で上に出ないように", () => {
  // "no" で `com.notion` を拾ってしまうと、検索するたびに別物が先頭に来る
  assert.equal(provenanceOf(entry("com.notion/mcp"), "no"), "third-party-domain");
});

// **検索していないときに代用しようとして、やめた**（2026-09-21）。
// 「自分のブランドで出しているか」で代用したら、**実データの先頭12件が全部
// 「提供元」になった**（`ac.snag/snag`・`ai.aard/aard`…公開者はたいてい自分の
// ブランドで出す）。常に点く札は何も教えないうえ、並びは実際には名前順なので
// **優先が効いているように見えるだけ**になる（規則13）。
test("検索していないときは、誰も提供元を名乗らない", () => {
  assert.equal(provenanceOf(entry("com.stripe/mcp", "active", "Stripe"), ""), "third-party-domain");
  assert.equal(provenanceOf(entry("ac.snag/snag", "active", "Snag"), ""), "third-party-domain");
});

test("検索中は「自分のブランドか」を足さない——再梱包が提供元の顔をしないように", () => {
  // `ai.smithery/smithery-notion` は Smithery 自身のものではあるが、
  // 「notion」で探している人にとっての提供元は Notion であって Smithery ではない
  assert.equal(provenanceOf(entry("ai.smithery/smithery-notion"), "notion"), "third-party-domain");
});

test("公式が先、次に確認済みドメイン、最後に GitHub アカウント", () => {
  const ranked = rankEntries(
    [
      entry("io.github.codespar/mcp-stripe"),
      entry("eu.nordicmcp/stripe"),
      entry("com.stripe/mcp"),
      entry("io.github.rafaelcg/stripekit"),
    ],
    "stripe",
  );
  assert.deepEqual(
    ranked.map((e) => e.server.name),
    [
      "com.stripe/mcp",
      "eu.nordicmcp/stripe",
      "io.github.codespar/mcp-stripe",
      "io.github.rafaelcg/stripekit",
    ],
  );
});

test("使えないもの（deprecated）は、公式であっても下へ置く——消しはしない", () => {
  const ranked = rankEntries(
    [entry("com.stripe/mcp", "deprecated"), entry("io.github.someone/stripe-mcp")],
    "stripe",
  );
  assert.deepEqual(
    ranked.map((e) => e.server.name),
    ["io.github.someone/stripe-mcp", "com.stripe/mcp"],
  );
});

test("同点の並びは決まっている——実行のたびに入れ替わらない", () => {
  const names = ["io.github.b/x", "io.github.a/x", "io.github.c/x"];
  const once = rankEntries(names.map((n) => entry(n)), "x").map((e) => e.server.name);
  const twice = rankEntries([...names].reverse().map((n) => entry(n)), "x").map((e) => e.server.name);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, ["io.github.a/x", "io.github.b/x", "io.github.c/x"]);
});

test("元の配列を書き換えない", () => {
  const input = [entry("io.github.z/x"), entry("com.x/mcp")];
  const before = input.map((e) => e.server.name);
  rankEntries(input, "x");
  assert.deepEqual(input.map((e) => e.server.name), before);
});

// **一覧の見出し**（追加・2026-09-21、実ブラウザで発覚）。`title` は任意で、
// **公式ほど書いていない**——実データの `com.stripe/mcp` には無く、見出しが
// 「mcp」になっていた。人が最初に読むところなので、製品名になっている必要がある。
test("題が無く、名前が「mcp」のような語なら、ドメイン名を見出しにする", () => {
  assert.equal(displayLabel({ name: "com.stripe/mcp" }), "stripe");
  assert.equal(displayLabel({ name: "com.notion/mcp" }), "notion");
  assert.equal(displayLabel({ name: "com.googleapis.firestore/mcp" }), "googleapis");
});

test("題が在れば、それをそのまま使う", () => {
  assert.equal(displayLabel({ name: "eu.nordicmcp/stripe", title: "NordicMCP — Stripe" }), "NordicMCP — Stripe");
});

test("名前が中身を言っているなら、そのまま使う（作り話をしない）", () => {
  assert.equal(displayLabel({ name: "io.github.codespar/mcp-stripe" }), "mcp-stripe");
});
