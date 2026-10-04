// 形と操作の決まりごと（§4.4）——検証・輪の検出・閉じる／開き直す・分ける・並べ替え・id の作り方。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKLOG_FORMAT,
  BacklogError,
  assignMissingNumbers,
  createItem,
  emptyDocument,
  findCycles,
  findItem,
  isActionable,
  makeId,
  moveItem,
  parseDocument,
  serializeDocument,
  splitStory,
  updateItem,
  validateDocument,
  type BacklogDocument,
  type BacklogItem,
} from "./model.js";

const T0 = "2026-10-03T00:00:00.000Z";
const T1 = "2026-10-03T01:00:00.000Z";

function item(id: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    number: null,
    kind: "task",
    title: id,
    status: "ready",
    parent: null,
    dependsOn: [],
    milestone: null,
    priority: "normal",
    labels: [],
    body: "",
    doneWhen: "",
    resolution: null,
    refs: [],
    threads: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    extra: {},
    ...over,
  };
}

function doc(...items: BacklogItem[]): BacklogDocument {
  return { format: BACKLOG_FORMAT, milestones: [{ id: "m1", title: "M1", status: "open" }], items };
}

test("id：題の英数字から作り、ぶつかれば番号を足す。日本語だけの題は item-n", () => {
  assert.equal(makeId("Repositories の続き", new Set()), "repositories");
  assert.equal(makeId("Repositories の続き", new Set(["repositories"])), "repositories-2");
  assert.equal(makeId("滞留通知", new Set()), "item-1");
  assert.equal(makeId("滞留通知", new Set(["item-1"])), "item-2");
});

test("検証：parent はストーリーだけ・parent を持てるのはタスクだけ", () => {
  const story = item("s", { kind: "story" });
  assert.deepEqual(validateDocument(doc(story, item("t", { parent: "s" }))), []);
  assert.match(validateDocument(doc(item("a"), item("t", { parent: "a" }))).join(), /ストーリーではありません/);
  assert.match(validateDocument(doc(story, item("b", { kind: "bug", parent: "s" }))).join(), /親を持てません/);
  assert.match(validateDocument(doc(item("t", { parent: "nope" }))).join(), /親「nope」がありません/);
});

test("検証：dependsOn は在る項目だけ・自分を含む輪は断る", () => {
  assert.match(validateDocument(doc(item("a", { dependsOn: ["x"] }))).join(), /「x」がありません/);
  assert.match(validateDocument(doc(item("a", { dependsOn: ["a"] }))).join(), /自分自身/);
  const looped = doc(item("a", { dependsOn: ["b"] }), item("b", { dependsOn: ["c"] }), item("c", { dependsOn: ["a"] }));
  assert.deepEqual(findCycles(looped.items), [["a", "b", "c", "a"]]);
  assert.match(validateDocument(looped).join(), /輪になっています：a → b → c → a/);
  // 菱形は輪ではない
  assert.deepEqual(findCycles(doc(item("a", { dependsOn: ["b", "c"] }), item("b", { dependsOn: ["d"] }), item("c", { dependsOn: ["d"] }), item("d")).items), []);
});

test("検証：id の重複・やめるのに理由が無い・閉じていないのに closedAt", () => {
  assert.match(validateDocument(doc(item("a"), item("a"))).join(), /2つあります/);
  assert.match(validateDocument(doc(item("a", { status: "dropped", closedAt: T0 }))).join(), /理由/);
  assert.match(validateDocument(doc(item("a", { closedAt: T0 }))).join(), /closedAt/);
  assert.match(validateDocument(doc(item("Bad ID"))).join(), /使えません/);
});

test("閉じると closedAt、開き直すと closedAt と理由を消す。やめるは理由つきで閉じる", () => {
  let d = doc(item("a"));
  d = updateItem(d, "a", { status: "done" }, T1).doc;
  assert.equal(d.items[0]!.closedAt, T1);
  d = updateItem(d, "a", { status: "ready" }, T1).doc;
  assert.equal(d.items[0]!.closedAt, null);
  d = updateItem(d, "a", { status: "dropped", resolution: "重複" }, T1).doc;
  assert.equal(d.items[0]!.resolution, "重複");
  assert.deepEqual(validateDocument(d), []);
  d = updateItem(d, "a", { status: "backlog" }, T1).doc;
  assert.equal(d.items[0]!.resolution, null);
  assert.equal(d.items[0]!.closedAt, null);
  // 理由なしでやめる——文書の検証で断られる（黙って直さない）
  assert.match(validateDocument(updateItem(doc(item("a")), "a", { status: "dropped" }, T1).doc).join(), /理由/);
});

