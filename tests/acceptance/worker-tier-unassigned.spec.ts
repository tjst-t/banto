/**
 * **等級に候補が無いとき、黙って落ちない**（ADR-0021 決定104・task-0108 の a4）。
 *
 * 決定104 の前は `resolveForWorker` が `[要求した等級, ...MODEL_TIERS の残り]` の順に見て
 * いた。`MODEL_TIERS` は `["reasoning","standard","fast"]` なので、**`fast` を要求して候補が
 * 無いと次に見るのは `reasoning`**——安いつもりで一番高いモデルが走る。
 *
 * その落ち方は `llm.resolve` では止めたが、**工房の経路には残っていた**：等級に割り当てが
 * 無いと `planModel(runtime, undefined)` がランタイム任せになり、pi のドライバは起動時の
 * 写し（`defaultProvider` / `defaultModel`）で走る。**例外にならないので誰も気づけない。**
 *
 * ここで守る性質は3つ。
 *   1. **工房は断る**（黙ってランタイム既定へ落ちない）
 *   2. **上書きの経路は無傷**（名指し・台帳の割り当てはそのまま通る・決定99a）
 *   3. **取次へ一通積まれる**——直せるのは PO だけなので、会話のエラーで終わらせない。
 *      積むのは番頭ホスト（工房は取次を知らない・決定27）
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Inbox, withTierUnassignedNotice, type NamespacedToolDefinition } from "@banto/host";
import { TIER_UNASSIGNED_CODE, WorkerPool, tierFromUnassignedError } from "@banto/worker-pool";
import type {
  DriverEvent,
  DriverEventHandler,
  RuntimeDriver,
  SessionHandle,
  SpawnOptions,
} from "@banto/core";

/** 起こしたことだけを覚える偽のランタイム（**何で**起こされたかを見たい）。 */
class FakeDriver implements RuntimeDriver {
  readonly spawned: SpawnOptions[] = [];
  private counter = 0;
  private readonly children: childProcess.ChildProcess[] = [];
  private readonly handlers = new Set<DriverEventHandler>();

  async spawn(options: SpawnOptions): Promise<SessionHandle> {
    this.spawned.push(options);
    this.counter += 1;
    fs.mkdirSync(path.dirname(options.sessionPath), { recursive: true });
    fs.writeFileSync(options.sessionPath, "");
    // 工房は pid の生存で職人の生死を見るので、実プロセスを持たせる
    const child = childProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    this.children.push(child);
    return { pid: child.pid!, sessionId: `s-${this.counter}`, sessionPath: options.sessionPath };
  }

  async inject(): Promise<void> {}

  async kill(): Promise<void> {}

  subscribe(handler: DriverEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  cleanup(): void {
    for (const child of this.children) child.kill("SIGKILL");
  }
}

/** 核の台帳の、工房が読む分だけ（`ModelLedger` の部分形）。 */
function fakeLedger(
  roles: Partial<Record<string, { backend: string; provider: string; model: string }>>,
  defaultTier?: string,
  exists = true
) {
  return {
    exists: () => exists,
    defaultTier: () => defaultTier,
    role: (role: string) => {
      const found = roles[role];
      return found ? { default: found } : undefined;
    },
  };
}

let dir: string;
let driver: FakeDriver;
let pool: WorkerPool | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-tier-unassigned-"));
  driver = new FakeDriver();
});

