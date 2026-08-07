/**
 * task-0067: 検証環境の衛生（畳み忘れ・畳み損ね・孤児）が**会話へ返る**。
 *
 * task-0066 で Environment Pool を独立サービスへ出したとき、`onAttention` の繋ぎ先が
 * 番頭ホストの中から消え、知らせがサービスのログに落ちるだけになった。職人と同じく
 * **引きに行く形**（`env.events` を `afterEventId` で追う）に戻したのがここ。
 *
 * **本物のドライバと本物のサービスで見る。** 偽の fetch で済ませない——過去に
 * 「偽物では全部通るのに本物で壊れていた」を繰り返している。
 *
 * I3: 外に残ったリソースは金銭的実害。**気づく契機が消えていないこと**がこの検査の主題。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentPool } from "../../packages/banto-environment-pool/src/pool.js";
import { EnvironmentPoolService } from "../../packages/banto-environment-pool/src/service.js";
import { createEnvTools } from "../../packages/banto-environment-pool/src/tools.js";
import type { EnvEvent } from "../../packages/banto-environment-pool/src/event-log.js";
import { createRemoteEnvironmentPoolModule } from "../../packages/banto-host/src/remote-pools.js";
import { renderEnvNotice, startEnvNotices } from "../../packages/banto-host/src/env-notice.js";
import type { NamespacedToolDefinition } from "../../packages/banto-host/src/tool-registry.js";

// imp-0012: テスト用の一時 state に隔離（本番のドライバ state を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-notices.json"
);
const FAILING_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-failing-driver-state-acceptance-env-notices.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;
process.env["BANTO_FAILING_DRIVER_STATE_FILE"] = FAILING_DRIVER_STATE;

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
/** teardown が必ず失敗する本物のドライバ（偽物ではない）。 */
const FAILING_DRIVER = path.resolve(_thisDir, "../fixtures/failing-teardown-driver.ts");

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
  fs.rmSync(FAILING_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-notices-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
  // ドライバの state が前のテストから残っていると、身に覚えのない孤児が出る
  fs.rmSync(FAILING_DRIVER_STATE, { force: true });
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function makePool(
  options: Partial<ConstructorParameters<typeof EnvironmentPool>[0]> = {}
): EnvironmentPool {
  const p = new EnvironmentPool({ dataDir, driverTimeoutMs: 20_000, ...options });
  pools.push(p);
  return p;
}

/** 条件が満たされるまで待つ（時間そのものではなく状態を待つ）。 */
async function until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("待っていた状態にならなかった");
}

/** Tool を1本呼んで `details` を返す。 */
async function invoke(
  tools: NamespacedToolDefinition[],
  name: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `${name} が無い`);
  const result = await tool!.execute(args as never, { toolCallId: "test" });
  return (result.details ?? {}) as Record<string, unknown>;
}