test("Thread は進めたときだけ足す（閉じただけでは足さない・同じ Thread を2回は足さない）", () => {
  const t = { projectId: "p", threadId: "t1" };
  const other = { projectId: "p", threadId: "t2" };
  // 片づけ：別の Thread が閉じただけなら足さない
  let h = doc(item("h"));
  h = updateItem(h, "h", { status: "done" }, T1, other).doc;
  assert.deepEqual(h.items[0]!.threads, []);
  h = updateItem(doc(item("h")), "h", { status: "dropped", resolution: "重複" }, T1, other).doc;
  assert.deepEqual(h.items[0]!.threads, []);
  let d = doc(item("a"));
  d = updateItem(d, "a", { title: "題だけ" }, T1, t).doc;
  assert.deepEqual(d.items[0]!.threads, []);
  d = updateItem(d, "a", { status: "in-progress" }, T1, t).doc;
  d = updateItem(d, "a", { status: "done" }, T1, other).doc;
  assert.deepEqual(d.items[0]!.threads, [t]);
  // 刻印が無い（人の画面）なら足さない
  d = updateItem(d, "a", { status: "in-progress" }, T1).doc;
  assert.deepEqual(d.items[0]!.threads, [t]);
});

test("足す：親があればストーリーの子の最後の後ろ、無ければ末尾。マイルストーンは親から継ぐ", () => {
  const d = doc(item("s", { kind: "story", milestone: "m1" }), item("s1", { parent: "s", milestone: "m1" }), item("z"));
  const { doc: next, result } = createItem(d, { kind: "task", title: "New task", parent: "s" }, T1);
  assert.deepEqual(next.items.map((i) => i.id), ["s", "s1", "new-task", "z"]);
  assert.equal(result.milestone, "m1");
  assert.equal(result.status, "backlog");
  const tail = createItem(d, { kind: "bug", title: "落ちる" }, T1);
  assert.equal(tail.doc.items.at(-1)!.id, "item-1");
  assert.throws(() => createItem(d, { kind: "task", title: "x", id: "s" }, T1), BacklogError);
});

test("分ける：ストーリーの下に複数のタスクを1回で、同じ回の依存つき", () => {
  const d = doc(item("s", { kind: "story" }), item("other"));
  const { doc: next, result } = splitStory(
    d,
    "s",
    [{ title: "Step one" }, { title: "Step two", waitsFor: [0] }, { title: "Step three", waitsFor: [0, 1], dependsOn: ["other"] }],
    T1,
  );
  assert.deepEqual(next.items.map((i) => i.id), ["s", "step-one", "step-two", "step-three", "other"]);
  assert.deepEqual(result[2]!.dependsOn, ["other", "step-one", "step-two"]);
  assert.ok(result.every((r) => r.parent === "s" && r.status === "ready"));
  assert.deepEqual(validateDocument(next), []);
  assert.throws(() => splitStory(d, "other", [{ title: "x" }], T1), /ストーリーではありません/);
  assert.throws(() => splitStory(d, "s", [{ title: "x", waitsFor: [3] }], T1), /番号/);
});

test("並べ替え：指定した項目の前／後ろへ", () => {
  const d = doc(item("a"), item("b"), item("c"));
  assert.deepEqual(moveItem(d, "c", "a", "before").doc.items.map((i) => i.id), ["c", "a", "b"]);
  assert.deepEqual(moveItem(d, "a", "c", "after").doc.items.map((i) => i.id), ["b", "c", "a"]);
  assert.throws(() => moveItem(d, "a", "a", "after"), BacklogError);
  assert.throws(() => moveItem(d, "a", "x", "after"), /ありません/);
});

test("着手できる：ready で依存が全部 done（やめた依存は終わっていない扱い）", () => {
  const items = [item("a", { status: "done", closedAt: T0 }), item("b", { status: "dropped", resolution: "x", closedAt: T0 }), item("c", { dependsOn: ["a"] }), item("d", { dependsOn: ["b"] })];
  assert.equal(isActionable(items[2]!, items), true);
  assert.equal(isActionable(items[3]!, items), false);
});

test("読む：欄の既定を埋め、型違い・知らない欄・古い形は理由つきで断る", () => {
  const ok = parseDocument({ format: BACKLOG_FORMAT, items: [{ id: "a", kind: "task", title: "A", status: "ready" }] });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.doc.items[0]!.labels, []);
  const legacy = parseDocument({ tasks: [{ id: "a" }] });
  assert.ok(!legacy.ok && legacy.legacy);
  const wrong = parseDocument({ format: BACKLOG_FORMAT, items: [{ id: "a", kind: "task", title: "A", status: "pending" }] });
  assert.ok(!wrong.ok && /status/.test(wrong.reason));
  const unknown = parseDocument({ format: BACKLOG_FORMAT, items: [{ id: "a", kind: "task", title: "A", status: "ready", why: "x" }] });
  assert.ok(!unknown.ok && /知らない欄 "why"/.test(unknown.reason));
  const other = parseDocument({ format: "banto-backlog/2", items: [] });
  assert.ok(!other.ok && !other.legacy);
});

test("書く：2字下げ・末尾改行・欄の順は固定（読んだ順に依らない）", () => {
  const parsed = parseDocument({
    items: [{ status: "ready", title: "A", kind: "task", id: "a", extra: { x: 1 } }],
    milestones: [],
    format: BACKLOG_FORMAT,
  });
  assert.ok(parsed.ok);
  const text = serializeDocument(parsed.ok ? parsed.doc : emptyDocument());
  assert.ok(text.endsWith("}\n"));
  assert.ok(text.startsWith('{\n  "format": "banto-backlog/1",\n  "milestones": [],\n  "items": [\n    {\n      "id": "a",\n      "kind": "task",\n      "title": "A",\n      "status": "ready",\n      "parent": null,'));
  const back = parseDocument(JSON.parse(text));
  assert.ok(back.ok);
  assert.equal(serializeDocument(back.ok ? back.doc : emptyDocument()), text);
});

