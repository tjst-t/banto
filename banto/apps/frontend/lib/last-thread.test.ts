import { test } from "node:test";
import assert from "node:assert/strict";
import { lastForkOf } from "./last-thread.ts";
import { projectNavHref } from "./settings-link.ts";

test("最後に開いた Fork がまだ開いていればその id、閉じていれば・覚えていなければ Base（null）", () => {
  const store = { p1: "f1", p2: "gone", p3: null };
  assert.equal(lastForkOf(store, "p1", ["f1", "f2"]), "f1");
  assert.equal(lastForkOf(store, "p2", ["f1"]), null);
  assert.equal(lastForkOf(store, "p3", ["f1"]), null);
  assert.equal(lastForkOf(store, "p4", ["f1"]), null);
});

test("Project の名前の行き先：最後の Fork を渡せばその Fork、渡さなければ Base", () => {
  const none = new URLSearchParams();
  assert.equal(projectNavHref("p1", "/p/p0", none, "project-danger", "f1"), "/p/p1?fork=f1");
  assert.equal(projectNavHref("p1", "/p/p0", none, "project-danger"), "/p/p1");
  // 設定を開いたまま別の Project へ：設定はその Project の層、下の画面は最後の Fork
  const settings = new URLSearchParams("settings=1&project=p0&section=project-general");
  const href = projectNavHref("p1", "/p/p0", settings, "project-danger", "f1");
  const url = new URL(href, "https://x");
  assert.equal(url.pathname, "/p/p1");
  assert.equal(url.searchParams.get("fork"), "f1");
  assert.equal(url.searchParams.get("project"), "p1");
  assert.equal(url.searchParams.get("settings"), "1");
});
