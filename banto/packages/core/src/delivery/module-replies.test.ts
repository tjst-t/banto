import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleReplyArguments } from "@banto/module-contract";
import { ModuleReplies } from "./module-replies.js";

async function withDir(fn: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-module-replies-"));
  try {
    await fn(join(dir, "delivery", "module-replies.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const args = (over: Partial<ModuleReplyArguments> = {}): ModuleReplyArguments => ({
  replyId: "rid_1", from: "subagent", title: "終わりました", text: "{}", final: true, lost: false, ...over,
});

test("届いたら残してから受け口に渡す——渡せなければ残し、次に繋がったときに順に渡す", async () => {
  await withDir(async (file) => {
    const handed: Array<[string, string]> = [];
    let up = false;
    const hand = async (to: string, a: ModuleReplyArguments) => {
      if (!up) throw new Error("繋がっていない");
      handed.push([to, a.title]);
      return "handed" as const;
    };
    const r = await ModuleReplies.open({ file, hand });
    await r.deliver({ toConn: "factory-p1", args: args({ title: "1通目", final: false }) });
    await r.deliver({ toConn: "factory-p1", args: args({ title: "2通目" }) });
    await r.handPending("factory-p1");
    assert.deepEqual(handed, []);
    assert.equal(r.pending().length, 2);
    // 起こし直しても残っている
    const reopened = await ModuleReplies.open({ file, hand });
    assert.deepEqual(reopened.pending().map((p) => p.args.title), ["1通目", "2通目"]);
    up = true;
    await reopened.handPending("factory-p1");
    assert.deepEqual(handed, [["factory-p1", "1通目"], ["factory-p1", "2通目"]]);
    assert.equal(reopened.pending().length, 0);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { pending: unknown[] };
    assert.equal(onDisk.pending.length, 0, "渡したのにファイルに残っている");
  });
});

test("頼んだ先が止まったら・起こし直したら、返事待ちは「途中で終わりました」（lost）になって呼んだ Module に渡る", async () => {
  await withDir(async (file) => {
    const handed: ModuleReplyArguments[] = [];
    const r = await ModuleReplies.open({ file, hand: async (_to, a) => (handed.push(a), "handed") });
    const base = { toConn: "factory-p1", toModule: "factory", fromModule: "subagent" };
    await r.recordAwaiting({ ...base, replyTo: "reply_a", replyId: "rid_a", fromConn: "subagent-p1" });
    await r.recordAwaiting({ ...base, replyTo: "reply_b", replyId: "rid_b", fromConn: "subagent-p2" });
    assert.equal(await r.loseFrom("subagent-p1", "頼んだ先の Module が止まったため"), 1);
    await r.handPending("factory-p1");
    assert.equal(handed.length, 1);
    assert.equal(handed[0]!.replyId, "rid_a");
    assert.equal(handed[0]!.lost, true);
    assert.equal(handed[0]!.final, true);
    assert.match(handed[0]!.text, /止まったため/);
    // 起こし直した：残りの返事待ちも全部
    const reopened = await ModuleReplies.open({ file, hand: async (_to, a) => (handed.push(a), "handed") });
    assert.equal(reopened.awaiting().length, 1);
    assert.equal(await reopened.loseAll("banto を起動し直したため"), 1);
    await reopened.handPending("factory-p1");
    assert.equal(handed.at(-1)!.replyId, "rid_b");
    assert.equal(reopened.awaiting().length, 0);
  });
});

test("最後の1通が届けば返事待ちは済む——後から止まっても「途中で終わりました」は出ない", async () => {
  await withDir(async (file) => {
    const handed: ModuleReplyArguments[] = [];
    const r = await ModuleReplies.open({ file, hand: async (_to, a) => (handed.push(a), "handed") });
    await r.recordAwaiting({ replyTo: "reply_a", replyId: "rid_a", toConn: "f", toModule: "factory", fromConn: "s", fromModule: "subagent" });
    await r.deliver({ toConn: "f", replyTo: "reply_a", args: args({ replyId: "rid_a" }) });
    assert.equal(await r.loseFrom("s", "止まった"), 0);
    await r.handPending("f");
    assert.equal(handed.filter((a) => a.lost).length, 0);
  });
});

test("受け口が断ったものは捨てる（何度渡しても同じ）——後ろのものは渡る", async () => {
  await withDir(async (file) => {
    const handed: string[] = [];
    const r = await ModuleReplies.open({
      file,
      hand: async (_to, a) => (a.title === "壊れた" ? "refused" : (handed.push(a.title), "handed")),
    });
    await r.deliver({ toConn: "f", args: args({ title: "壊れた" }) });
    await r.deliver({ toConn: "f", args: args({ title: "ふつう" }) });
    await r.handPending("f");
    assert.deepEqual(handed, ["ふつう"]);
    assert.equal(r.pending().length, 0);
  });
});

test("読めない置き場は横に退けて空から始める（黙って上書きしない）", async () => {
  await withDir(async (file) => {
    await ModuleReplies.open({ file, hand: async () => "handed" }).then((r) => r.deliver({ toConn: "x", args: args() }).catch(() => undefined));
    await writeFile(file, "{壊れた");
    const r = await ModuleReplies.open({ file, hand: async () => "handed" });
    assert.equal(r.pending().length, 0);
  });
});
