/**
 * task-0010: Worker Pool（職人ランタイム）。ADR-0010 決定23・27b・27c。
 *
 * **Kobo も Banto も起動せずに検証する**（受け入れ条件 a4）——これ自体が
 * 「Worker Pool は独立したモジュールで単体で成立する」ことの証明になる。
 *
 * 実プロセスの起動は偽ドライバで置き換える。pi の起動は runtime-driver-contract.spec.ts
 * が別途検証しており、ここで見たいのは Worker Pool の帳簿と受け渡しの振る舞い。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MODULE_TOOL_PATH, createModuleClient } from "@banto/core";
import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";
import {
  WorkerPool,
  WorkerPoolService,
  createWorkerPoolModule,
  createWorkerTools,
  createWorkerReportTools,
  type WorkerEvent,
} from "@banto/worker-pool";

/** ToolDefinition.execute の第5引数は本Tool群が参照しないためスタブ。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 上記の理由 (I4)
const TOOL_CTX = {} as any;

function textOf(result: { content: ReadonlyArray<{ type: string }> }): string {
  return result.content
    .map((c) => (c.type === "text" ? (c as { type: "text"; text: string }).text : ""))
    .join("\n");
}

/**
 * 偽ドライバ。pi を起こす代わりに無害な `sleep` を起こす。
 *
 * 実プロセスを持たせるのは、生存確認（alive）と停止が本物の pid に対して働くことを
 * 見たいため。自分のプロセスIDを使うと `stop` がテストランナー自身を kill する
 * （実際にそれを踏んだ）。
 */
class FakeDriver implements RuntimeDriver {
  spawned: SpawnOptions[] = [];
  injected: Array<{ sessionId: string; message: string }> = [];
  killed: string[] = [];
  failNext = false;
  failInject = false;
  private counter = 0;
  /** sessionPath → sessionId。再開時に同じIDを返すため。 */
  private sessionIdByPath = new Map<string, string>();
  private children: childProcess.ChildProcess[] = [];

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    if (this.failNext) throw new Error("boom");
    this.spawned.push(opts);
    this.counter++;
    // 本物（pi）は --session で再開すると**同じ sessionId** を返す。ここを新しいIDにすると、
    // 「起こし直した職人が前回の記録に引きずられる」不具合を偽ドライバが隠してしまう
    const resume = opts.driverOptions?.["resumeSessionPath"];
    const sessionId =
      typeof resume === "string"
        ? (this.sessionIdByPath.get(resume) ?? `fake-${this.counter}`)
        : `fake-${this.counter}`;
    // セッションファイルを作っておく（attach の検証用）
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");

    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    this.children.push(child);
    this.sessionIdByPath.set(opts.sessionPath, sessionId);
    return { pid: child.pid!, sessionId, sessionPath: opts.sessionPath };
  }

  /** テスト終了時に取り残しを掃除する。 */
  cleanup(): void {
    for (const child of this.children) {
      if (child.pid !== undefined && !child.killed) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // 既に終わっていれば何もしない
        }
      }
    }
    this.children = [];
  }
  async inject(sessionId: string, message: string): Promise<void> {
    if (this.failInject) throw new Error("inject boom");
    this.injected.push({ sessionId, message });
  }
  private handlers = new Set<DriverEventHandler>();

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** 購読者の数（購読解除の検証用）。 */
  get subscriberCount(): number {
    return this.handlers.size;
  }

  /** ドライバがイベントを出したことにする。 */
  emit(event: DriverEvent): void {
    for (const handler of this.handlers) handler(event);
  }
  async kill(sessionId: string): Promise<void> {
    this.killed.push(sessionId);
  }
}

let dir: string;
let driver: FakeDriver;
let pool: WorkerPool;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wp-"));
  driver = new FakeDriver();
  pool = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
});

