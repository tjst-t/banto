/**
 * T1: ターンの台帳（docs/proposals/2026-08-15-trunk-availability-plan.md）。
 *
 * `turn_start`/`turn_end` は WS へ broadcast されるだけでどこにも残らないため、
 * 「幹のターンが1日に何本回り、どの出所から来たか」を機械的に数えられない。
 * ここでは台帳（turns.jsonl）が
 *   - 知らせ1件で1行だけ増え、source が呼び出し側の値になること
 *   - PO の発話で `source: "po"` が残ること
 *   - 失敗したターンで `ok: false` と `errorMessage` が残ること
 * を確かめる。集計は turn-report の純粋関数（`summarize`）を直接叩く。
 *
 * server は FakeSession（プロバイダを一切呼ばない）で組み、台帳は一時ディレクトリへ
 * 向ける。既存の banto-host-server.spec.ts と同じ土台。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BantoHarness, HarnessEvent } from "@banto/core";
import { JsonlMemoryStore, ScopedMemory } from "@banto/core";
import {
  ThreadRegistry,
  BANTO_WS_PATH,
  BantoHostClient,
  BantoHostServer,
  createMemoryTools,
  type ServerEvent,
} from "@banto/host";
import { TRUNK, branchSpec } from "./threadSpecs.js";
import { TurnLog, type TurnLogEntry } from "../../packages/banto-host/src/turn-log.js";
import { summarize } from "../../packages/banto-host/src/turn-report.js";

/** テスト用セッション。プロバイダを呼ばずにターンの進行だけをこちらから発火できる。 */
class FakeSession implements BantoHarness {
  readonly sessionId = "test-session";
  isStreaming = false;
  prompts: string[] = [];
  aborted = 0;
  /** true の間は prompt が投げる（失敗したターンの再現用）。 */
  failNext = false;
  private listeners = new Set<(event: HarnessEvent) => void>();

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    if (this.failNext) throw new Error("prompt failed (test)");
    this.prompts.push(text);
  }

  async abort(): Promise<void> {
    this.aborted++;
  }

  emit(event: HarnessEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // ── BantoHarness の残り。この試験では使わない ──
  readonly backendId = "fake";
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
let store: JsonlMemoryStore;
let server: BantoHostServer | undefined;
let session: FakeSession;
let ledger: TurnLog;
let ledgerFile: string;
/** いま立てているホストのスレッド帳簿（試験から枝を開くのに使う）。 */
let threads: ThreadRegistry | undefined;

/** 台帳つきでサーバを立てる。既定スレッド（幹）を1本開いてから立つ。 */
async function startHost(): Promise<{ url: string }> {
  const tools = createMemoryTools(new ScopedMemory(store));
  threads = new ThreadRegistry(async () => {
    session = new FakeSession();
    return { harness: session, tools };
  });
  await threads.open(TRUNK);
  server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });
  return { url: `ws://localhost:${server.port}${BANTO_WS_PATH}` };
}

