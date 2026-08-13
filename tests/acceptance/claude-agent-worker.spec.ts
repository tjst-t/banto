/**
 * 職人を **Claude Code（Agent SDK）** でも動かせるようにする（PO要望 2026-08-10）。
 *
 * 見たいのは3つ:
 *   1. ランタイム中立な口（`worker.delegate`）から Claude Code を選べること・
 *      **番頭がモデルを名指しできる**こと
 *   2. 起こしたときのランタイムが職人ごとに残り、追加の指示（steer）・畳み（close）・
 *      起こし直し（wake）が**同じランタイムへ**届くこと
 *   3. ドライバが子プロセスと約束どおりの言葉で話すこと（本物の Claude を呼ばずに確かめる）
 *
 * **本物の Claude は呼ばない。** 認証と課金の前提が要るものを試験に混ぜると、落ちた理由が
 * 「壊れた」のか「鍵が無い」のか分からなくなる（P6：間欠の芽を持ち込まない）。ここでは
 * ホストの代わりに、同じ言葉を話す小さな台本を起こして経路を通す。
 */

import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";

import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import {
  ClaudeAgentDriver,
  CLAUDE_AGENT_DRIVER_ID,
  CLAUDE_ASK_TOOL,
  CLAUDE_KNOWN_MODELS,
  CLAUDE_KOBO_TOOL_NAMES,
  createKoboChannel,
  CLAUDE_REPORT_TOOL,
  SessionTranscript,
  WorkerPool,
  createWorkerPoolSettings,
  createWorkerTools,
  endedWithoutReporting,
  readSessionIdFromLines,
  resolveClaudeModel,
  toClaudeToolNames,
} from "@banto/worker-pool";