afterEach(() => {
  driver.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const JOB = { taskId: "task-0042", worktreePath: "/tmp/wt", instruction: "調べて直して" };

describe("[task-0010/a1] 職人の起動・監視・停止", () => {
  it("[task-0010/a1] delegate で職人が起き、worktree が渡る", async () => {
    const worker = await pool.delegate(JOB);

    assert.equal(worker.taskId, "task-0042");
    assert.equal(worker.projectTag, "test");
    assert.equal(worker.alive, true);
    assert.equal(driver.spawned.length, 1);
    assert.equal(driver.spawned[0]!.worktreePath, "/tmp/wt");
  });

  it("[task-0010/a1] spawn だけでなく inject で指示が届く（これが無いと職人は何もしない）", async () => {
    const worker = await pool.delegate(JOB);

    // RuntimeDriver の契約：spawn はセッションを起こすところまで。実際に働かせるには
    // inject で prompt を送る必要がある。これを忘れると職人は起動したまま固まる
    // （実際にその不具合を踏んだ）
    assert.deepEqual(driver.injected, [
      { sessionId: worker.sessionId, message: "調べて直して" },
    ]);
  });

  it("[task-0010/a1] システムプロンプトは立場の伝達で、やることは instruction で渡す", async () => {
    await pool.delegate(JOB);
    const systemPrompt = driver.spawned[0]!.systemPrompt;

    assert.match(systemPrompt, /職人/, "立場を伝える");
    assert.match(systemPrompt, /記憶を持ちません/, "D11 を職人自身にも伝える");
    assert.doesNotMatch(systemPrompt, /調べて直して/, "やることは instruction 側");
  });

  it("[task-0010/a1] システムプロンプトは差し替えられる", async () => {
    await pool.delegate({ ...JOB, systemPrompt: "あなたは監査役です。" });
    assert.equal(driver.spawned[0]!.systemPrompt, "あなたは監査役です。");
  });

  it("[imp-0004] tools を省略したらランタイムの既定（空の許可リスト）", async () => {
    await pool.delegate(JOB);
    assert.deepEqual(driver.spawned[0]!.tools, []);
  });

  it("[imp-0004] tools を絞っても報告経路の Tool は残る", async () => {
    // pi の許可リストは拡張の Tool にも効く。番頭が「読むだけ」のつもりで絞ると
    // worker.report / worker.ask まで消え、職人は報告も質問もできなくなる
    const withReport = new WorkerPool({
      driver,
      dataDir: dir,
      defaultProjectTag: "test",
      reportUrl: "http://localhost:4110",
    });
    try {
      await withReport.delegate({ ...JOB, tools: ["read", "grep"] });
      assert.deepEqual(driver.spawned[0]!.tools, [
        "read",
        "grep",
        "worker__report",
        "worker__ask",
      ]);
    } finally {
      withReport.dispose();
    }
  });

  it("[imp-0004] 報告先が無ければ足すものも無い（拡張ごと載らないため）", async () => {
    await pool.delegate({ ...JOB, tools: ["read"] });
    assert.deepEqual(driver.spawned[0]!.tools, ["read"]);
  });

  it("[task-0010/a1] list が生存確認つきで返す（D3：状態を別に持たない）", async () => {
    const worker = await pool.delegate(JOB);
    const workers = pool.list();

    assert.equal(workers.length, 1);
    assert.equal(workers[0]!.sessionId, worker.sessionId);
    assert.equal(workers[0]!.alive, true, "生きているプロセスは alive");
  });

  it("[task-0010/a1] projectTag で絞れる（複数の利用者に仕える）", async () => {
    await pool.delegate({ ...JOB, projectTag: "kobo", taskId: "k-1" });
    await pool.delegate({ ...JOB, projectTag: "banto", taskId: "b-1" });

    assert.deepEqual(pool.list({ projectTag: "kobo" }).map((w) => w.taskId), ["k-1"]);
    assert.deepEqual(pool.list({ projectTag: "banto" }).map((w) => w.taskId), ["b-1"]);
    assert.equal(pool.list().length, 2);
  });

  it("[task-0010/a1] steer で稼働中の職人へ追加指示が届く", async () => {
    const worker = await pool.delegate(JOB);
    await pool.steer(worker.sessionId, "方針を変えて");

    // 1件目は delegate が送る最初の指示。steer はその後に積まれる
    assert.deepEqual(driver.injected, [
      { sessionId: worker.sessionId, message: "調べて直して" },
      { sessionId: worker.sessionId, message: "方針を変えて" },
    ]);
  });

  it("[task-0010/a1・task-0028/a3] stop で止まるが、記録は消えない", async () => {
    const worker = await pool.delegate(JOB);
    await pool.stop(worker.sessionId);

    assert.deepEqual(driver.killed, [worker.sessionId]);
    // 決定30c: 台帳（生きているプロセスの帳簿）からは外れるが、履歴には残る
    assert.deepEqual(pool.list({ includeClosed: false }), []);
    assert.deepEqual(
      pool.list().map((w) => [w.taskId, w.state, w.closeReason]),
      [["task-0042", "closed", "stopped"]]
    );
  });

  it("[task-0010/a1] 台帳はプロセスを跨いで残る（別インスタンスから見える）", async () => {
    const worker = await pool.delegate(JOB);
    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });

    assert.deepEqual(reopened.list().map((w) => w.sessionId), [worker.sessionId]);
  });

  it("[task-0010] reap は終了済みの職人だけを片付ける", async () => {
    const worker = await pool.delegate(JOB);
    assert.equal(pool.reap(), 0, "生きている職人は片付けない");
    assert.equal(pool.list().length, 1);

    // 職人のプロセスを外から終わらせる（クラッシュ相当）
    process.kill(worker.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(pool.reap(), 1, "終了済みは片付ける");
    assert.deepEqual(pool.list(), []);
  });
});

describe("[task-0010/a1] ライブアタッチ（決定18のセッションビューアの実体）", () => {
  it("[task-0010/a1] セッション出力の末尾を返す。プロセスに割り込まない", async () => {
    const worker = await pool.delegate(JOB);
    fs.writeFileSync(worker.sessionPath, ["one", "two", "three"].join("\n"));

    const { lines, truncated } = pool.attach(worker.sessionId);
    assert.deepEqual(lines, ["one", "two", "three"]);
    assert.equal(truncated, false);
  });

  it("[task-0010/a1] 行数を絞ると末尾が返り、切ったことが分かる", async () => {
    const worker = await pool.delegate(JOB);
    fs.writeFileSync(worker.sessionPath, Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n"));

    const { lines, truncated } = pool.attach(worker.sessionId, 3);
    assert.deepEqual(lines, ["L7", "L8", "L9"]);
    assert.equal(truncated, true, "打ち切ったことを黙って隠さない");
  });

  it("[task-0010/a1] まだ出力が無い状態と、見失った状態を混同しない（I2）", async () => {
    const worker = await pool.delegate(JOB);
    assert.deepEqual(pool.attach(worker.sessionId), { lines: [], truncated: false });
  });
});

describe("[task-0010] 失敗の扱い（I2）", () => {
  it("[task-0010] 起動に失敗したら台帳に書かず、理由を添えて投げる", async () => {
    driver.failNext = true;
    await assert.rejects(() => pool.delegate(JOB), /Failed to start worker for "task-0042".*boom/s);
    assert.deepEqual(pool.list(), [], "失敗した職人は台帳に残らない");
  });

  it("[task-0010] 指示の送信に失敗したら、起こしただけの職人を放置せず止める（I2）", async () => {
    driver.failInject = true;
    await assert.rejects(
      () => pool.delegate(JOB),
      /Started a worker for "task-0042" but failed to deliver the instruction/
    );

    assert.equal(driver.killed.length, 1, "起こした職人を止める");
    assert.deepEqual(pool.list(), [], "台帳にも残さない");
  });

  it("[task-0010] 不在の職人への操作はエラー（動いている一覧を添える）", async () => {
    const worker = await pool.delegate(JOB);
    await assert.rejects(
      () => pool.steer("no-such-session", "x"),
      new RegExp(`Unknown worker "no-such-session".*${worker.sessionId}`, "s")
    );
    await assert.rejects(() => pool.stop("no-such-session"), /Unknown worker/);
    assert.throws(() => pool.attach("no-such-session"), /Unknown worker/);
  });

  it("[task-0010] 壊れた台帳は空扱いにせずエラー（生きている職人を見失わない）", () => {
    fs.writeFileSync(path.join(dir, "spawn-ledger.json"), "{ not json");
    assert.throws(
      () => new WorkerPool({ driver, dataDir: dir }),
      /Worker Pool ledger is corrupt/
    );
  });
});

describe("[task-0010/a2] worker.* Tool とモジュール定義", () => {
  it("[task-0010/a2] 提供するToolは全て worker 名前空間に属する", () => {
    // Tool名の一覧をここに焼くと、Toolを足すたびに無関係なテストが落ちる（実際に2度踏んだ）。
    // 見たいのは「名前空間規則（決定9）に従っているか」であって、何個あるかではない
    const names = createWorkerTools(pool).map((t) => t.name);
    assert.ok(names.length > 0);
    for (const name of names) {
      assert.match(name, /^worker\.[a-z_]+$/, `${name} は <domain>.<verb> の形（決定9）`);
    }
    // D10 の機構として最低限これは要る
    for (const required of ["worker.delegate", "worker.list", "worker.attach"]) {
      assert.ok(names.includes(required), `${required} が無い`);
    }
  });

  it("[task-0010/a2] worker.delegate で職人へ委譲できる（D10の機構）", async () => {
    const [delegate] = createWorkerTools(pool);
    const out = await delegate!.execute("c1", JOB, undefined, undefined, TOOL_CTX);

    assert.match(textOf(out), /職人を起こしました/);
    assert.equal(pool.list().length, 1);
  });

  it("[task-0010/a2] worker.list / attach が結果を返す", async () => {
    const tools = createWorkerTools(pool);
    const worker = await pool.delegate(JOB);
    fs.writeFileSync(worker.sessionPath, "hello");

    // Tool を位置で引くと、Toolを足すたびに壊れる（実際に壊れた）。名前で引く
    const byName = (name: string) => tools.find((t) => t.name === name)!;

    const list = await byName("worker.list").execute("c1", {} as never, undefined, undefined, TOOL_CTX);
    assert.match(textOf(list), /task-0042/);

    const attach = await byName("worker.attach").execute(
      "c2", { sessionId: worker.sessionId } as never, undefined, undefined, TOOL_CTX
    );
    assert.match(textOf(attach), /hello/);
  });

  it("[task-0010/a2] モジュール定義が決定27の4要素を満たす", () => {
    const module = createWorkerPoolModule(pool);

    assert.equal(module.name, "worker-pool");
    assert.ok(module.endpoint.baseUrl.length > 0, "接続情報");
    assert.ok(module.tools.length > 0, "番頭へのTool");
    assert.deepEqual(module.views.map((v) => v.kind), ["worker.viewer"], "キャンバスへのGUI");
    assert.deepEqual(module.skills.map((s) => s.name), ["worker-delegation"], "SKILL");
    assert.ok(fs.existsSync(module.skills[0]!.filePath), "SKILLの実体がある");
  });

  it("[task-0010/a2] 到達先は差し替えられる（独立サービスなら絶対URL）", () => {
    const module = createWorkerPoolModule(pool, "http://localhost:4300/api/worker-pool");
    assert.equal(module.endpoint.baseUrl, "http://localhost:4300/api/worker-pool");
  });
});

describe("[task-0010/a3] 独立サービスとしての公開（Bantoを起動しない）", () => {
  let service: WorkerPoolService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("[task-0010/a3] 決定27bの規約でToolを公開し、Bantoを経由せず呼べる", async () => {
    service = await WorkerPoolService.start({ tools: createWorkerTools(pool), port: 0 });

    // BantoHostServer も AgentSession も起動していない。呼び出しは当事者間で直接
    const client = createModuleClient({ modules: { "worker-pool": { baseUrl: service.baseUrl } } });
    const result = await client.invoke("worker-pool", "worker.delegate", JOB);

    assert.match(String(result.content[0]?.text), /職人を起こしました/);
    assert.equal(pool.list().length, 1, "サービス経由でも同じ Worker Pool が動く");
  });

  it("[task-0010/a3] /health が公開しているToolを返す", async () => {
    service = await WorkerPoolService.start({ tools: createWorkerTools(pool), port: 0 });
    const res = await fetch(`http://localhost:${service.port}/health`);
    const body = (await res.json()) as { ok: boolean; tools: string[] };

    assert.equal(body.ok, true);
    assert.ok(body.tools.includes("worker.delegate"));
  });

  it("[task-0010/a3] 未知のToolは持っているToolを添えて404（I2）", async () => {
    service = await WorkerPoolService.start({ tools: createWorkerTools(pool), port: 0 });
    const client = createModuleClient({ modules: { "worker-pool": { baseUrl: service.baseUrl } } });

    await assert.rejects(
      () => client.invoke("worker-pool", "worker.nope"),
      /has no tool "worker.nope".*worker\.delegate/s
    );
  });

  it("[task-0010/a3] Tool内のエラーは成功で包まれず伝わる（I2）", async () => {
    service = await WorkerPoolService.start({ tools: createWorkerTools(pool), port: 0 });
    const client = createModuleClient({ modules: { "worker-pool": { baseUrl: service.baseUrl } } });

    await assert.rejects(
      () => client.invoke("worker-pool", "worker.stop", { sessionId: "no-such" }),
      /Unknown worker/
    );
  });

  it("[task-0010/a3] GET では呼べない（POSTのみ）", async () => {
    service = await WorkerPoolService.start({ tools: createWorkerTools(pool), port: 0 });
    const res = await fetch(`${service.baseUrl}${MODULE_TOOL_PATH}worker.list`);
    assert.equal(res.status, 405);
  });
});

describe("[task-0027] ドライバのライフサイクルイベントを購読する", () => {
  it("[task-0027/a1] WorkerPool はドライバのイベントを購読している", () => {
    // 構築した時点で購読が始まっている（起動より前のイベントも取りこぼさない）
    assert.equal(driver.subscriberCount, 1);
  });

  it("[task-0027/a2] 終了が「その瞬間」に分かる（覗きに行かなくてよい）", async () => {
    const worker = await pool.delegate(JOB);
    const seen: WorkerEvent[] = [];
    pool.subscribe((e) => seen.push(e), { type: "worker_exited" });

    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 0,
      signal: null,
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, worker.sessionId);
    assert.equal(seen[0]!.taskId, "task-0042");
    assert.equal(seen[0]!.projectTag, "test");
    assert.equal(seen[0]!.data["exitCode"], 0);
  });

  it("[task-0027/a2] 異常終了の内訳（終了コード・シグナル）も伝わる", async () => {
    const worker = await pool.delegate(JOB);
    const seen: WorkerEvent[] = [];
    pool.subscribe((e) => seen.push(e), { type: "worker_exited" });

    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: null,
      signal: "SIGKILL",
    });

    assert.equal(seen[0]!.data["exitCode"], null);
    assert.equal(seen[0]!.data["signal"], "SIGKILL");
  });

  it("[task-0027] 終了の内訳が list にも出る", async () => {
    const worker = await pool.delegate(JOB);
    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 2,
      signal: null,
    });

    const found = pool.list().find((w) => w.sessionId === worker.sessionId);
    assert.equal(found?.exit?.exitCode, 2);
  });

  it("[task-0027] 生死の判定はイベントに依存しない（再起動しても分かる。D3）", async () => {
    const worker = await pool.delegate(JOB);
    process.kill(worker.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 150));

    // イベントを一切流していない別インスタンスでも「終了」と分かる
    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    const found = reopened.list().find((w) => w.sessionId === worker.sessionId);
    assert.equal(found?.alive, false);
    assert.equal(found?.state, "exited");
    reopened.dispose();
  });

  it("[task-0027] 台帳に無い職人の終了イベントは無視する（知らせる相手がいない）", async () => {
    const seen: WorkerEvent[] = [];
    pool.subscribe((e) => seen.push(e), { type: "worker_exited" });

    driver.emit({
      type: "process_exited",
      pid: 999999,
      sessionId: "no-such-session",
      exitCode: 0,
      signal: null,
    });

    assert.deepEqual(seen, []);
  });

  it("[task-0027] 購読側の失敗が Worker Pool を止めない", async () => {
    const worker = await pool.delegate(JOB);
    const seen: string[] = [];
    pool.subscribe(() => {
      throw new Error("購読側の不具合");
    });
    pool.subscribe((e) => seen.push(e.type));

    assert.doesNotThrow(() =>
      driver.emit({
        type: "process_exited",
        pid: worker.pid,
        sessionId: worker.sessionId,
        exitCode: 0,
        signal: null,
      })
    );
    assert.deepEqual(seen, ["worker_exited"], "他の購読者は呼ばれる");
  });

  it("[task-0027] dispose で購読を解除する", () => {
    const local = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    assert.equal(driver.subscriberCount, 2, "beforeEach の pool と合わせて2つ");

    local.dispose();
    assert.equal(driver.subscriberCount, 1);
  });
});

