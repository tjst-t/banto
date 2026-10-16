import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "../project-thread/types.js";
import type { RunningItem } from "./project-move.js";
import {
  idleDaysOf,
  idleExclusionOf,
  lastHumanMessages,
  lastSeenOf,
  ProjectActivity,
  ProjectIdle,
  type AutoSleepMode,
  type ProjectIdleDeps,
} from "./project-idle.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function project(id: string, over: Partial<ProjectState> = {}): ProjectState {
  // 試験に要る分だけ（数え方と外し方が見るのは status・sleep・move・createdAt）
  return { id, name: id, root: "/tmp", status: "active", createdAt: T0.toISOString(), ...over } as ProjectState;
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "banto-idle-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withIdle(
  projects: ProjectState[],
  fn: (ctx: { idle: ProjectIdle; activity: ProjectActivity; slept: string[]; changes: () => number; setMode: (m: AutoSleepMode) => void; setNow: (d: Date) => void }) => Promise<void>,
  over: Partial<ProjectIdleDeps> = {},
) {
  await withDir(async (dir) => {
    const activity = new ProjectActivity(join(dir, "project-activity.json"));
    await activity.load(async () => new Map());
    let mode: AutoSleepMode = "ask";
    let now = at(0);
    let changes = 0;
    const slept: string[] = [];
    const idle = new ProjectIdle({
      listProjects: () => projects,
      getProject: (id) => projects.find((p) => p.id === id),
      activity,
      mode: () => mode,
      hostActivity: () => [],
      sleepInProgress: () => false,
      runningInPlace: async () => [],
      sleep: async (id) => {
        slept.push(id);
      },
      onChange: () => changes++,
      now: () => now,
      ...over,
    });
    await fn({ idle, activity, slept, changes: () => changes, setMode: (m) => (mode = m), setNow: (d) => (now = d) });
  });
}

// ── 数え方 ─────────────────────────────────────────────────────────────────

test("数え方：人の操作・「今はしない」・作った、のうち一番新しいものから数える", () => {
  const created = at(0).toISOString();
  assert.equal(lastSeenOf(undefined, created), created);
  assert.equal(lastSeenOf({ lastHumanAt: at(3).toISOString() }, created), at(3).toISOString());
  assert.equal(lastSeenOf({ lastHumanAt: at(3).toISOString(), dismissedAt: at(5).toISOString() }, created), at(5).toISOString());
  assert.equal(lastSeenOf({ lastHumanAt: at(7).toISOString(), dismissedAt: at(5).toISOString() }, created), at(7).toISOString());
  // 作ったより前の人の操作（記録から埋めた古い値）は効かない
  assert.equal(lastSeenOf({ lastHumanAt: at(-3).toISOString() }, created), created);
});

test("数え方：日数は切り捨て（14日に1分足りなければ13日）", () => {
  const seen = at(0).toISOString();
  assert.equal(idleDaysOf(seen, new Date(at(14).getTime() - 60_000)), 13);
  assert.equal(idleDaysOf(seen, at(14)), 14);
  assert.equal(idleDaysOf(seen, at(20)), 20);
  assert.equal(idleDaysOf(seen, at(-1)), 0);
});

test("初めて読むとき：会話の記録の人の発言だけを Project ごとに一番新しいもので埋める（届いたもの・AI の発言は数えない）", async () => {
  async function* events() {
    yield { type: "message.appended", ts: at(1).toISOString(), payload: { threadId: "t1", role: "user", text: "a" } };
    yield { type: "message.appended", ts: at(2).toISOString(), payload: { threadId: "t2", role: "user", text: "b" } };
    yield { type: "message.appended", ts: at(3).toISOString(), payload: { threadId: "t1", role: "assistant", text: "c" } };
    yield { type: "message.appended", ts: at(4).toISOString(), payload: { threadId: "t1", role: "user", text: "d", origin: { from: "banto" } } };
    yield { type: "turn.started", ts: at(5).toISOString(), payload: { threadId: "t1" } };
    yield { type: "message.appended", ts: at(6).toISOString(), payload: { threadId: "gone", role: "user", text: "e" } };
  }
  const projectOf: Record<string, string> = { t1: "p1", t2: "p1", t3: "p2" };
  const seeded = await lastHumanMessages(events(), (t) => projectOf[t]);
  assert.deepEqual([...seeded], [["p1", at(2).toISOString()]]);
});

test("project-activity.json：無ければ埋めて書く・人の操作は同じ Project で1分に1回まで・「今はしない」・壊れていたら退けて埋め直す", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "project-activity.json");
    const a = new ProjectActivity(file);
    await a.load(async () => new Map([["p1", at(1).toISOString()]]));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { p1: { lastHumanAt: at(1).toISOString() } });

    assert.equal(await a.noteHuman("p1", at(2)), true);
    assert.equal(await a.noteHuman("p1", new Date(at(2).getTime() + 59_000)), false, "1分たたないのに書いた");
    assert.equal(a.get("p1")?.lastHumanAt, at(2).toISOString());
    assert.equal(await a.noteHuman("p1", new Date(at(2).getTime() + 60_000)), true);
    await a.dismiss(["p2"], at(3));

    // 読み直すと同じ（埋め直さない）
    const b = new ProjectActivity(file);
    await b.load(async () => assert.fail("ファイルがあるのに埋め直した"));
    assert.deepEqual(b.get("p1"), { lastHumanAt: new Date(at(2).getTime() + 60_000).toISOString() });
    assert.deepEqual(b.get("p2"), { dismissedAt: at(3).toISOString() });

    await writeFile(file, "{ broken");
    const c = new ProjectActivity(file);
    await c.load(async () => new Map([["p9", at(9).toISOString()]]));
    assert.deepEqual(c.get("p9"), { lastHumanAt: at(9).toISOString() });
    assert.equal(c.get("p1"), undefined);
    assert.ok((await readdir(dir)).some((f) => f.startsWith("project-activity.json.broken-")), "壊れたファイルを残していない");
  });
});