/** ToolDefinition.execute の第5引数は本Tool群が参照しないためスタブ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由 (I4)
const TOOL_CTX = {} as any;

// ── 偽ドライバ（どのランタイムに渡ったかだけを見る） ─────────────────────────

class FakeDriver implements RuntimeDriver {
  readonly spawned: SpawnOptions[] = [];
  readonly injected: Array<{ sessionId: string; message: string }> = [];
  readonly killed: string[] = [];
  private counter = 0;
  private readonly handlers = new Set<DriverEventHandler>();
  private readonly children: childProcess.ChildProcess[] = [];
  private readonly sessionIdByPath = new Map<string, string>();

  constructor(private readonly label: string) {}

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    this.spawned.push(opts);
    this.counter += 1;
    const resume = opts.driverOptions?.["resumeSessionPath"];
    const sessionId =
      typeof resume === "string"
        ? (this.sessionIdByPath.get(resume) ?? `${this.label}-${this.counter}`)
        : `${this.label}-${this.counter}`;
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");
    this.sessionIdByPath.set(opts.sessionPath, sessionId);
    // 実プロセスを持たせる：Worker Pool は pid の生存で職人の生死を見るため
    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    this.children.push(child);
    return { pid: child.pid!, sessionId, sessionPath: opts.sessionPath };
  }

  async inject(sessionId: string, message: string): Promise<void> {
    this.injected.push({ sessionId, message });
  }

  async kill(sessionId: string): Promise<void> {
    this.killed.push(sessionId);
  }

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: DriverEvent): void {
    for (const handler of this.handlers) handler(event);
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }

  cleanup(): void {
    for (const child of this.children) {
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // 既に終わっている
        }
      }
    }
    this.children.length = 0;
  }
}

// ── 名前の対応（純関数） ────────────────────────────────────────────────────

describe("[claude-worker] 中立な道具名を Claude Code の名前へ写す", () => {
  it("[claude-worker] pi 側の名前が Claude の名前になる", () => {
    assert.deepEqual(toClaudeToolNames(["read", "grep", "bash", "edit", "write"]), [
      "Read",
      "Grep",
      "Bash",
      "Edit",
      "Write",
    ]);
  });

  it("[claude-worker] ls と find はどちらも Glob（重複は畳む）", () => {
    assert.deepEqual(toClaudeToolNames(["ls", "find"]), ["Glob"]);
  });

  it("[claude-worker] 報告経路と外を読む口も対応が付く", () => {
    assert.deepEqual(toClaudeToolNames(["worker__report", "worker__ask", "web.fetch"]), [
      CLAUDE_REPORT_TOOL,
      CLAUDE_ASK_TOOL,
      "WebFetch",
    ]);
  });

  it("[claude-worker] 知らない名前は捨てずにそのまま通す", () => {
    // I2: ここで黙って捨てると、絞ったつもりの許可リストが空になり道具の無い職人が生まれる
    assert.deepEqual(toClaudeToolNames(["Read", "mcp__other__thing"]), [
      "Read",
      "mcp__other__thing",
    ]);
  });
});

describe("[claude-worker] 使うモデルの決め方", () => {
  it("[claude-worker] 名指しが等級より優先される（番頭が選べる）", () => {
    assert.equal(resolveClaudeModel("claude-opus-5", "fast"), "claude-opus-5");
  });

  it("[claude-worker] 名指しが無ければ等級から決まる", () => {
    assert.equal(resolveClaudeModel(undefined, "reasoning"), "opus");
    assert.equal(resolveClaudeModel(undefined, "fast"), "haiku");
  });

  it("[claude-worker] どちらも無ければ既定に落ちる", () => {
    assert.equal(resolveClaudeModel(undefined, undefined, "sonnet"), "sonnet");
    assert.equal(resolveClaudeModel("   ", undefined, "sonnet"), "sonnet");
  });
});

// ── セッションの写し（覗き窓が壊れないこと） ────────────────────────────────

describe("[claude-worker] 会話をセッションJSONLへ写す", () => {
  it("[claude-worker] 発話・思考・道具の呼び出しと結果が、ビューアの読める形になる", () => {
    const transcript = new SessionTranscript();
    const start = transcript.start("sess-1", "opus", "2026-08-10T00:00:00.000Z");
    assert.equal(start[0]?.["type"], "session");
    assert.equal(start[1]?.["modelId"], "opus");

    const assistant = transcript.fromSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "考える" },
          { type: "text", text: "直します" },
          { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/a" } },
        ],
      },
    });
    const content = (assistant[0]?.["message"] as { content: Record<string, unknown>[] }).content;
    assert.deepEqual(
      content.map((block) => block["type"]),
      ["thinking", "text", "toolCall"]
    );

    const result = transcript.fromSdkMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "中身" }],
      },
    });
    const message = result[0]?.["message"] as Record<string, unknown>;
    assert.equal(message["role"], "toolResult");
    assert.equal(message["toolCallId"], "call-1");
    // 呼び出しの名前を覚えていないと、ビューアには「結果」とだけ出る
    assert.equal(message["toolName"], "Read");
  });

  it("[claude-worker] 書いたセッションから Claude の session id を読み戻せる（起こし直しの手がかり）", () => {
    const lines = new SessionTranscript()
      .start("sess-42", "sonnet", "2026-08-10T00:00:00.000Z")
      .map((line) => JSON.stringify(line));
    assert.equal(readSessionIdFromLines(lines), "sess-42");
    assert.equal(readSessionIdFromLines(["こわれた行"]), undefined);
  });
});

describe("[claude-worker] 黙って終える職人の安全弁", () => {
  it("[claude-worker] 報告も質問もしていなければ拾う", () => {
    assert.equal(endedWithoutReporting(new Set(["Read", "Bash"])), true);
  });

  it("[claude-worker] 報告していれば拾わない／質問して待っているのも拾わない", () => {
    assert.equal(endedWithoutReporting(new Set([CLAUDE_REPORT_TOOL])), false);
    assert.equal(endedWithoutReporting(new Set([CLAUDE_ASK_TOOL])), false);
  });
});

// ── ランタイムの選択と経路 ──────────────────────────────────────────────────

let dir: string;
let piDriver: FakeDriver;
let claudeDriver: FakeDriver;
let pool: WorkerPool;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-claude-worker-"));
  piDriver = new FakeDriver("pi");
  claudeDriver = new FakeDriver("claude");
  pool = new WorkerPool({
    driver: piDriver,
    // 本物と同じ形で登録する（バックエンドが自分の持ちモデルを名乗る）
    runtimes: { [CLAUDE_AGENT_DRIVER_ID]: claudeBackend(claudeDriver) },
    dataDir: dir,
    defaultProjectTag: "test",
    idleTimeoutMs: 0,
  });
});

afterEach(() => {
  pool.dispose();
  piDriver.cleanup();
  claudeDriver.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const JOB = { taskId: "task-0100", worktreePath: "/tmp/wt", instruction: "調べて直して" };

/** bin.ts と同じ登録の形（表示名・使えるか・持っているモデル）。 */
const claudeBackend = (driver: FakeDriver) => ({
  driver,
  title: "Claude Code",
  description: "Claude Code（Agent SDK）",
  probe: () => ({ ok: true, detail: "試験用" }),
  models: () => CLAUDE_KNOWN_MODELS.map((m) => ({ name: m.value, label: m.label })),
});

