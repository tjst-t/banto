/**
 * task-0232: 先に消えた子プロセスの stdin へ書いて EPIPE で落ちるのを止める。
 *
 * pi-rpc-driver.ts は起動直後、200ms 待ってから get_state を子の stdin へ書く。
 * 負荷が高いと子は 200ms を待たずに死ぬことがある——Node の timers フェーズは
 * poll フェーズ（子の exit を検知する側）より先に回るため、イベントループが
 * 詰まっていると、死んだことが exitCode に反映されるより先に書き込みが走ることが
 * ある。死んだ子の stdin へ書けば `write EPIPE` になり、しかも `proc.stdin` に
 * error ハンドラが無いと、その EPIPE はそのまま uncaughtException になって
 * 親プロセスごと落ちる。
 *
 * ここでは「わざと即死する子を spawn し、直後にイベントループを busy-loop で
 * 止めてから書き込みを起こす」ことで、実際の負荷を待たずに決定的にこの順序を
 * 再現する。busy-loop を外すと、通常は子の exit イベントが 200ms の余裕をもって
 * 先に届くため、この再現には至らない。
 *
 * D6: node:test, node:child_process, node:fs のみで完結させる。LLM もネットワークも使わない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PiRpcDriver } from "@banto/worker-pool";

// ── 即死する偽の pi ────────────────────────────────────────────────────────
// 起動直後に stderr へ目印を書いてから終了する。RPC には一切応答しない
// （spawn 直後に落ちる／メモリ不足で死ぬ、を模している）。
const DIES_IMMEDIATELY = `
process.stderr.write("stub: dying immediately (imitates death under load)\\n");
process.exit(9);
`;

// ── get_state にだけ答える、生きたままの偽の pi ──────────────────────────────
const STAYS_ALIVE = `
import * as readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type === "get_state") {
    process.stdout.write(JSON.stringify({
      id: cmd.id, type: "response", command: "get_state", success: true,
      data: { sessionId: "clean-session", sessionFile: "clean-session.jsonl" },
    }) + "\\n");
  }
});
setTimeout(() => process.exit(0), 30_000);
`;

let tmpDir: string;
let diesImmediatelyPath: string;
let staysAlivePath: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-child-stdin-epipe-"));
  diesImmediatelyPath = path.join(tmpDir, "dies-immediately.mjs");
  fs.writeFileSync(diesImmediatelyPath, DIES_IMMEDIATELY, "utf8");
  staysAlivePath = path.join(tmpDir, "stays-alive.mjs");
  fs.writeFileSync(staysAlivePath, STAYS_ALIVE, "utf8");
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** イベントループを同期的に止める。負荷が高いときと同じ順序（timers→poll）を強制する。 */
function busySpinMs(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // わざと busy-spin する。負荷下と同じ「イベントループが詰まる」状態を作るため。
  }
}

describe("[task-0232] 先に消えた子の stdin へ書いても EPIPE で落ちない", () => {
  it("[a1][a2] 即死する子への get_state 書き込みは、EPIPE ではなく理由が分かる形で失敗し、親は落ちない", async () => {
    const sessionDir = path.join(tmpDir, "dead", "sessions");
    const worktree = path.join(tmpDir, "dead", "wt");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    const driver = new PiRpcDriver({ sessionBaseDir: sessionDir, piCliPath: diesImmediatelyPath });

    // proc.stdin に error ハンドラが無ければ、EPIPE がここに飛んでテストプロセスごと落ちる
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);

    let caught: Error | undefined;
    try {
      // spawn() は最初の await に達するまで同期的に走る。その中で
      // 200ms の問い合わせタイマーと exit リスナーの登録が既に終わっている。
      const spawnPromise = driver.spawn({
        taskId: "dead",
        worktreePath: worktree,
        sessionPath: path.join(sessionDir, "dead.jsonl"),
        systemPrompt: "stub",
        tools: [],
      });

      // 負荷が高いときと同じ順序を、実際の負荷を待たず決定的に作る。
      busySpinMs(300);

      await spawnPromise;
    } catch (err) {
      caught = err as Error;
    }

    // uncaughtException は非同期に飛ぶので一呼吸置いてから確かめる
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onUncaught);

    assert.ok(caught, "即死する子への spawn は失敗するはず");
    assert.doesNotMatch(
      caught!.message,
      /EPIPE/,
      `EPIPE をそのまま出さない。実際のメッセージ: ${caught!.message}`
    );
    assert.match(
      caught!.message,
      /exit=9|signal=/,
      `子が先に終わったと分かる理由が要る。実際のメッセージ: ${caught!.message}`
    );
    assert.match(
      caught!.message,
      /dying immediately/,
      `子の stderr の末尾が含まれているはず。実際のメッセージ: ${caught!.message}`
    );
    assert.equal(
      uncaught.length,
      0,
      `proc.stdin の error が uncaughtException になっている: ${uncaught.map((e) => e.message).join(", ")}`
    );
  });

  it("[a3] 決着したあとは 200ms/3000ms のタイマーが止まっている（同じ書き込みをやり直さない）", async () => {
    const sessionDir = path.join(tmpDir, "clean", "sessions");
    const worktree = path.join(tmpDir, "clean", "wt");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });

    type TimeoutId = ReturnType<typeof setTimeout>;
    const scheduled = new Map<TimeoutId, number>();
    const cleared = new Set<TimeoutId>();
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    // 生き残ったタイマーを外から観測する手段が無いので、テストの中だけ薄くラップする。
    global.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      const id = originalSetTimeout(handler, timeout, ...args);
      if (timeout === 200 || timeout === 3000) scheduled.set(id, timeout);
      return id;
    }) as typeof setTimeout;
    global.clearTimeout = ((id?: TimeoutId) => {
      if (id !== undefined) cleared.add(id);
      return originalClearTimeout(id);
    }) as typeof clearTimeout;

    let driver: PiRpcDriver | undefined;
    let sessionId: string | undefined;
    try {
      driver = new PiRpcDriver({ sessionBaseDir: sessionDir, piCliPath: staysAlivePath });
      const handle = await driver.spawn({
        taskId: "clean",
        worktreePath: worktree,
        sessionPath: path.join(sessionDir, "clean.jsonl"),
        systemPrompt: "stub",
        tools: [],
      });
      sessionId = handle.sessionId;
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }

    const uncleared = [...scheduled.entries()].filter(([id]) => !cleared.has(id));
    assert.equal(
      uncleared.length,
      0,
      `決着後もタイマーが残っている（delay: ${uncleared.map(([, d]) => d).join(", ")}）`
    );

    if (driver && sessionId) await driver.kill(sessionId);
  });
});
