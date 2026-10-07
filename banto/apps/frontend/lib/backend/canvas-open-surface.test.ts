// Canvas から別の面を開く口：押した直後だけ・同じ Project の中だけ・無いものは断り、移る先の URL を返す
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideOpenSurface, parseOpenSurfaceParams, runOpenSurface, type OpenSurfaceTarget } from "./canvas-open-surface.ts";
import { serializeViewState } from "./canvas-view-state.ts";

const launchers = [
  { server: "subagent", resourceUri: "ui://banto-subagent/runs" },
  { server: "fs", resourceUri: "ui://fs/a" },
  { server: "fs", resourceUri: "ui://fs/b" },
];
const threads: Record<string, { projectId: string; parentThreadId: string | null; status: "open" | "closed"; title: string }> = {
  base: { projectId: "p1", parentThreadId: null, status: "open", title: "Base" },
  f1: { projectId: "p1", parentThreadId: "base", status: "open", title: "Fork 1" },
  f2: { projectId: "p1", parentThreadId: "base", status: "closed", title: "Fork 2" },
  other: { projectId: "p2", parentThreadId: null, status: "open", title: "別の Project" },
};
const decide = (target: OpenSurfaceTarget, over: { activated?: boolean; projectId?: string | null } = {}) =>
  decideOpenSurface({
    target,
    projectId: over.projectId === null ? undefined : (over.projectId ?? "p1"),
    activated: over.activated ?? true,
    launchers,
    settings: [{ server: "factory" }],
    getThread: (id) => threads[id],
    here: { pathname: "/p/p1", search: "?canvas=factory%3Aui%3A%2F%2Fbanto-factory%2Fruns" },
    serializeSelect: serializeViewState,
  });
const errorOf = (r: { href: string } | { error: string }) => ("error" in r ? r.error : `移った：${r.href}`);

test("params：3つの先だけ受け、形の違うものは理由を返す", () => {
  assert.deepEqual(parseOpenSurfaceParams({ surface: "launcher", server: "subagent", select: { runId: "r1" } }, "factory"), { surface: "launcher", server: "subagent", select: { runId: "r1" } });
  assert.deepEqual(parseOpenSurfaceParams({ surface: "settings", server: "factory", select: 1 }, "factory"), { surface: "settings", server: "factory" });
  assert.deepEqual(parseOpenSurfaceParams({ surface: "thread", threadId: "f1" }, "factory"), { surface: "thread", threadId: "f1" });
  // 設定の節は、名前を省けば頼んできた Module 自身
  assert.deepEqual(parseOpenSurfaceParams({ surface: "settings" }, "factory"), { surface: "settings", server: "factory" });
  assert.ok("error" in parseOpenSurfaceParams({ surface: "launcher", server: "../x" }, "factory"));
  assert.ok("error" in parseOpenSurfaceParams({ surface: "launcher", server: "fs", resourceUri: "https://x" }, "factory"));
  assert.ok("error" in parseOpenSurfaceParams({ surface: "thread", threadId: "a/b" }, "factory"));
  assert.ok("error" in parseOpenSurfaceParams({ surface: "project" }, "factory"));
});

test("入口の画面：その Project の入口だけ。選ぶものは見ている場所として URL に載る", () => {
  assert.deepEqual(decide({ surface: "launcher", server: "subagent", select: { runId: "r1" } }), {
    href: `/p/p1?canvas=${encodeURIComponent("subagent:ui://banto-subagent/runs")}&canvasView=${encodeURIComponent('{"runId":"r1"}')}`,
  });
  assert.deepEqual(decide({ surface: "launcher", server: "fs", resourceUri: "ui://fs/b" }), { href: `/p/p1?canvas=${encodeURIComponent("fs:ui://fs/b")}` });
  assert.match(errorOf(decide({ surface: "launcher", server: "fs" })), /入口の画面が 2 つあります/);
  assert.match(errorOf(decide({ surface: "launcher", server: "fs", resourceUri: "ui://fs/c" })), /ui:\/\/fs\/c という入口の画面はありません/);
  assert.match(errorOf(decide({ surface: "launcher", server: "nope" })), /「nope」の入口の画面はこの Project にありません/);
  assert.match(errorOf(decide({ surface: "launcher", server: "subagent", select: "x".repeat(3000) })), /select が大きすぎる/);
});

test("設定の節・Thread：無い節・別の Project の Thread・畳んだ Fork は断る", () => {
  // いまの画面（Factory の入口）の上に重ねる——閉じると戻る
  assert.deepEqual(decide({ surface: "settings", server: "factory" }), {
    href: `/p/p1?canvas=${encodeURIComponent("factory:ui://banto-factory/runs")}&settings=1&project=p1&section=${encodeURIComponent("project-module:factory")}`,
  });
  assert.match(errorOf(decide({ surface: "settings", server: "subagent" })), /設定に節を持っていません/);
  assert.deepEqual(decide({ surface: "thread", threadId: "base" }), { href: "/p/p1" });
  assert.deepEqual(decide({ surface: "thread", threadId: "f1" }), { href: "/p/p1?fork=f1" });
  assert.match(errorOf(decide({ surface: "thread", threadId: "f2" })), /畳んだ Fork です/);
  assert.match(errorOf(decide({ surface: "thread", threadId: "other" })), /この Project にありません/);
});

test("押した直後でなければ・Project の外の画面からは断る。移っている間の頼みは断る", async () => {
  assert.equal(errorOf(decide({ surface: "settings", server: "factory" }, { activated: false })), "別の画面を開くのは、人が画面を押した直後だけです");
  assert.match(errorOf(decide({ surface: "settings", server: "factory" }, { projectId: null })), /Project の中で開かれていない/);
  let release!: () => void;
  const first = runOpenSurface(() => new Promise<string>((resolve) => (release = () => resolve("移った"))));
  assert.deepEqual(await runOpenSurface(async () => "2回目"), { error: "別の画面へ移っているところです" });
  release();
  assert.equal(await first, "移った");
  assert.equal(await runOpenSurface(async () => "次"), "次");
});
