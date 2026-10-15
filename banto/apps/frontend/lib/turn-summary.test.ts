// まとめの url を押せるリンクにしてよいか（追加・2026-10-15、v4-frontend.md §6.41・§6.35）
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeLinkUrl } from "./turn-summary.ts";

test("押せるリンクにするのは http/https の URL だけ", () => {
  assert.equal(safeLinkUrl("https://mock.example.net/p/a?x=1"), "https://mock.example.net/p/a?x=1");
  assert.equal(safeLinkUrl("http://localhost:3000/"), "http://localhost:3000/");
  assert.equal(safeLinkUrl("javascript:alert(1)"), undefined);
  assert.equal(safeLinkUrl("/p/banto"), undefined);
  assert.equal(safeLinkUrl("file:///etc/passwd"), undefined);
  assert.equal(safeLinkUrl(undefined), undefined);
  assert.equal(safeLinkUrl(42), undefined);
});
