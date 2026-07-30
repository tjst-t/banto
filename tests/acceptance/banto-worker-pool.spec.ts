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
  type WorkerExit,
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
  private children: childProcess.ChildProcess[] = [];

  async spawn(opts: SpawnOptions): Promise<SessionHandle> {
    if (this.failNext) throw new Error("boom");
    this.spawned.push(opts);
    this.counter++;
    // セッションファイルを作っておく（attach の検証用）
    fs.mkdirSync(path.dirname(opts.sessionPath), { recursive: true });
    fs.writeFileSync(opts.sessionPath, "");

    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore", detached: false });
    this.children.push(child);
    return {
      pid: child.pid!,
      sessionId: `fake-${this.counter}`,
      sessionPath: opts.sessionPath,
    };
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

    assert.deepEqual(pool.list("kobo").map((w) => w.taskId), ["k-1"]);
    assert.deepEqual(pool.list("banto").map((w) => w.taskId), ["b-1"]);
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

  it("[task-0010/a1] stop で止まり、台帳から消える", async () => {
    const worker = await pool.delegate(JOB);
    await pool.stop(worker.sessionId);

    assert.deepEqual(driver.killed, [worker.sessionId]);
    assert.deepEqual(pool.list(), []);
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
  it("[task-0010/a2] 名前空間規則に従う5つのToolを提供する", () => {
    assert.deepEqual(createWorkerTools(pool).map((t) => t.name), [
      "worker.delegate",
      "worker.list",
      "worker.steer",
      "worker.stop",
      "worker.attach",
    ]);
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

    const list = await tools[1]!.execute("c1", {}, undefined, undefined, TOOL_CTX);
    assert.match(textOf(list), /task-0042/);

    const attach = await tools[4]!.execute(
      "c2", { sessionId: worker.sessionId }, undefined, undefined, TOOL_CTX
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
    const seen: WorkerExit[] = [];
    pool.onExit((e) => seen.push(e));

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
    assert.equal(seen[0]!.projectTag, "test", "誰の仕事かが分かる（起動元へ届けるため）");
    assert.equal(seen[0]!.exitCode, 0);
  });

  it("[task-0027/a2] 異常終了の内訳（終了コード・シグナル）も伝わる", async () => {
    const worker = await pool.delegate(JOB);
    const seen: WorkerExit[] = [];
    pool.onExit((e) => seen.push(e));

    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: null,
      signal: "SIGKILL",
    });

    assert.equal(seen[0]!.exitCode, null);
    assert.equal(seen[0]!.signal, "SIGKILL");
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
    const seen: WorkerExit[] = [];
    pool.onExit((e) => seen.push(e));

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
    pool.onExit(() => {
      throw new Error("購読側の不具合");
    });
    pool.onExit((e) => seen.push(e.sessionId));

    assert.doesNotThrow(() =>
      driver.emit({
        type: "process_exited",
        pid: worker.pid,
        sessionId: worker.sessionId,
        exitCode: 0,
        signal: null,
      })
    );
    assert.deepEqual(seen, [worker.sessionId], "他のハンドラは呼ばれる");
  });

  it("[task-0027] dispose で購読を解除する", () => {
    const local = new WorkerPool({ driver, dataDir: dir, defaultProjectTag: "test" });
    assert.equal(driver.subscriberCount, 2, "beforeEach の pool と合わせて2つ");

    local.dispose();
    assert.equal(driver.subscriberCount, 1);
  });

  it("[task-0027] stop / reap で終了の内訳も片付く", async () => {
    const worker = await pool.delegate(JOB);
    driver.emit({
      type: "process_exited",
      pid: worker.pid,
      sessionId: worker.sessionId,
      exitCode: 0,
      signal: null,
    });
    await pool.stop(worker.sessionId);

    assert.deepEqual(pool.list(), []);
  });
});
