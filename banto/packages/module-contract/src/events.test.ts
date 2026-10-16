import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  eventFieldsProblem,
  eventMatchesWhere,
  eventNameProblem,
  eventWhereProblem,
  parseEventDeclarations,
  type EmittedEvent,
} from "./events.js";
import { EventOutbox } from "./outbox.js";

const crashed = {
  name: "service.crashed",
  title: "Service が落ちた",
  description: "unit が止まった",
  fields: {
    service: { type: "string", title: "Service" },
    exitCode: { type: "number", title: "終了コード" },
    kind: { type: "string", title: "種類", enum: ["web", "worker"] },
  },
  subject: "service",
};

test("名乗り：出どころは Module 自身の名前、banto.* は名乗れない、subject は属性の名前", () => {
  const [d] = parseEventDeclarations([crashed], "service");
  assert.equal(d!.name, "service.crashed");
  assert.equal(d!.subject, "service");
  assert.deepEqual(d!.fields.kind!.enum, ["web", "worker"]);
  assert.throws(() => parseEventDeclarations([crashed], "factory"), /名乗った Module の名前（factory）/);
  assert.throws(() => parseEventDeclarations([{ ...crashed, name: "banto.turn-decisions" }], "banto-x"), /banto 本体だけ/);
  assert.equal(eventNameProblem("banto.turn-decisions", "banto"), undefined);
  assert.throws(() => parseEventDeclarations([{ ...crashed, subject: "nope" }], "service"), /subject は fields にある/);
  assert.throws(() => parseEventDeclarations([crashed, crashed], "service"), /2回名乗って/);
  assert.throws(
    () => parseEventDeclarations([{ ...crashed, fields: { x: { type: "date", title: "x" } } }], "service"),
    /type は string・number・boolean/,
  );
  assert.throws(() => parseEventDeclarations([{ ...crashed, fields: { x: { type: "number", title: "x", enum: ["a"] } } }], "service"), /enum/);
  assert.deepEqual(parseEventDeclarations(undefined, "service"), []);
});

test("属性：名乗っていない属性・型違い・enum の外は受けない。無い属性はよい", () => {
  const [d] = parseEventDeclarations([crashed], "service");
  assert.equal(eventFieldsProblem(d!, { service: "web", exitCode: 1 }), undefined);
  assert.equal(eventFieldsProblem(d!, {}), undefined);
  assert.match(eventFieldsProblem(d!, { service: 1 })!, /service は string/);
  assert.match(eventFieldsProblem(d!, { other: "x" })!, /名乗っていません/);
  assert.match(eventFieldsProblem(d!, { kind: "db" })!, /どれか/);
  assert.match(eventFieldsProblem(d!, { exitCode: Number.NaN })!, /有限/);
});

test("条件（where）：名乗りと照らす。等しい／どれか", () => {
  const [d] = parseEventDeclarations([crashed], "service");
  assert.equal(eventWhereProblem(d!, { service: ["web", "api"], exitCode: 1 }), undefined);
  assert.match(eventWhereProblem(d!, { svc: "web" })!, /名乗っていません/);
  assert.match(eventWhereProblem(d!, { exitCode: "1" })!, /number/);
  assert.match(eventWhereProblem(d!, { service: [] })!, /空/);
  assert.equal(eventMatchesWhere({ service: ["web", "api"] }, { service: "api" }), true);
  assert.equal(eventMatchesWhere({ service: "web", exitCode: 1 }, { service: "web", exitCode: 2 }), false);
  assert.equal(eventMatchesWhere({ service: "web" }, {}), false);
  assert.equal(eventMatchesWhere(undefined, {}), true);
});

function event(id: string, at: string): EmittedEvent {
  return { name: "service.crashed", eventId: id, occurredAt: at, fields: { service: id } };
}

test("出口の箱：古い順に出し、受け取られた・断られたものは消し、一時の失敗で止まって残す", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "outbox-")), "box");
  const logs: string[] = [];
  const box = new EventOutbox({ dir, log: (m) => logs.push(m), now: () => new Date("2026-10-16T12:00:00Z") });
  box.write(event("b", "2026-10-16T11:00:00Z"));
  box.write(event("a", "2026-10-16T10:00:00Z"));
  box.write(event("c", "2026-10-16T11:30:00Z"));
  assert.deepEqual(box.list().map((e) => e.eventId), ["a", "b", "c"]);

  const seen: string[] = [];
  const first = await box.flush(async (e) => {
    seen.push(e.eventId);
    if (e.eventId === "a") return { refused: "宣言に無い" };
    if (e.eventId === "b") return { accepted: true };
    throw new Error("繋がっていません");
  });
  assert.deepEqual(seen, ["a", "b", "c"]);
  assert.deepEqual(first, { sent: 1, left: 1 });
  assert.deepEqual(box.list().map((e) => e.eventId), ["c"]);
  assert.ok(logs.some((l) => l.includes("断ったので捨てます")));

  const second = await box.flush(async () => ({ accepted: true }));
  assert.deepEqual(second, { sent: 1, left: 0 });
  assert.deepEqual(box.list(), []);
});

test("出口の箱：7日を過ぎたもの・上限を超えた分は古いものから捨て、数をログに残す", () => {
  const dir = mkdtempSync(join(tmpdir(), "outbox-"));
  const logs: string[] = [];
  const box = new EventOutbox({ dir, log: (m) => logs.push(m), now: () => new Date("2026-10-16T12:00:00Z"), limits: { maxItems: 2 } });
  box.write(event("old", "2026-10-01T00:00:00Z"));
  assert.deepEqual(box.list(), []);
  box.write(event("1", "2026-10-16T01:00:00Z"));
  box.write(event("2", "2026-10-16T02:00:00Z"));
  box.write(event("3", "2026-10-16T03:00:00Z"));
  assert.deepEqual(box.list().map((e) => e.eventId), ["2", "3"]);
  assert.equal(readdirSync(dir).length, 2);
  assert.ok(logs.some((l) => l.includes("1 件捨てました")));
});
