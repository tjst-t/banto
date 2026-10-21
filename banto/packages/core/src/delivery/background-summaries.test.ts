// **裏の仕事の要約**（Backlog #489、アーキ仕様 §4.2「札の手がかりを Module があとから足す」の 2.・3.）
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS, REPLY_TO_USES } from "@banto/module-contract";
import { ReplyHandles } from "./reply-handles.js";
import { BackgroundSummaries, BACKGROUND_SUMMARY_SYSTEM_PROMPT, WITHOUT_SUMMARIES } from "./background-summaries.js";
import { backgroundItemsOf } from "../http/app-events.js";
import type { AwaitingReply } from "../project-thread/types.js";

const SHELL = { moduleName: "subagent", connName: "subagent-p1", projectId: "p1" };

function setup(opts: { answer?: (prompt: string) => Promise<string> } = {}) {
  const clock = { now: 1_000_000 };
  const handles = new ReplyHandles(() => clock.now);
  const asked: Array<{ systemPrompt: string; prompt: string; projectId: string }> = [];
  const placed: string[] = [];
  const summaries = new BackgroundSummaries({
    handles,
    ask: async (input) => {
      asked.push(input);
      return opts.answer ? opts.answer(input.prompt) : "要約：いま試験を直しています。";
    },
    onPlaced: (threadId) => placed.push(threadId),
    now: () => clock.now,
  });
  handles.onSettled((id) => summaries.forget(id));
  const issueAwaiting = (threadId = "t1") => {
    const id = handles.issue({ threadId, projectId: "p1", connName: "subagent-p1", moduleName: "subagent", hop: 0, work: { toolName: "runSubagent" } });
    handles.markAwaiting(id);
    return id;
  };
  return { clock, handles, summaries, asked, placed, issueAwaiting };
}

const material = (text = "頼んだ文：試験を直して", workId = "run_1") => ({ workId, text });

test("返事待ちの Thread 宛ての札なら、作って返し、表に置いて画面に知らせる。指示は core のもの", async () => {
  const { summaries, asked, placed, issueAwaiting } = setup();
  const replyTo = issueAwaiting();
  const r = await summaries.summarize(SHELL, { replyTo, material: material() });
  assert.deepEqual(r, { summary: "いま試験を直しています。" });
  assert.equal(asked[0]!.systemPrompt, BACKGROUND_SUMMARY_SYSTEM_PROMPT);
  assert.equal(asked[0]!.projectId, "p1");
  assert.equal(summaries.of(replyTo)?.summary, "いま試験を直しています。");
  assert.equal(summaries.of(replyTo)?.summaryAt, new Date(1_000_000).toISOString());
  assert.deepEqual(placed, ["t1"]);
});

test("違う Module の札は理由つきで断り、小さいモデルを呼ばない", async () => {
  const { summaries, asked, issueAwaiting } = setup();
  const replyTo = issueAwaiting();
  const other = await summaries.summarize({ moduleName: "shell", connName: "shell-p1", projectId: "p1" }, { replyTo, material: material() });
  assert.match((other as { error: string }).error, /あなたに渡したものではありません/);
  // 名前が同じでも、別の接続（別の Project の同じ Module）は断る
  const otherConn = await summaries.summarize({ moduleName: "subagent", connName: "subagent-p2", projectId: "p2" }, { replyTo, material: material() });
  assert.match((otherConn as { error: string }).error, /あなたに渡したものではありません/);
  assert.equal(asked.length, 0);
  assert.equal(summaries.of(replyTo), undefined);
});

test("札の回数を減らさない——要約のあとも届けは5回使え、起こし直しで覚え直した札（finalOnly）でも受ける", async () => {
  const { clock, handles, summaries, issueAwaiting } = setup();
  const replyTo = issueAwaiting();
  await summaries.summarize(SHELL, { replyTo, material: material() });
  clock.now += 10_000;
  await summaries.summarize(SHELL, { replyTo, material: material() });
  assert.equal(handles.get(replyTo)!.usesLeft, REPLY_TO_USES);
  for (let i = 0; i < REPLY_TO_USES; i++) assert.ok(!("error" in handles.use(replyTo, SHELL)));

  const restored = "reply_restored";
  handles.restore(restored, { threadId: "t2", projectId: "p1", connName: "subagent-p1", moduleName: "subagent", hop: 0 });
  const r = await summaries.summarize(SHELL, { replyTo: restored, material: material("x", "run_2") });
  assert.ok("summary" in r);
  assert.equal(handles.get(restored)!.usesLeft, 1, "覚え直した札の最後の1回を使った");
  assert.ok(summaries.of(restored), "覚え直した札にも置く");
});

test("宛先が Module の札・済んだ札・札なしは、作って返すが表に置かない", async () => {
  const { clock, handles, summaries, placed, issueAwaiting } = setup();
  const { replyTo: toModule } = handles.issueToModule({
    to: { connName: "factory-p1", moduleName: "factory" },
    projectId: "p1",
    connName: "subagent-p1",
    moduleName: "subagent",
  });
  handles.markAwaiting(toModule);
  assert.ok("summary" in (await summaries.summarize(SHELL, { replyTo: toModule, material: material() })));
  assert.equal(summaries.of(toModule), undefined);

  const settled = issueAwaiting();
  handles.settle(settled);
  clock.now += 10_000;
  assert.ok("summary" in (await summaries.summarize(SHELL, { replyTo: settled, material: material() })));
  assert.equal(summaries.of(settled), undefined);

  assert.ok("summary" in (await summaries.summarize(SHELL, { material: material() })));
  // まだ返事待ちになっていない札（呼び出しの途中）も置かない
  const notYet = handles.issue({ threadId: "t1", projectId: "p1", connName: "subagent-p1", moduleName: "subagent", hop: 0 });
  assert.ok("summary" in (await summaries.summarize(SHELL, { replyTo: notYet, material: material() })));
  assert.equal(summaries.of(notYet), undefined);
  assert.deepEqual(placed, []);
});