describe("[claude-worker] 番頭がランタイムとモデルを選ぶ", () => {
  it("[claude-worker] 既定では pi。runtime を渡すと Claude Code で起きる", async () => {
    await pool.delegate(JOB);
    assert.equal(piDriver.spawned.length, 1);
    assert.equal(claudeDriver.spawned.length, 0);

    const worker = await pool.delegate({ ...JOB, taskId: "task-0101", runtime: "claude-code" });
    assert.equal(claudeDriver.spawned.length, 1);
    assert.equal(worker.runtime, CLAUDE_AGENT_DRIVER_ID);
  });

  it("[claude-worker] `claude` / `claude-agent-sdk` のどの呼び方でも通る", async () => {
    await pool.delegate({ ...JOB, taskId: "task-0102", runtime: "claude" });
    await pool.delegate({ ...JOB, taskId: "task-0103", runtime: CLAUDE_AGENT_DRIVER_ID });
    assert.equal(claudeDriver.spawned.length, 2);
  });

  it("[claude-worker] 知らないランタイムは黙って既定に落とさず、選べる名前を添えて断る", async () => {
    // I2: 「claude で頼んだのに pi で動いていた」は出来上がりを見ても気づけない
    await assert.rejects(
      () => pool.delegate({ ...JOB, taskId: "task-0104", runtime: "gpt" }),
      /Unknown runtime "gpt".*claude-agent-sdk/s
    );
    assert.equal(piDriver.spawned.length, 0);
    assert.equal(claudeDriver.spawned.length, 0);
  });

  it("[claude-worker] モデルの名指しがドライバまで届く", async () => {
    const worker = await pool.delegate({
      ...JOB,
      taskId: "task-0105",
      runtime: "claude-code",
      model: "opus",
      modelTier: "fast",
    });
    const spawned = claudeDriver.spawned[0]!;
    assert.equal(spawned.driverOptions?.["model"], "opus");
    // 等級もそのまま渡す（名指しが無いときのために、ドライバ側で解決できるように）
    assert.equal(spawned.modelTier, "fast");
    assert.equal(worker.model, "opus");
  });

  it("[claude-worker] 外を読む口を許したかどうかもドライバに渡る（imp-0005）", async () => {
    await pool.delegate({ ...JOB, taskId: "task-0106", runtime: "claude-code", network: true });
    assert.equal(claudeDriver.spawned[0]?.driverOptions?.["network"], true);
  });
});

describe("[claude-worker] 起こしたランタイムに、あとの操作も届く", () => {
  it("[claude-worker] steer と close は起こしたランタイムへ行く", async () => {
    const worker = await pool.delegate({ ...JOB, taskId: "task-0110", runtime: "claude-code" });

    await pool.steer(worker.sessionId, "こちらも見て");
    assert.deepEqual(
      claudeDriver.injected.map((i) => i.message),
      ["調べて直して", "こちらも見て"]
    );
    assert.equal(piDriver.injected.length, 0);

    await pool.close(worker.sessionId, "done");
    assert.deepEqual(claudeDriver.killed, [worker.sessionId]);
    assert.equal(piDriver.killed.length, 0);
  });

  it("[claude-worker] 一覧にもランタイムとモデルが出る", async () => {
    await pool.delegate({ ...JOB, taskId: "task-0111", runtime: "claude-code", model: "opus" });
    const listed = pool.list().find((w) => w.taskId === "task-0111");
    assert.equal(listed?.runtime, CLAUDE_AGENT_DRIVER_ID);
    assert.equal(listed?.model, "opus");
  });

  it("[claude-worker] 起こし直しは同じランタイム・同じモデルで（別のランタイムで目を覚まさない）", async () => {
    const worker = await pool.delegate({
      ...JOB,
      taskId: "task-0112",
      runtime: "claude-code",
      model: "opus",
    });
    await pool.close(worker.sessionId, "done");

    const woken = await pool.wake(worker.sessionId, "続きを頼む");
    assert.equal(woken.runtime, CLAUDE_AGENT_DRIVER_ID);
    assert.equal(claudeDriver.spawned.length, 2);
    assert.equal(piDriver.spawned.length, 0);
    assert.equal(claudeDriver.spawned[1]?.driverOptions?.["model"], "opus");
    // 決定30d: 元のセッションの再開である（会話が戻る）
    assert.equal(claudeDriver.spawned[1]?.driverOptions?.["resumeSessionPath"], worker.sessionPath);
  });

  it("[claude-worker] どのランタイムの終了も記録される（購読の取りこぼしが無い）", async () => {
    const worker = await pool.delegate({ ...JOB, taskId: "task-0113", runtime: "claude-code" });
    claudeDriver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 0,
      signal: null,
    });
    const exited = pool.events(0, { sessionId: worker.sessionId, type: "worker_exited" });
    assert.equal(exited.length, 1);
  });
});

