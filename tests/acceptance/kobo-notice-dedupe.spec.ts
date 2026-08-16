/**
 * task-0217: **同じ失敗の知らせを何度も配らない。**
 *
 * ## 何が起きていたか（dentaku/task-0042・2026-08-16 の実測）
 *
 * 工場の帳簿の最後の出来事は `08:40:39` の1件だけで、それ以降タスクは動いていない。
 * にもかかわらず**番頭のターンが同じ内容で3回起きた**：
 *
 * | # | 届いたもの | 正体 |
 * |---|---|---|
 * | 1 | 「起きたこと: agent_exited_without_report」 | 08:34 の分の**再送** |
 * | 2 | 「【取り下げ】probe-worker-pool からの報告」 | **番頭が読んで畳んだ**職人の報告 |
 * | 3 | 「起きたこと: rework session spawn failed … ECONNRESET」 | 08:40:39 の分の**再送** |
 *
 * しかもそのタスクには既に PO 判断待ちの札が立っていて先へ進めない——**進めない件に
 * ついて、判断を促す知らせだけが増える**形になっていた（inc-0063 と同じ周回）。
 *
 * ## ここで固めること
 *
 * 1. 一度配った event id は二度と配らない（**再起動をまたいでも**）
 * 2. PO 判断待ちの札が立っている間、同じタスクの同じ催促を繰り返さない
 * 3. **ただし新しい出来事は必ず配る**——抑制が新着を食わない（inc-0069：知らせを消さない）
 * 4. 番頭が畳んだ職人の報告を、取り下げ札として再送しない
 * 5. 配らなかったことは記録から読める（黙って落とさない・I2）
 *
 * 配り役（`kobo-notice` / `worker-notice`）だけを見たいので、`kobo.*` / `worker.*` は
 * 差し替える。**引き先が読み位置を無視して同じ出来事を返し続けても**二度配らない、
 * というのがここで見たいことなので、偽の口の方が検体として強い。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startKoboNotices } from "../../packages/banto-host/src/kobo-notice.js";
import {
  startWorkerNotices,
  threadOrigin,
} from "../../packages/banto-host/src/worker-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";
import type { WorkerEvent } from "../../packages/banto-worker-pool/src/event-log.js";

// ── 工場の知らせ ─────────────────────────────────────────────────────────────

interface KoboStub {
  /** 引き先が返す出来事。**読み位置は無視する**（再送する引き先の身代わり）。 */
  events: Array<Record<string, unknown>>;
  /** `kobo.task` の返り。 */
  task?: { status: string; title?: string };
  reviewStage?: string;
  /** `inbox.list` が返す文（PO 判断待ちの札）。undefined なら取次は未配線。 */
  inbox?: string;
}

interface Run {
  delivered: string[];
  logs: string[];
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kobo-notice-dedupe-"));
}