describe("[task-0067/a1] 衛生の出来事が Environment Pool に残る", () => {
  it("期限切れで畳んだこと（＝畳み忘れ）が出来事として残る", async () => {
    writeProfiles(
      "profiles:\n  short:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 2s\n"
    );
    const pool = makePool({ maintenanceIntervalMs: 300 });
    const env = await pool.provision({ repoPath: repo, profile: "short", taskId: "t-1" });

    pool.startMaintenance();
    await until(() => pool.events().some((e) => e.type === "env_expired"));

    const event = pool.events().find((e) => e.type === "env_expired")!;
    assert.equal(event.envId, env.envId);
    assert.equal(event.profile, "short");
    assert.ok(event.id > 0, "連番が振られていない（afterEventId で追えない）");
  });

  it("畳み損ねが出来事として残る（外にリソースが残る側・I3）", async () => {
    writeProfiles(`profiles:\n  badneck:\n    driver: "${FAILING_DRIVER}"\n    ttl: 1s\n`);
    const pool = makePool({ teardownRetryLimit: 2 });
    await pool.provision({ repoPath: repo, profile: "badneck", taskId: "t-2" });
    await new Promise((r) => setTimeout(r, 1200));
    await pool.runMaintenance();

    const failed = pool.events().find((e) => e.type === "env_teardown_failed");
    assert.ok(failed, "畳めなかったことが出来事に出ない（気づく契機がログだけになる）");
    assert.equal(failed!.data["attempts"], 2, "何回試したかが残らないと、諦めたのか判断できない");
    assert.ok(String(failed!.data["error"] ?? "").length > 0, "理由が残っていない（I2）");
  });

  it("台帳に無い実リソース（孤児）が出来事として残る", async () => {
    // 期限は来させない——ここで見たいのは照合であって TTL 執行ではない
    writeProfiles(`profiles:\n  badneck:\n    driver: "${FAILING_DRIVER}"\n    ttl: 1h\n`);
    const pool = makePool();
    await pool.provision({ repoPath: repo, profile: "badneck", taskId: "t-2b" });

    // ドライバの管理下に、台帳が知らないリソースを1つ置く（クラッシュ中に生じた孤児と同じ形）
    const state = JSON.parse(fs.readFileSync(FAILING_DRIVER_STATE, "utf-8")) as unknown[];
    state.push({ name: "lost-1", taskId: "t-lost", created: new Date().toISOString() });
    fs.writeFileSync(FAILING_DRIVER_STATE, JSON.stringify(state), "utf-8");

    await pool.runMaintenance();

    const orphans = pool.events().find((e) => e.type === "env_orphans_found");
    assert.ok(orphans, "孤児が出来事に出ない（台帳に無いものは誰も片付けない）");
    const found = (orphans!.data["orphans"] ?? []) as Array<{ name?: string }>;
    assert.ok(
      found.some((o) => o.name === "lost-1"),
      `何が孤児なのかが残っていない（名前が無いと確かめようがない）: ${JSON.stringify(found)}`
    );
    assert.ok(
      !found.some((o) => o.name?.includes("t-2b")),
      "台帳に載っている環境まで孤児として数えている"
    );
    assert.equal(orphans!.envId, undefined, "孤児は特定の環境の話ではない");
  });

  it("立てた・畳んだの実況は残さない（会話が検証環境の中継にならないため）", async () => {
    writeProfiles(
      "profiles:\n  dev:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 1h\n"
    );
    const pool = makePool();
    const env = await pool.provision({ repoPath: repo, profile: "dev", taskId: "t-3" });
    await pool.teardown(env.envId);

    assert.deepEqual(pool.events(), [], "正常な出入りまで会話へ流すと、番頭が中継役になる");
  });
});

describe("[task-0067/a3] 同じことを何度も知らせない", () => {
  it("畳めない環境は毎分の tick で検出されるが、出来事は1度だけ", async () => {
    writeProfiles(`profiles:\n  badneck:\n    driver: "${FAILING_DRIVER}"\n    ttl: 1s\n`);
    const pool = makePool({ teardownRetryLimit: 1 });
    await pool.provision({ repoPath: repo, profile: "badneck", taskId: "t-4" });
    await new Promise((r) => setTimeout(r, 1200));

    // 手で3回回す（tick が3回来たのと同じ）
    await pool.runMaintenance();
    await pool.runMaintenance();
    await pool.runMaintenance();

    const failures = pool.events().filter((e) => e.type === "env_teardown_failed");
    assert.equal(failures.length, 1, `同じ文面が tick ごとに流れる: ${failures.length} 件`);
  });
});

describe("[task-0067/a1] 追記専用のログとして読み返せる", () => {
  it("afterEventId で続きだけを取れる", async () => {
    writeProfiles(
      "profiles:\n  short:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 2s\n"
    );
    const pool = makePool({ maintenanceIntervalMs: 300 });
    await pool.provision({ repoPath: repo, profile: "short", taskId: "t-5" });
    pool.startMaintenance();
    await until(() => pool.events().length > 0);

    const all = pool.events();
    assert.deepEqual(
      pool.events(all[all.length - 1]!.id),
      [],
      "最後まで読んだ後に同じものが返る（会話に重複が出る）"
    );
    assert.equal(pool.lastEventId, all[all.length - 1]!.id);
  });

  it("プロセスが変わっても残る（追記専用のファイル）", async () => {
    writeProfiles(
      "profiles:\n  short:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 2s\n"
    );
    const first = makePool({ maintenanceIntervalMs: 300 });
    await first.provision({ repoPath: repo, profile: "short", taskId: "t-6" });
    first.startMaintenance();
    await until(() => first.events().length > 0);
    first.stopMaintenance();
    const before = first.events().length;

    // 同じ置き場で開き直す＝サービスの再起動に相当
    const second = makePool();
    assert.equal(second.events().length, before, "再起動で知らせが消えた");
  });

  it("壊れた行があっても、読めた分は使いつつ黙らない（I2）", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "env-events.jsonl"),
      `${JSON.stringify({ id: 1, at: "2026-08-07T00:00:00Z", type: "env_expired", data: {} })}\n{壊れている\n`,
      "utf-8"
    );
    const pool = makePool();
    assert.ok(pool.eventLogCorruption, "読めなかった行があったことが分かる形で残る");
    assert.equal(pool.events().length, 1, "1行壊れただけで全部を失わせない");
  });
});