test("札が済んだら表から消える。作っている間に済んだら置かない", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { handles, summaries, issueAwaiting } = setup({ answer: async () => (await gate, "途中の要約") });
  const done = issueAwaiting();
  const pending = summaries.summarize(SHELL, { replyTo: done, material: material() });
  handles.settle(done);
  release();
  assert.deepEqual(await pending, { summary: "途中の要約" });
  assert.equal(summaries.of(done), undefined);

  const { handles: h2, summaries: s2, issueAwaiting: issue2 } = setup();
  const later = issue2();
  await s2.summarize(SHELL, { replyTo: later, material: material() });
  assert.ok(s2.of(later));
  h2.settle(later);
  assert.equal(s2.of(later), undefined);
});

test("同じ札で同時に1つ・前の要約から 10 秒あける。札が無ければ Module＋workId で数える", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const { clock, summaries, issueAwaiting, asked } = setup({
    answer: async () => {
      if (first) {
        first = false;
        await gate;
      }
      return "要約";
    },
  });
  const replyTo = issueAwaiting();
  const running = summaries.summarize(SHELL, { replyTo, material: material() });
  assert.match(((await summaries.summarize(SHELL, { replyTo, material: material() })) as { error: string }).error, /いま作っている/);
  release();
  await running;
  clock.now += 9_000;
  assert.match(((await summaries.summarize(SHELL, { replyTo, material: material() })) as { error: string }).error, /10 秒あけて.*あと 1 秒/);
  clock.now += 1_000;
  assert.ok("summary" in (await summaries.summarize(SHELL, { replyTo, material: material() })));

  // 札なし：同じ Module の同じ仕事は数える。別の仕事・別の Module の接続は別に数える
  assert.ok("summary" in (await summaries.summarize(SHELL, { material: material("a", "run_x") })));
  assert.ok("error" in (await summaries.summarize(SHELL, { material: material("a", "run_x") })));
  assert.ok("summary" in (await summaries.summarize(SHELL, { material: material("a", "run_y") })));
  assert.ok("summary" in (await summaries.summarize({ ...SHELL, connName: "subagent-p2", projectId: "p2" }, { material: material("a", "run_x") })));
  assert.equal(asked.length, 5);
});

test("材料は上限の字数で切って渡す。失敗は理由を返す。形の違う引数・Project の決まらない頼みは断る", async () => {
  const { summaries, asked } = setup({
    answer: async (prompt) => {
      if (prompt.startsWith("fail")) throw new Error("ログインが切れています");
      return "要約";
    },
  });
  await summaries.summarize(SHELL, { material: material("あ".repeat(BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS + 50), "big") });
  assert.equal([...asked[0]!.prompt].length, BACKGROUND_SUMMARY_MATERIAL_MAX_CHARS);
  assert.match(((await summaries.summarize(SHELL, { material: material("fail", "f") })) as { error: string }).error, /要約を作れませんでした：ログインが切れています/);
  assert.match(((await summaries.summarize(SHELL, { material: { workId: "", text: "x" } })) as { error: string }).error, /workId/);
  assert.match(((await summaries.summarize(SHELL, { material: { workId: "w", text: "  " } })) as { error: string }).error, /空/);
  assert.match(((await summaries.summarize(SHELL, { replyTo: 3, material: material() })) as { error: string }).error, /replyTo/);
  assert.match(((await summaries.summarize({ moduleName: "subagent" }, { material: material("x", "np") })) as { error: string }).error, /Project/);
});

test("backgroundItemsOf は表を重ねる。AI 向けの WITHOUT_SUMMARIES では重ねない。名乗った画面も1件に載る", () => {
  const view = { resourceUri: "ui://banto-shell/commands", select: { commandId: "c1" } };
  const awaiting: AwaitingReply[] = [
    { replyTo: "r1", connName: "subagent-p1", moduleName: "subagent", hop: 1, since: "2026-10-21T00:00:00.000Z", work: { toolName: "runSubagent", title: "仕事" } },
    { replyTo: "r2", connName: "shell-p1", moduleName: "shell", hop: 1, since: "2026-10-21T00:01:00.000Z", work: { toolName: "runCommand", view } },
  ];
  const table = new Map([["r1", { summary: "いま試験を直しています", summaryAt: "2026-10-21T00:05:00.000Z" }]]);
  const items = backgroundItemsOf(awaiting, (id) => table.get(id));
  assert.deepEqual(items[0], {
    module: "subagent",
    since: "2026-10-21T00:00:00.000Z",
    toolName: "runSubagent",
    title: "仕事",
    summary: "いま試験を直しています",
    summaryAt: "2026-10-21T00:05:00.000Z",
  });
  assert.deepEqual(items[1], { module: "shell", since: "2026-10-21T00:01:00.000Z", toolName: "runCommand", view });
  assert.equal(backgroundItemsOf(awaiting, WITHOUT_SUMMARIES)[0]!.summary, undefined);
  assert.ok(!JSON.stringify(backgroundItemsOf(awaiting, WITHOUT_SUMMARIES)).includes("replyTo"), "札が一覧に出ている");
});
