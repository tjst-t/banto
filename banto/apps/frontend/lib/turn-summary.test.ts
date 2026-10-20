// まとめの url を押せるリンクにしてよいか（追加・2026-10-15、v4-frontend.md §6.41・§6.35）
import { test } from "node:test";
import assert from "node:assert/strict";
import { knownPlaceUrl, safeLinkUrl } from "./turn-summary.ts";

test("押せるリンクにするのは http/https の URL だけ", () => {
  assert.equal(safeLinkUrl("https://mock.example.net/p/a?x=1"), "https://mock.example.net/p/a?x=1");
  assert.equal(safeLinkUrl("http://localhost:3000/"), "http://localhost:3000/");
  assert.equal(safeLinkUrl("javascript:alert(1)"), undefined);
  assert.equal(safeLinkUrl("/p/banto"), undefined);
  assert.equal(safeLinkUrl("file:///etc/passwd"), undefined);
  assert.equal(safeLinkUrl(undefined), undefined);
  assert.equal(safeLinkUrl(42), undefined);
});

// 読むだけの回が書いた URL（追加・2026-10-20、アーキ仕様 §4.4）
test("読むだけの回の URL は、banto が知っている場所だけリンクにし、クエリと # 以降を落とす", () => {
  const places = { bantoOrigin: "https://banto.example.net", projectId: "p1", githubRepos: ["Owner/Repo"] };
  assert.equal(knownPlaceUrl("https://banto.example.net/p/p1?fork=f1#x", places), "https://banto.example.net/p/p1");
  assert.equal(knownPlaceUrl("https://banto.example.net/p/p1/t/abc?q=1", places), "https://banto.example.net/p/p1/t/abc");
  assert.equal(knownPlaceUrl("https://github.com/owner/repo/pull/3?secret=x#y", places), "https://github.com/owner/repo/pull/3");
  // ほかの Project・ほかのリポジトリ・外の場所は文字のまま
  assert.equal(knownPlaceUrl("https://banto.example.net/p/p2", places), undefined);
  assert.equal(knownPlaceUrl("https://banto.example.net/p/p10", places), undefined);
  assert.equal(knownPlaceUrl("https://github.com/owner/other/issues/1", places), undefined);
  assert.equal(knownPlaceUrl("https://evil.example.com/?leak=abc", places), undefined);
  assert.equal(knownPlaceUrl("https://user:pw@banto.example.net/p/p1", places), undefined);
  assert.equal(knownPlaceUrl("javascript:alert(1)", places), undefined);
  assert.equal(knownPlaceUrl(undefined, places), undefined);
  // リポジトリが分からなければ GitHub もリンクにしない
  assert.equal(knownPlaceUrl("https://github.com/owner/repo", { bantoOrigin: "https://banto.example.net", projectId: "p1" }), undefined);
});
