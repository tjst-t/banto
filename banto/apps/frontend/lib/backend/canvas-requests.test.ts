// Canvas から banto の確かめを開かせる頼み（Project を閉じる）と、Module の画面が返す「用意したフォルダ」の読み方
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeProjectsRequests, parseCloseProjectsParams } from "./canvas-close-projects.ts";
import { DECLINE_COOLDOWN_MS } from "./canvas-requests.ts";
import { parseFolderPrepared } from "./canvas-folder-prepared.ts";

test("Project を閉じる頼み：id の並びだけ受け、開く場所が無い・開いている間・会話の中で押した直後でないものは断る", () => {
  assert.deepEqual(parseCloseProjectsParams({ projectIds: ["p1", "p1", "p-2"] }), { projectIds: ["p1", "p-2"] });
  assert.deepEqual(parseCloseProjectsParams({ projectIds: [] }), { error: "projectIds が要ります" });
  assert.ok("error" in parseCloseProjectsParams({ projectIds: ["../x"] }));
  assert.ok("error" in parseCloseProjectsParams({ projectIds: Array.from({ length: 21 }, (_, i) => `p${i}`) }));

  assert.match((closeProjectsRequests.decide({ fromConversation: false, activated: true }) as { error: string }).error, /開けません/);
  const off = closeProjectsRequests.registerHost();
  assert.deepEqual(closeProjectsRequests.decide({ fromConversation: false, activated: false }), { ok: true });
  assert.deepEqual(closeProjectsRequests.decide({ fromConversation: true, activated: false }), { error: "会話の中の画面からは、人が押した直後にだけ開けます" });
  closeProjectsRequests.request({ projectIds: ["p1"], from: "repositories" });
  assert.deepEqual(closeProjectsRequests.decide({ fromConversation: false, activated: true }), { error: "Project を閉じる確かめは、もう開いています" });
  assert.equal(closeProjectsRequests.get()!.from, "repositories");
  closeProjectsRequests.clear();
  off();
});

test("用意したフォルダ：/ から始まるパスと1行の説明だけ受ける", () => {
  assert.deepEqual(parseFolderPrepared({ path: "/home/u/banto/x", summary: " clone しました ", suggestedName: " x " }), {
    path: "/home/u/banto/x",
    summary: "clone しました",
    suggestedName: "x",
  });
  assert.ok("error" in parseFolderPrepared({ path: "~/x", summary: "s" }));
  assert.ok("error" in parseFolderPrepared({ path: "/x", summary: "" }));
  assert.ok("error" in parseFolderPrepared({ path: "/x", summary: "s", suggestedName: 3 }));
});

test("人が断ったら、同じ画面からは 30 秒受けない（ほかの画面・済んだあとは縛らない）", () => {
  const off = closeProjectsRequests.registerHost();
  const t0 = 1_000_000;
  closeProjectsRequests.request({ projectIds: ["p1"], from: "repositories" });
  closeProjectsRequests.decline(t0);
  assert.equal(closeProjectsRequests.get(), null);
  assert.match(
    (closeProjectsRequests.decide({ fromConversation: false, activated: true, from: "repositories", now: t0 + 1000 }) as { error: string }).error,
    /さきほど人が閉じました/,
  );
  assert.deepEqual(closeProjectsRequests.decide({ fromConversation: false, activated: true, from: "other", now: t0 + 1000 }), { ok: true });
  assert.deepEqual(
    closeProjectsRequests.decide({ fromConversation: false, activated: true, from: "repositories", now: t0 + DECLINE_COOLDOWN_MS }),
    { ok: true },
  );
  // 済んだ（閉じた）ものは縛らない
  closeProjectsRequests.request({ projectIds: ["p1"], from: "fresh" });
  closeProjectsRequests.clear();
  assert.deepEqual(closeProjectsRequests.decide({ fromConversation: false, activated: false, from: "fresh" }), { ok: true });
  off();
});

test("用意したフォルダのパスを揃える：// と /./ を畳み、末尾の / を外し、.. は断る", () => {
  assert.equal((parseFolderPrepared({ path: "/home//u/./banto/x/", summary: "s" }) as { path: string }).path, "/home/u/banto/x");
  assert.equal((parseFolderPrepared({ path: "/", summary: "s" }) as { path: string }).path, "/");
  assert.match((parseFolderPrepared({ path: "/home/u/banto/../..", summary: "s" }) as { error: string }).error, /\.\. は使えません/);
});