/** 指定の型のイベントが来るまで待つ。 */
function waitFor(
  events: ServerEvent[],
  type: ServerEvent["type"],
  timeoutMs = 2000,
  where: (e: ServerEvent) => boolean = () => true
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const found = events.find((e) => e.type === type && where(e));
      if (found) {
        clearInterval(tick);
        resolve(found);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(
          new Error(
            `timed out waiting for "${type}"; got: ${events.map((e) => e.type).join(", ")}`
          )
        );
      }
    }, 10);
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-turn-ledger-"));
  store = new JsonlMemoryStore(path.join(dir, "memory.jsonl"));
  ledgerFile = path.join(dir, "turns.jsonl");
  ledger = new TurnLog(ledgerFile);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("[T1] ターンの台帳", () => {
  it("[T1] 知らせ1件で台帳に1行だけ増え、source が呼び出し側の値になる", async () => {
    await startHost();
    assert.equal(fs.existsSync(ledgerFile), false);

    const trunk = threads!.resolve();
    await server!.notify("職人から報告が届きました", { source: "worker" });
    // notify はターンの完走を待って返る（thread.notices の列）

    const entries = ledger.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "worker");
    /**
     * T3: 知らせで**幹のターンは回らない**。1行は用件の枝のもので、親が幹になる
     * ——「幹の行が0本」を数で示せるのが T1 の台帳の役目。
     */
    assert.equal(entries[0]!.threadKind, "branch");
    assert.equal(entries[0]!.parentId, trunk.id);
    assert.equal(entries.filter((e) => e.threadId === trunk.id).length, 0);
    assert.equal(entries[0]!.ok, true);
    assert.equal(entries[0]!.errorMessage, undefined);
    assert.ok(entries[0]!.threadId.length > 0);
    assert.ok(!Number.isNaN(Date.parse(entries[0]!.at)));
    assert.ok(entries[0]!.durationMs >= 0);
  });

  it("[T1] 枝への知らせには threadKind と親の幹の id が残る", async () => {
    const threads = new ThreadRegistry(async () => {
      session = new FakeSession();
      return { harness: session, tools: createMemoryTools(new ScopedMemory(store)) };
    });
    const trunk = await threads.open(TRUNK);
    const branch = await threads.open(branchSpec("枝の相談"));
    server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });

    await server!.notify("枝での調べ物の報告", { threadId: branch.id, source: "worker" });

    const entries = ledger.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.threadId, branch.id);
    assert.equal(entries[0]!.threadKind, "branch");
    assert.equal(entries[0]!.parentId, trunk.id);
  });

  it("[T1] PO の発話で source: \"po\" の行が1行増える", async () => {
    const { url } = await startHost();
    const events: ServerEvent[] = [];
    const client = await BantoHostClient.connect(url, (e) => events.push(e));
    await waitFor(events, "welcome");

    client.send({ type: "prompt", text: "幹で話したい" });
    await waitFor(events, "turn_end");

    const entries = ledger.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "po");
    assert.equal(entries[0]!.threadKind, "trunk");
    assert.equal(entries[0]!.ok, true);
    client.close();
  });

  it("[T1] 枝からの相談（nudge）は source: \"nudge\" で残る", async () => {
    const threads = new ThreadRegistry(async () => {
      session = new FakeSession();
      return { harness: session, tools: createMemoryTools(new ScopedMemory(store)) };
    });
    const trunk = await threads.open(TRUNK);
    server = await BantoHostServer.start({ threads, port: 0, turnLog: ledger });

    await server!.nudge(trunk.id, "枝から相談が来ました");

    const entries = ledger.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "nudge");
    assert.equal(entries[0]!.ok, true);
  });

  it("[T1] ターンが失敗したとき ok: false と errorMessage が残る", async () => {
    await startHost();
    // T3: 知らせは用件の枝で捌かれる。壊すのは**その枝を回すハーネス**
    const branch = await threads!.open(branchSpec("壊れる知らせの枝"));
    session.failNext = true; // `session` は帳簿が最後に組んだ＝この枝のもの

    await server!.notify("壊れる知らせ", { threadId: branch.id, source: "kobo" });

    const entries = ledger.readAll();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.source, "kobo");
    assert.equal(entries[0]!.ok, false);
    // サーバは String(err) で残す（Error は "Error: ..." の形になる）
    assert.equal(entries[0]!.errorMessage, "Error: prompt failed (test)");
  });

  it("[T1] 集計は日付×スレッド×source の内訳を正しく出す", () => {
    const entries: TurnLogEntry[] = [
      {
        at: "2026-08-15T01:00:00.000Z",
        threadId: "thread-1",
        threadKind: "trunk",
        source: "worker",
        durationMs: 100,
        ok: true,
      },
      {
        at: "2026-08-15T02:00:00.000Z",
        threadId: "thread-1",
        threadKind: "trunk",
        source: "worker",
        durationMs: 200,
        ok: true,
      },
      {
        at: "2026-08-15T03:00:00.000Z",
        threadId: "thread-1",
        threadKind: "trunk",
        source: "po",
        durationMs: 300,
        ok: true,
      },
      {
        at: "2026-08-15T04:00:00.000Z",
        threadId: "thread-2",
        threadKind: "branch",
        parentId: "thread-1",
        source: "po",
        durationMs: 400,
        ok: false,
        errorMessage: "落ちた",
      },
      {
        at: "2026-08-16T01:00:00.000Z",
        threadId: "thread-1",
        threadKind: "trunk",
        source: "system",
        durationMs: 500,
        ok: true,
      },
    ];

    const summary = summarize(entries);
    // 日付が昇順で2日
    assert.deepEqual(
      summary.days.map((d) => d.date),
      ["2026-08-15", "2026-08-16"]
    );
    // 15日: 幹 thread-1 は worker 2本 + po 1本、busy 600ms
    const day1 = summary.days[0]!;
    assert.deepEqual(
      day1.threads.map((t) => t.threadId),
      ["thread-1", "thread-2"]
    );
    const trunk = day1.threads.find((t) => t.threadId === "thread-1")!;
    assert.equal(trunk.turns, 3);
    assert.equal(trunk.busyMs, 600);
    assert.deepEqual(trunk.bySource, { worker: 2, po: 1 });
    // 15日: 枝 thread-2 は po 1本（失敗）で、親の幹が分かる
    const branch = day1.threads.find((t) => t.threadId === "thread-2")!;
    assert.equal(branch.threadKind, "branch");
    assert.equal(branch.parentId, "thread-1");
    assert.equal(branch.turns, 1);
    assert.equal(branch.busyMs, 400);
    assert.deepEqual(branch.bySource, { po: 1 });
    // 16日: 幹 thread-1 は system 1本
    const day2 = summary.days[1]!;
    assert.equal(day2.threads.length, 1);
    assert.equal(day2.threads[0]!.bySource.system, 1);
    // 全体
    assert.deepEqual(summary.total, { turns: 5, busyMs: 1500 });

    // --since / --thread の絞り込み
    const since = summarize(entries, { since: "2026-08-16" });
    assert.deepEqual(since.total, { turns: 1, busyMs: 500 });
    const onlyThread2 = summarize(entries, { thread: "thread-2" });
    assert.deepEqual(onlyThread2.total, { turns: 1, busyMs: 400 });
    const both = summarize(entries, { since: "2026-08-16", thread: "thread-2" });
    assert.deepEqual(both.total, { turns: 0, busyMs: 0 });
  });
});
