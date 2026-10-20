import { test } from "node:test";
import assert from "node:assert/strict";
import { includesBrNetfilter, parseModuleNames, sameModuleNames } from "./virtualization.ts";

// 決定・2026-10-20（v4-security.md §1「`containers` で仮想化（KVM）」の 2.）：名前は空白で区切り、`[a-z0-9_-]+`
test("parseModuleNames：空白（改行・続けた空白も）で分け、形の違うものを分ける", () => {
  assert.deepEqual(parseModuleNames("  kvm_intel\tbr-netfilter\n 8021q "), { names: ["kvm_intel", "br-netfilter", "8021q"], invalid: [] });
  assert.deepEqual(parseModuleNames(""), { names: [], invalid: [] });
  assert.deepEqual(parseModuleNames("vxlan Bridge ../x a;b"), { names: ["vxlan"], invalid: ["Bridge", "../x", "a;b"] });
});

test("includesBrNetfilter：`-` と `_` を同じに見る", () => {
  assert.equal(includesBrNetfilter(["vxlan", "br-netfilter"]), true);
  assert.equal(includesBrNetfilter(["br_netfilter"]), true);
  assert.equal(includesBrNetfilter(["bridge", "netfilter"]), false);
});

test("sameModuleNames：順・重なり・`-` と `_` の違いは同じ", () => {
  assert.equal(sameModuleNames(["a-b", "c"], ["c", "a_b", "c"]), true);
  assert.equal(sameModuleNames(["a"], ["a", "b"]), false);
});
