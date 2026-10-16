import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-store/log.js";
import { ProjectThreadStore } from "../project-thread/store.js";
import { errandLeftoversOf, ProjectSleep, ProjectSleepError, type ProjectSleepDeps } from "./project-sleep.js";
import type { RunningItem } from "./project-move.js";

async function withSleep(
  fn: (ctx: { store: ProjectThreadStore; dir: string; calls: string[]; deps: ProjectSleepDeps; sleep: ProjectSleep }) => Promise<void>,
  over: Partial<ProjectSleepDeps> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "banto-sleep-test-"));
  try {
    const log = new EventLog(dir);
    await log.init();
    const store = new ProjectThreadStore(dir, log);
    await store.load();
    const calls: string[] = [];
    const deps: ProjectSleepDeps = {
      projectThread: store,
      hostActivity: () => [],
      suspendServices: async (id) => {
        calls.push(`suspend:${id}`);
        return [];
      },
      releaseModules: async (id, keep) => {
        calls.push(`release:${id}:${store.getProject(id)?.sleep ? "asleep" : "awake"}${keep.length > 0 ? `:keep=${keep.join(",")}` : ""}`);
        return [`shell-${id}`];
      },
      runningInPlace: async () => [],
      ...over,
    };
    await fn({ store, dir, calls, deps, sleep: new ProjectSleep(deps) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const refusal = async (p: Promise<unknown>): Promise<ProjectSleepError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProjectSleepError) return err;
    throw err;
  }
  assert.fail("断らなかった");
};

test("眠らせる：記録してから Module とコンテナを止める。この機械のコンテナでは Service を別に止めない。もう眠っていれば何もしない", async () => {
  await withSleep(async ({ store, dir, calls, sleep }) => {
    const p = await store.createProject("demo", dir);
    assert.deepEqual(await sleep.sleep(p.id, "human"), { released: [`shell-${p.id}`] });
    assert.deepEqual(calls, [`release:${p.id}:asleep`], "記録より先に止めた／この機械で Service を止めた");
    assert.equal(store.getProject(p.id)?.sleep?.by, "human");
    assert.deepEqual(await sleep.sleep(p.id, "human"), { released: [] });
    assert.equal(calls.length, 1);
  });
});

test("動いているもの（hostActivity）があれば 409 busy で断り、理由を並べる。印は消える", async () => {
  let activity: RunningItem[] = [{ kind: "turn", label: "ターンが走っています（会話）" }];
  await withSleep(
    async ({ store, dir, calls, sleep }) => {
      const p = await store.createProject("demo", dir);
      const err = await refusal(sleep.sleep(p.id, "human"));
      assert.deepEqual([err.status, err.code, err.reasons], [409, "busy", ["ターンが走っています（会話）"]]);
      assert.equal(store.getProject(p.id)?.sleep, undefined);
      assert.deepEqual(calls, []);
      // 印が残っていない——空けばそのまま眠らせられる
      activity = [];
      await sleep.sleep(p.id, "human");
      assert.ok(store.getProject(p.id)?.sleep);
    },
    { hostActivity: () => activity },
  );
});

test("閉じた・無い Project は断る", async () => {
  await withSleep(async ({ store, dir, sleep }) => {
    const p = await store.createProject("demo", dir);
    await store.closeProject(p.id);
    assert.deepEqual([(await refusal(sleep.sleep(p.id, "human"))).code], ["closed"]);
    assert.equal((await refusal(sleep.sleep("無い", "human"))).status, 404);
  });
});

