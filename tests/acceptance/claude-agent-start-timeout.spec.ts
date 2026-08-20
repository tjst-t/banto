/**
 * `ClaudeAgentDriver` の起動待ち（task-0233）。
 *
 * 見たいのは5つ:
 *   [a1] START_TIMEOUT_MS / INJECT_TIMEOUT_MS が環境変数で変えられる（読めない値は投げる）
 *   [a2] 起動の名乗りが返らなければ、1回だけ起こし直される（失敗した子は始末され孤児が残らない）
 *   [a3] 2回目も名乗りが返らなければ、これまでと同じ形（spawn_failed→例外）で失敗を返す
 *        （inject は再試行されない）
 *   [a4] `--resume` 付きの起動が失敗したら、`--resume` を外して新しいセッションとして
 *        起こし直される。退路を通ったことが記録に残る
 *   [a5] 失敗・再試行の記録に、試行回数・再開か新規か・再開元セッションの大きさが載る
 *   [a6] 死んだ子への write は `write EPIPE` ではなく理由の分かる失敗になる
 *
 * **本物の Claude は呼ばない。** ホストの代わりに、同じ言葉（get_state / prompt / abort）を
 * 話す小さな台本を起こして経路を通す（`claude-agent-worker.spec.ts` と同じ流儀）。
 * ハングは `setInterval` だけで作り、偶然のタイミングに頼らない——**決定的に**再現させる。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DriverEvent, SpawnOptions } from "@banto/core";
import { ClaudeAgentDriver } from "@banto/worker-pool";

// ── 台本（get_state / prompt / abort だけを話す） ────────────────────────────
//
// 何回目に起こされたか（`n`）を、テストの外にあるカウンタファイルへ書き出す。
// `STUB_HANG_START_ATTEMPTS` 回目までは get_state に答えず（起動タイムアウトを起こす）、
// それ以降は普通に答える。`STUB_HANG_PROMPT=1` なら prompt にも一切答えない
// （inject のタイムアウトを起こす）。message が `__exit_now__` のときは、応答せず
// その場で自分から終了する（a6: 死んだ子への write を作るための引き金）。
const STUB_HOST = `
import * as fs from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf("--" + name); return i === -1 ? undefined : args[i + 1]; };
const sessionFile = flag("session-file");
const resumeArg = flag("resume");
const sessionId = resumeArg ?? "stub-session";

let n = 0;
const counterFile = process.env.STUB_ATTEMPT_COUNTER_FILE;
try { n = Number(fs.readFileSync(counterFile, "utf-8")) || 0; } catch {}
n += 1;
fs.writeFileSync(counterFile, String(n));
if (process.env.STUB_ATTEMPTS_LOG) {
  fs.appendFileSync(
    process.env.STUB_ATTEMPTS_LOG,
    JSON.stringify({ n, resumed: resumeArg !== undefined, pid: process.pid, args }) + "\\n"
  );
}

const hangStart = Number(process.env.STUB_HANG_START_ATTEMPTS ?? "0");
const hangPrompt = process.env.STUB_HANG_PROMPT === "1";

if (n <= hangStart) {
  // 名乗らない。プロセス自体は生きたまま——起動タイムアウトを起こすためだけの子
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", sessionId }) + "\\n");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const cmd = JSON.parse(line);
      if (cmd.type === "get_state") {
        process.stdout.write(JSON.stringify({ type: "response", command: "get_state", success: true, data: { sessionId, sessionFile } }) + "\\n");
      } else if (cmd.type === "prompt") {
        if (cmd.message === "__exit_now__") { process.exit(4); }
        if (hangPrompt) { continue; }
        fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: cmd.message } }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\\n");
      } else if (cmd.type === "abort") {
        process.exit(0);
      }
    }
  });
  setInterval(() => {}, 1000);
}
`;

/** `process.stderr.write` を一時的に横取りして、行ごとに集める（a5 の診断記録を読むため）。 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  let carry = "";
  const orig = process.stderr.write.bind(process.stderr);
  const intercept = (chunk: string | Uint8Array): boolean => {
    carry += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    let idx: number;
    while ((idx = carry.indexOf("\n")) !== -1) {
      lines.push(carry.slice(0, idx));
      carry = carry.slice(idx + 1);
    }
    return true;
  };
  // process.stderr.write はオーバーロードが多く、横取り用の簡略シグネチャとは合わないため (I4)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ...rest: any[]): boolean => {
    intercept(chunk);
    return orig(chunk, ...rest);
  };
  return {
    lines,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = orig;
    },
  };
}

/** 起動診断（`logStartAttempt`）の行だけを拾って構造化して返す。 */
function readStartDiagnostics(lines: string[]): Array<Record<string, unknown>> {
  const prefix = "[claude-agent] 起動診断 ";
  return lines
    .filter((l) => l.startsWith(prefix))
    .map((l) => JSON.parse(l.slice(prefix.length)) as Record<string, unknown>);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 偶然のタイミングに頼らず、かつ無限に待たない（P6）。決まった上限で諦めて理由を残す。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil: ${timeoutMs}ms 待っても条件が満たされませんでした`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * `ClaudeAgentDriver` の起動タイムアウトを壁時計から切り離す試験用 scheduler（task-0291）。
 *
 * **なぜこれを選んだか**: a3/a5 は「短いタイムアウト（150ms）で2回とも失敗させる」
 * ことを実時間の `setTimeout` で作っていた。フルスイート負荷下では、150ms のうちに
 * 本物の子プロセス（node がスタブ台本を読み込んで応答する）が起動しきれず、期待している
 * 「間に合った」側まで巻き込まれて落ちた——3度目の再発（`BANTO_CLAUDE_START_TIMEOUT_MS`
 * を1000ms へ上げる手当てを task-0267・task-0269 で既に2回打っている）。今回は数字を
 * 上げるのをやめ、`ClaudeAgentDriver` に注入した `startTimeoutScheduler` 経由で
 * 「時間切れ」そのものを試験が握る：`fireNext()` を呼べば実時間がどれだけ残っていようと
 * 即座に時間切れにできる（＝間に合わなかった側は実時間に依存しない）。逆に一度も
 * `fireNext()` を呼ばなければタイムアウトは永遠に発火しないので、本物の応答が
 * どれだけ遅れてもレースに負けない（＝間に合った側にも実時間の上限が無くなる）。
 * 「本物のサブプロセス起動自体を偽物にする」案もあったが、a2/a4 が検証している
 * 「本物の子プロセスを実際に起こし直す」経路を土台から変えることになるため見送った。
 */
function createManualStartTimeoutScheduler(): {
  scheduler: { schedule: (ms: number, onTimeout: () => void) => { cancel: () => void } };
  fireNext: () => void;
  pendingCount: () => number;
} {
  const pending: Array<{ cancelled: boolean; fire: () => void }> = [];
  return {
    scheduler: {
      schedule(_ms: number, onTimeout: () => void) {
        const entry = { cancelled: false, fire: onTimeout };
        pending.push(entry);
        return {
          cancel: () => {
            entry.cancelled = true;
          },
        };
      },
    },
    fireNext: () => {
      const entry = pending.shift();
      if (!entry) throw new Error("fireNext: 保留中のタイムアウトがありません");
      if (!entry.cancelled) entry.fire();
    },
    pendingCount: () => pending.length,
  };
}

describe("[claude-agent] 起動の待ちと起こし直し（task-0233）", () => {
  let stubDir: string;
  let stubPath: string;
  let counterFile: string;
  let attemptsLog: string;
  let driver: ClaudeAgentDriver;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "BANTO_CLAUDE_START_TIMEOUT_MS",
    "BANTO_CLAUDE_INJECT_TIMEOUT_MS",
    "STUB_ATTEMPT_COUNTER_FILE",
    "STUB_ATTEMPTS_LOG",
    "STUB_HANG_START_ATTEMPTS",
    "STUB_HANG_PROMPT",
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-claude-start-timeout-"));
    stubPath = path.join(stubDir, "stub-host.mjs");
    counterFile = path.join(stubDir, "counter.txt");
    attemptsLog = path.join(stubDir, "attempts.jsonl");
    fs.writeFileSync(stubPath, STUB_HOST);
    process.env["STUB_ATTEMPT_COUNTER_FILE"] = counterFile;
    process.env["STUB_ATTEMPTS_LOG"] = attemptsLog;
    driver = new ClaudeAgentDriver({
      hostPath: stubPath,
      nodeArgs: [],
      sessionBaseDir: path.join(stubDir, "sessions"),
    });
  });

  afterEach(async () => {
    for (const sessionId of driver.listActiveSessions()) await driver.kill(sessionId);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  const spawnOptions = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
    taskId: "task-0233",
    worktreePath: stubDir,
    sessionPath: path.join(stubDir, "sessions", "task-0233.jsonl"),
    systemPrompt: "You are a worker.",
    tools: [],
    ...over,
  });

  const attempts = (): Array<{ n: number; resumed: boolean; pid: number; args: string[] }> =>
    fs
      .readFileSync(attemptsLog, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

  // ── a1: 環境変数で待ちを変えられる ──────────────────────────────────────

  it("[a1] BANTO_CLAUDE_START_TIMEOUT_MS で起動待ちを短くできる", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "120";
    process.env["STUB_HANG_START_ATTEMPTS"] = "99"; // 何回起こしても名乗らない
    const startedAt = Date.now();
    await assert.rejects(() => driver.spawn(spawnOptions()), /120ms 以内に応答しませんでした/u);
    const elapsedMs = Date.now() - startedAt;
    // 既定の10sではなく、上書きした値の近く（2回試すので概ね2倍）で終わること
    assert.ok(elapsedMs < 3_000, `既定値のまま待っていないか（実測 ${elapsedMs}ms）`);
  });

  it("[a1] BANTO_CLAUDE_INJECT_TIMEOUT_MS で inject の待ちを短くできる", async () => {
    process.env["BANTO_CLAUDE_INJECT_TIMEOUT_MS"] = "150";
    process.env["STUB_HANG_PROMPT"] = "1";
    const handle = await driver.spawn(spawnOptions());
    const startedAt = Date.now();
    await assert.rejects(
      () => driver.inject(handle.sessionId, "はじめてください"),
      /150ms 以内に返りませんでした/u
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 2_000, `既定値のまま待っていないか（実測 ${elapsedMs}ms）`);
  });

  it("[a1] 読めない値は黙って既定へ落とさず、投げる（I2）", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "not-a-number";
    await assert.rejects(
      () => driver.spawn(spawnOptions()),
      /BANTO_CLAUDE_START_TIMEOUT_MS を読み取れません/u
    );
    // 子を起こす前に落ちること（孤児が残らない）。次のふつうの起動は通ること
    delete process.env["BANTO_CLAUDE_START_TIMEOUT_MS"];
    const handle = await driver.spawn(spawnOptions());
    assert.ok(handle.pid > 0);
  });

  // ── a2/a3: 1回だけ起こし直す ────────────────────────────────────────────

  it("[a2] 名乗りが返らなくても1回目で失敗した子は始末され、起こし直しで職人は使える状態になる", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "1000";
    process.env["STUB_HANG_START_ATTEMPTS"] = "1"; // 1回目だけハングし、2回目は普通に答える

    const events: DriverEvent[] = [];
    driver.subscribe((e) => events.push(e));

    const handle = await driver.spawn(spawnOptions());
    assert.equal(handle.sessionId, "stub-session");
    assert.ok(handle.pid > 0);

    const seen = attempts();
    assert.equal(seen.length, 2, "起こし直しは1回だけ（合計2回の試行）");
    assert.equal(seen[0]!.resumed, false);
    assert.equal(seen[1]!.resumed, false);

    // 起こし直したあとは普通に使える（指示が届く）
    await driver.inject(handle.sessionId, "はじめてください");
    const session = fs.readFileSync(handle.sessionPath, "utf-8");
    assert.match(session, /はじめてください/);

    // spawn_failed は出ない（最終的に起きたので）。process_started は1回だけ
    assert.equal(events.filter((e) => e.type === "spawn_failed").length, 0);
    assert.equal(events.filter((e) => e.type === "process_started").length, 1);
  });

  it("[a2] 失敗した1回目の子プロセスは始末され、孤児が残らない", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "1000"; // P6: 上記 a2 と同理由でフルスイート負荷に耐える値
    process.env["STUB_HANG_START_ATTEMPTS"] = "1";

    const handle = await driver.spawn(spawnOptions());
    const seen = attempts();
    assert.equal(seen.length, 2);
    const firstAttemptPid = seen[0]!.pid;
    assert.notEqual(firstAttemptPid, handle.pid, "1回目と2回目は別プロセス");

    // 少し待って SIGKILL が効くのを見届ける（起こし直し自体は待たずに終わっているため）
    await waitUntil(() => !isAlive(firstAttemptPid)).catch(() => {
      // タイムアウトさせず、次の assert で分かりやすい失敗にする
    });
    assert.equal(isAlive(firstAttemptPid), false, "失敗した1回目の子が生き残っている（孤児）");
    assert.ok(isAlive(handle.pid), "起こし直して使っている2回目は生きている");
  });

  it("[a3] 2回目も名乗りが返らなければ、同じ形（spawn_failed→例外）で失敗し、inject は再試行されない", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "150"; // 口は生きたまま——エラー文言に載ることで確かめる
    process.env["STUB_HANG_START_ATTEMPTS"] = "99"; // 何度起こしても名乗らない

    // task-0291: 時間切れは実時間の 150ms ではなく、手動 scheduler の fireNext() で作る
    // （理由は createManualStartTimeoutScheduler のコメント）
    const { scheduler, fireNext, pendingCount } = createManualStartTimeoutScheduler();
    const manualDriver = new ClaudeAgentDriver({
      hostPath: stubPath,
      nodeArgs: [],
      sessionBaseDir: path.join(stubDir, "sessions"),
      startTimeoutScheduler: scheduler,
    });

    const events: DriverEvent[] = [];
    manualDriver.subscribe((e) => events.push(e));

    const spawnPromise = manualDriver.spawn(spawnOptions());
    // 1回目・2回目、それぞれの起動待ちが scheduler に仕掛けられるのを待ってから発火する。
    // ここで待つのは「非同期処理が schedule() まで進んだこと」であって、150ms という
    // 締切そのものではない——本物の締切は fireNext() が作る
    await waitUntil(() => pendingCount() > 0);
    fireNext();
    await waitUntil(() => pendingCount() > 0);
    fireNext();
    await assert.rejects(() => spawnPromise, /ホストが 150ms 以内に応答しませんでした/u);

    const seen = attempts();
    assert.equal(seen.length, 2, "起こし直しは1回だけ試して、そこで止まる（無限に粘らない）");

    // これまでと同じ形：spawn_failed が飛び、例外で伝わる
    const failures = events.filter((e) => e.type === "spawn_failed");
    assert.equal(failures.length, 1);

    // 工房は生きている：次の職人はふつうに起こせる。ここでは fireNext() を一度も
    // 呼ばない——本物の応答がどれだけ遅れてもレースに負けない（実時間の上限が無い）
    process.env["STUB_HANG_START_ATTEMPTS"] = "0";
    fs.writeFileSync(counterFile, "0");
    fs.rmSync(attemptsLog, { force: true });
    const handle = await manualDriver.spawn(spawnOptions());
    assert.ok(handle.pid > 0, "1人起こせなかっただけで工房が死んでいる");
    await manualDriver.kill(handle.sessionId);
  });

  // ── a4: resume の退路 ──────────────────────────────────────────────────

  it("[a4] --resume 付きの起動が失敗したら、--resume を外して新しいセッションとして起こし直す", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "1000"; // P6: 退路（2回目の起動成功）を待つため、負荷に耐える値
    process.env["STUB_HANG_START_ATTEMPTS"] = "1"; // resume 付きの1回目だけ落とす

    const previous = path.join(stubDir, "previous.jsonl");
    fs.writeFileSync(previous, JSON.stringify({ type: "session", sessionId: "sess-old" }) + "\n");

    const stderr = captureStderr();
    let handle;
    try {
      handle = await driver.spawn(
        spawnOptions({
          sessionPath: path.join(stubDir, "sessions", "resumed.jsonl"),
          driverOptions: { resumeSessionPath: previous },
        })
      );
    } finally {
      stderr.restore();
    }

    const seen = attempts();
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.resumed, true, "1回目は --resume 付きで試す");
    assert.equal(seen[0]!.args.includes("--resume"), true);
    assert.equal(seen[1]!.resumed, false, "2回目は退路として --resume を外す");
    assert.equal(seen[1]!.args.includes("--resume"), false);

    // 黙って新規にしない：退路を通ったことが職人には見えない sessionId にも表れる
    // （resume に使うはずだった sess-old ではなく、stub の既定 id で新規に起こる）
    assert.equal(handle.sessionId, "stub-session");

    // a5: 退路を通ったことが記録に残る
    const diag = readStartDiagnostics(stderr.lines);
    const succeeded = diag.find((d) => d["outcome"] === "succeeded");
    assert.ok(succeeded, "成功時の診断が残っていること");
    assert.equal(succeeded!["fellBackFromResume"], true);
  });

  // ── a5: 診断の中身 ──────────────────────────────────────────────────────

  it("[a5] 失敗と再試行の記録に、試行回数・再開か新規か・再開元の大きさが載る（条件には使わない）", async () => {
    process.env["BANTO_CLAUDE_START_TIMEOUT_MS"] = "150"; // 口は生きたまま——診断の中身で確かめる
    process.env["STUB_HANG_START_ATTEMPTS"] = "99";

    const previous = path.join(stubDir, "previous.jsonl");
    const body = JSON.stringify({ type: "session", sessionId: "sess-old" }) + "\n";
    fs.writeFileSync(previous, body);
    const expectedBytes = Buffer.byteLength(body, "utf-8");

    // task-0291: a3 と同じ理由で、時間切れは手動 scheduler の fireNext() で作る
    const { scheduler, fireNext, pendingCount } = createManualStartTimeoutScheduler();
    const manualDriver = new ClaudeAgentDriver({
      hostPath: stubPath,
      nodeArgs: [],
      sessionBaseDir: path.join(stubDir, "sessions"),
      startTimeoutScheduler: scheduler,
    });

    const stderr = captureStderr();
    try {
      const spawnPromise = manualDriver.spawn(
        spawnOptions({
          sessionPath: path.join(stubDir, "sessions", "resumed.jsonl"),
          driverOptions: { resumeSessionPath: previous },
        })
      );
      await waitUntil(() => pendingCount() > 0);
      fireNext();
      await waitUntil(() => pendingCount() > 0);
      fireNext();
      await assert.rejects(() => spawnPromise);
    } finally {
      stderr.restore();
    }

    const diag = readStartDiagnostics(stderr.lines);
    assert.equal(diag.length, 2, "1回目・2回目それぞれの記録が残る");

    assert.equal(diag[0]!["attempt"], 1);
    assert.equal(diag[0]!["maxAttempts"], 2);
    assert.equal(diag[0]!["resumed"], true);
    assert.equal(diag[0]!["fellBackFromResume"], false);
    assert.equal(diag[0]!["resumeSessionBytes"], expectedBytes);
    assert.equal(diag[0]!["outcome"], "failed");

    assert.equal(diag[1]!["attempt"], 2);
    assert.equal(diag[1]!["resumed"], false);
    assert.equal(diag[1]!["fellBackFromResume"], true, "2回目は resume からの退路であったこと");
    assert.equal(diag[1]!["resumeSessionBytes"], expectedBytes);
    assert.equal(diag[1]!["outcome"], "failed");
  });

  // ── a6: 死んだ子への write は EPIPE でなく理由の分かる失敗になる ──────────

  it("[a6] 子が既に終わっていれば inject は EPIPE ではなく exit/signal の分かる失敗になり、driver は落ちない", async () => {
    const handle = await driver.spawn(spawnOptions());

    // process_exited は「map から消す前」に届く。そのタイミングで inject すると、
    // map にはまだ載っているが proc は既に exit=4 になっている——狙った競合を
    // タイミングに頼らず作れる、決定的なフック
    let raced: Promise<unknown> | undefined;
    const unsubscribe = driver.subscribe((e) => {
      if (e.type === "process_exited" && e.sessionId === handle.sessionId) {
        raced = driver.inject(handle.sessionId, "too late").catch((err) => err);
      }
    });

    // このプロセスがクラッシュしていないことの確認（EPIPE が uncaughtException に
    // なっていれば、ここに到達する前にテストランナーごと落ちる）
    let uncaught: unknown;
    const onUncaught = (err: unknown): void => {
      uncaught = err;
    };
    process.once("uncaughtException", onUncaught);

    // 子を自分から exit させる（応答を待たずに投げっぱなしにする——ここは
    // タイムアウトを待つ意味が無いので拾うだけ）
    void driver.inject(handle.sessionId, "__exit_now__").catch(() => {});

    // exit イベントが飛ぶまで待つ（無限には待たない）
    await waitUntil(() => raced !== undefined);
    unsubscribe();

    const err = await raced;
    assert.match(String(err), /exit=4|signal=/u, `EPIPE ではなく理由が分かる形であること: ${String(err)}`);

    process.removeListener("uncaughtException", onUncaught);
    assert.equal(uncaught, undefined, "EPIPE が uncaughtException になっていないこと");
  });

  it("[a6] 死んだ子への kill は abort を書こうとせず、静かに片付く", async () => {
    const handle = await driver.spawn(spawnOptions());
    // 子を自分から落とす。exit イベントで map から消えるまで少し待つ
    void driver.inject(handle.sessionId, "__exit_now__").catch(() => {});
    await waitUntil(() => !driver.listActiveSessions().includes(handle.sessionId));
    // 既に map から消えている：kill は冪等に静かに戻る（例外にならない）
    await driver.kill(handle.sessionId);
  });

  // ── a7: 正常系は変わらない ──────────────────────────────────────────────

  it("[a7] 正常に起きるときは1回で起動し、名乗りが返り、指示が届く", async () => {
    const events: DriverEvent[] = [];
    driver.subscribe((e) => events.push(e));

    const handle = await driver.spawn(spawnOptions());
    assert.equal(handle.sessionId, "stub-session");
    assert.ok(handle.pid > 0);
    assert.ok(isAlive(handle.pid));

    const seen = attempts();
    assert.equal(seen.length, 1, "普通に起きるときは1回だけ");

    await driver.inject(handle.sessionId, "はじめてください");
    const session = fs.readFileSync(handle.sessionPath, "utf-8");
    assert.match(session, /はじめてください/);

    await driver.kill(handle.sessionId);
    assert.equal(driver.listActiveSessions().length, 0);
    assert.ok(events.some((e) => e.type === "process_started"));
    assert.equal(events.filter((e) => e.type === "spawn_failed").length, 0);
  });
});
