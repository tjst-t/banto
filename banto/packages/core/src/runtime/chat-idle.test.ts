import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectState } from "../project-thread/types.js";
import type { ProjectActivityEntry } from "./project-idle.js";
import type { RunningItem } from "./project-move.js";
import {
  ChatIdle,
  chatIdleSettingsOf,
  type ChatIdleDeps,
} from "./chat-idle.js";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const after = (ms: number) => new Date(T0.getTime() + ms);

function chat(id: string, over: Partial<ProjectState> = {}): ProjectState {
  // 試験に要る分だけ（見るのは kind・status・prototyping・sleep・move・createdAt）
  return { id, name: id, root: "/tmp", status: "active", kind: "chat", prototyping: true, createdAt: T0.toISOString(), ...over } as ProjectState;
}

/**
 * 眠らせる・閉じるは本物の手順の代わりに、状態を書き換えて記録する（眠った・閉じた Project は次の刻みでもう見られない）。
 * 閉じたらコンテナを消したことも記録する
 */
function setup(projects: ProjectState[], over: Partial<ChatIdleDeps> = {}) {
  const slept: string[] = [];
  const closed: string[] = [];
  const containers = new Set(projects.map((p) => p.id));
  const busy = new Map<string, RunningItem[]>();
  const activity = new Map<string, ProjectActivityEntry>();
  const lastTurn = new Map<string, string>();
  const idle = new ChatIdle({
    listProjects: () => projects,
    lastTurnStartedAt: (id) => lastTurn.get(id),
    activity: { get: (id) => activity.get(id) },
    settings: () => ({ sleepAfterMinutes: 15, closeAfterDays: 14 }),
    hostActivity: (id) => busy.get(id) ?? [],
    sleepInProgress: () => false,
    sleep: async (id) => {
      const i = projects.findIndex((p) => p.id === id);
      projects[i] = { ...projects[i]!, sleep: { since: "", by: "auto" } };
      slept.push(id);
    },
    close: async (id) => {
      const i = projects.findIndex((p) => p.id === id);
      const { sleep: _sleep, ...rest } = projects[i]!;
      projects[i] = { ...rest, status: "closed" };
      containers.delete(id);
      closed.push(id);
    },
    ...over,
  });
  return { idle, slept, closed, containers, busy, activity, lastTurn };
}

test("設定：無ければ既定の15分・14日。知らない値は黙って既定にしない", () => {
  assert.deepEqual(chatIdleSettingsOf({ layerValue: () => undefined }), { sleepAfterMinutes: 15, closeAfterDays: 14 });
  const values: Record<string, unknown> = { "chat.sleepAfterMinutes": 60, "chat.closeAfterDays": "off" };
  assert.deepEqual(chatIdleSettingsOf({ layerValue: (k: string) => values[k] } as never), { sleepAfterMinutes: 60, closeAfterDays: "off" });
  assert.throws(() => chatIdleSettingsOf({ layerValue: (k: string) => (k === "chat.sleepAfterMinutes" ? 10 : undefined) } as never), /chat.sleepAfterMinutes/);
  assert.throws(() => chatIdleSettingsOf({ layerValue: (k: string) => (k === "chat.closeAfterDays" ? 3 : undefined) } as never), /chat.closeAfterDays/);
});

test("眠らせる：試作中のチャットは、使ってから既定15分で眠る（14分ではまだ）", async () => {
  const { idle, slept } = setup([chat("c1")]);
  idle.noteUse("c1", after(0));
  await idle.check({ now: after(14 * MIN) });
  assert.deepEqual(slept, []);
  await idle.check({ now: after(15 * MIN) });
  assert.deepEqual(slept, ["c1"]);
  // もう眠っている——2度は眠らせない
  await idle.check({ now: after(30 * MIN) });
  assert.deepEqual(slept, ["c1"]);
});

