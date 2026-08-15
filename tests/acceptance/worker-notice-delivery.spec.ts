/**
 * inc-0069: 職人の報告が番頭の会話に届かない（あるいは、手遅れになってから届く）。
 *
 * 2026-08-14 に1日で4例出た。工房（Worker Pool）の帳簿にはすべて残っているので、
 * 落ちているのは記録ではなく **工房 → 番頭ホスト → 会話** の配送経路である。
 *
 * | # | 見えかた |
 * |---|---|
 * | 1 | 報告が来ない |
 * | 2 | 解決済みの報告が遅れて「判断待ち」として届く |
 * | 3 | 既に畳んだ職人について「畳んでください」と催促が届く |
 * | 4 | 停止済みの職人から遅れて結果が届く |
 *
 * **本物の Worker Pool と本物のイベントログで見る。** 偽の `worker.events` で済ませると、
 * 「知らせを渡す側」だけを検査して、肝心の読み位置と鮮度の判定を通さずに終わる。
 * 差し替えるのは `notify`（＝番頭のターン）だけ——ここが「時間がかかる」ことこそが
 * 事故の元なので、かかる時間をテストが握れないと検体にならない。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { BantoHostServer, ThreadRegistry } from "@banto/host";
import { WorkerPool } from "../../packages/banto-worker-pool/src/pool.js";
import { createWorkerTools } from "../../packages/banto-worker-pool/src/worker-tools.js";
import {
  startWorkerNotices,
  renderWorkerNotice,
  withdrawnBecause,
} from "../../packages/banto-host/src/worker-notice.js";
import type { WorkerEvent } from "../../packages/banto-worker-pool/src/event-log.js";
import { FakeRuntimeDriver } from "./worker-pool-harness.js";

/** 番頭のハーネスの身代わり。プロバイダを呼ばずに、届いた文面だけを覚える。 */
class NoticeHarness implements BantoHarness {
  readonly sessionId = "notice-harness";
  readonly backendId = "fake";
  isStreaming = false;
  readonly prompts: string[] = [];

  subscribe(_listener: (event: HarnessEvent) => void): () => void {
    return () => undefined;
  }
  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }
  async abort(): Promise<void> {}
  contextWindow(): number | undefined {
    return undefined;
  }
  contextTokens(): number | undefined {
    return undefined;
  }
  messageCount(): number {
    return 0;
  }
  transcript(): string {
    return "";
  }
  async startChapter(): Promise<void> {}
}

let dir: string;
let driver: FakeRuntimeDriver;
let pool: WorkerPool;
const stops: Array<() => void> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-notice-delivery-"));
  driver = new FakeRuntimeDriver();
  pool = new WorkerPool({
    driver,
    dataDir: path.join(dir, "pool"),
    defaultProjectTag: "banto",
    defaultOrigin: "banto",
    // 安全弁が途中で職人を畳むと、見たいものが消える
    idleTimeoutMs: 0,
  });
});

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const worker of pool.list({ includeClosed: false })) {
    await pool.close(worker.sessionId, "stopped").catch(() => undefined);
  }
  pool.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 職人を1人起こす。`origin` はスレッド宛（決定35a）。 */
async function spawnWorker(threadId: string, taskId: string): Promise<string> {
  const worktreePath = path.join(dir, "wt", taskId);
  fs.mkdirSync(worktreePath, { recursive: true });
  const worker = await pool.delegate({
    origin: `banto:${threadId}`,
    taskId,
    worktreePath,
    instruction: "やってください",
  });
  return worker.sessionId;
}

/** 会話へ入った知らせ（宛先つき）。 */
interface Delivered {
  message: string;
  threadId: string | undefined;
}

/**
 * `notify` の身代わり。**番頭のターンにかかる時間をテストが握る**ための仕掛け。
 *
 * 実物の `server.notify` は番頭のターンが終わるまで解決しない。今回の事故は
 * まさにそこで詰まったので、「解決しないまま置いておける notify」が要る。
 */