// ── task-0026: 職人から起動元への報告経路（決定29） ─────────────────────────────

describe("[task-0026/a1] イベントログと購読", () => {
  it("[task-0026/a1] 起動・終了がログに残り、後から追いつける", async () => {
    const worker = await pool.delegate(JOB);
    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 0,
      signal: null,
    });

    const all = pool.events();
    assert.deepEqual(
      all.map((e) => e.type),
      ["worker_started", "worker_exited"]
    );
    // afterEventId で続きだけ取れる
    assert.deepEqual(
      pool.events(all[0]!.id).map((e) => e.type),
      ["worker_exited"]
    );
  });

  it("[task-0026/a1] 落ちていた間の報告を取りこぼさない（afterEventId で再開）", async () => {
    const worker = await pool.delegate(JOB);
    // 起動元がいない間に報告が来る
    pool.report(worker.sessionId, "調べ終えました");
    pool.ask(worker.sessionId, "どちらの方式にしますか");

    // 後から購読を始めても、最初から受け取れる
    const seen: WorkerEvent[] = [];
    pool.subscribe((e) => seen.push(e), { afterEventId: 0 });

    assert.deepEqual(
      seen.map((e) => e.type),
      ["worker_started", "worker_reported", "worker_asked"]
    );
  });

  it("[task-0026/a1] ログはファイルに残る（Worker Pool を再起動しても消えない）", async () => {
    const worker = await pool.delegate(JOB);
    pool.report(worker.sessionId, "終わりました");

    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    assert.deepEqual(
      reopened.events().map((e) => e.type),
      ["worker_started", "worker_reported"]
    );
    reopened.dispose();
  });
});

