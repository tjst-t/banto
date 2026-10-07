// Factory の Module の口を、host を起こし直したときの形で通す（v4-modules.md §4.5「起こし直し」・アーキ仕様 §2.5「2.」）。
// 本物の git、偽の中継（Subagent・Backlog・Thread への届け）。「起こし直し」は同じ置き場で2本目のサーバを作ること
// ——1本目の札（メモリにだけ持つ）は失われ、host に問われて覚え直す。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { REPLY_TO_META_KEY, RESUME_AFTER_RESTART_TOOL, THREAD_META_KEY } from "@banto/module-contract";
import type { Factory, RelayResult } from "./engine.js";
import { createFactoryServer } from "./server.js";
import { writeSettings, type FactorySettings } from "./settings.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const THREAD = { projectId: "p1", threadId: "t1" };

/**
 * 偽の中継。実装役は worktree にコミットし、`holdImplementer` の間は返事を渡さない（host が落ちて届かなかった）。
 * レビュー役はすぐ pass を返す。返事は**いま動いているサーバ**の受け口に渡す
 */
function setup(settings: Partial<FactorySettings> = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-server-"));
  const project = join(root, "project");
  const data = join(root, "data");
  execFileSync("mkdir", ["-p", project]);
  git(project, "init", "-q", "-b", "main");
  writeFileSync(join(project, "README"), "x\n");
  git(project, "add", ".");
  git(project, "commit", "-q", "-m", "init");
  writeSettings(data, { testCommand: "test -f done.txt", implementer: { agent: "fake" }, reviewer: { agent: "fake" }, ...settings });
  const delivered: Array<{ replyTo: string; title: string; text: string; final: boolean }> = [];
  const held: Array<{ replyId: string; body: unknown }> = [];
  const state = { current: undefined as Factory | undefined, holdImplementer: true, implements: 0, seq: 0, failDeliveries: 0 };
  const hand = (replyId: string, body: unknown) =>
    setTimeout(() => state.current!.receiveReply({ replyId, from: "subagent", title: "終わりました", text: JSON.stringify(body), final: true, lost: false }), 5);
  const relay = async (name: string, args: Record<string, unknown>): Promise<RelayResult> => {
    if (name === "relayListTargets") {
      return { text: JSON.stringify([{ name: "subagent-p1", roles: ["subagent"] }, { name: "backlog-p1", roles: ["backlog"] }]), isError: false };
    }
    if (name === "relayDeliverToThread") {
      // host が落ちて届かなかった知らせ
      if (state.failDeliveries > 0) {
        state.failDeliveries--;
        return { text: "届けられません", isError: true };
      }
      delivered.push({ replyTo: String(args.replyTo), title: String(args.title), text: String(args.text), final: args.final === true });
      return { text: "ok", isError: false };
    }
    const tool = String(args.name);
    const a = args.arguments as Record<string, unknown>;
    if (tool === "getItem") {
      return {
        text: "",
        isError: false,
        structured: { item: { id: String(a.id), number: null, kind: "task", title: "題", status: "ready", body: "", doneWhen: "", parent: null }, waitingOn: [] },
      };
    }
    if (tool === "updateItem") return { text: "ok", isError: false };
    if (tool === "runSubagent") {
      const replyId = `rid_${++state.seq}`;
      if (a.schema) hand(replyId, { text: "", sessionId: "rev", structured: { verdict: "pass", items: [] } });
      else {
        state.implements++;
        const cwd = join(project, String(a.cwd));
        writeFileSync(join(cwd, "done.txt"), "x\n");
        git(cwd, "add", "done.txt");
        git(cwd, "commit", "-q", "-m", "done");
        const body = { text: "やりました", sessionId: "impl" };
        if (state.holdImplementer) held.push({ replyId, body });
        else hand(replyId, body);
      }
      return { text: JSON.stringify({ runId: `run${state.seq}` }), isError: false, meta: { "dev.banto/replyId": replyId } };
    }
    return { text: `知らない呼び出し ${tool}`, isError: true };
  };
  const open: Client[] = [];
  /** サーバを起こして繋ぐ（2本目からは「起こし直した」もの） */
  const start = async (opts: { resumeAskWaitMs?: number } = {}) => {
    const { server, factory } = createFactoryServer({ projectRoot: project, dataDir: data, relay, ...opts });
    state.current = factory;
    const [s, c] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    open.push(client);
    const call = async (tool: string, args: Record<string, unknown>, meta?: Record<string, unknown>) => {
      const r = (await client.callTool({ name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) })) as { content: Array<{ text: string }>; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError === true };
    };
    return { factory, call };
  };
  return {
    project,
    delivered,
    held,
    state,
    start,
    cleanup: async () => {
      for (const c of open) await c.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function until(cond: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`待っても ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const runMeta = { [REPLY_TO_META_KEY]: "rt_run", [THREAD_META_KEY]: THREAD };
const ask = (replyTo: string) => ({ items: [{ replyTo, toolName: "runFactory", thread: THREAD }] });

test("起き直して流し直した実行が host に問われる前に終わっても、問われたら「続ける」と答えて最後の知らせを届ける", async () => {
  const h = setup();
  try {
    const first = await h.start();
    const started = await first.call("runFactory", { items: ["a"] }, runMeta);
    assert.equal(started.isError, false, started.text);
    const { runId } = JSON.parse(started.text) as { runId: string };
    await until(() => h.held.length === 1, "実装役に頼まない");

    // host が落ちて起き直した：Factory も起こし直され、Subagent が続けた返事がすぐ届き、問いより先に最後まで進む
    h.state.holdImplementer = false;
    const second = await h.start();
    for (const r of h.held.splice(0)) second.factory.receiveReply({ replyId: r.replyId, from: "subagent", title: "終わりました", text: JSON.stringify(r.body), final: true, lost: false });
    await until(() => second.factory.get(runId)?.items[0]?.status === "done", "流し直した実行が終わらない");
    assert.equal(h.delivered.length, 0, "問われる前に知らせた（札はまだ無い）");

    const answered = await second.call(RESUME_AFTER_RESTART_TOOL, ask("rt_run"));
    assert.deepEqual(JSON.parse(answered.text), { answers: [{ replyTo: "rt_run", resume: true }] });
    await until(() => h.delivered.length === 1, "問われたあと最後の知らせが届かない");
    assert.equal(h.delivered[0]!.replyTo, "rt_run");
    assert.equal(h.delivered[0]!.final, true);
    assert.match(h.delivered[0]!.title, /^Factory の実行が終わりました（取り込み 1／1 件）/);
    assert.deepEqual(second.factory.get(runId)!.notifyErrors, []);
    assert.equal(h.state.implements, 1, "実装役に頼み直した");
    assert.equal(existsSync(join(h.project, "done.txt")), true, "main に入っていない");
  } finally {
    await h.cleanup();
  }
});

test("起き直したあと問われないまま待ちの上限を越えたら、知らせられなかったことを記録に残す（問われても続けない）", async () => {
  const h = setup();
  try {
    const first = await h.start();
    const { runId } = JSON.parse((await first.call("runFactory", { items: ["a"] }, runMeta)).text) as { runId: string };
    await until(() => h.held.length === 1, "実装役に頼まない");
    h.state.holdImplementer = false;
    const second = await h.start({ resumeAskWaitMs: 200 });
    for (const r of h.held.splice(0)) second.factory.receiveReply({ replyId: r.replyId, from: "subagent", title: "終わりました", text: JSON.stringify(r.body), final: true, lost: false });
    await until(() => (second.factory.get(runId)?.notifyErrors.length ?? 0) > 0, "知らせられなかったことが残らない");
    assert.match(second.factory.get(runId)!.notifyErrors[0]!, /知らせる先がありません/);
    const answered = await second.call(RESUME_AFTER_RESTART_TOOL, ask("rt_run"));
    assert.equal((JSON.parse(answered.text) as { answers: Array<{ resume: boolean }> }).answers[0]!.resume, false);
    assert.equal(h.delivered.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("止まって人を待っていた1件は、起き直して流し直しても「止まりました」を届け直さない（札は最後の知らせに残す）", async () => {
  const h = setup({ testCommand: "test -f never.txt", limits: { testRetries: 0, reviewRounds: 2, rebaseRetries: 3, noCommitRetries: 2, conflictFixes: 2 } });
  try {
    h.state.holdImplementer = false;
    const first = await h.start();
    const { runId } = JSON.parse((await first.call("runFactory", { items: ["a"] }, runMeta)).text) as { runId: string };
    await until(() => h.delivered.length === 1, "止まったことが届かない");
    assert.match(h.delivered[0]!.title, /が止まりました/);
    assert.equal(h.delivered[0]!.final, false);
    await until(() => first.factory.get(runId)!.items[0]!.stopped?.notified === true, "届いたことが記録に残らない");

    const second = await h.start();
    const answered = await second.call(RESUME_AFTER_RESTART_TOOL, ask("rt_run"));
    assert.deepEqual(JSON.parse(answered.text), { answers: [{ replyTo: "rt_run", resume: true }] });
    await until(() => second.factory.get(runId)?.items[0]?.status === "stopped", "流し直して止まったところまで戻らない");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.delivered.length, 1, "「止まりました」を届け直した");
    assert.deepEqual(second.factory.get(runId)!.notifyErrors, []);

    // 答えてやめると、覚え直した札で最後の知らせが1回届く
    await second.call("answerFactory", { runId, item: "a", action: "drop" });
    await until(() => h.delivered.length === 2, "やめたあと最後の知らせが届かない");
    assert.equal(h.delivered[1]!.replyTo, "rt_run");
    assert.equal(h.delivered[1]!.final, true);
    assert.match(h.delivered[1]!.title, /^Factory の実行が終わりました（取り込み 0／1 件）/);
  } finally {
    await h.cleanup();
  }
});

/** 期限までに終わらなければ落とす（以前は最長 150 秒返らなかった呼び出しを、上限まで待たずに落とすため） */
function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  return Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${ms}ms で ${what}`)), ms).unref())]);
}