describe("[claude-worker] 番頭の口（worker.delegate）から選べる", () => {
  it("[claude-worker] runtime と model が Tool 越しに通る", async () => {
    const tools = createWorkerTools(pool);
    const delegate = tools.find((t) => t.name === "worker.delegate")!;
    const result = await delegate.execute(
      {
        taskId: "task-0120",
        worktreePath: "/tmp/wt",
        instruction: "調べて",
        runtime: "claude-code",
        model: "haiku",
      },
      TOOL_CTX
    );

    assert.equal(claudeDriver.spawned.length, 1);
    assert.equal(claudeDriver.spawned[0]?.driverOptions?.["model"], "haiku");
    // 番頭には「どのランタイムのどのモデルで起きたか」が返る
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /claude-agent-sdk\/haiku/);
  });

  it("[claude-worker] 選べるランタイムが Tool の説明に出る（番頭が綴りを当てにいかない）", () => {
    const delegate = createWorkerTools(pool).find((t) => t.name === "worker.delegate")!;
    const properties = (
      delegate.parameters as { properties: Record<string, { description?: string }> }
    ).properties;
    assert.match(properties["runtime"]?.description ?? "", /claude-code/);
    assert.match(properties["model"]?.description ?? "", /opus/);
  });

  it("[claude-worker] Tool の契約は、生きた工房が無くても組み立てられる", () => {
    // 番頭ホストは別プロセスの工房を「契約だけの写し」（remote-module.ts）として載せる。
    // 説明文を作るのに pool の中身を覗くと、その写しが触れた瞬間に落ちる（実際に踏んだ）
    const contractOnly = new Proxy({} as WorkerPool, {
      get(_target, prop) {
        throw new Error(`実装を持たない写しに触れました: ${String(prop)}`);
      },
    });
    const names = createWorkerTools(contractOnly).map((t) => t.name);
    assert.ok(names.includes("worker.delegate"));
  });
});

// ── ドライバと子プロセスの約束 ──────────────────────────────────────────────

/**
 * ホストの代わりに立てる台本。**同じ言葉だけを話す**（get_state / prompt / abort）。
 *
 * 本物の Claude を呼ばずに、ドライバ側の経路（起動・名乗り・指示・畳み）を通す。
 * 受け取った引数はファイルに書き出して、写した名前を試験から確かめられるようにする。
 */
const STUB_HOST = `
import * as fs from "node:fs";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf("--" + name); return i === -1 ? undefined : args[i + 1]; };
const sessionFile = flag("session-file");
const sessionId = flag("resume") ?? "stub-session";
fs.writeFileSync(process.env.STUB_ARGV_FILE, JSON.stringify({ args, env: {
  BANTO_WORKER_POOL_URL: process.env.BANTO_WORKER_POOL_URL,
  BANTO_TASK_ID: process.env.BANTO_TASK_ID,
  BANTO_DAEMON_URL: process.env.BANTO_DAEMON_URL,
} }));
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
      fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "user", content: cmd.message } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: "prompt", success: true }) + "\\n");
    } else if (cmd.type === "abort") {
      process.exit(0);
    }
  }
});
setInterval(() => {}, 1000);
`;

/**
 * **工場の口が、工場の面をそのまま叩く**（PO報告 2026-08-11）。
 *
 * pi 拡張（`pi-extension/banto-executor.ts` / `banto-auditor.ts`）と同じ HTTP 面を使う
 * ——ランタイムが違っても、工場から見た形が変わらないこと。
 */
describe("[PO報告 2026-08-11] 工場（Kobo）の口", () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ path: string; body: unknown }> = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += String(c)));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const env = (): NodeJS.ProcessEnv => ({
    BANTO_DAEMON_URL: base,
    BANTO_PROJECT: "hiragana",
    // 役目の接尾辞は工房の都合。工場の帳簿の鍵はタスクだけ
    BANTO_TASK_ID: "task-0002:audit",
  });

  it("到達先が無ければ口を作らない（工場の職人でないものに渡さない）", () => {
    assert.equal(createKoboChannel({}), undefined);
    assert.equal(createKoboChannel({ BANTO_DAEMON_URL: base }), undefined);
  });

  it("report_done は監査へ回す（自分で review-ready へ進めない）", async () => {
    seen.length = 0;
    const kobo = createKoboChannel(env())!;
    await kobo.reportDone("a66ea05 でコミット済み");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.path, "/api/v1/projects/hiragana/tasks/task-0002/transition");
    assert.deepEqual(seen[0]!.body, { to: "auditing", reason: "a66ea05 でコミット済み" });
  });

  it("audit_report は判定をそのまま出す（自由文にしない）", async () => {
    seen.length = 0;
    const kobo = createKoboChannel(env())!;
    await kobo.auditReport("fail", ["a2 が未検証"]);
    assert.equal(seen[0]!.path, "/api/v1/projects/hiragana/tasks/task-0002/audit-report");
    assert.deepEqual(seen[0]!.body, { verdict: "fail", findings: ["a2 が未検証"] });
  });

  it("届かなかったことを成功に見せない（I2）", async () => {
    const kobo = createKoboChannel({ ...env(), BANTO_DAEMON_URL: "http://127.0.0.1:1" })!;
    await assert.rejects(() => kobo.reportDone("x"), /工場への/u);
  });
});