describe("[task-0026/a2] 事実と主張を分ける（I1）", () => {
  it("[task-0026/a2] プロセス終了は事実、職人の完了報告は主張", async () => {
    const worker = await pool.delegate(JOB);
    pool.report(worker.sessionId, "終わりました", { done: true });
    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 0,
      signal: null,
    });

    const byType = new Map(pool.events().map((e) => [e.type, e]));
    assert.equal(byType.get("worker_reported")!.kind, "claim", "職人が言ったことは主張");
    assert.equal(byType.get("worker_exited")!.kind, "fact", "プロセスの終了は事実");
    assert.equal(byType.get("worker_started")!.kind, "fact");
  });

  it("[task-0026/a2] 「終わったと言っている」だけでは終了扱いにならない", async () => {
    const worker = await pool.delegate(JOB);
    pool.report(worker.sessionId, "終わりました", { done: true });

    // 主張だけでは状態は変わらない——プロセスはまだ生きている
    const found = pool.get(worker.sessionId);
    assert.equal(found?.state, "running");
    assert.equal(found?.alive, true);
  });
});

describe("[task-0026/a3] 質問と waiting", () => {
  it("[task-0026/a3] 質問した職人は waiting になり、稼働中と区別できる", async () => {
    const worker = await pool.delegate(JOB);
    assert.equal(pool.get(worker.sessionId)?.state, "running");

    pool.ask(worker.sessionId, "どちらの方式にしますか");

    const waiting = pool.get(worker.sessionId);
    assert.equal(waiting?.state, "waiting");
    assert.equal(waiting?.alive, true, "生きているが止まっている");
    assert.equal(waiting?.question, "どちらの方式にしますか");
  });

  it("[task-0026/a3・a6] 答えると待ちが解ける", async () => {
    const worker = await pool.delegate(JOB);
    pool.ask(worker.sessionId, "どちらの方式にしますか");

    await pool.steer(worker.sessionId, "A案で進めてください");

    assert.equal(pool.get(worker.sessionId)?.state, "running");
    assert.equal(pool.get(worker.sessionId)?.question, undefined);
    // 答えは職人へ実際に届いている
    assert.equal(driver.injected.at(-1)?.message, "A案で進めてください");
  });

  it("[task-0026/a3] 2回目の質問でまた待ちになる", async () => {
    const worker = await pool.delegate(JOB);
    pool.ask(worker.sessionId, "1つ目");
    await pool.steer(worker.sessionId, "答え");
    pool.ask(worker.sessionId, "2つ目");

    assert.equal(pool.get(worker.sessionId)?.state, "waiting");
    assert.equal(pool.get(worker.sessionId)?.question, "2つ目");
  });

  it("[task-0026/a3] 終了した職人は waiting のままにしない", async () => {
    const worker = await pool.delegate(JOB);
    pool.ask(worker.sessionId, "答えを待ちます");
    process.kill(worker.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(pool.get(worker.sessionId)?.state, "exited");
  });
});

describe("[task-0026/a4] 起動元は自分の職人の分だけ受け取る", () => {
  it("[task-0026/a4] origin で絞ると他の起動元の職人は届かない", async () => {
    const mine = await pool.delegate({ ...JOB, taskId: "task-mine", origin: "banto" });
    const theirs = await pool.delegate({ ...JOB, taskId: "task-theirs", origin: "kobo" });

    const seen: WorkerEvent[] = [];
    pool.subscribe((e) => seen.push(e), { origin: "banto" });

    pool.report(mine.sessionId, "私の職人の報告");
    pool.report(theirs.sessionId, "別の起動元の職人の報告");

    assert.deepEqual(
      seen.map((e) => e.data["summary"]),
      ["私の職人の報告"]
    );
  });

  it("[task-0026/a4] origin は projectTag とは別（同じ projectTag に別の起動元がいる）", async () => {
    const a = await pool.delegate({ ...JOB, taskId: "task-a", projectTag: "same", origin: "banto" });
    const b = await pool.delegate({ ...JOB, taskId: "task-b", projectTag: "same", origin: "kobo" });

    assert.equal(pool.get(a.sessionId)?.origin, "banto");
    assert.equal(pool.get(b.sessionId)?.origin, "kobo");
    assert.deepEqual(
      pool.events(0, { origin: "kobo" }).map((e) => e.taskId),
      ["task-b"]
    );
  });

  it("[task-0026/a4] origin は台帳に残る（再起動しても宛先を見失わない）", async () => {
    const worker = await pool.delegate({ ...JOB, origin: "kobo" });

    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    assert.equal(reopened.get(worker.sessionId)?.origin, "kobo");
    reopened.dispose();
  });
});

describe("[task-0026/a5] Worker Pool は報告の意味を解釈しない（D5）", () => {
  it("[task-0026/a5] 報告の中身はそのまま残り、状態遷移も判定もしない", async () => {
    const worker = await pool.delegate(JOB);
    pool.report(worker.sessionId, "テストが3件落ちています", { done: false, custom: 1 });

    const event = pool.events().find((e) => e.type === "worker_reported")!;
    // 中身は素通し。Kobo のステートマシンの語彙も番頭の会話の語彙も混ざらない
    assert.deepEqual(event.data, { summary: "テストが3件落ちています", done: false, custom: 1 });
    assert.equal(pool.get(worker.sessionId)?.state, "running", "報告で状態を動かさない");
  });
});

describe("[task-0026/a6] 職人自身の Tool（worker.report / worker.ask）", () => {
  it("[task-0026/a6] 職人は projectTag と taskId で名乗って報告できる", async () => {
    const worker = await pool.delegate(JOB);
    const [report] = createWorkerReportTools(pool);

    await report!.execute(
      "call-1",
      { projectTag: "test", taskId: "task-0042", summary: "調べ終えました", done: true } as never,
      undefined,
      undefined,
      TOOL_CTX
    );

    const event = pool.events().find((e) => e.type === "worker_reported")!;
    assert.equal(event.sessionId, worker.sessionId, "名乗りから職人が引けている");
    assert.equal(event.data["summary"], "調べ終えました");
  });

  it("[task-0026/a6] 職人は質問でき、番頭が worker.steer で答えられる", async () => {
    const worker = await pool.delegate(JOB);
    const [, ask] = createWorkerReportTools(pool);
    const steer = createWorkerTools(pool).find((t) => t.name === "worker.steer")!;

    await ask!.execute(
      "call-1",
      { projectTag: "test", taskId: "task-0042", question: "A案とB案どちらで？" } as never,
      undefined,
      undefined,
      TOOL_CTX
    );
    assert.equal(pool.get(worker.sessionId)?.state, "waiting");

    await steer.execute(
      "call-2",
      { sessionId: worker.sessionId, message: "A案で" } as never,
      undefined,
      undefined,
      TOOL_CTX
    );
    assert.equal(pool.get(worker.sessionId)?.state, "running");
  });

  it("[task-0026/a6] 名乗りが台帳に無ければ黙って捨てずエラー（I2）", async () => {
    const [report] = createWorkerReportTools(pool);
    await assert.rejects(
      () =>
        report!.execute(
          "call-1",
          { projectTag: "test", taskId: "no-such-task", summary: "x" } as never,
          undefined,
          undefined,
          TOOL_CTX
        ),
      /No worker registered/
    );
  });

  it("[task-0026/a6] 番頭には報告用Toolを渡さない（自分に報告しても意味がない）", () => {
    const bantoTools = createWorkerTools(pool).map((t) => t.name);
    assert.equal(bantoTools.includes("worker.report"), false);
    assert.equal(bantoTools.includes("worker.ask"), false);
    assert.equal(bantoTools.includes("worker.events"), true, "起こったことは番頭も引ける");
  });
});

describe("[task-0026/a6] 職人（別プロセス）からHTTPで報告できる（決定27b・29e）", () => {
  let service: WorkerPoolService | undefined;

  afterEach(async () => {
    await service?.close();
    service = undefined;
  });

  it("[task-0026/a6] worker.report を HTTP 経由で呼べる", async () => {
    const worker = await pool.delegate(JOB);
    // 職人向けのToolも公開の口には出す（番頭に渡さないだけ）
    service = await WorkerPoolService.start({
      tools: [...createWorkerTools(pool), ...createWorkerReportTools(pool)],
      port: 0,
    });

    const res = await fetch(`${service.baseUrl}${MODULE_TOOL_PATH}worker.report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        args: { projectTag: "test", taskId: "task-0042", summary: "終わりました", done: true },
      }),
    });

    assert.equal(res.status, 200);
    const event = pool.events().find((e) => e.type === "worker_reported")!;
    assert.equal(event.sessionId, worker.sessionId);
    assert.equal(event.kind, "claim");
  });

  it("[task-0026/a6] モジュール定義は報告用Toolを internalTools に置く", () => {
    const module = createWorkerPoolModule(pool);
    const banto = module.tools.map((t) => t.name);
    const internal = module.internalTools.map((t) => t.name);

    assert.equal(banto.includes("worker.report"), false, "番頭には渡らない");
    assert.deepEqual(internal.sort(), ["worker.ask", "worker.report"]);
  });
});

// ── task-0028: 職人の店じまいと履歴（決定30） ───────────────────────────────────

describe("[task-0028/a1] 番頭が畳む・理由が残る", () => {
  it("[task-0028/a1] close で畳むと done として記録される", async () => {
    const worker = await pool.delegate(JOB);
    await pool.close(worker.sessionId);

    const found = pool.get(worker.sessionId);
    assert.equal(found?.state, "closed");
    assert.equal(found?.closeReason, "done");
    assert.ok(found?.closedAt);
  });

  it("[task-0028/a1] 畳んだ理由を区別する（done / idle / stopped）", async () => {
    const a = await pool.delegate({ ...JOB, taskId: "t-done" });
    const b = await pool.delegate({ ...JOB, taskId: "t-stopped" });
    const c = await pool.delegate({ ...JOB, taskId: "t-idle" });

    await pool.close(a.sessionId, "done");
    await pool.stop(b.sessionId);
    await pool.close(c.sessionId, "idle");

    const reasons = new Map(pool.list().map((w) => [w.taskId, w.closeReason]));
    assert.equal(reasons.get("t-done"), "done");
    assert.equal(reasons.get("t-stopped"), "stopped", "強制停止は done と混ざらない");
    assert.equal(reasons.get("t-idle"), "idle", "安全弁が働いたことが後から分かる");
  });

  it("[task-0028/a1・決定29a] 報告だけでは畳まれない", async () => {
    const worker = await pool.delegate(JOB);
    pool.report(worker.sessionId, "終わりました", { done: true });

    // 報告は主張。畳むのは番頭が確かめてから
    assert.equal(pool.get(worker.sessionId)?.state, "running");
    assert.deepEqual(driver.killed, []);
  });

  it("[task-0028/a1] 二度畳んでも壊れない（冪等）", async () => {
    const worker = await pool.delegate(JOB);
    await pool.close(worker.sessionId);
    await pool.close(worker.sessionId);

    assert.equal(pool.events().filter((e) => e.type === "worker_closed").length, 1);
  });

  it("[task-0028/a1] 質問に答えないまま畳んだことが履歴に残る", async () => {
    const worker = await pool.delegate(JOB);
    pool.ask(worker.sessionId, "どちらにしますか");
    await pool.close(worker.sessionId, "idle");

    const closed = pool.events().find((e) => e.type === "worker_closed")!;
    assert.equal(closed.data["unansweredQuestion"], "どちらにしますか");
  });
});

describe("[task-0028/a2] アイドルの安全弁", () => {
  it("[task-0028/a2] 何もしていない職人を閉じる", async () => {
    const local = new WorkerPool({
      driver, dataDir: dir, defaultProjectTag: "test",
      idleTimeoutMs: 60_000,
      idleCheckMs: 3_600_000, // 自動掃除は回さず、手で呼んで確かめる
    });
    const worker = await local.delegate(JOB);

    assert.equal(await local.sweepIdle(), 0, "まだ活動したばかりなので閉じない");

    // 期限を過ぎた時点として掃除する
    const closed = await local.sweepIdle(Date.now() + 120_000);
    assert.equal(closed, 1);
    assert.equal(local.get(worker.sessionId)?.closeReason, "idle");
    local.dispose();
  });

  it("[task-0028/a2] 安全弁は切れる（0以下で無効）", async () => {
    const local = new WorkerPool({
      driver, dataDir: dir, defaultProjectTag: "test", idleTimeoutMs: 0,
    });
    await local.delegate(JOB);
    assert.equal(await local.sweepIdle(Date.now() + 10_000_000), 0);
    local.dispose();
  });

  it("[task-0028/a2] 直前に活動していれば閉じない（セッションの更新を見る）", async () => {
    const local = new WorkerPool({
      driver, dataDir: dir, defaultProjectTag: "test",
      idleTimeoutMs: 60_000, idleCheckMs: 3_600_000,
    });
    const worker = await local.delegate(JOB);
    // 職人が書いた＝活動した
    fs.writeFileSync(worker.sessionPath, "{}\n");

    assert.equal(await local.sweepIdle(Date.now() + 30_000), 0);
    local.dispose();
  });
});

describe("[task-0028/a3] 閉じた職人が見える", () => {
  it("[task-0028/a3] 畳んだ職人も一覧に出る（既定）", async () => {
    const worker = await pool.delegate(JOB);
    await pool.close(worker.sessionId);

    assert.equal(pool.list().length, 1);
    assert.equal(pool.list({ includeClosed: false }).length, 0, "稼働中だけも見られる");
  });

  it("[task-0028/a3] 畳んだ職人のセッションを読める（台帳が消えても）", async () => {
    const worker = await pool.delegate(JOB);
    fs.writeFileSync(worker.sessionPath, "職人が書いた記録\n");
    await pool.close(worker.sessionId);

    // 台帳から外れても sessionPath が分かる＝起動イベントに載せてあるから
    assert.deepEqual(pool.attach(worker.sessionId).lines, ["職人が書いた記録"]);
  });

  it("[task-0028/a3] Worker Pool を再起動しても履歴は残る", async () => {
    const worker = await pool.delegate(JOB);
    await pool.close(worker.sessionId);

    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    const found = reopened.get(worker.sessionId);
    assert.equal(found?.state, "closed");
    assert.equal(found?.taskId, "task-0042");
    assert.equal(found?.origin, "unknown");
    reopened.dispose();
  });

  it("[task-0028/a3] 履歴は起動順に並ぶ", async () => {
    const a = await pool.delegate({ ...JOB, taskId: "t-1" });
    await pool.close(a.sessionId);
    await pool.delegate({ ...JOB, taskId: "t-2" });

    assert.deepEqual(pool.list().map((w) => w.taskId), ["t-1", "t-2"]);
  });
});

describe("[task-0028/a4] 起こし直し（同じセッションの再開）", () => {
  it("[task-0028/a4] wake で元のセッションを引き継いで起こす", async () => {
    const first = await pool.delegate(JOB);
    const sessionPath = first.sessionPath;
    await pool.close(first.sessionId);

    const again = await pool.wake(first.sessionId, "さっきの続きをやって");

    // ランタイムに「このセッションから再開せよ」と伝わっている
    assert.equal(driver.spawned.at(-1)?.driverOptions?.["resumeSessionPath"], sessionPath);
    assert.equal(again.taskId, first.taskId, "同じ仕事として扱う");
    assert.equal(again.worktree, first.worktree);
    assert.equal(driver.injected.at(-1)?.message, "さっきの続きをやって");
  });

  it("[task-0028/a4] 起こし直したことが履歴に残る", async () => {
    const first = await pool.delegate(JOB);
    await pool.close(first.sessionId);
    await pool.wake(first.sessionId, "続き");

    const started = pool.events().filter((e) => e.type === "worker_started");
    assert.equal(started.length, 2);
    assert.equal(started[1]!.data["resumedFrom"], first.sessionPath);
  });

  it("[task-0028/a4] 起動元を引き継ぐ（宛先を見失わない）", async () => {
    const first = await pool.delegate({ ...JOB, origin: "kobo" });
    await pool.close(first.sessionId);
    const again = await pool.wake(first.sessionId, "続き");

    assert.equal(again.origin, "kobo");
  });

  it("[task-0028/a4] まだ畳んでいない職人は起こし直せない（I2）", async () => {
    const worker = await pool.delegate(JOB);
    await assert.rejects(() => pool.wake(worker.sessionId, "続き"), /まだ畳まれていません/);
  });

  it("[task-0028/a4] 知らない職人は起こし直せない（I2）", async () => {
    await assert.rejects(() => pool.wake("no-such-session", "続き"), /Unknown worker/);
  });
});

describe("[task-0028/a4] 起こし直した職人は「畳んだまま」に見えない", () => {
  it("[task-0028/a4] 再開で同じ sessionId が返っても、状態は今の起動を見る", async () => {
    const first = await pool.delegate(JOB);
    await pool.close(first.sessionId, "done");

    const again = await pool.wake(first.sessionId, "続き");
    assert.equal(again.sessionId, first.sessionId, "本物の pi は同じIDを返す");

    const now = pool.get(again.sessionId);
    assert.equal(now?.state, "running", "前回の worker_closed に引きずられない");
    assert.equal(now?.closeReason, undefined);
    assert.equal(now?.alive, true);
  });

  it("[task-0028/a4] 前回の質問が起こし直した職人に残らない", async () => {
    const first = await pool.delegate(JOB);
    pool.ask(first.sessionId, "前回の質問");
    await pool.close(first.sessionId, "idle");

    await pool.wake(first.sessionId, "続き");

    const now = pool.get(first.sessionId);
    assert.equal(now?.state, "running");
    assert.equal(now?.question, undefined, "答え済みでない古い質問を持ち越さない");
  });

  it("[task-0028/a4] 起こし直した職人も、また畳める", async () => {
    const first = await pool.delegate(JOB);
    await pool.close(first.sessionId);
    await pool.wake(first.sessionId, "続き");
    await pool.close(first.sessionId, "done");

    assert.equal(pool.get(first.sessionId)?.state, "closed");
    assert.equal(pool.events().filter((e) => e.type === "worker_closed").length, 2);
  });
});

describe("[task-0028/a3] セッションを読めない理由を黙らせない（I2）", () => {
  it("[task-0028/a3] 在り処が分からない職人は「出力なし」ではなくエラー", async () => {
    const worker = await pool.delegate(JOB);
    await pool.close(worker.sessionId);
    // sessionPath を記録する前に起こされた職人を再現する（起動イベントから落とす）
    const file = path.join(dir, "worker-events.jsonl");
    const kept = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const e = JSON.parse(l) as { type: string; data: Record<string, unknown> };
        if (e.type === "worker_started") delete e.data["sessionPath"];
        return JSON.stringify(e);
      });
    fs.writeFileSync(file, `${kept.join("\n")}\n`);

    const reopened = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    assert.throws(() => reopened.attach(worker.sessionId), /在り処が記録されていません/);
    reopened.dispose();
  });

  it("[task-0028/a3] 畳んだ職人のセッションは普通に読める", async () => {
    const worker = await pool.delegate(JOB);
    fs.writeFileSync(worker.sessionPath, "記録\n");
    await pool.close(worker.sessionId);

    assert.deepEqual(pool.attach(worker.sessionId).lines, ["記録"]);
  });
});


// ── task-0030: 一覧の絞り込みとページ送り（提案 worker-list-pagination の A案） ────

describe("[task-0030/a1] ページ送り", () => {
  /** n 人起こす。taskId は t-0, t-1, ... */
  const spawnMany = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await pool.delegate({ ...JOB, taskId: `t-${i}`, instruction: `${i} 番目の仕事` });
    }
  };

  it("[task-0030/a1] limit / offset で切り出せる。総数も返る", async () => {
    await spawnMany(5);

    const first = pool.find({ limit: 2 });
    assert.equal(first.total, 5, "総数は絞り込み後の全件");
    assert.equal(first.workers.length, 2);
    assert.equal(first.offset, 0);

    const second = pool.find({ limit: 2, offset: 2 });
    assert.equal(second.workers.length, 2);
    assert.notDeepEqual(
      second.workers.map((w) => w.taskId),
      first.workers.map((w) => w.taskId)
    );
  });

  it("[task-0030/a1] 新しいものから返す（履歴を辿る用途）", async () => {
    await spawnMany(3);
    assert.deepEqual(pool.find().workers.map((w) => w.taskId), ["t-2", "t-1", "t-0"]);
    // 古い順に見たいときは list（起動順のまま）
    assert.deepEqual(pool.list().map((w) => w.taskId), ["t-0", "t-1", "t-2"]);
  });

  it("[task-0030/a1] 範囲を超えた offset は空を返す（落ちない）", async () => {
    await spawnMany(2);
    const page = pool.find({ limit: 10, offset: 100 });
    assert.deepEqual(page.workers, []);
    assert.equal(page.total, 2, "総数は変わらないのでページ数を出し直せる");
  });

  it("[task-0030/a1] 畳んだ職人の数も返る（隠していることを言えるように）", async () => {
    await spawnMany(3);
    const all = pool.list();
    await pool.close(all[0]!.sessionId);

    const page = pool.find({ includeClosed: false });
    assert.equal(page.total, 2, "一覧には出さない");
    assert.equal(page.closedTotal, 1, "が、隠している数は分かる");
  });
});

describe("[task-0030/a2] 検索", () => {
  it("[task-0030/a2] taskId で絞れる", async () => {
    await pool.delegate({ ...JOB, taskId: "fix-login" });
    await pool.delegate({ ...JOB, taskId: "add-search" });

    assert.deepEqual(pool.find({ query: "login" }).workers.map((w) => w.taskId), ["fix-login"]);
  });

  it("[task-0030/a2] 起動時の指示でも探せる（taskId を覚えていなくても辿れる）", async () => {
    await pool.delegate({ ...JOB, taskId: "t-1", instruction: "README を書いてください" });
    await pool.delegate({ ...JOB, taskId: "t-2", instruction: "テストを直してください" });

    assert.deepEqual(pool.find({ query: "readme" }).workers.map((w) => w.taskId), ["t-1"]);
  });

  it("[task-0030/a2] 大文字小文字を区別しない", async () => {
    await pool.delegate({ ...JOB, taskId: "Fix-Login" });
    assert.equal(pool.find({ query: "FIX" }).workers.length, 1);
    assert.equal(pool.find({ query: "fix" }).workers.length, 1);
  });

  it("[task-0030/a2] 空白区切りの語は AND", async () => {
    await pool.delegate({ ...JOB, taskId: "t-1", instruction: "ログイン画面を直す" });
    await pool.delegate({ ...JOB, taskId: "t-2", instruction: "ログイン処理のテストを足す" });

    assert.deepEqual(pool.find({ query: "ログイン テスト" }).workers.map((w) => w.taskId), ["t-2"]);
    assert.equal(pool.find({ query: "ログイン" }).workers.length, 2);
  });

  it("[task-0030/a2] 状態や畳んだ理由でも探せる", async () => {
    const a = await pool.delegate({ ...JOB, taskId: "t-1" });
    await pool.delegate({ ...JOB, taskId: "t-2" });
    await pool.close(a.sessionId, "idle");

    assert.deepEqual(pool.find({ query: "idle" }).workers.map((w) => w.taskId), ["t-1"]);
  });

  it("[task-0030/a2] 絞り込みとページ送りは併用できる", async () => {
    for (const i of [1, 2, 3]) {
      await pool.delegate({ ...JOB, taskId: `keep-${i}`, instruction: "在庫を数える" });
    }
    await pool.delegate({ ...JOB, taskId: "other", instruction: "帳簿を締める" });

    const page = pool.find({ query: "在庫", limit: 2 });
    assert.equal(page.total, 3, "総数は絞り込み後の件数");
    assert.equal(page.workers.length, 2);
  });

  it("[task-0030/a2] worker.list Tool から絞り込みとページ送りが使える", async () => {
    await pool.delegate({ ...JOB, taskId: "fix-login" });
    await pool.delegate({ ...JOB, taskId: "add-search" });
    const list = createWorkerTools(pool).find((t) => t.name === "worker.list")!;

    const out = await list.execute(
      "c1", { query: "login" } as never, undefined, undefined, TOOL_CTX
    );
    assert.match(textOf(out), /fix-login/);
    assert.equal(textOf(out).includes("add-search"), false);
    assert.match(textOf(out), /全 1 件中 1〜1 件/, "どこを見ているか番頭に分かる");
  });

  it("[task-0030/a2] 当てはまらないときは、そう言う（空一覧と区別する）", async () => {
    await pool.delegate(JOB);
    const list = createWorkerTools(pool).find((t) => t.name === "worker.list")!;
    const out = await list.execute(
      "c1", { query: "存在しない語" } as never, undefined, undefined, TOOL_CTX
    );
    assert.match(textOf(out), /当てはまる職人はいません/);
  });
});