/**
 * 起き直して流し直した1件が、前の走行で届かなかった「止まりました」を問いまで待たせている間に、AI が answerFactory で答えた
 * （札を引き継ぐ）。そのあと host の問いが来る
 */
async function stoppedAndAnsweredBeforeAsk(action: "drop" | "continue") {
  const h = setup({ testCommand: "test -f never.txt", limits: { testRetries: 0, reviewRounds: 2, rebaseRetries: 3, noCommitRetries: 2, conflictFixes: 2 } });
  h.state.holdImplementer = false;
  h.state.failDeliveries = 1;
  const first = await h.start();
  const { runId } = JSON.parse((await first.call("runFactory", { items: ["a"] }, runMeta)).text) as { runId: string };
  await until(() => (first.factory.get(runId)?.notifyErrors.length ?? 0) === 1, "止まった知らせが届かなかったことが残らない");
  const second = await h.start();
  await until(() => second.factory.get(runId)?.items[0]?.status === "stopped", "流し直して止まったところまで戻らない");
  const t0 = Date.now();
  const answered = await within(5_000, "answerFactory が返らない", second.call("answerFactory", { runId, item: "a", action }, { [REPLY_TO_META_KEY]: "rt_answer", [THREAD_META_KEY]: THREAD }));
  assert.equal(answered.isError, false, answered.text);
  return { h, second, runId, answeredInMs: Date.now() - t0 };
}