describe("[claude-worker] ドライバは子プロセスと約束どおりに話す", () => {
  let stubDir: string;
  let stubPath: string;
  let argvFile: string;
  let driver: ClaudeAgentDriver;

  beforeEach(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-claude-stub-"));
    stubPath = path.join(stubDir, "stub-host.mjs");
    argvFile = path.join(stubDir, "argv.json");
    fs.writeFileSync(stubPath, STUB_HOST);
    process.env["STUB_ARGV_FILE"] = argvFile;
    driver = new ClaudeAgentDriver({
      hostPath: stubPath,
      nodeArgs: [],
      sessionBaseDir: path.join(stubDir, "sessions"),
    });
  });

  afterEach(async () => {
    for (const sessionId of driver.listActiveSessions()) await driver.kill(sessionId);
    delete process.env["STUB_ARGV_FILE"];
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  const spawnOptions = (over: Partial<SpawnOptions> = {}): SpawnOptions => ({
    taskId: "task-0130",
    worktreePath: stubDir,
    sessionPath: path.join(stubDir, "sessions", "task-0130.jsonl"),
    systemPrompt: "You are a worker.",
    tools: [],
    ...over,
  });

  it("[claude-worker] 起こすと名乗りが返り、指示が届く", async () => {
    const handle = await driver.spawn(spawnOptions());
    assert.equal(handle.sessionId, "stub-session");
    assert.ok(handle.pid > 0);

    await driver.inject(handle.sessionId, "はじめてください");
    const session = fs.readFileSync(handle.sessionPath, "utf-8");
    assert.match(session, /はじめてください/);
  });

  /**
   * **起こせなかったことで工房ごと落とさない**（PO報告 2026-08-11）。
   *
   * ワークツリーが無い（＝`cwd` が無い）と `spawn` は `ENOENT` を **`error` イベントで**
   * 返す。受け手が居ない `error` は Node の決まりでプロセスごと落ちる——実際に工房の
   * サービスが死に、systemd が起こし直すまで**動いていた他の職人も道連れ**になった。
   */
  it("[PO報告 2026-08-11] 作業場所が無くても、断るだけで工房は生きている", async () => {
    const missing = path.join(stubDir, "無いワークツリー");
    const failures: string[] = [];
    driver.subscribe((e) => {
      if (e.type === "spawn_failed") failures.push(String(e.error ?? ""));
    });

    await assert.rejects(
      () => driver.spawn(spawnOptions({ worktreePath: missing })),
      /起こせませんでした/u,
      "起こせなかったことは断って伝える（黙って「起きたつもり」にしない）"
    );
    // **なぜ**まで届く。「pid が取れません」だけでは手が打てない
    assert.match(failures.join("\n"), /ENOENT|no such file/u);
    assert.match(failures.join("\n"), /無いワークツリー/u, "どこが無いのかが分かること");

    // 工房は生きている：次の職人はふつうに起こせる
    const handle = await driver.spawn(spawnOptions());
    assert.ok(handle.pid > 0, "1人起こせなかっただけで工房が死んでいる");
  });

  it("[claude-worker] 絞った道具は Claude の名前に写り、報告経路は残る（imp-0004）", async () => {
    await driver.spawn(spawnOptions({ tools: ["read", "grep"] }));
    const { args } = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as { args: string[] };
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    // 報告・質問に加えて**工場の口も消さない**（PO報告 2026-08-11）——絞り込みで
    // 消えると、実装を終えても工場へ伝えられずタスクが1本も完走しなくなる
    assert.deepEqual(tools, [
      "Read",
      "Grep",
      CLAUDE_REPORT_TOOL,
      CLAUDE_ASK_TOOL,
      ...CLAUDE_KOBO_TOOL_NAMES,
    ]);
    // 外を読む口は許していないので足さない（imp-0005）
    assert.equal(tools.includes("WebFetch"), false);
  });

  /**
   * **工場（Kobo）の口が生える**（PO報告 2026-08-11）。
   *
   * Kobo は `driverOptions.extensionPaths`（pi の言葉）で職人に `report_done` /
   * `audit_report` を渡す前提だったが、このドライバはそれを黙って無視していた。
   * **Claude Code の職人には工場の口が1つも無く**、実装を終えてコミットまでしていても
   * タスクは `implementing` のまま止まった。監査人は「`audit_report` ツールはこの環境に
   * 存在せず」と書き残して落ちた（実機の記録）。
   */
  it("[PO報告 2026-08-11] 工場が起こした職人には、工場の口が渡る", async () => {
    await driver.spawn(
      spawnOptions({ tools: ["read"], driverOptions: { daemonUrl: "http://127.0.0.1:4500" } })
    );
    const { args, env } = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as {
      args: string[];
      env?: Record<string, string>;
    };
    // 到達先が子へ渡る（無いと口を作れない）
    assert.equal(env?.["BANTO_DAEMON_URL"], "http://127.0.0.1:4500");
    // 絞り込んでも消えない
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    for (const name of CLAUDE_KOBO_TOOL_NAMES) {
      assert.ok(tools.includes(name), `${name} が絞り込みで消えている`);
    }
  });

  it("[claude-worker] モデルの名指しと外の口の許可が子プロセスへ渡る", async () => {
    await driver.spawn(spawnOptions({ driverOptions: { model: "opus", network: true } }));
    const { args } = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as { args: string[] };
    assert.equal(args[args.indexOf("--model") + 1], "opus");
    assert.ok(args.includes("--network"));
  });

  it("[claude-worker] 起こし直しは元のセッションの id を読み戻して渡す（決定30d）", async () => {
    const previous = path.join(stubDir, "previous.jsonl");
    fs.writeFileSync(previous, JSON.stringify({ type: "session", sessionId: "sess-old" }) + "\n");

    const handle = await driver.spawn(
      spawnOptions({
        sessionPath: path.join(stubDir, "sessions", "resumed.jsonl"),
        driverOptions: { resumeSessionPath: previous },
      })
    );
    const { args } = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as { args: string[] };
    assert.equal(args[args.indexOf("--resume") + 1], "sess-old");
    // pi と同じく、再開した職人は同じ sessionId で返る
    assert.equal(handle.sessionId, "sess-old");
  });

  it("[claude-worker] 元のセッションが読めないときは、新しい会話で黙って起こさない（I2）", async () => {
    await assert.rejects(
      () =>
        driver.spawn(
          spawnOptions({ driverOptions: { resumeSessionPath: path.join(stubDir, "nope.jsonl") } })
        ),
      /起こし直しの元セッションを読めません/
    );
  });

  it("[claude-worker] 報告の宛先と名乗りが環境変数で渡る（決定29e）", async () => {
    await driver.spawn(
      spawnOptions({ driverOptions: { workerPoolUrl: "http://127.0.0.1:4300/api/worker-pool" } })
    );
    const { env } = JSON.parse(fs.readFileSync(argvFile, "utf-8")) as {
      env: Record<string, string>;
    };
    assert.equal(env["BANTO_WORKER_POOL_URL"], "http://127.0.0.1:4300/api/worker-pool");
    assert.equal(env["BANTO_TASK_ID"], "task-0130");
  });

  it("[claude-worker] 畳むとプロセスが終わり、終了が知らされる", async () => {
    const events: DriverEvent[] = [];
    driver.subscribe((event) => events.push(event));
    const handle = await driver.spawn(spawnOptions());
    await driver.kill(handle.sessionId);
    assert.equal(driver.listActiveSessions().length, 0);
    assert.ok(events.some((e) => e.type === "process_started"));
  });

  it("[claude-worker] 起きなかった職人は spawn_failed になり、例外で伝わる（I2）", async () => {
    const broken = new ClaudeAgentDriver({
      hostPath: path.join(stubDir, "missing-host.mjs"),
      nodeArgs: [],
    });
    const events: DriverEvent[] = [];
    broken.subscribe((event) => events.push(event));
    await assert.rejects(() => broken.spawn(spawnOptions()));
    assert.ok(events.some((e) => e.type === "spawn_failed"));
  });
});

// ── モデルの名指しと、設定画面から選べること ────────────────────────────────

describe("[claude-worker] モデルの名指しから、ランタイムが決まる", () => {
  it("[claude-worker] Claude Code の名前を書けば、ランタイムを併記しなくても Claude Code で起きる", async () => {
    // 2か所（runtime と model）に書かせると、片方だけ直した指定が黙って通る
    const worker = await pool.delegate({ ...JOB, taskId: "task-0140", model: "opus" });
    assert.equal(worker.runtime, CLAUDE_AGENT_DRIVER_ID);
    assert.equal(claudeDriver.spawned[0]?.driverOptions?.["model"], "opus");
  });

  it("[claude-worker] pi のモデルは provider/model に割ってドライバへ渡る", async () => {
    await pool.delegate({ ...JOB, taskId: "task-0141", model: "opencode-go/deepseek-v4-flash" });
    const spawned = piDriver.spawned[0]!;
    assert.equal(spawned.driverOptions?.["provider"], "opencode-go");
    assert.equal(spawned.driverOptions?.["model"], "deepseek-v4-flash");
  });

  it("[claude-worker] 既定のバックエンドが Claude でも、pi のモデルは pi で起きる", async () => {
    // **実機で踏んだ取り違え**：既定を Claude Code にすると、等級に当てた pi のモデル
    // （provider/model）が Claude Code へ流れ、Claude が見ない `provider` を落として
    // 存在しないモデル名で起こそうとしていた。名前の持ち主でランタイムを決める
    const withCatalog = new WorkerPool({
      driver: piDriver,
      runtimes: { [CLAUDE_AGENT_DRIVER_ID]: claudeBackend(claudeDriver) },
      catalog: {
        models: () => [
          {
            providerId: "opencode-go",
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            tier: "standard",
            policy: ["worker"],
          },
        ],
      },
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "banto-default-backend-")),
      idleTimeoutMs: 0,
    });
    try {
      const settings = createWorkerPoolSettings(withCatalog);
      settings.write({ backends: { [CLAUDE_AGENT_DRIVER_ID]: { makeDefault: true } } });
      settings.write({ assignments: { standard: "opencode-go/deepseek-v4-flash" } });

      const worker = await withCatalog.delegate({
        ...JOB,
        taskId: "task-0160",
        modelTier: "standard",
      });
      assert.equal(worker.runtime, "pi-rpc", "pi のモデルは pi で起きる");
      assert.equal(claudeDriver.spawned.length, 0, "Claude Code には流れない");
    } finally {
      withCatalog.dispose();
    }
  });

  it("[claude-worker] 名指しとランタイムが食い違うなら断る（どちらが違うのか分からなくなる）", async () => {
    // 一覧が持ち主を知っているときだけ言える。**知らない名前は断らない**
    // ——採用していないモデルを頼まれただけかもしれず、そこまでは言い当てられない（I1）
    await assert.rejects(
      () => pool.delegate({ ...JOB, taskId: "task-0161", runtime: "pi", model: "opus" }),
      /食い違って/
    );
  });

  it("[claude-worker] 割れない名前は断る（pi は片方だけでは効かない・I2）", async () => {
    await assert.rejects(
      () => pool.delegate({ ...JOB, taskId: "task-0142", model: "deepseek-v4-flash" }),
      /provider\/model/
    );
    assert.equal(piDriver.spawned.length, 0);
  });

  it("[claude-worker] 名指しできるモデルを数え上げられる（worker.models）", async () => {
    const withCatalog = new WorkerPool({
      driver: piDriver,
      runtimes: { [CLAUDE_AGENT_DRIVER_ID]: claudeBackend(claudeDriver) },
      catalog: {
        models: () => [
          { providerId: "opencode-go", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", tier: "standard", policy: ["worker"] },
          // 採用していないものは並べない（PO裁定 2026-08-04）
          { providerId: "opencode-go", id: "not-adopted", name: "未採用", tier: "fast", policy: [] },
        ],
      },
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "banto-claude-models-")),
      defaultProjectTag: "test",
      idleTimeoutMs: 0,
    });
    try {
      const names = withCatalog.selectableModels().map((m) => m.name);
      assert.ok(names.includes("opus"), "Claude Code の別名が並ぶ");
      assert.ok(names.includes("opencode-go/deepseek-v4-flash"), "採用した pi のモデルが並ぶ");
      assert.equal(names.includes("opencode-go/not-adopted"), false, "採用していないものは並べない");

      const tool = createWorkerTools(withCatalog).find((t) => t.name === "worker.models")!;
      const result = await tool.execute({}, TOOL_CTX);
      assert.match(result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), /opus/);
    } finally {
      withCatalog.dispose();
    }
  });
});