describe("[task-0067/a2] 番頭の会話へ返る（本物のサービス越し）", () => {
  it("独立サービスに起きたことが、写しの env.events から会話へ届く", async () => {
    writeProfiles(`profiles:\n  badneck:\n    driver: "${FAILING_DRIVER}"\n    ttl: 1s\n`);
    const pool = makePool({ teardownRetryLimit: 1 });
    const service = await EnvironmentPoolService.start({ tools: createEnvTools(pool), port: 0 });
    const remote = createRemoteEnvironmentPoolModule(service.baseUrl);
    const cursorPath = path.join(dir, "env-cursor.json");
    const seen: string[] = [];

    try {
      await pool.provision({ repoPath: repo, profile: "badneck", taskId: "t-7" });
      await new Promise((r) => setTimeout(r, 1200));
      await pool.runMaintenance();

      const stop = startEnvNotices({
        tools: remote.tools,
        notify: async (message) => {
          seen.push(message);
        },
        cursorPath,
        intervalMs: 50,
        log: () => undefined,
      });
      try {
        await until(() => seen.some((m) => m.includes("畳めませんでした")));
      } finally {
        stop();
      }

      // **読み位置が残る**（番頭が落ちている間の分は届き、届いた分は繰り返さない）
      const saved = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as { lastEventId: number };
      assert.ok(saved.lastEventId > 0, "どこまで読んだかが残っていない");

      const again: string[] = [];
      const stopAgain = startEnvNotices({
        tools: remote.tools,
        notify: async (message) => {
          again.push(message);
        },
        cursorPath,
        intervalMs: 50,
        log: () => undefined,
      });
      try {
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(again, [], "起動し直すたびに同じ知らせが並ぶ");
      } finally {
        stopAgain();
      }
    } finally {
      await service.close();
    }
  });

  it("到達先が居ないことを「何も起きていない」と混同しない（I2）", async () => {
    const logged: string[] = [];
    const stop = startEnvNotices({
      tools: [],
      notify: async () => {
        throw new Error("知らせてはいけない");
      },
      cursorPath: path.join(dir, "cursor.json"),
      intervalMs: 50,
      log: (m) => logged.push(m),
    });
    try {
      await until(() => logged.length > 0, 3000);
      assert.match(logged[0]!, /未配線|引けませんでした/);
    } finally {
      stop();
    }
  });
});

describe("[task-0067/a2] 知らせの言い換え", () => {
  const event = (over: Partial<EnvEvent>): EnvEvent => ({
    id: 1,
    at: "2026-08-07T00:00:00Z",
    type: "env_expired",
    data: {},
    ...over,
  });

  it("畳み忘れは「あなたが畳んだのではない」と分かる形で伝える", () => {
    const text = renderEnvNotice(event({ envId: "env-a", profile: "dev" }));
    assert.match(text ?? "", /env-a/);
    assert.match(text ?? "", /env\.teardown/, "次にどうするかが書いていない");
  });

  it("畳み損ねは費用の話として伝える（画面を開くまで気づけない、にしない）", () => {
    const text = renderEnvNotice(
      event({ type: "env_teardown_failed", envId: "env-b", data: { attempts: 3, error: "boom" } })
    );
    assert.match(text ?? "", /外にリソースが残っている/);
    assert.match(text ?? "", /boom/, "理由を落とすと確かめようがない");
  });

  it("孤児は「機構は消さない」ことまで伝える", () => {
    const text = renderEnvNotice(
      event({ type: "env_orphans_found", data: { orphans: [{ driver: "process", name: "x-1" }] } })
    );
    assert.match(text ?? "", /x-1/);
    assert.match(text ?? "", /消しません/, "勝手に消えると期待させない");
  });

  it("知らないものは黙って流さない", () => {
    assert.equal(renderEnvNotice(event({ type: "env_provisioned" as never })), undefined);
  });
});