test("眠らせる：走っているターンがあれば眠らせない。終わって15分たったら眠る", async () => {
  const { idle, slept, busy } = setup([chat("c1")]);
  busy.set("c1", [{ kind: "turn", label: "ターンが走っています（会話）" }]);
  await idle.check({ now: after(20 * MIN) });
  assert.deepEqual(slept, []);
  // ターンが終わった（host が終わりを見て覚える）
  busy.delete("c1");
  idle.noteUse("c1", after(20 * MIN));
  await idle.check({ now: after(34 * MIN) });
  assert.deepEqual(slept, []);
  await idle.check({ now: after(35 * MIN) });
  assert.deepEqual(slept, ["c1"]);
});

test("眠らせる：人の操作・会話の記録の最後のターンも「使った」に数える", async () => {
  const { idle, slept, activity, lastTurn } = setup([chat("c1"), chat("c2")]);
  activity.set("c1", { lastHumanAt: after(10 * MIN).toISOString() });
  lastTurn.set("c2", after(12 * MIN).toISOString());
  await idle.check({ now: after(24 * MIN) });
  assert.deepEqual(slept, []);
  await idle.check({ now: after(27 * MIN) });
  assert.deepEqual(slept.sort(), ["c1", "c2"]);
});

test("眠らせる：試作を始めていないチャット・普通の Project は眠らせない。設定の分に従う", async () => {
  const { idle, slept } = setup([chat("talk", { prototyping: undefined }), chat("plain", { kind: undefined }), chat("c1")], {
    settings: () => ({ sleepAfterMinutes: 5, closeAfterDays: 14 }),
  });
  await idle.check({ now: after(5 * MIN) });
  assert.deepEqual(slept, ["c1"]);
});

test("閉じる：既定14日でチャットを閉じ、コンテナが消える（眠っていても・試作前でも）", async () => {
  const { idle, slept, closed, containers } = setup([chat("c1"), chat("talk", { prototyping: undefined }), chat("plain", { kind: undefined })]);
  await idle.check({ now: after(15 * MIN) });
  assert.deepEqual(slept, ["c1"]);
  await idle.check({ now: after(14 * DAY - MIN) });
  assert.deepEqual(closed, []);
  await idle.check({ now: after(14 * DAY) });
  assert.deepEqual(closed.sort(), ["c1", "talk"]);
  assert.deepEqual([...containers], ["plain"]);
});

test("閉じる：走っているターンがあれば閉じない。off なら閉じない", async () => {
  const busyCase = setup([chat("c1", { sleep: undefined })]);
  busyCase.busy.set("c1", [{ kind: "turn", label: "ターンが走っています（会話）" }]);
  await busyCase.idle.check({ now: after(30 * DAY) });
  assert.deepEqual(busyCase.closed, []);
  assert.deepEqual(busyCase.slept, []);

  const off = setup([chat("c1")], { settings: () => ({ sleepAfterMinutes: 15, closeAfterDays: "off" }) });
  await off.idle.check({ now: after(365 * DAY) });
  assert.deepEqual(off.closed, []);
  assert.deepEqual(off.slept, ["c1"]);
});

test("失敗しても止まらない：眠らせられなかったチャットは次の刻みでまた見る。ほかのチャットは進む", async () => {
  let refuse = true;
  const projects = [chat("c1"), chat("c2")];
  const slept: string[] = [];
  const { idle } = setup(projects, {
    sleep: async (id) => {
      if (id === "c1" && refuse) throw new Error("いま眠らせています");
      slept.push(id);
      const i = projects.findIndex((p) => p.id === id);
      projects[i] = { ...projects[i]!, sleep: { since: "", by: "auto" } };
    },
  });
  await idle.check({ now: after(15 * MIN) });
  assert.deepEqual(slept, ["c2"]);
  refuse = false;
  await idle.check({ now: after(16 * MIN) });
  assert.deepEqual(slept, ["c2", "c1"]);
});