function makeNotify(): {
  notify: (message: string, target: { threadId?: string }) => Promise<void>;
  delivered: Delivered[];
  /** 解決させずに握っているスレッド（そのターンがまだ終わっていない）。 */
  hold(threadId: string): void;
  release(threadId: string): void;
} {
  const delivered: Delivered[] = [];
  const held = new Map<string, Array<() => void>>();
  const holding = new Set<string>();
  return {
    delivered,
    notify(message, target) {
      const key = target.threadId ?? "";
      delivered.push({ message, threadId: target.threadId });
      if (!holding.has(key)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const queue = held.get(key) ?? [];
        queue.push(resolve);
        held.set(key, queue);
      });
    },
    hold(threadId) {
      holding.add(threadId);
    },
    release(threadId) {
      holding.delete(threadId);
      for (const resolve of held.get(threadId) ?? []) resolve();
      held.set(threadId, []);
    },
  };
}

/** 条件が満たされるまで待つ（時間ではなく状態を待つ）。 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("待っていた状態にならなかった");
}

function start(
  notify: (message: string, target: { threadId?: string }) => Promise<void>,
  options: { cursorPath?: string } = {}
): () => void {
  const stop = startWorkerNotices({
    tools: createWorkerTools(pool),
    notify,
    intervalMs: 30,
    ...(options.cursorPath ? { cursorPath: options.cursorPath } : {}),
    log: () => undefined,
  });
  stops.push(stop);
  return stop;
}

/** 会話に入った知らせのうち、その職人についてのもの。 */
function noticesFor(delivered: Delivered[], sessionId: string): string[] {
  return delivered.filter((d) => d.message.includes(sessionId)).map((d) => d.message);
}

