/**
 * task-0213: **検証コマンドを職人の袋の外で回す**（Kobo が回して結果を職人へ返す）。
 *
 * 何が起きたか（2026-08-16 の実測）。職人は1本ごとに cgroup の袋（既定 2 GiB）に入って
 * いる。その袋の中で `npm ci` / `npm test` / `npm run typecheck` を回したせいで、
 * `memory.oom.group` により**職人が袋ごと殺された**——`banto-worker-pool.service` が
 * 7回揺れ、中身は無罪のタスクが7本落ちた。袋を破っていたのは職人の会話ではなく `npm`。
 *
 * 出どころは Kobo の指示文だった：実装者の手順3が「検証コマンドがあれば自分で実行して」、
 * 受け入れ基準が「（検証コマンド: `npm test`）」、監査人には**何も書いていない**（各自の
 * 判断に委ねられ、実測では袋の中で回っていた）。
 *
 * **I1 は緩めない。** 検証をやめるのではなく、回す場所を袋の外（検証環境）へ移す。
 * マージ前ゲートが既に袋の外で回しているので、**その経路を前倒しで使う**。
 *
 * 見るもの:
 *   - a1 実装者への指示文に「一式は自分で叩かない」と「ではどう確かめるか」がある
 *   - a2 監査人への指示文にも同じことがある（各自の判断に任せない）
 *   - a3 受け入れ基準に添える検証コマンドから、どこが回すのかが読み取れる
 *   - a4 Kobo が袋の外で回し、落ちた結果が職人へ届く経路がある
 *   - a5 実行はマージ前ゲートと同じ経路（`runAcceptanceVerify`）の再利用
 *   - a6 検証環境を立てるのは受け入れ条件ごとではなく1回
 *   - a7 職人へ返す結果は切り詰める（失敗した箇所と末尾・切ったことと全文の置き場所）
 *
 * a8（既存のマージ前ゲートの振る舞いが変わらないこと）は既存の
 * `merge-gate-*.spec.ts` が見る——ここでは重ねない。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildAuditInstruction,
  buildExecutorInstruction,
  Daemon,
} from "../../packages/banto-daemon/src/daemon.js";
import {
  runAcceptanceVerify,
  summarizeVerifyLog,
  VERIFY_LOG_MAX_LINES,
} from "../../packages/banto-daemon/src/merge-gate.js";
import type { TaskRecord } from "../../packages/banto-core/src/index.js";
import { hostVerifyRunner } from "./gate-verify-runner.js";
import { startWorkerPool, type WorkerPoolHarness } from "./worker-pool-harness.js";
import { createAndAdvance, transition } from "./task-flow.js";
import type {
  RuntimeDriver,
  SpawnOptions,
  SessionHandle,
  DriverEventHandler,
  DriverEvent,
} from "../../packages/banto-core/src/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const task: TaskRecord = {
  id: "task-0213-sample",
  status: "implementing",
  projectTag: "bagproj",
  title: "検証を袋の外で回す",
  kind: "fix",
  scope: { paths: ["src/**"] },
  acceptance: [
    { id: "a1", text: "動く", verify: "npm test" },
    { id: "a2", text: "型が通る", verify: "npm run typecheck" },
  ],
};

// ── a1: 実装者への指示文 ──────────────────────────────────────────────────────

describe("[a1] 実装者への指示文が、一式を袋の中で叩かせない（そして代わりの確かめ方を書く）", () => {
  const instruction = buildExecutorInstruction(task, "/tmp/wt");

  it("一式（npm ci / npm test / npm run typecheck）を自分で叩かないことが書いてある", () => {
    assert.match(
      instruction,
      /自分で叩かない|自分の環境で叩かないで/,
      "「自分で叩くな」が指示文に無い——袋の中で `npm test` が回り、職人ごと殺される"
    );
    for (const cmd of ["npm ci", "npm test", "npm run typecheck"]) {
      assert.ok(
        instruction.includes(cmd),
        `禁じる「一式」の具体例に ${cmd} が無い——曖昧だと各自の判断に戻る`
      );
    }
  });

  it("**ではどう確かめるのか**が書いてある（「回すな」だけだと I1 が壊れる）", () => {
    assert.match(
      instruction,
      /report_done/,
      "検証がいつ回るのか（report_done の後）が書かれていない"
    );
    assert.match(
      instruction,
      /検証環境/,
      "どこで回るのか（検証環境）が書かれていない"
    );
    assert.match(
      instruction,
      /差し戻/,
      "落ちたときに結果が自分へ戻ってくることが書かれていない——" +
        "戻ると分からなければ、職人は自分で回そうとする"
    );
  });

  it("軽い確認は袋の中でよい、という線引きが書いてある", () => {
    assert.match(
      instruction,
      /test:one/,
      "1本だけ回す道（npm run test:one）が示されていない——" +
        "線引きが無いと「全部やるな」と読まれて、何も確かめない職人が出る"
    );
  });

  it("手順3が「自分で実行して」のままになっていない", () => {
    assert.ok(
      !instruction.includes("検証コマンドがあれば自分で実行して"),
      "手順3が古いまま——ここが袋を破っていた出どころ（daemon.ts の実装者手順）"
    );
  });
});

// ── a2: 監査人への指示文 ──────────────────────────────────────────────────────

describe("[a2] 監査人への指示文にも、どこで検証が回るかが明示されている", () => {
  const instruction = buildAuditInstruction(task, "bagproj", task.id, "/tmp/wt");

  it("実装者と同じ説明が載っている（各自の判断に任せない）", () => {
    assert.match(instruction, /検証環境/, "監査人にどこで回るのかが届いていない");
    assert.match(
      instruction,
      /自分で叩かない|自分の環境で叩かないで|自分で実行しないで/,
      "監査人が袋の中で一式を回すのを止めていない——実測ではここが原因で" +
        "`memory.oom.group` により 15 プロセスが袋ごと死んだ"
    );
    for (const cmd of ["npm test", "npm run typecheck"]) {
      assert.ok(instruction.includes(cmd), `監査人向けにも ${cmd} を名指しすること`);
    }
  });

  it("監査手順3が「それを実行して」のままになっていない", () => {
    assert.ok(
      !instruction.includes("verify コマンドがある場合はそれを実行して結果を確認してください"),
      "監査手順3が古いまま"
    );
  });

  it("軽い確認は許されることが書いてある（I1 を殺さない）", () => {
    assert.match(
      instruction,
      /test:one/,
      "監査人にも「ここまでは自分でやってよい」が要る"
    );
  });
});

// ── a3: 受け入れ基準の見せ方 ──────────────────────────────────────────────────

describe("[a3] 受け入れ基準に添える検証コマンドから、どこが回すのかが読み取れる", () => {
  it("「（検証コマンド: `npm test`）」だけの見せ方をしていない", () => {
    for (const instruction of [
      buildExecutorInstruction(task, "/tmp/wt"),
      buildAuditInstruction(task, "bagproj", task.id, "/tmp/wt"),
    ]) {
      assert.ok(
        !instruction.includes("（検証コマンド: `npm test`）"),
        "検証コマンドを裸で添えている——そのままだと「自分で叩け」と読める"
      );
      assert.match(
        instruction,
        /検証コマンド: `npm test` — \*\*Kobo が検証環境で回します。自分で叩かないこと\*\*/,
        "受け入れ基準の行に、誰が回すのかが書かれていない"
      );
    }
  });

  it("検証コマンドを持たない基準には何も足さない（読みづらくしない）", () => {
    const noVerify: TaskRecord = {
      ...task,
      acceptance: [{ id: "a1", text: "検証コマンドなし" }],
    };
    const instruction = buildExecutorInstruction(noVerify, "/tmp/wt");
    assert.ok(
      instruction.includes("- [a1] 検証コマンドなし\n"),
      "検証コマンドが無い基準にまで注記が付いている"
    );
  });
});