test("番号：作るときに「いまある最大＋1」。閉じた・やめた項目の番号も使い直さない。分けるときは続き番号", () => {
  const d = doc(item("a", { number: 1 }), item("b", { number: 7, status: "dropped", resolution: "要らない", closedAt: T0 }), item("old"));
  const made = createItem(d, { kind: "task", title: "c" }, T1);
  assert.equal(made.result.number, 8);
  const s = createItem(made.doc, { kind: "story", title: "s" }, T1);
  assert.equal(s.result.number, 9);
  const split = splitStory(s.doc, s.result.id, [{ title: "x" }, { title: "y" }], T1);
  assert.deepEqual(split.result.map((i) => i.number), [10, 11]);
  assert.deepEqual(validateDocument(split.doc), []);
  // 番号の無い一覧なら 1 から
  assert.equal(createItem(doc(item("old")), { kind: "task", title: "n" }, T1).result.number, 1);
  // updateItem では変わらない（patch に欄が無い）
  assert.equal(updateItem(made.doc, made.result.id, { title: "c2" }, T1).result.number, 8);
});

test("番号：重なり・0 以下は検証で言う。整数でないものは読まない。番号の無い項目は読めて、欄ごと書かない", () => {
  const problems = validateDocument(doc(item("a", { number: 3 }), item("b", { number: 3 }), item("c", { number: 0 })));
  assert.ok(problems.some((p) => p === "番号 #3 が 2 つあります（a・b）"), problems.join("／"));
  assert.ok(problems.some((p) => /「c」の番号 0 は使えません/.test(p)), problems.join("／"));
  const bad = parseDocument({ format: BACKLOG_FORMAT, items: [{ id: "a", kind: "task", title: "A", status: "ready", number: 1.5 }] });
  assert.ok(!bad.ok && /number が整数ではありません/.test(bad.reason));
  const old = parseDocument({ format: BACKLOG_FORMAT, items: [{ id: "a", kind: "task", title: "A", status: "ready" }] });
  assert.ok(old.ok);
  assert.equal(old.doc.items[0]!.number, null);
  assert.ok(!serializeDocument(old.doc).includes('"number"'));
  assert.match(serializeDocument(doc(item("a", { number: 4 }))), /"id": "a",\n      "number": 4,/);
});

test("指し方：id・番号（42・\"#42\"・\"42\"）。数字だけの id があれば id が先", () => {
  const items = [item("a", { number: 42 }), item("7", { number: 1 })];
  assert.equal(findItem(items, "a").id, "a");
  assert.equal(findItem(items, 42).id, "a");
  assert.equal(findItem(items, "#42").id, "a");
  assert.equal(findItem(items, "42").id, "a");
  assert.equal(findItem(items, "7").id, "7");
  assert.equal(findItem(items, "#1").id, "7");
  assert.throws(() => findItem(items, 5), /項目「#5」がありません/);
  assert.throws(() => findItem(items, "#0"), /項目「#0」がありません/);
  assert.throws(() => findItem(items, "zzz"), /項目「zzz」がありません/);
});

test("振り直し：createdAt の無いものが先で古い一覧の並び（id、合わなければ同じ題）、次に createdAt 順。番号のあるものは変えず、2回目は何も振らない", () => {
  const d = doc(
    item("has", { number: 5 }),
    item("not-in-legacy", { createdAt: null }),
    item("new-2", { createdAt: "2026-10-04T02:00:00.000Z" }),
    item("legacy-b", { createdAt: null, title: "移したあとで題を直した" }),
    item("renamed", { createdAt: null, title: "重なっていた題" }),
    item("new-1", { createdAt: "2026-10-04T01:00:00.000Z" }),
    item("legacy-a", { createdAt: null }),
  );
  const legacy = [
    { id: "legacy-a", title: "legacy-a" },
    { id: "legacy-a", title: "重なっていた題" },
    { id: "gone", title: "消えた" },
    { id: "legacy-b", title: "legacy-b" },
  ];
  const first = assignMissingNumbers(d, legacy);
  assert.deepEqual(
    first.result.map((i) => `${i.id}#${i.number}`),
    ["legacy-a#6", "renamed#7", "legacy-b#8", "not-in-legacy#9", "new-1#10", "new-2#11"],
  );
  assert.equal(first.doc.items[0]!.number, 5);
  assert.deepEqual(first.doc.items.map((i) => i.id), d.items.map((i) => i.id), "並び（優先順）は変えない");
  assert.deepEqual(validateDocument(first.doc), []);
  const again = assignMissingNumbers(first.doc, legacy);
  assert.equal(again.result.length, 0);
  assert.deepEqual(again.doc, first.doc);
});