test("問いの前に answerFactory が札を引き継いだら、問いは引き継いだ札を上書きせず、覚え直した札は引き継いだことを知らせて閉じる（やめた）", async () => {
  const { h, second, runId } = await stoppedAndAnsweredBeforeAsk("drop");
  try {
    await until(() => h.delivered.some((d) => d.replyTo === "rt_answer" && d.final), "引き継いだ札に最後の知らせが届かない");
    const answers = JSON.parse((await second.call(RESUME_AFTER_RESTART_TOOL, ask("rt_run"))).text) as { answers: Array<{ resume: boolean }> };
    assert.equal(answers.answers[0]!.resume, true, "覚え直した札を「途中で終わりました」にさせた");
    await until(() => h.delivered.some((d) => d.replyTo === "rt_run"), "覚え直した札を閉じない");
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      h.delivered.map((d) => [d.replyTo, d.final, d.title.replace(/（.*$/, "")]),
      [
        ["rt_answer", true, "Factory の実行が終わりました"],
        ["rt_run", true, "Factory：知らせの宛先を answerFactory の呼び出しに引き継ぎました"],
      ],
      "答えたあとに古い「止まりました」が届いた・同じ札に二度届いた",
    );
    assert.deepEqual(second.factory.get(runId)!.notifyErrors.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("問いの前に answerFactory が札を引き継いだら、answerFactory はすぐ返り、以後の知らせは引き継いだ札に届く（続けた）", async () => {
  const { h, second, runId, answeredInMs } = await stoppedAndAnsweredBeforeAsk("continue");
  try {
    assert.ok(answeredInMs < 5_000, `answerFactory が ${answeredInMs}ms 返らなかった`);
    // 続けた → 実装役に戻ってまたテストが落ち、止まる。その知らせは引き継いだ札（最後ではない）に届く
    await until(() => h.delivered.some((d) => d.replyTo === "rt_answer" && /が止まりました/.test(d.title)), "引き継いだ札に「止まりました」が届かない");
    const answers = JSON.parse((await second.call(RESUME_AFTER_RESTART_TOOL, ask("rt_run"))).text) as { answers: Array<{ resume: boolean }> };
    assert.equal(answers.answers[0]!.resume, true);
    await until(() => h.delivered.some((d) => d.replyTo === "rt_run"), "覚え直した札を閉じない");
    await second.call("answerFactory", { runId, item: "a", action: "drop" });
    await until(() => h.delivered.some((d) => /^Factory の実行が終わりました/.test(d.title)), "最後の知らせが届かない");
    assert.deepEqual(
      h.delivered.map((d) => [d.replyTo, d.final, d.title.replace(/（.*$/, "")]),
      [
        ["rt_answer", false, "Factory：題 が止まりました"],
        ["rt_run", true, "Factory：知らせの宛先を answerFactory の呼び出しに引き継ぎました"],
        ["rt_answer", true, "Factory の実行が終わりました"],
      ],
    );
  } finally {
    await h.cleanup();
  }
});

test("2件が止まったまま起き直し、1件に answerFactory で答えて札を引き継いだら、もう1件の待たせていた「止まりました」はすぐその札に届く", async () => {
  const h = setup({ testCommand: "test -f never.txt", limits: { testRetries: 0, reviewRounds: 2, rebaseRetries: 3, noCommitRetries: 2, conflictFixes: 2 } });
  try {
    h.state.holdImplementer = false;
    h.state.failDeliveries = 2;
    const first = await h.start();
    const { runId } = JSON.parse((await first.call("runFactory", { items: ["a", "b"] }, runMeta)).text) as { runId: string };
    await until(() => (first.factory.get(runId)?.notifyErrors.length ?? 0) === 2, "2件の止まった知らせが届かなかったことが残らない");
    const second = await h.start();
    await until(() => second.factory.get(runId)?.items.every((i) => i.status === "stopped") === true, "流し直して2件とも止まったところまで戻らない");
    await within(5_000, "answerFactory が返らない", second.call("answerFactory", { runId, item: "b", action: "drop" }, { [REPLY_TO_META_KEY]: "rt_answer", [THREAD_META_KEY]: THREAD }));
    await until(() => h.delivered.length > 0, "もう1件の「止まりました」が引き継いだ札に届かない（問いまで待っている）", 5_000);
    assert.equal(h.delivered[0]!.replyTo, "rt_answer");
    assert.equal(h.delivered[0]!.final, false);
    assert.equal((JSON.parse(h.delivered[0]!.text) as { task: string }).task, "a");
  } finally {
    await h.cleanup();
  }
});