describe("[inc-0069/1] 報告が来ない", () => {
  /**
   * **一番の本体。** 番頭が長いターンを回している間、引き役（poller）が
   * `await notify` のまま止まっていた。止まるのは1本の会話ではなく**引き役そのもの**
   * なので、無関係な会話の職人の報告まで、まとめて足止めされる。
   */
  it("片方の会話のターンが終わらなくても、もう片方の会話へは報告が届く", async () => {
    const slow = await spawnWorker("thread-A", "task-slow");
    const other = await spawnWorker("thread-B", "task-other");
    const { notify, delivered, hold, release } = makeNotify();

    // thread-A の番頭は長考中（ターンが終わらない）
    hold("thread-A");
    start(notify);

    pool.report(slow, "A の報告", { done: true });
    await until(() => noticesFor(delivered, slow).length > 0);

    // A が詰まっている最中に B が報告する
    pool.report(other, "B の報告", { done: true });
    await until(() => noticesFor(delivered, other).length > 0, 5_000);

    release("thread-A");
  });

  /**
   * 同じ会話の中では順番を守る（報告が前後すると読めなくなる）。
   * 上の「詰まらない」は、**会話をまたいで**の話であって、順序を捨てる話ではない。
   */
  it("同じ会話の中では、前の知らせが片付くまで次を積まない", async () => {
    const session = await spawnWorker("thread-A", "task-a");
    const { notify, delivered, hold, release } = makeNotify();
    hold("thread-A");
    start(notify);

    pool.report(session, "1通目", { done: false });
    await until(() => delivered.length === 1);

    pool.report(session, "2通目", { done: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(delivered.length, 1, "前のターンが終わる前に次を積んでいる");

    release("thread-A");
    await until(() => delivered.length === 2);
  });

  /**
   * 番頭ホストが落ちている間に出た報告が消えない（読み位置をファイルに持つ）。
   *
   * 工場（`kobo-cursor.json`）・検証環境（`env-cursor.json`）は既にそうしているのに、
   * 職人だけがメモリ上の読み位置だった——落ちた瞬間に、届いていない報告が消える。
   */
  it("引き役を止めている間に出た報告が、次に立ち上げたとき届く", async () => {
    const cursorPath = path.join(dir, "worker-cursor.json");
    const session = await spawnWorker("thread-A", "task-a");

    const first = makeNotify();
    const stopFirst = start(first.notify, { cursorPath });
    pool.report(session, "1通目", { done: false });
    await until(() => first.delivered.length === 1);
    stopFirst();

    // 止まっている間の報告
    pool.report(session, "落ちている間の報告", { done: true });

    const second = makeNotify();
    start(second.notify, { cursorPath });
    await until(() => second.delivered.length >= 1, 5_000);
    assert.ok(
      second.delivered.some((d) => d.message.includes("落ちている間の報告")),
      "落ちている間に出た報告が消えている"
    );
    assert.ok(
      !second.delivered.some((d) => d.message.includes("1通目")),
      "既に届けた分をもう一度流している（二重配送）"
    );
  });
});

describe("[inc-0069/2-4] 遅れて届く知らせが、古い写しのまま届く", () => {
  /**
   * **番頭の見立て**（この incident の起票時）：「知らせが、送られる瞬間の事実ではなく、
   * 出来事が起きた瞬間の写しのまま届く」。imp-0021 と同じ構図——知らせの寿命。
   */
  it("[2] 解決済みの報告は、判断を求める文面のままでは届かない", async () => {
    const session = await spawnWorker("thread-A", "task-a");
    const { notify, delivered, hold, release } = makeNotify();
    hold("thread-A");
    start(notify);

    // 1通目で引き役の足を止め、その裏で報告 → 番頭が自分で片付ける、を再現する
    pool.report(session, "足止め", { done: false });
    await until(() => delivered.length === 1);

    pool.report(session, "終わりました", { done: true });
    await pool.close(session, "done");

    release("thread-A");
    await until(() => delivered.length >= 2, 5_000);
    const late = delivered.find((d) => d.message.includes("終わりました"));
    assert.ok(late, "報告そのものが消えている");
    assert.ok(
      late!.message.includes("取り下げ"),
      "既に片が付いたのに、判断待ちの札のまま届いている"
    );
    assert.ok(
      !late!.message.includes("worker.close で畳んでください"),
      "畳み済みの職人について、もう一度畳めと求めている"
    );
  });

  it("[3] 既に畳んだ職人について「畳んでください」と催促しない", async () => {
    const session = await spawnWorker("thread-A", "task-a");
    const { notify, delivered, hold, release } = makeNotify();
    hold("thread-A");
    start(notify);

    pool.report(session, "足止め", { done: false });
    await until(() => delivered.length === 1);

    // 「報告はしたが手が止まっている」＝畳んでくださいと催促する種類の知らせ
    // settled は工房が決める。直前の報告が done:false なので settled:false になる
    const ended = pool.turnEnded(session, { text: "ひととおり終わりました", reported: true });
    assert.equal(ended.data["settled"], false, "検体になっていない（知らせない側の分岐）");
    await pool.close(session, "done");

    release("thread-A");
    await until(() => delivered.length >= 2, 5_000);
    const late = delivered[delivered.length - 1]!;
    assert.ok(
      !late.message.includes("worker.close で"),
      "畳み済みの職人に「worker.close で畳んでください」と催促している"
    );
    assert.ok(late.message.includes("取り下げ"), "取り下げたことが読めない");
  });

  it("[4] 停止済みの職人から遅れて届いた結果は、そう分かる形で届く", async () => {
    const session = await spawnWorker("thread-A", "task-a");
    const { notify, delivered, hold, release } = makeNotify();
    hold("thread-A");
    start(notify);

    pool.report(session, "足止め", { done: false });
    await until(() => delivered.length === 1);

    pool.report(session, "遅れてきた結果", { done: true });
    await pool.close(session, "stopped");

    release("thread-A");
    await until(() => delivered.length >= 2, 5_000);
    const late = delivered.find((d) => d.message.includes("遅れてきた結果"))!;
    assert.ok(late, "止めた職人の結果が消えている");
    assert.ok(
      late.message.includes("停止"),
      `止めた職人からの後追いだと読めない: ${late.message}`
    );
  });

  it("状態が動いていなければ、今までどおり判断を求める文面で届く", async () => {
    const session = await spawnWorker("thread-A", "task-a");
    const { notify, delivered } = makeNotify();
    start(notify);

    pool.report(session, "終わりました", { done: true });
    await until(() => delivered.length >= 1);
    const notice = delivered[0]!.message;
    assert.ok(!notice.includes("取り下げ"), "動いていないのに取り下げている");
    assert.ok(
      notice.includes("worker.close で畳んでください"),
      "判断を求める文面が消えている"
    );
  });
});

describe("[inc-0069/1] 1度転んだだけで、その会話の知らせが以後ぜんぶ消えない", () => {
  /**
   * 会話ごとの配送列は `thread.notices` に `.then` を継ぎ足す形で作られている。
   * どこかが1度投げると Promise は rejected のまま残り、**以後の `.then` は本体すら
   * 走らない**——その会話に来る職人の報告が、エラーも出さずに全部消える。
   *
   * 「静かに繰り返す種類の事故」（inc-0069）の、いちばん静かな形。
   */
  it("知らせの途中で転んでも、次の知らせは会話に入る", async () => {
    let blowUp = true;
    const harness = new NoticeHarness();
    const threads = new ThreadRegistry(async () => ({
      harness,
      tools: [],
      // 実物ではハーネス側が持つ口。ここが投げると列が毒される
      getLastError: () => {
        if (!blowUp) return undefined;
        blowUp = false;
        throw new Error("ハーネスが一時的に転んだ");
      },
    }));
    await threads.open({ kind: "trunk" });
    /**
     * 宛先は**枝**にする（T3）。幹宛ての知らせは用件ごとの枝へ回るので、幹へ2通送ると
     * 別々の枝＝**別々の列**になり、ここで見たい「1本の列が毒される」形が作れない。
     */
    const thread = await threads.open({
      kind: "branch",
      title: "報告の宛先",
      returnCondition: "報告を捌いたら",
      openedBy: "banto",
      reason: "列が毒されないことを見るため",
    });
    const server = await BantoHostServer.start({ threads, port: 0 });
    try {
      await server.notify("1通目", { threadId: thread.id, source: "worker" });
      await server.notify("2通目", { threadId: thread.id, source: "worker" });
      assert.deepEqual(
        harness.prompts,
        ["1通目", "2通目"],
        "1度転んだあと、その会話への知らせが番頭に届かなくなっている"
      );
    } finally {
      await server.close();
    }
  });
});

describe("[inc-0069] 鮮度の判定そのもの", () => {
  const base = (over: Partial<WorkerEvent> = {}): WorkerEvent => ({
    id: 10,
    at: "2026-08-14T09:48:48.000Z",
    type: "worker_reported",
    kind: "claim",
    origin: "banto:thread-A",
    projectTag: "banto",
    taskId: "task-a",
    sessionId: "s-1",
    data: { summary: "終わりました", done: true },
    ...over,
  });
  const later = (type: WorkerEvent["type"], data: Record<string, unknown> = {}): WorkerEvent =>
    base({ id: 11, type, kind: "fact", data });

  it("後続が無ければ取り下げない", () => {
    assert.equal(withdrawnBecause(base(), []), undefined);
  });

  it("畳まれていれば取り下げる", () => {
    const why = withdrawnBecause(base(), [later("worker_closed", { reason: "done" })]);
    assert.ok(why?.includes("畳"), String(why));
  });

  it("止められていれば、そう言う", () => {
    const why = withdrawnBecause(base(), [later("worker_closed", { reason: "stopped" })]);
    assert.ok(why?.includes("停止"), String(why));
  });

  it("質問に答えが出ていれば取り下げる", () => {
    const asked = base({ type: "worker_asked", data: { question: "どちらですか" } });
    assert.ok(withdrawnBecause(asked, [later("worker_answered")]));
  });

  it("「手が空きました」のあとに報告が来ていれば取り下げる", () => {
    const ended = base({ type: "worker_turn_ended", data: { settled: false, text: "ふむ" } });
    assert.ok(withdrawnBecause(ended, [later("worker_reported")]));
  });

  it("取り下げた知らせも、中身は消さずに残す（imp-0021 の作法）", () => {
    const event = base();
    const notice = renderWorkerNotice(event, [later("worker_closed", { reason: "done" })])!;
    assert.ok(notice.includes("終わりました"), "本文が消えている");
    assert.ok(notice.includes("取り下げ"), "取り下げたことが読めない");
  });
});