// ── a5 / a6: マージ前ゲートと同じ経路・環境は1回だけ ───────────────────────────

describe("[a5][a6] 検証はゲートと同じ経路で回り、環境は1回しか立てない", () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-verify-bag-"));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("[a6] 受け入れ条件が3本あっても、立てる環境は1つ・畳むのも1つ", async () => {
    const runner = hostVerifyRunner();
    const outcome = await runAcceptanceVerify({
      taskId: "task-many-ac",
      projectTag: "bagproj",
      acceptance: [
        { id: "a1", verify: 'sh -c "exit 0"' },
        { id: "a2", verify: 'sh -c "exit 0"' },
        { id: "a3", verify: 'sh -c "exit 0"' },
      ],
      worktreePath: dir,
      logBaseDir: path.join(dir, "logs-a6"),
      runner,
      repoPathForProfile: dir,
    });

    assert.equal(outcome.blocked, undefined, "検証に到達できているはず");
    assert.equal(outcome.runs.length, 3, "3本とも走ること");
    assert.equal(
      runner.provisioned.length,
      1,
      "**立てるのは1回**——受け入れ条件ごとに立て直すと、テスト一式を何度も用意することになる"
    );
    assert.equal(runner.tornDown.length, 1, "立てた分だけ畳むこと（I3）");
    assert.equal(runner.ran.length, 3, "3本を同じ環境で回すこと");
  });

  it("[a5] ゲートも前倒しの検証も、同じ関数（runAcceptanceVerify）を通る", () => {
    const gateSrc = fs.readFileSync(
      path.join(repoRoot, "packages/banto-daemon/src/merge-gate.ts"),
      "utf-8"
    );
    const daemonSrc = fs.readFileSync(
      path.join(repoRoot, "packages/banto-daemon/src/daemon.ts"),
      "utf-8"
    );

    // 環境を立てる呼び出しが1箇所しかない＝2箇所実装になっていない
    const provisionCalls = (gateSrc.match(/runner\.provision\(/g) ?? []).length;
    assert.equal(
      provisionCalls,
      1,
      "検証環境を立てる場所が複数ある——別実装になると" +
        "「ゲートは通るのに職人のところでは落ちる」が起きる"
    );
    assert.ok(
      !daemonSrc.includes("runVerifyInEnv"),
      "daemon.ts が検証の実行を自前で持っている（ゲートの経路を再利用すること）"
    );
    assert.match(
      daemonSrc,
      /runAcceptanceVerify\(\{/,
      "daemon.ts がゲートと共有の実行経路を呼んでいない"
    );
    assert.match(
      gateSrc,
      /await runAcceptanceVerify\(\{/,
      "runMergeGate が共有の実行経路を使っていない（切り出しただけで使っていない）"
    );
  });

  it("環境が立たないときは「落ちた」ではなく「到達できなかった」と言う（I2）", async () => {
    const outcome = await runAcceptanceVerify({
      taskId: "task-no-env",
      projectTag: "bagproj",
      acceptance: [{ id: "a1", verify: 'sh -c "exit 0"' }],
      worktreePath: dir,
      logBaseDir: path.join(dir, "logs-noenv"),
      runner: hostVerifyRunner({ failProvision: "docker が居ません" }),
      repoPathForProfile: dir,
    });
    assert.match(
      String(outcome.blocked),
      /verify_env_unavailable/,
      "立てられなかったことを、検証の失敗と混同している"
    );
    assert.equal(outcome.runs.length, 0, "走っていないのに結果を作らないこと");
  });
});

// ── a7: 職人へ返す結果の切り詰め ──────────────────────────────────────────────

describe("[a7] 職人へ返す検証の結果は切り詰める（失敗した箇所と末尾・全文の置き場所つき）", () => {
  const lines: string[] = [];
  for (let i = 1; i <= 4000; i++) {
    lines.push(i === 1500 ? `not ok 42 - FAIL さっきの検査が落ちた（${i}行目）` : `ok ${i} - 通った`);
  }
  lines.push("# fail 1", "最後の行");
  const huge = lines.join("\n");

  it("上限を超える分は落とす（巨大な出力を職人の文脈へ丸ごと載せない）", () => {
    const out = summarizeVerifyLog(huge, { fullLogPath: "/var/log/gate/a1/stdout.txt" });
    assert.ok(
      out.length < huge.length / 10,
      `切り詰められていない（元 ${huge.length} 字 → ${out.length} 字）`
    );
    // 見出し・区切りの分だけ増えるので、多少の余裕を見る
    assert.ok(
      out.split("\n").length <= VERIFY_LOG_MAX_LINES + 6,
      `上限（${VERIFY_LOG_MAX_LINES} 行）を大きく超えている: ${out.split("\n").length} 行`
    );
  });

  it("切り詰めたことと、全文の置き場所が分かる", () => {
    const out = summarizeVerifyLog(huge, { fullLogPath: "/var/log/gate/a1/stdout.txt" });
    assert.match(out, /切り詰めました/, "切ったことを黙らせている（I2）");
    assert.match(out, /全 4002 行/, "元が何行だったのかが書かれていない");
    assert.ok(
      out.includes("/var/log/gate/a1/stdout.txt"),
      "全文の置き場所が書かれていない——職人は「これが全部だ」と読んでしまう"
    );
  });

  it("失敗した箇所と末尾が残る", () => {
    const out = summarizeVerifyLog(huge, { fullLogPath: "/tmp/x.log" });
    assert.ok(
      out.includes("さっきの検査が落ちた（1500行目）"),
      "失敗した行が落とされている——どこで落ちたか分からなければ直せない"
    );
    assert.ok(out.includes("最後の行"), "末尾が落とされている（集計やスタックはここに出る）");
  });

  it("上限に収まる出力はそのまま返す（要らない加工をしない）", () => {
    const small = "1行目\n2行目\n3行目";
    assert.equal(summarizeVerifyLog(small, { fullLogPath: "/tmp/x.log" }), small);
  });
});

// ── a4: 袋の外で回した結果が職人へ届く ────────────────────────────────────────

interface CaptureRecord {
  opts: SpawnOptions;
  pid: number;
  sessionId: string;
}

/** 起こされた職人と、注入された文面を記録するだけのドライバ。 */
class CaptureDriver implements RuntimeDriver {
  readonly spawned: CaptureRecord[] = [];
  readonly injected: Array<{ sessionId: string; message: string }> = [];
  private handlers = new Set<DriverEventHandler>();
  private sessions = new Map<string, { pid: number }>();

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    const proc = childProcess.spawn("sleep", ["120"], { stdio: "ignore", detached: true });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error("CaptureDriver: pid が取れない");
    const sessionId = `capture-${opts.taskId}-${pid}`;
    this.sessions.set(sessionId, { pid });
    proc.once("exit", (code, signal) => {
      const ev: DriverEvent = { type: "process_exited", pid, sessionId, exitCode: code, signal };
      for (const h of this.handlers) {
        try {
          h(ev);
        } catch {
          /* 記録用のドライバなので無視 */
        }
      }
      this.sessions.delete(sessionId);
    });
    const startEv: DriverEvent = {
      type: "process_started",
      pid,
      sessionId,
      sessionPath: opts.sessionPath,
    };
    for (const h of this.handlers) {
      try {
        h(startEv);
      } catch {
        /* 同上 */
      }
    }
    this.spawned.push({ opts, pid, sessionId });
    return { pid, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(sessionId: string, message: string): Promise<void> {
    this.injected.push({ sessionId, message });
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async kill(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      /* もう死んでいる */
    }
  }

  async killAll(): Promise<void> {
    for (const [sid] of this.sessions) await this.kill(sid);
    await new Promise<void>((r) => setTimeout(r, 150));
  }
}

function git(args: string[], cwd: string): void {
  const r = childProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} が落ちた: ${r.stderr}`);
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
}

async function pollUntil<T>(
  fn: () => T,
  pred: (v: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 80
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = fn();
  }
  return last;
}

async function pollUntilAsync<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 80
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!pred(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

describe("[a4] Kobo が袋の外で検証を回し、落ちた中身が職人へ戻る", () => {
  let tmpDir: string;
  let repoDir: string;
  let daemon: Daemon;
  let base: string;
  let driver: CaptureDriver;
  let workers: WorkerPoolHarness;
  const runner = hostVerifyRunner();

  const proj = "proj-verify-outside-bag";
  const taskId = "task-outside-bag-1";

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobo-outside-bag-"));
    repoDir = path.join(tmpDir, "repo");
    initRepo(repoDir);

    driver = new CaptureDriver();
    workers = await startWorkerPool(driver);

    daemon = Daemon.create({
      port: 0,
      dataDir: path.join(tmpDir, "data"),
      tickIntervalMs: 99999,
      worktreeBaseDir: path.join(tmpDir, "worktrees"),
      workerPoolUrl: workers.url,
      // **これがこのタスクの要点**：検証は職人の袋の外（この runner の向こう）で回る
      verifyRunner: runner,
    });

    await daemon.start();
    base = `http://localhost:${daemon.port}`;

    const projRes = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: proj, repoPath: repoDir }),
    });
    assert.equal(projRes.status, 201, "プロジェクトを登録できること");

    // 職人が「終わった」と言うところまで進める（implementing → auditing）
    await createAndAdvance(base, proj, taskId, ["queued", "planning", "implementing"], {
      scope: { paths: ["src/**"] },
      acceptance: [
        {
          id: "a1",
          text: "検証が通る",
          verify: 'sh -c "echo 走りました; echo \'not ok 1 - ここで落ちた\' >&2; exit 3"',
        },
      ],
    });
    await transition(base, proj, taskId, "auditing");
  });

  after(async () => {
    await daemon.stop();
    await workers.close();
    await driver.killAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("検証は職人の中ではなく、Kobo が立てた検証環境で回る", async () => {
    await pollUntil(() => runner.ran.length, (n) => n >= 1);
    assert.equal(runner.ran.length, 1, "Kobo が検証環境で1本回すこと");
    assert.equal(runner.provisioned.length, 1, "立てるのは1回（a6）");
    assert.equal(runner.tornDown.length, 1, "回し終えたら畳むこと（I3）");
  });

  it("落ちたので監査へは回さず、実装者へ差し戻す", async () => {
    const settled = await pollUntilAsync(
      async () => {
        const res = await fetch(`${base}/api/v1/projects/${proj}/tasks/${taskId}`);
        const { task: t } = (await res.json()) as { task: { status: string } };
        return t.status;
      },
      (s) => s === "implementing",
      15_000
    );
    assert.equal(
      settled,
      "implementing",
      "検証が落ちているのに監査へ回している——落ちたものを監査させるのは無駄"
    );
    assert.ok(
      !driver.spawned.some((r) => r.opts.taskId === `${taskId}:audit`),
      "落ちた実装を監査人に見せている（監査人の時間も袋も無駄に使う）"
    );
  });

  it("何がどう落ちたのかが、職人へ届く文面に入っている", async () => {
    const reworkSpawn = await pollUntil(
      () => driver.spawned.find((r) => r.opts.taskId === `${taskId}:rework`),
      (found) => found !== undefined,
      15_000
    );
    assert.ok(
      reworkSpawn,
      `rework の職人が起こされること。起こされたのは: ${JSON.stringify(
        driver.spawned.map((r) => r.opts.taskId)
      )}`
    );

    const message = await pollUntil(
      () => driver.injected.find((r) => r.sessionId === reworkSpawn!.sessionId)?.message,
      (m) => m !== undefined,
      15_000
    );
    assert.ok(message, "指摘が職人へ注入されていない（届かなければ直せない）");

    assert.ok(message!.includes("[a1]"), "どの受け入れ基準が落ちたのかが無い");
    assert.match(message!, /exit=3/, "終了コードが無い——時間切れなのか失敗なのか分からない");
    assert.ok(message!.includes("ここで落ちた"), "検証の出力（落ちた箇所）が入っていない");
    assert.match(message!, /検証環境/, "どこで回したのかが分からない");
    assert.match(
      message!,
      /全文/,
      "全文の置き場所が示されていない（a7：切り詰めるなら置き場所を添える）"
    );
  });
});