afterEach(() => {
  pool?.dispose();
  pool = undefined;
  driver.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

const JOB = { taskId: "task-0108", worktreePath: "/tmp/wt", instruction: "調べて直して" };

function poolWith(ledger: ReturnType<typeof fakeLedger>): WorkerPool {
  pool = new WorkerPool({
    driver,
    dataDir: dir,
    defaultProjectTag: "test",
    idleTimeoutMs: 0,
    modelLedger: ledger,
  });
  return pool;
}

describe("[決定104] 工房は、割り当ての無い等級で黙って起こさない", () => {
  it("既定の等級に割り当てが無ければ断る（ランタイム既定へ落ちない）", async () => {
    const p = poolWith(fakeLedger({}, "fast"));
    await assert.rejects(
      () => p.delegate(JOB),
      (err: Error) => {
        assert.match(err.message, /役ごとのモデル/, "どこで直すかを言う");
        assert.equal(tierFromUnassignedError(err.message), "fast", "どの等級かを渡す");
        return true;
      }
    );
    assert.equal(
      driver.spawned.length,
      0,
      "**起こさない**——起きてしまうと、別のモデルで走ったことに誰も気づけない"
    );
  });

  it("頼まれた等級に割り当てが無ければ断る（別の等級の割り当てで埋めない）", async () => {
    // `fast` に候補が無いとき `reasoning` へ落ちるのが、決定104 が止めた形そのもの
    const p = poolWith(
      fakeLedger({ "worker.reasoning": { backend: "pi", provider: "cloud", model: "big" } })
    );
    await assert.rejects(() => p.delegate({ ...JOB, modelTier: "fast" }), /BANTO_TIER_UNASSIGNED/);
    assert.equal(driver.spawned.length, 0);
  });

  it("名指しは最優先で通る（上書きの経路は無傷・決定99a）", async () => {
    const p = poolWith(fakeLedger({}, "fast"));
    await p.delegate({ ...JOB, model: "cloud/big" });
    assert.equal(driver.spawned.length, 1);
    assert.equal(driver.spawned[0]?.driverOptions?.["model"], "big");
  });

  it("等級に割り当てがあれば、今までどおり起きる", async () => {
    const p = poolWith(
      fakeLedger({ "worker.fast": { backend: "pi", provider: "cloud", model: "small" } }, "fast")
    );
    await p.delegate(JOB);
    assert.equal(driver.spawned[0]?.driverOptions?.["model"], "small");
  });

  it("等級そのものが決まっていなければ断らない（等級の問いが立っていない）", async () => {
    const p = poolWith(fakeLedger({}));
    await p.delegate(JOB);
    assert.equal(driver.spawned.length, 1, "「割り当てが無い等級」ではないので、断る根拠が無い");
  });

  it("台帳がまだ無いときは断らない（入れ替えの窓）", async () => {
    // 工房を先に上げるので、台帳がまだ無い窓が必ずできる。そこで断ると工場が全部止まる
    const p = poolWith(fakeLedger({}, "fast", false));
    await p.delegate(JOB);
    assert.equal(driver.spawned.length, 1);
  });
});

/**
 * **名指しはモデルだけを上書きする——バックエンドは名前から決まる**（決定99a）。
 *
 * 実測 2026-08-17：Kobo の設定で監査だけ `opus` に当てたら、監査の spawn が**全部**
 * 「モデル "opus" は Claude Code のものです（runtime: pi と食い違っています）」で落ちた。
 * 等級（reasoning）に当たっていたのが pi のモデルで、名指しがモデルだけを差し替え、
 * **ランタイムだけ等級側の pi が残った**ため。名指しした瞬間に必ず落ちるので、
 * 「監査だけ別のバックエンドに当てる」という設定が成立しなかった。
 */
describe("[決定99a] 名指しは、等級に当たっているバックエンドを引き継がない", () => {
  /** 等級は pi に当たっている台帳（実機の `model-roles.json` と同じ形）。 */
  const piTier = fakeLedger(
    { "worker.fast": { backend: "pi", provider: "cloud", model: "small" } },
    "fast"
  );

  function poolWithClaude(claude: FakeDriver): WorkerPool {
    pool = new WorkerPool({
      driver,
      dataDir: dir,
      defaultProjectTag: "test",
      idleTimeoutMs: 0,
      modelLedger: piTier,
      runtimes: {
        "claude-agent-sdk": {
          driver: claude,
          title: "Claude Code",
          models: () => [{ name: "opus", label: "opus" }],
        },
      },
    });
    return pool;
  }

  it("等級が pi でも、claude のモデルを名指しすれば claude で起きる", async () => {
    const claude = new FakeDriver();
    try {
      const p = poolWithClaude(claude);
      await p.delegate({ ...JOB, model: "opus" });
      assert.equal(driver.spawned.length, 0, "等級の pi へ流さない");
      assert.equal(claude.spawned.length, 1, "名前が指すバックエンドで起こす");
      assert.equal(claude.spawned[0]?.driverOptions?.["model"], "opus");
    } finally {
      claude.cleanup();
    }
  });

  it("runtime を明記したときは、これまでどおり食い違いを断る", async () => {
    const claude = new FakeDriver();
    try {
      const p = poolWithClaude(claude);
      // 併記は呼び出し側の意思表示。黙ってどちらかを勝たせない（I2）
      await assert.rejects(
        () => p.delegate({ ...JOB, model: "opus", runtime: "pi" }),
        /食い違っています/
      );
      assert.equal(driver.spawned.length + claude.spawned.length, 0);
    } finally {
      claude.cleanup();
    }
  });

  it("pi のモデルを名指ししたときは、これまでどおり pi で起きる", async () => {
    const claude = new FakeDriver();
    try {
      const p = poolWithClaude(claude);
      await p.delegate({ ...JOB, model: "cloud/big" });
      assert.equal(claude.spawned.length, 0);
      assert.equal(driver.spawned[0]?.driverOptions?.["model"], "big");
    } finally {
      claude.cleanup();
    }
  });
});

/** `worker.delegate` の形だけを持つ、断る／通る偽の Tool。 */
function delegateTool(behavior: () => Promise<void>): NamespacedToolDefinition {
  return {
    name: "worker.delegate",
    label: "Worker: Delegate",
    description: "職人へ委譲する（試験用の写し）",
    parameters: { type: "object", properties: {} },
    async execute() {
      await behavior();
      return { content: [{ type: "text", text: "起こしました" }] };
    },
  } as unknown as NamespacedToolDefinition;
}

describe("[決定104] 断られたら取次へ一通積む（積むのは番頭ホスト）", () => {
  it("等級の空きは取次に出る。押す先は「役ごとのモデル」", async () => {
    const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
    const tool = withTierUnassignedNotice(
      delegateTool(() => Promise.reject(new Error(`${TIER_UNASSIGNED_CODE}:reasoning\n割り当てなし`))),
      { inbox, threadId: "th-1" }
    );

    await assert.rejects(
      () => tool.execute({ taskId: "task-0108" } as never, { toolCallId: "c1" }),
      /BANTO_TIER_UNASSIGNED/,
      "**断りは呼び出し側にも返る**——積んだから成功、にしない"
    );

    const items = inbox.list();
    assert.equal(items.length, 1);
    assert.match(items[0]!.title, /reasoning/);
    assert.equal(items[0]!.opens?.settings?.section, "roles", "直す場所へ連れて行く");
    assert.match(items[0]!.why ?? "", /task-0108/, "何を委譲しようとしたのかを載せる");
  });

  it("同じ等級で札を積み増さない（直すべき設定は1つ）", async () => {
    const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
    const tool = withTierUnassignedNotice(
      delegateTool(() => Promise.reject(new Error(`${TIER_UNASSIGNED_CODE}:fast`))),
      { inbox }
    );
    for (let i = 0; i < 3; i++) {
      await tool.execute({ taskId: `task-${i}` } as never, { toolCallId: `c${i}` }).catch(() => undefined);
    }
    assert.equal(inbox.list().length, 1);
  });

  it("合印の無い失敗は素通しする（取次の札が意味を失う）", async () => {
    const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
    const tool = withTierUnassignedNotice(
      delegateTool(() => Promise.reject(new Error("Failed to reach module \"worker\""))),
      { inbox }
    );
    await assert.rejects(() => tool.execute({} as never, { toolCallId: "c1" }), /Failed to reach/);
    assert.equal(inbox.list().length, 0);
  });

  it("起こせたときは何も積まない", async () => {
    const inbox = new Inbox(path.join(dir, "inbox.jsonl"));
    const tool = withTierUnassignedNotice(delegateTool(() => Promise.resolve()), { inbox });
    await tool.execute({} as never, { toolCallId: "c1" });
    assert.equal(inbox.list().length, 0);
  });
});

describe("[決定104] 合印は契約（文言を直しても取次は止まらない）", () => {
  it("等級を読み取る。合印が無ければ undefined", () => {
    assert.equal(tierFromUnassignedError(`${TIER_UNASSIGNED_CODE}:standard\nどんな文言でも`), "standard");
    assert.equal(tierFromUnassignedError("等級に割り当てがありません"), undefined);
    assert.equal(
      tierFromUnassignedError(`${TIER_UNASSIGNED_CODE}:genius`),
      undefined,
      "知らない等級は名乗らせない"
    );
  });
});
