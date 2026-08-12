/**
 * AC-S654396-4-2: `banto events --follow` streams events via WebSocket.
 *
 * Tests launch the real banto binary as a subprocess (node + tsx loader).
 * Daemon runs as a real HTTP server on an OS-assigned port.
 * Direct import of main() is explicitly prohibited.
 *
 * Scenarios:
 *   1. Connect + subscribe → print connection message
 *   2. REST API creates a task → event appears in stdout while subscribed
 *   3. SIGINT → exit code 0, no stderr errors
 *   4. --after <id> reconnect catches up missed events
 *
 * 持ち時間は「起動を待つ」と「流れてくるのを測る」で分けてある（下の定数・task-0092）。
 *
 * D6: spawn node directly with tsx loaders to avoid the tsx-wrapper → node
 * two-process chain that causes child orphaning on SIGKILL.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Daemon } from "@banto/daemon";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BIN = path.join(REPO_ROOT, "packages/banto-cli/src/bin.ts");
const NODE = process.execPath;
const TSX_PREFLIGHT = path.join(REPO_ROOT, "node_modules/tsx/dist/preflight.cjs");
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs")).href;

// ── 持ち時間の使い分け（task-0092）────────────────────────────────────────────
//
// この試験が確かめたいのは「イベントが**流れて**くる（貯めて後出ししない）」こと。
// ところが子プロセスは node を起こして tsx で CLI 一式を変換するところから始まるので、
// 最初の1行が出るまでの時間は**機械の混み具合そのもの**になる。実測（4コアVM）：
//
//   | 走らせ方                      | 最初の1行まで |
//   |-------------------------------|---------------|
//   | 空いている（load ≈ 2.7）      | 0.56〜0.68 秒 |
//   | 混んでいる（load ≈ 11）       | 2.4〜3.5 秒   |
//
// 元は起動待ちにも 3〜4 秒しか置いていなかったので、**混むと起動を測っただけで落ちた**
// （inc-0042 と同じ形：時間で判定する試験は隣で何が走っているかに結果を握られる）。
//
// そこで2つを分ける。起動は「立ち上がるまで」の待ちなので広く取り、**流れてくる速さは
// 購読が済んだ後から測る**——主題の方は測り続ける。
const STARTUP_MS = 30_000; // node + tsx で CLI が立ち上がるまで（機械の都合。主題ではない）
const STREAM_MS = 10_000; // 購読が済んだ後、イベントが届くまで（貯め込んでいれば届かない）
const EXIT_MS = 15_000; // SIGINT を受けて後始末を済ませ、抜けるまで

// task-0092: 起こした子は**必ず**畳む。
//
// 元は各 it の中で kill していたので、待ちが時間切れになると kill に辿り着かず子が残った。
// 残った子の stdout/stderr パイプは親（node --test のワーカー）の event loop を握るので、
// **1件の失敗が、走り全体の停止に化けた**（実測: step 1・step 3 が落ちた回で、
// `node --test tests/acceptance/cli-events.spec.ts` が20分以上抜けずに居座った）。
// 「たまに落ちる」より始末が悪い——落ちたことすら報告されない。
// そこで起こした子を1箇所に控え、afterEach で残らず畳む。
const liveProcs = new Set<ChildProcess>();

/** 生きている子を SIGKILL で畳み、抜けるまで待つ。既に閉じていれば何もしない。 */
async function reap(proc: ChildProcess): Promise<void> {
  if (!liveProcs.has(proc)) return;
  proc.kill("SIGKILL");
  await new Promise((r) => proc.once("close", r));
}

/** Spawn `banto events --follow [--after N]` and return the process + readers.
 *  Spawns node directly (not via tsx wrapper) to avoid the two-process chain
 *  that causes child orphaning when the parent is killed.
 */
function spawnEventsFollow(
  daemonUrl: string,
  afterId?: number
): {
  proc: ChildProcess;
  stdoutLines: string[];
  stderrLines: string[];
} {
  const cliArgs = ["events", "--follow"];
  if (typeof afterId === "number") {
    cliArgs.push("--after", String(afterId));
  }
  const nodeArgs = ["--require", TSX_PREFLIGHT, "--import", TSX_LOADER, BIN, ...cliArgs];

  const proc = spawn(NODE, nodeArgs, {
    env: { ...process.env, BANTO_DAEMON_URL: daemonUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });

  liveProcs.add(proc);
  proc.once("close", () => liveProcs.delete(proc));

  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  proc.stdout!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").filter((l) => l.trim()).forEach((l) => stdoutLines.push(l));
  });
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").filter((l) => l.trim()).forEach((l) => stderrLines.push(l));
  });

  return { proc, stdoutLines, stderrLines };
}

