/**
 * task-0059: 検証環境の**期限・上限・台帳**は Environment Pool が持つ（ADR-0013 決定60）。
 *
 * ここは Kobo から移設した検査。以前は同じ振る舞いを Kobo 側の受け入れテストが見ていたが、
 * 台帳が Kobo と Environment Pool の両方にあったため（inc-0027）、**Kobo が回す期限**と
 * **番頭が立てた環境**が噛み合っていなかった。台帳を1つに寄せたので、検査もこちらへ移す。
 *
 * **Kobo も Banto も起こさない。** 同梱の `process` ドライバを本物の子プロセスとして回す。
 *
 * I3: 外部リソースの消し忘れは金銭的実害。ここが一番大事な検査になる。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { EnvironmentPool } from "@banto/environment-pool";

// imp-0012: テスト用の一時 state に隔離（本番のドライバ state を汚さない）
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-env-pool-lifecycle.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
/** teardown が必ず失敗する本物のドライバ（偽物ではない）。 */
const FAILING_DRIVER = path.resolve(_thisDir, "../fixtures/failing-teardown-driver.ts");

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-life-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function makePool(options: Partial<ConstructorParameters<typeof EnvironmentPool>[0]> = {}): EnvironmentPool {
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

describe("[task-0059] 期限（TTL）の執行は Environment Pool が持つ", () => {
  it("期限を過ぎた環境は強制的に畳まれる（I3：消し忘れが一番困る）", async () => {
    writeProfiles("profiles:\n  short:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 2s\n");
    const pool = makePool({ maintenanceIntervalMs: 300 });

    const env = await pool.provision({ repoPath: repo, profile: "short", taskId: "t-1" });
    assert.equal(pool.list({ taskId: "t-1" }).length, 1, "立った直後は生きている");

    // **執行を回さないと期限は効かない**（呼ばないと誰も片付けない）
    pool.startMaintenance();
    await until(() => pool.list({ taskId: "t-1" }).length === 0);

    const history = pool.list({ taskId: "t-1", includeTornDown: true });
    assert.equal(history.length, 1, "履歴からは消えない");
    assert.equal(history[0]!.envId, env.envId);
    assert.equal(history[0]!.state, "torn-down");
  });

  it("執行を回していないことは list から分かる（黙って畳まれるふりをしない・I2）", async () => {
    writeProfiles("profiles:\n  short:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 2s\n");
    const pool = makePool();
    assert.equal(pool.isMaintaining(), false, "start していなければ回っていない");

    await pool.provision({ repoPath: repo, profile: "short", taskId: "t-2" });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(pool.list({ taskId: "t-2" }).length, 1, "回っていないので畳まれない");

    await pool.teardown(pool.list({ taskId: "t-2" })[0]!.envId);
  });
});

describe("[task-0059] 畳み損ねを成功に見せない（teardown の再試行）", () => {
  it("畳めなかった環境は teardown-failed として残り、知らせが出る（I2・I3）", async () => {
    writeProfiles(`profiles:\n  badneck:\n    driver: "${FAILING_DRIVER}"\n    ttl: 2s\n`);
    const notices: string[] = [];
    const pool = makePool({
      maintenanceIntervalMs: 300,
      teardownRetryLimit: 2,
      onAttention: (m) => notices.push(m),
    });

    await pool.provision({ repoPath: repo, profile: "badneck", taskId: "t-3" });
    pool.startMaintenance();

    await until(() => {
      const all = pool.list({ taskId: "t-3", includeTornDown: true });
      return all.length > 0 && all[0]!.state === "teardown-failed";
    });

    const entry = pool.list({ taskId: "t-3", includeTornDown: true })[0]!;
    assert.equal(entry.state, "teardown-failed", "畳めなかったことが状態に残る");
    assert.ok(notices.length > 0, "畳み損ねは知らせに出る（画面を開くまで気づけない、にしない）");
  });
});

describe("[task-0059] 同時上限（quota）は能力側が持つ（決定34f）", () => {
  it("プロファイルの上限を超える provision は黙って丸めず拒否される", async () => {
    writeProfiles(
      "profiles:\n  capped:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 1h\n    quota:\n      max_instances: 1\n"
    );
    const pool = makePool();

    const first = await pool.provision({ repoPath: repo, profile: "capped", taskId: "t-4" });
    await assert.rejects(
      () => pool.provision({ repoPath: repo, profile: "capped", taskId: "t-5" }),
      /同時に動かせる/,
      "2つ目は理由つきで断られる"
    );

    await pool.teardown(first.envId);
    // 1つ空けば通る（上限は「いま生きている数」で決まる・D3）
    const second = await pool.provision({ repoPath: repo, profile: "capped", taskId: "t-5" });
    await pool.teardown(second.envId);
  });

  it("機構のハード上限を超えるプロファイルは使えないものとして返る（理由つき）", () => {
    writeProfiles("profiles:\n  toolong:\n    driver: process\n    config:\n      cmd: sleep 1\n    ttl: 720h\n");
    const pool = makePool();

    const { usable, rejected } = pool.profiles(repo);
    assert.equal(usable.length, 0);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]!.reason, /ttl|上限/i, "なぜ使えないかが書いてある（I2）");
  });
});

describe("[task-0059] 台帳は Environment Pool のもの（再起動と破損）", () => {
  it("プロセスが変わっても台帳から環境が戻る", async () => {
    writeProfiles("profiles:\n  dev:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 1h\n");
    const first = makePool();
    const env = await first.provision({ repoPath: repo, profile: "dev", taskId: "t-6" });
    first.stopMaintenance();

    // 同じ置き場で開き直す＝プロセスの再起動に相当
    const second = makePool();
    const restored = second.list({ taskId: "t-6" });
    assert.equal(restored.length, 1, "再起動しても環境は台帳から戻る");
    assert.equal(restored[0]!.envId, env.envId);

    await second.teardown(env.envId);
  });

  it("台帳が壊れていたら、黙って空で動き出さない（I2）", () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "env-ledger.json"), "{壊れている", "utf-8");

    const pool = makePool();
    assert.ok(pool.ledgerCorruption, "読めなかったことが分かる形で残る");
    assert.equal(pool.list().length, 0, "空の台帳で立ち上がりはする（止まらない）");
  });
});

describe("[task-0059] 秘密が一覧に漏れない", () => {
  it("credentials の参照名は出るが、値は出ない", () => {
    writeProfiles(
      "profiles:\n  dev:\n    driver: process\n    config:\n      cmd: sleep 60\n    ttl: 1h\n    credentials: staging-secrets\n"
    );
    const pool = makePool();

    const { usable } = pool.profiles(repo);
    const dumped = JSON.stringify(usable);
    assert.match(dumped, /staging-secrets/, "参照名は出る（何を使うかは見える）");
    assert.doesNotMatch(dumped, /BEGIN AGE|sops|ENC\[/, "復号した値や鍵は出ない");
  });
});