// ── 候補の外し方 ───────────────────────────────────────────────────────────

test("外し方：閉じた・眠っている・眠らせている途中・移している・host で動いているもの・動いている Service", () => {
  const none = { sleepInProgress: false, hostActivity: [] as RunningItem[], running: [] as RunningItem[] };
  assert.equal(idleExclusionOf(project("p"), none), undefined);
  assert.equal(idleExclusionOf(project("p", { status: "closed" }), none), "閉じている");
  assert.equal(idleExclusionOf(project("p", { sleep: { since: at(0).toISOString(), by: "human" } }), none), "眠っている");
  assert.equal(idleExclusionOf(project("p"), { ...none, sleepInProgress: true }), "眠らせている途中");
  assert.equal(idleExclusionOf(project("p", { move: {} as ProjectState["move"] }), none), "別の実行場所へ移している");
  assert.equal(idleExclusionOf(project("p"), { ...none, hostActivity: [{ kind: "turn", label: "ターン" }] }), "動いているものがある");
  assert.equal(idleExclusionOf(project("p"), { ...none, running: [{ kind: "service", label: "web" }] }), "動いている Service がある");
  // Terminal のセッション・待たないコマンドは外さない（仕様が外すのは Service と公開中のもの）
  assert.equal(
    idleExclusionOf(project("p"), { ...none, running: [{ kind: "terminal", label: "t" }, { kind: "command", label: "c" }] }),
    undefined,
  );
});

test("ask：14日開いていない Project だけを覚えて idle に出し、外すものは出さない。人の操作・「今はしない」でその場で消える", async () => {
  const projects = [
    project("old"),
    project("fresh", { createdAt: at(5).toISOString() }),
    project("busy"),
    project("svc"),
    project("unknown"),
    project("closed", { status: "closed" }),
    project("asleep", { sleep: { since: at(1).toISOString(), by: "human" } }),
    project("seen"),
  ];
  await withIdle(
    projects,
    async ({ idle, activity, changes, setNow }) => {
      await activity.noteHuman("seen", at(2));
      await idle.check({ now: at(15) });
      const marked = projects.map((p) => p.id).filter((id) => idle.idleOf(id));
      assert.deepEqual(marked, ["old"]);
      assert.deepEqual(idle.idleOf("old"), { days: 15, suggestSleep: true });
      assert.equal(changes(), 1);

      // 「今はしない」：その場で消え、今から14日はまた聞かない
      setNow(at(15));
      await idle.dismiss(["old"]);
      assert.equal(idle.idleOf("old"), undefined);
      assert.equal(changes(), 2);
      await idle.check({ now: at(28) });
      assert.equal(idle.idleOf("old"), undefined, "「今はしない」から14日たたないのにまた聞いた");
      await idle.check({ now: at(29) });
      assert.deepEqual(idle.idleOf("old"), { days: 14, suggestSleep: true });

      // 人の操作：その場で消える
      setNow(at(29));
      await idle.noteHuman("old");
      assert.equal(idle.idleOf("old"), undefined);
    },
    {
      hostActivity: (id) => (id === "busy" ? [{ kind: "reply", label: "裏の仕事" }] : []),
      runningInPlace: async (id) => {
        if (id === "unknown") throw new Error("ssh が繋がらない");
        return id === "svc" ? [{ kind: "service", label: "web" }] : [];
      },
    },
  );
});

test("ask：名指し（only）の見直しは、ほかの覚えた候補に触らない。眠った・閉じた候補は idle に出さない", async () => {
  const projects = [project("a"), project("b")];
  await withIdle(projects, async ({ idle }) => {
    await idle.check({ now: at(15) });
    assert.ok(idle.idleOf("a") && idle.idleOf("b"));
    await idle.check({ now: at(1), only: ["a"] });
    assert.equal(idle.idleOf("a"), undefined);
    assert.ok(idle.idleOf("b"), "名指ししていない候補まで消えた");
    projects[1] = project("b", { sleep: { since: at(16).toISOString(), by: "human" } });
    assert.equal(idle.idleOf("b"), undefined);
  });
});

test("auto：当たる Project を眠らせ、聞かない。off：何もせず、覚えていた候補も消す", async () => {
  const projects = [project("old"), project("svc"), project("fresh", { createdAt: at(10).toISOString() })];
  await withIdle(
    projects,
    async ({ idle, slept, setMode }) => {
      await idle.check({ now: at(15) });
      assert.ok(idle.idleOf("old"));

      setMode("off");
      assert.equal(idle.idleOf("old"), undefined, "off なのに聞いた");
      await idle.check({ now: at(15) });
      setMode("ask");
      assert.equal(idle.idleOf("old"), undefined, "off の見直しで候補が消えていない");
      assert.deepEqual(slept, []);

      setMode("auto");
      await idle.check({ now: at(15) });
      assert.deepEqual(slept, ["old"]);
      assert.equal(idle.idleOf("old"), undefined);
    },
    { runningInPlace: async (id) => (id === "svc" ? [{ kind: "service", label: "web" }] : []) },
  );
});

test("auto：眠らせられなかった Project があっても、ほかは眠らせる（次の刻みでまた見る）", async () => {
  const slept: string[] = [];
  await withIdle(
    [project("a"), project("b")],
    async ({ idle, setMode }) => {
      setMode("auto");
      await idle.check({ now: at(15) });
      assert.deepEqual(slept, ["b"]);
    },
    {
      sleep: async (id) => {
        if (id === "a") throw new Error("いま眠らせています");
        slept.push(id);
      },
    },
  );
});