describe("[claude-worker] 職人の設定（バックエンドと等級ごとのモデル）", () => {
  /** 設定の区画を、実体の工房に対して組み立てる。 */
  const settingsOf = (target: WorkerPool = pool) => createWorkerPoolSettings(target);

  it("[claude-worker] 項目ではなく描き先を宣言する（決定43 をモジュールへ開放）", () => {
    // 一覧と状態が絡むので平たい項目にはしない。**読み書きは設定画面の口のまま**
    const spec = settingsOf();
    assert.equal(spec.view, "WorkerSettings");
    assert.deepEqual(spec.fields, []);
  });

  it("[claude-worker] バックエンドの一覧が状態つきで出る", async () => {
    const spec = settingsOf();
    const values = (await spec.read()) as Record<string, unknown>;
    const backends = values["backends"] as Array<Record<string, unknown>>;
    assert.deepEqual(
      backends.map((b) => b["id"]).sort(),
      ["claude-agent-sdk", "pi-rpc"]
    );
    assert.equal(backends.find((b) => b["id"] === "pi-rpc")?.["isDefault"], true);
    assert.equal(backends.every((b) => b["enabled"] === true), true);
  });

  it("[claude-worker] 等級にモデルを当てると、その等級の職人がそのモデルで起きる", async () => {
    const spec = settingsOf();
    await spec.write({ assignments: { reasoning: "opus" } });

    const worker = await pool.delegate({ ...JOB, taskId: "task-0150", modelTier: "reasoning" });
    // 名指しが無くても、割り当てからランタイムまで決まる
    assert.equal(worker.runtime, CLAUDE_AGENT_DRIVER_ID);
    assert.equal(claudeDriver.spawned[0]?.driverOptions?.["model"], "opus");
  });

  it("[claude-worker] 名指しは割り当てより優先される（番頭の判断が勝つ）", async () => {
    await settingsOf().write({ assignments: { standard: "opus" } });
    await pool.delegate({ ...JOB, taskId: "task-0151", modelTier: "standard", model: "haiku" });
    assert.equal(claudeDriver.spawned[0]?.driverOptions?.["model"], "haiku");
  });

  it("[claude-worker] 選べないモデルは当てさせない（保存できたのに起きない、を作らない）", async () => {
    // 同期に投げるので throws で受ける（保存の口はその場で断る）
    assert.throws(() => settingsOf().write({ assignments: { fast: "gpt-9" } }), /知らないモデルです/);
  });

  it("[claude-worker] 切ったバックエンドでは起こさない。モデルの一覧からも消える", async () => {
    const spec = settingsOf();
    await spec.write({ backends: { "claude-agent-sdk": { enabled: false } } });

    const values = (await spec.read()) as Record<string, unknown>;
    const models = values["models"] as Array<Record<string, unknown>>;
    assert.equal(models.some((m) => m["runtime"] === CLAUDE_AGENT_DRIVER_ID), false);

    await assert.rejects(
      () => pool.delegate({ ...JOB, taskId: "task-0152", runtime: "claude-code" }),
      /切ってあります/
    );

    // 入れ直せる（切ったら消える、では戻せない）
    await spec.write({ backends: { "claude-agent-sdk": { enabled: true } } });
    const back = (await spec.read()) as Record<string, unknown>;
    assert.equal(
      (back["models"] as Array<Record<string, unknown>>).some(
        (m) => m["runtime"] === CLAUDE_AGENT_DRIVER_ID
      ),
      true
    );
  });

  it("[claude-worker] 最後のバックエンドは切れない（職人を起こせなくなる）", async () => {
    const spec = settingsOf();
    await spec.write({ backends: { "claude-agent-sdk": { enabled: false } } });
    assert.throws(
      () => spec.write({ backends: { "pi-rpc": { enabled: false } } }),
      /最後のバックエンド/
    );
  });

  it("[claude-worker] 「指定なしのときの実際」は、既定のバックエンド自身が答える", async () => {
    // 工房が代表して答えると、既定を切り替えた瞬間に画面が嘘をつく（実機で出していた）
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-fallback-"));
    const withResolvers = new WorkerPool({
      driver: piDriver,
      driverRegistration: {
        title: "pi",
        resolveTier: (tier) => (tier === "reasoning" ? "opencode-go/kimi-k3" : undefined),
      },
      runtimes: {
        [CLAUDE_AGENT_DRIVER_ID]: {
          ...claudeBackend(claudeDriver),
          resolveTier: (tier) => ({ reasoning: "opus", standard: "sonnet", fast: "haiku" })[tier],
        },
      },
      dataDir,
      idleTimeoutMs: 0,
    });
    try {
      const settings = createWorkerPoolSettings(withResolvers);
      const asPi = (await settings.read()) as Record<string, unknown>;
      assert.equal(asPi["fallbackBackend"], "pi");
      assert.deepEqual(asPi["fallbacks"], { reasoning: "opencode-go/kimi-k3" });

      settings.write({ backends: { [CLAUDE_AGENT_DRIVER_ID]: { makeDefault: true } } });
      const asClaude = (await settings.read()) as Record<string, unknown>;
      assert.equal(asClaude["fallbackBackend"], "Claude Code");
      assert.deepEqual(asClaude["fallbacks"], {
        reasoning: "opus",
        standard: "sonnet",
        fast: "haiku",
      });
    } finally {
      withResolvers.dispose();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("[claude-worker] 既定のバックエンドを差し替えられる", async () => {
    const spec = settingsOf();
    await spec.write({ backends: { "claude-agent-sdk": { makeDefault: true } } });
    assert.equal(pool.defaultRuntime, CLAUDE_AGENT_DRIVER_ID);

    const worker = await pool.delegate({ ...JOB, taskId: "task-0153" });
    assert.equal(worker.runtime, CLAUDE_AGENT_DRIVER_ID);
  });

  it("[claude-worker] 決めたことは保存され、次の起動でも効く", async () => {
    const stored: Record<string, unknown> = {};
    const section = {
      read: () => ({ ...stored }),
      write: (values: Record<string, unknown>) => {
        for (const key of Object.keys(stored)) delete stored[key];
        Object.assign(stored, values);
      },
    };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-ws-persist-"));
    const first = new WorkerPool({
      driver: piDriver,
      runtimes: { [CLAUDE_AGENT_DRIVER_ID]: claudeBackend(claudeDriver) },
      dataDir,
      settingsSection: section,
      idleTimeoutMs: 0,
    });
    createWorkerPoolSettings(first).write({
      assignments: { reasoning: "opus" },
      defaultTier: "fast",
    });
    first.dispose();

    // 立ち上げ直しても、決めた当て方は残っている
    const second = new WorkerPool({
      driver: piDriver,
      runtimes: { [CLAUDE_AGENT_DRIVER_ID]: claudeBackend(claudeDriver) },
      dataDir,
      settingsSection: section,
      idleTimeoutMs: 0,
    });
    try {
      assert.deepEqual(second.tierAssignments(), {
        defaultTier: "fast",
        assignments: { reasoning: "opus" },
      });
    } finally {
      second.dispose();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