test("眠らせている間：もう1本は 409 sleeping、起こす口は印が消えるまで待ってから起こす（project.woke は1回）", async () => {
  let unblock!: () => void;
  const blocked = new Promise<void>((r) => (unblock = r));
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      const sleeping = sleep.sleep(p.id, "human");
      assert.equal((await refusal(sleep.sleep(p.id, "auto"))).code, "sleeping");
      const preview = await sleep.preview(p.id);
      assert.deepEqual(preview.blockers, ["いま眠らせています"]);
      let woke: boolean[] | undefined;
      const waking = Promise.all([sleep.wake(p.id, "human"), sleep.wake(p.id, "delivery")]).then((r) => (woke = r));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(woke, undefined, "眠らせている途中に起こした");
      unblock();
      await sleeping;
      await waking;
      assert.deepEqual(woke!.sort(), [false, true], "同時に起こすと2回起きた");
      assert.equal(store.getProject(p.id)?.sleep, undefined);
      assert.equal(await sleep.wake(p.id, "opened"), false);
    },
    { releaseModules: () => blocked.then(() => []) },
  );
});

test("別のサーバの Project は、記録より先に Service を止めて自動起動から外す。止められなければ眠らせない（502）", async () => {
  let fail = true;
  const seen: string[] = [];
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("far", dir, { runtime: "remote:box" });
      const err = await refusal(sleep.sleep(p.id, "human"));
      assert.equal(err.status, 502);
      assert.equal(store.getProject(p.id)?.sleep, undefined);
      fail = false;
      await sleep.sleep(p.id, "human");
      assert.deepEqual(seen, [`suspend:${p.id}`, `suspend:${p.id}`, `release:${p.id}`]);
    },
    {
      suspendServices: async (id) => {
        seen.push(`suspend:${id}`);
        if (fail) throw new Error("繋がりません");
        return [];
      },
      releaseModules: async (id) => {
        seen.push(`release:${id}`);
        return [];
      },
    },
  );
});

test("止まるもの：実行場所で動いているものを並べる。眠っている・閉じたものは数えない", async () => {
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      assert.deepEqual(await sleep.preview(p.id), {
        stops: [{ kind: "service", label: "Service「web」が動いています" }],
        blockers: [],
        keeps: [],
        servicesKept: false,
      });
      await sleep.sleep(p.id, "human");
      assert.deepEqual(await sleep.preview(p.id), { stops: [], blockers: [], keeps: [], servicesKept: false });
    },
    { runningInPlace: async () => [{ kind: "service", label: "Service「web」が動いています" }] },
  );
});

test("眠りに戻す：用事（delivery・automation）で起きた Project は、何も残っていなければ by auto で眠る。人が開いた・送ったで起きたものは戻さない", async () => {
  let leftovers: string[] = [];
  let activity: RunningItem[] = [];
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      // 起きていた Project には何もしない
      assert.equal(await sleep.returnIfDone(p.id), false);
      for (const cause of ["opened", "human"] as const) {
        await sleep.sleep(p.id, "human");
        await sleep.wake(p.id, cause);
        assert.equal(sleep.awakeForErrand(p.id), false, cause);
        assert.equal(await sleep.returnIfDone(p.id), false, cause);
        assert.equal(store.getProject(p.id)?.sleep, undefined, cause);
      }
      for (const cause of ["delivery", "automation"] as const) {
        await sleep.sleep(p.id, "human");
        await sleep.wake(p.id, cause);
        assert.equal(sleep.awakeForErrand(p.id), true, cause);
        // 走っている・残っている間は戻さない（候補のまま）
        activity = [{ kind: "turn", label: "ターンが走っています（会話）" }];
        assert.equal(await sleep.returnIfDone(p.id), false);
        activity = [];
        leftovers = ["判断待ちがあります（会話）"];
        assert.equal(await sleep.returnIfDone(p.id), false);
        assert.equal(store.getProject(p.id)?.sleep, undefined);
        assert.equal(sleep.awakeForErrand(p.id), true);
        leftovers = [];
        assert.equal(await sleep.returnIfDone(p.id), true, cause);
        assert.equal(store.getProject(p.id)?.sleep?.by, "auto");
        assert.equal(sleep.awakeForErrand(p.id), false, "眠ったのに候補に残っている");
      }
    },
    { hostActivity: () => activity, errandLeftovers: () => leftovers },
  );
});