/** 工場の配り役を数 tick 回して、届いた札とログを返す。 */
async function runKobo(cursorPath: string, stub: KoboStub, ticks = 3): Promise<Run> {
  const delivered: string[] = [];
  const logs: string[] = [];
  let polls = 0;

  const tools = [
    {
      name: "kobo.events",
      async execute() {
        polls += 1;
        return {
          content: [],
          details: {
            events: stub.events,
            origins: { "banto/task-0042": threadOrigin("th-1") },
          },
        };
      },
    },
    {
      name: "kobo.task",
      async execute() {
        return {
          content: [],
          details: {
            task: stub.task ?? { status: "failed", title: "道具定義の書き直し" },
            reviewStage: stub.reviewStage ?? "banto",
          },
        };
      },
    },
    ...(stub.inbox === undefined
      ? []
      : [
          {
            name: "inbox.list",
            async execute() {
              return { content: [{ type: "text" as const, text: stub.inbox }], details: {} };
            },
          },
        ]),
  ] as unknown as NamespacedToolDefinition[];

  const stop = startKoboNotices({
    tools,
    async notify(message) {
      delivered.push(message);
    },
    cursorPath,
    intervalMs: 10,
    log: (m) => logs.push(m),
  });
  try {
    // 「n 回目の引きが始まった」＝「n-1 回目の tick は配り終えている」
    const deadline = Date.now() + 5000;
    while (polls <= ticks && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    stop();
  }
  // 止めた時点で走っている tick の配りを取りこぼさない
  await new Promise((r) => setTimeout(r, 30));
  return { delivered, logs };
}

const failed = (eventId: number, reason: string): Record<string, unknown> => ({
  eventId,
  type: "task_failed",
  timestamp: new Date(0).toISOString(),
  projectTag: "banto",
  taskId: "task-0042",
  reason,
});

const ECONNRESET = "rework session spawn failed: read ECONNRESET";

describe("[a1] 同じ event id は、一度配ったら二度と配らない", () => {
  it("引き先が読み位置を無視して同じ出来事を返し続けても、届くのは1通", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET)],
      });
      assert.equal(
        delivered.length,
        1,
        `同じ出来事が ${delivered.length} 回届いた（実機で起きたのがこの形）`
      );
      assert.match(delivered[0]!, /task-0042 が止まりました/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[a2] 配達済みの印は、起こし直しをまたいで残る", () => {
  it("同じ帳面で起こし直しても、古い出来事はまとめて再送されない", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    try {
      const first = await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      assert.equal(first.delivered.length, 1);

      const second = await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      assert.deepEqual(second.delivered, [], "起こし直した直後に再送された");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **読み位置だけでは足りない。** `notify` は番頭のターンが空くまで返らないので、
   * 100件を捌く間ずっと読み位置が書かれないことがある。その途中で落とされる
   * （起こし直しは kill -9）と、読み位置は古いまま残る——配り終えた分が丸ごと再送される。
   * 印はそこを埋めるためにあるので、**読み位置を巻き戻して**確かめる。
   */
  it("読み位置が巻き戻っていても、印のある出来事は配らない", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    try {
      await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      const ledger = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as {
        lastEventId: number;
        delivered: number[];
      };
      assert.ok(ledger.delivered.includes(7), "配達済みの印が残っていない");
      fs.writeFileSync(cursorPath, JSON.stringify({ ...ledger, lastEventId: 0 }), "utf-8");

      const again = await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      assert.deepEqual(again.delivered, [], "読み位置が巻き戻ると再送された");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **印を付ける向きを間違えると、今度は知らせが消える。**
   *
   * 滞留（`task_stalled`）は1件ずつではなく束にして配るので、配られるのは
   * ループを抜けた後。ところが読み位置はループの中で1通ごとに書かれる——
   * そのまま進めると「滞留の id を追い越した読み位置」が先にディスクへ残り、
   * 束を配る前（`notify` は番頭のターンが空くまで返らない）に kill -9 されると、
   * **その滞留の知らせは一度も配られないまま消える**。
   * 落としてよいのは「同じ出来事の2回目以降」だけである（inc-0069）。
   */
  it("束を配っている最中に落とされても、起こし直しで滞留の知らせは届く", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    const stalledEvent = (eventId: number): Record<string, unknown> => ({
      eventId,
      type: "task_stalled",
      timestamp: new Date(0).toISOString(),
      projectTag: "banto",
      taskId: "task-0042",
      status: "failed",
      dwellMs: 3_600_000,
      thresholdMs: 1_800_000,
    });
    try {
      const delivered: string[] = [];
      let hanging = false;
      const tools = [
        {
          name: "kobo.events",
          async execute() {
            return {
              content: [],
              details: {
                events: [stalledEvent(1), failed(2, ECONNRESET)],
                origins: { "banto/task-0042": threadOrigin("th-1") },
              },
            };
          },
        },
        {
          name: "kobo.task",
          async execute() {
            return {
              content: [],
              details: { task: { status: "failed" }, reviewStage: "banto" },
            };
          },
        },
      ] as unknown as NamespacedToolDefinition[];

      const stop = startKoboNotices({
        tools,
        async notify(message) {
          if (/止まっています/.test(message)) {
            // 番頭のターンが空かないまま落とされる（＝ kill -9 の窓）
            hanging = true;
            await new Promise<void>(() => undefined);
            return;
          }
          delivered.push(message);
        },
        cursorPath,
        intervalMs: 10_000,
        log: () => undefined,
      });
      const deadline = Date.now() + 5000;
      while (!hanging && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      stop();
      assert.ok(hanging, "滞留の束を配るところまで進まなかった（試験の前提が崩れている）");
      assert.equal(delivered.length, 1, "落ちた知らせが配られていない");

      const ledger = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as {
        lastEventId: number;
        delivered: number[];
      };
      assert.ok(
        ledger.lastEventId < 1,
        `まだ配っていない滞留 #1 を読み位置が追い越した（lastEventId=${ledger.lastEventId}）`
      );
      assert.ok(!ledger.delivered.includes(1), "配っていない滞留に配達済みの印が付いた");

      // 起こし直し：滞留は届き、配り終えていた分は再送されない
      const again = await runKobo(cursorPath, {
        events: [stalledEvent(1), failed(2, ECONNRESET)],
      });
      assert.equal(again.delivered.length, 1, "滞留が消えた、または配り終えた分が再送された");
      assert.match(again.delivered[0]!, /止まっています/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[a3] 新しい出来事は必ず配る（抑制が新着を食わない）", () => {
  it("印のある出来事に混ざっていても、新しい event id は届く", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    try {
      const first = await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      assert.equal(first.delivered.length, 1);

      const second = await runKobo(cursorPath, {
        events: [failed(7, ECONNRESET), failed(8, "verify_timeout: a4")],
      });
      assert.equal(second.delivered.length, 1, "新しい出来事が届いていない、または再送がある");
      assert.match(second.delivered[0]!, /待ち切れませんでした/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PO の札が立っていなければ、同じ内容でも別の出来事なら両方届く", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
      });
      assert.equal(delivered.length, 2, "札が立っていないのに抑えている（消えたら気づけない）");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[a4] PO 判断待ちの札が立っている間、同じ催促を繰り返さない", () => {
  const board =
    "- 【判断待ち】 in-248b13b7 番頭 / decision: task-0042 の直し方を決めてほしい\n" +
    "    求める判断: 積み直すか、畳むか";

  it("札が立っているタスクの、同じ種類・同じ中身の催促は1通だけ", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
        inbox: board,
      });
      assert.equal(delivered.length, 1, `判断待ちの件で催促が ${delivered.length} 通届いた`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("札が立っていても、**中身の違う知らせ**は届く", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, "scope_violation: src/x.ts")],
        inbox: board,
      });
      assert.equal(delivered.length, 2, "違う理由で落ちたことが握り潰された");
      assert.match(delivered[1]!, /スコープの外/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("札が下りたら、次の同じ催促は届く", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    try {
      const first = await runKobo(cursorPath, {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
        inbox: board,
      });
      assert.equal(first.delivered.length, 1);

      // 取次が空＝札が下りた
      const second = await runKobo(cursorPath, {
        events: [failed(9, ECONNRESET)],
        inbox: "取次は空です（POを待たせているものはありません）。",
      });
      assert.equal(second.delivered.length, 1, "札が下りたのに催促が抑えられたままになっている");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("取次が引けないことを「札が立っている」と読まない（届く方へ倒す）", async () => {
    const dir = tmpDir();
    try {
      // inbox 未配線＝`inbox.list` が引けない構成
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
      });
      assert.equal(delivered.length, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("レビューの段が `po` なら、取次を見るまでもなく判断待ちとして扱う（決定57）", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
        reviewStage: "po",
      });
      assert.equal(delivered.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("[a6] 抑えたことは記録から読める（黙って落とさない・I2）", () => {
  it("配達済みで落としたことがログに出る", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "cursor.json");
    try {
      await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      const { logs } = await runKobo(cursorPath, { events: [failed(7, ECONNRESET)] });
      assert.ok(
        logs.some((l) => l.includes("#7") && l.includes("配達済み")),
        `落としたことが記録に出ていない: ${logs.join(" / ")}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PO 判断待ちで催促を抑えたことがログに出る", async () => {
    const dir = tmpDir();
    try {
      const { logs } = await runKobo(path.join(dir, "cursor.json"), {
        events: [failed(7, ECONNRESET), failed(8, ECONNRESET)],
        reviewStage: "po",
      });
      assert.ok(
        logs.some((l) => l.includes("PO の判断待ち") && l.includes("task_failed")),
        `抑えたことが記録に出ていない: ${logs.join(" / ")}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 職人の知らせ ─────────────────────────────────────────────────────────────

const workerEvent = (
  id: number,
  type: WorkerEvent["type"],
  data: Record<string, unknown>
): WorkerEvent => ({
  id,
  at: new Date(0).toISOString(),
  type,
  kind: "fact",
  origin: threadOrigin("th-1"),
  projectTag: "banto",
  taskId: "probe-worker-pool",
  sessionId: "s-1",
  data,
});

type WorkerTools = Parameters<typeof startWorkerNotices>[0]["tools"];

/** `worker.events` の身代わり（読み位置は素直に効かせる）。 */
function workerTools(events: WorkerEvent[], onPoll?: () => void): WorkerTools {
  return [
    {
      name: "worker.events",
      async execute(args: { sessionId?: string; afterEventId?: number }) {
        const after = args.afterEventId ?? 0;
        if (args.sessionId !== undefined) {
          // 「配る瞬間の様子」——そのあとに積まれた分
          return {
            details: {
              events: events.filter((e) => e.sessionId === args.sessionId && e.id > after),
            },
          };
        }
        onPoll?.();
        return {
          details: {
            events: events.filter((e) => e.id > after),
            lastEventId: events.length > 0 ? events[events.length - 1]!.id : 0,
          },
        };
      },
    },
  ] as unknown as WorkerTools;
}

/** 職人の配り役を数 tick 回して、届いた札とログを返す。 */
async function runWorker(
  events: WorkerEvent[],
  cursorPath: string,
  reset = true
): Promise<Run> {
  const delivered: string[] = [];
  const logs: string[] = [];
  let polls = 0;
  if (reset) fs.writeFileSync(cursorPath, JSON.stringify({ lastEventId: 0 }), "utf-8");

  const tools = workerTools(events, () => {
    polls += 1;
  });

  const stop = startWorkerNotices({
    tools,
    async notify(message) {
      delivered.push(message);
    },
    cursorPath,
    intervalMs: 10,
    log: (m) => logs.push(m),
  });
  try {
    const deadline = Date.now() + 5000;
    while (polls <= 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    stop();
  }
  await new Promise((r) => setTimeout(r, 30));
  return { delivered, logs };
}

/**
 * [a5] **番頭が畳んだ職人の報告が、取り下げ札として「再送」されない。**
 *
 * ここで直すのは**再送**であって、取り下げ札そのものではない。inc-0069 で決めたとおり、
 * **まだ配っていない**知らせは、配る時点で用が済んでいても【取り下げ】として配る
 * （`worker-notice-delivery.spec.ts` の [2][3][4] がそれを固めている）——番頭がその報告を
 * まだ読んでいないなら、届かないより粗い方がよい。
 *
 * 実機で起きたのは**もう配った報告**の2周目である。番頭はその報告を読んで職人を畳んだのに、
 * 同じ報告がもう一度読み直され、そのときには畳み済みだったので【取り下げ】として届いた。
 *
 * 2周目が起きる筋は読み位置にある：位置は「まだ配れていない一番古い知らせの手前」で止まる。
 * 会話ごとに別の列で配るので、番頭が片方の会話で長考している間に**後ろの知らせが先に
 * 配り終わる**——その分は位置より先にあり、起こし直すと読み直される。
 */
describe("[a5] 番頭が畳んだ職人の報告は、取り下げ札として再送されない", () => {
  it("配り終えた報告は、そのあと番頭が畳んでも二度と配られない", async () => {
    const dir = tmpDir();
    const cursorPath = path.join(dir, "worker-cursor.json");
    let release: () => void = () => undefined;
    const longTurn = new Promise<void>((r) => {
      release = r;
    });
    try {
      const slow = workerEvent(1, "worker_reported", { summary: "長考している会話" });
      const read: WorkerEvent = {
        ...workerEvent(2, "worker_reported", { summary: "worker-pool を突いてみました" }),
        origin: threadOrigin("th-2"),
        sessionId: "s-2",
      };
      const events = [slow, read];
      fs.writeFileSync(cursorPath, JSON.stringify({ lastEventId: 0 }), "utf-8");

      const first: string[] = [];
      const stop = startWorkerNotices({
        tools: workerTools(events),
        async notify(message, target) {
          if (target.threadId === "th-1") await longTurn;
          first.push(message);
        },
        cursorPath,
        intervalMs: 10,
        log: () => undefined,
      });
      const deadline = Date.now() + 5000;
      while (first.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      stop();
      assert.equal(first.length, 1, "空いている会話の分が配り終わっていない");
      assert.match(first[0]!, /worker-pool を突いてみました/);

      // 長考の会話を配れないまま落ちた状態の帳面
      const ledger = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as {
        lastEventId: number;
        delivered: number[];
      };
      assert.equal(ledger.lastEventId, 0, "配れていない分まで読み位置が進んでいる");
      assert.deepEqual(ledger.delivered, [2], "先に配り終えた分の印が残っていない");
      const restarted = path.join(dir, "restarted.json");
      fs.writeFileSync(restarted, JSON.stringify(ledger), "utf-8");

      // 番頭は報告を読んで、その職人を畳んだ
      events.push({ ...workerEvent(3, "worker_closed", { reason: "done" }), sessionId: "s-2" });

      const again = await runWorker(events, restarted, false);
      assert.ok(
        !again.delivered.some((m) => m.includes("worker-pool を突いてみました")),
        "既に読んだ報告が【取り下げ】として届いた（実機で起きたのがこの形）"
      );
      assert.equal(again.delivered.length, 1, "長考していた会話の分が届いていない");
      assert.match(again.delivered[0]!, /長考している会話/);
      // a6: 黙って落とさない
      assert.ok(
        again.logs.some((l) => l.includes("#2") && l.includes("配達済み")),
        `落としたことが記録に出ていない: ${again.logs.join(" / ")}`
      );
    } finally {
      release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **1周目は今までどおり配る**（inc-0069 を崩さない）。番頭がまだ読んでいない報告は、
   * 畳み済みでも【取り下げ】として届く——落とすのは「同じ出来事の2回目以降」だけである。
   */
  it("まだ配っていない報告は、畳み済みでも取り下げ札として届く", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runWorker(
        [
          workerEvent(1, "worker_reported", { summary: "終わりました" }),
          workerEvent(2, "worker_closed", { reason: "done" }),
        ],
        path.join(dir, "worker-cursor.json")
      );
      assert.equal(delivered.length, 1);
      assert.match(delivered[0]!, /【取り下げ】/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("畳まれていない職人の報告は今までどおり届く", async () => {
    const dir = tmpDir();
    try {
      const { delivered } = await runWorker(
        [workerEvent(1, "worker_reported", { summary: "終わりました" })],
        path.join(dir, "worker-cursor.json")
      );
      assert.equal(delivered.length, 1);
      assert.doesNotMatch(delivered[0]!, /【取り下げ】/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