/** Wait until predicate over lines returns true, or timeout */
function waitForLine(
  lines: string[],
  predicate: (line: string) => boolean,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const found = lines.find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for matching line. Lines so far: ${JSON.stringify(lines)}`));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/** Send SIGINT to process and wait for it to exit */
function killAndWait(proc: ChildProcess, timeoutMs = EXIT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Process did not exit after SIGINT within timeout"));
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    proc.kill("SIGINT");
  });
}

describe("[AC-S654396-4-2] banto events --follow", () => {
  let tmpDir: string;
  let daemon: Daemon;
  let daemonUrl: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-cli-events-"));
    daemon = Daemon.create({ port: 0, dataDir: tmpDir, disableAutoSpawn: true });
    await daemon.start();
    daemonUrl = `http://localhost:${daemon.port}`;

    // Register proj-a so the follow command has something to subscribe to
    await fetch(`${daemonUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "proj-a", repoPath: "/repos/proj-a" }),
    });
  });

  // どの assert で落ちても、残った子はここで畳む（上の liveProcs の説明のとおり）
  afterEach(async () => {
    for (const proc of [...liveProcs]) await reap(proc);
  });

  after(async () => {
    await daemon.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[AC-S654396-4-2] step 1: WS connection established, listening message appears", async () => {
    const { proc, stdoutLines } = spawnEventsFollow(daemonUrl);
    try {
      // 立ち上がったことが分かればよい（速さを測る回ではない）
      const line = await waitForLine(
        stdoutLines,
        (l) => /connect|listen/i.test(l),
        STARTUP_MS
      );
      assert.ok(line, "A connection/listening message must appear");
    } finally {
      await reap(proc);
    }
  });

  it("[AC-S654396-4-2] step 2: REST task_created event appears in stdout while subscribed", async () => {
    const { proc, stdoutLines, stderrLines } = spawnEventsFollow(daemonUrl);
    try {
      // 購読が済むまで（ここから先が主題。起動そのものは測らない）
      await waitForLine(stdoutLines, (l) => /listen|subscrib/i.test(l), STARTUP_MS);

      // Inject a new task via REST API
      const res = await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "task-ev-001", title: "Event follow test" }),
      });
      assert.equal(res.status, 201);

      // 購読済みの相手には、作られたそばから流れてくる（貯め込んでいれば届かない）
      const evtLine = await waitForLine(
        stdoutLines,
        (l) => l.includes("task_created"),
        STREAM_MS
      );
      assert.match(evtLine, /task_created/, "stdout must show task_created event");

      // No errors on stderr
      const errorLines = stderrLines.filter((l) => /error/i.test(l));
      assert.equal(errorLines.length, 0, `Unexpected stderr errors: ${errorLines.join(", ")}`);
    } finally {
      await reap(proc);
    }
  });

  it("[AC-S654396-4-2] step 3: SIGINT → exit code 0, no stderr errors", async () => {
    const { proc, stdoutLines, stderrLines } = spawnEventsFollow(daemonUrl);

    // Wait for connection to be established before sending SIGINT
    await waitForLine(stdoutLines, (l) => /connect|listen/i.test(l), STARTUP_MS);

    const exitCode = await killAndWait(proc, EXIT_MS);
    assert.equal(exitCode, 0, `SIGINT should cause exit code 0, got ${exitCode}`);

    // No unexpected errors on stderr (ignore graceful close messages)
    const errorLines = stderrLines.filter(
      (l) => /error/i.test(l) && !/connection closed/i.test(l)
    );
    assert.equal(errorLines.length, 0, `Unexpected stderr errors: ${errorLines.join(", ")}`);
  });

  it("[AC-S654396-4-2] step 4: --after <id> catches up missed events on reconnect", async () => {
    // Phase A: connect, get initial subscription
    const { proc: proc1, stdoutLines: lines1 } = spawnEventsFollow(daemonUrl);
    await waitForLine(lines1, (l) => /listen|subscrib/i.test(l), STARTUP_MS);

    // Inject one task to get a known eventId
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-before-gap", title: "Before gap" }),
    });
    const evtLine = await waitForLine(
      lines1,
      (l) => l.includes("task-before-gap") || (l.includes("task_created") && /event #/.test(l)),
      STREAM_MS
    );
    // Extract eventId from line format: "event #N [ts] task_created ..."
    const evtIdMatch = evtLine.match(/event #(\d+)/);
    assert.ok(evtIdMatch, `Could not parse eventId from: ${evtLine}`);
    const lastSeenId = parseInt(evtIdMatch[1], 10);

    // Kill first subscriber
    await reap(proc1);

    // Phase B: inject 2 more tasks while disconnected
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-gap-1", title: "Gap task 1" }),
    });
    await fetch(`${daemonUrl}/api/v1/projects/proj-a/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "task-gap-2", title: "Gap task 2" }),
    });

    // Phase C: reconnect with --after lastSeenId; collect catch-up events
    const { proc: proc2, stdoutLines: lines2 } = spawnEventsFollow(daemonUrl, lastSeenId);
    try {
      // Must receive both gap events via catch-up replay
      // 1本目は繋ぎ直したプロセスの起動を含む。2本目はもう立ち上がった後の話
      await waitForLine(lines2, (l) => l.includes("task-gap-1"), STARTUP_MS);
      await waitForLine(lines2, (l) => l.includes("task-gap-2"), STREAM_MS);

      // All catch-up event lines must have eventId > lastSeenId
      const catchUpLines = lines2.filter((l) => /event #\d+/.test(l) && /task_created/.test(l));
      assert.ok(catchUpLines.length >= 2, `Expected ≥2 catch-up events, got ${catchUpLines.length}`);

      for (const line of catchUpLines) {
        const m = line.match(/event #(\d+)/);
        if (m) {
          const eid = parseInt(m[1], 10);
          assert.ok(eid > lastSeenId, `Catch-up event #${eid} should be > lastSeenId ${lastSeenId}`);
        }
      }
    } finally {
      await reap(proc2);
    }
  });
});