test("眠りに戻す：起きてから人の操作があれば戻さない。人が眠らせた・閉じたら候補から外す", async () => {
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      await sleep.sleep(p.id, "human");
      await sleep.wake(p.id, "automation");
      sleep.noteHuman(p.id);
      assert.equal(await sleep.returnIfDone(p.id), false);
      assert.equal(store.getProject(p.id)?.sleep, undefined);
      // 人が眠らせて、また用事で起きたら候補に戻る。閉じたら外す
      await sleep.sleep(p.id, "human");
      await sleep.wake(p.id, "delivery");
      await store.closeProject(p.id);
      assert.equal(await sleep.returnIfDone(p.id), false);
      assert.equal(sleep.awakeForErrand(p.id), false);
    },
    { errandLeftovers: () => [] },
  );
});

test("用が済んでいない理由：届いたもの・判断待ち・起きてから始めたターンの結末が人を待つ（古いターンは見ない）", () => {
  const turn = (startedAt: string, outcome: "completed" | "failed") => ({
    turnId: "t",
    startedSeq: 1,
    startedAt,
    cause: "delivery" as const,
    attempt: 0,
    outcome,
  });
  const since = "2026-10-16T10:00:00.000Z";
  assert.deepEqual(errandLeftoversOf([{ title: "A", messages: [], liveJudgment: false, lastTurn: turn("2026-10-16T10:00:01.000Z", "completed") }], since), []);
  assert.deepEqual(
    errandLeftoversOf(
      [
        { title: "A", messages: [], liveJudgment: false, deliveries: [{ deliveryId: "d", from: "x", title: "t", text: "", hop: 1, receivedAt: since }] },
        { title: "B", messages: [], liveJudgment: true },
        { title: "C", messages: [], liveJudgment: false, lastTurn: turn("2026-10-16T10:00:01.000Z", "failed") },
        { title: "D", messages: [], liveJudgment: false, lastTurn: turn("2026-10-01T00:00:00.000Z", "failed") },
      ],
      since,
    ),
    ["まだ渡していない届いたものがあります（A）", "判断待ちがあります（B）", "ターンの結末が人を待っています（C）"],
  );
});

// ── 出来事を待たれている Module は止めない（§2.2・§4.3 段2、Backlog #357）───────────────────────────

const byAutomation = (module: string) => ({ module, automations: [{ id: "a1", name: "落ちたら見る" }] });

test("待たれている Module は残す：Service の Module が待たれていれば Service は止めず、それ以外だけ外す（コンテナは残す）", async () => {
  await withSleep(
    async ({ store, dir, calls, sleep }) => {
      const p = await store.createProject("demo", dir);
      assert.deepEqual(sleep.partlyAwake(p.id), [], "起きている Project は一部起きているとは言わない");
      await sleep.sleep(p.id, "human");
      assert.deepEqual(calls, [`release:${p.id}:asleep:keep=service`], "Service を止めた／待たれている Module まで外した");
      assert.deepEqual(sleep.partlyAwake(p.id), [byAutomation("service")]);
    },
    { awaited: () => [byAutomation("service")], serviceModules: () => ["service"] },
  );
});

test("待たれているのが Service の Module でなければ、コンテナを残すので Service は管理操作で止めてから眠らせる", async () => {
  await withSleep(
    async ({ store, dir, calls, sleep }) => {
      const p = await store.createProject("demo", dir);
      await sleep.sleep(p.id, "human");
      assert.deepEqual(calls, [`suspend:${p.id}`, `release:${p.id}:asleep:keep=backlog`]);
    },
    { awaited: () => [byAutomation("backlog")], serviceModules: () => ["service"] },
  );
});

test("別のサーバで Service の Module が待たれていれば、Service を止めない", async () => {
  await withSleep(
    async ({ store, dir, calls, sleep }) => {
      const p = await store.createProject("far", dir, { runtime: "remote:box" });
      await sleep.sleep(p.id, "human");
      assert.deepEqual(calls, [`release:${p.id}:asleep:keep=service`]);
    },
    { awaited: () => [byAutomation("service")], serviceModules: () => ["service"] },
  );
});

test("止まるもの：コンテナを残すなら Service だけ（Service の Module が待たれていれば何も止まらない）。止めない Module を添える", async () => {
  let awaited = [byAutomation("backlog")];
  const running: RunningItem[] = [
    { kind: "service", label: "Service「web」が動いています" },
    { kind: "terminal", label: "Terminal のセッション「main」が開いています" },
  ];
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      assert.deepEqual(await sleep.preview(p.id), { stops: [running[0]], blockers: [], keeps: awaited, servicesKept: false });
      awaited = [byAutomation("service")];
      assert.deepEqual(await sleep.preview(p.id), { stops: [], blockers: [], keeps: awaited, servicesKept: true });
    },
    { awaited: () => awaited, serviceModules: () => ["service"], runningInPlace: async () => running },
  );
});

test("待たれなくなったら片づける：Service の Module なら先に Service を止めて外す。もう待たれていなければコンテナごと。起きている Project では何もしない", async () => {
  let awaited = [byAutomation("service"), byAutomation("backlog")];
  let connected = ["service", "backlog"];
  await withSleep(
    async ({ store, dir, calls, sleep }) => {
      const p = await store.createProject("demo", dir);
      assert.deepEqual(await sleep.releaseUnawaited(p.id, { force: true }), [], "起きている Project で片づけた");
      await sleep.sleep(p.id, "human");
      calls.length = 0;
      // まだ全部待たれている——何もしない
      assert.deepEqual(await sleep.releaseUnawaited(p.id, { force: true }), []);
      assert.deepEqual(calls, []);
      // Service の自動化を一時停止した
      awaited = [byAutomation("backlog")];
      await sleep.releaseUnawaited(p.id);
      assert.deepEqual(calls, [`suspend:${p.id}`, `release:${p.id}:asleep:keep=backlog`]);
      connected = ["backlog"];
      calls.length = 0;
      // 最後の自動化も消した——コンテナごと止める（Service の Module はもう繋がっていないので止め直さない）
      awaited = [];
      await sleep.releaseUnawaited(p.id, { force: true });
      assert.deepEqual(calls, [`release:${p.id}:asleep`]);
      connected = [];
      calls.length = 0;
      // 1分ごとの見回り（force なし）は、繋がっている待たれていない Module が無ければ何もしない
      await sleep.releaseUnawaited(p.id);
      assert.deepEqual(calls, []);
    },
    { awaited: () => awaited, serviceModules: () => ["service"], connectedModules: () => connected },
  );
});

test("待たれなくなった Service の Module の Service を止められなければ、外さずに残す（次のきっかけでまた試す）。片づけの間は起こす口が待つ", async () => {
  let fail = true;
  const seen: string[] = [];
  await withSleep(
    async ({ store, dir, sleep }) => {
      const p = await store.createProject("demo", dir);
      await sleep.sleep(p.id, "human");
      seen.length = 0;
      assert.deepEqual(await sleep.releaseUnawaited(p.id), []);
      assert.deepEqual(seen, ["suspend"]);
      fail = false;
      const tidy = sleep.releaseUnawaited(p.id);
      assert.equal(sleep.inProgress(p.id), true, "印の外で片づけた");
      const woke = sleep.wake(p.id, "opened");
      await tidy;
      assert.equal(await woke, true);
      assert.deepEqual(seen, ["suspend", "suspend", "release"], "起こす口が片づけを追い越した");
    },
    {
      awaited: () => [],
      serviceModules: () => ["service"],
      connectedModules: () => ["service"],
      suspendServices: async () => {
        seen.push("suspend");
        if (fail) throw new Error("繋がりません");
        return [];
      },
      releaseModules: async () => {
        seen.push("release");
        return ["service-x"];
      },
    },
  );
});
