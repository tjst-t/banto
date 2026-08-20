/**
 * 孤児の判定は「自分が作ったもの」に限る（`spec-environment` §5・PO指摘 2026-08-08）。
 *
 * **これは誤検出の試験であって、検出の試験ではない。** docker ドライバは所有を
 * **名前の綴りで推測**していた（`docker compose ls` の全件から `-docker` で終わるものを
 * 自分のものとみなす）。実測で、banto と何の関係もない `myapp-docker`——compose は既定で
 * ディレクトリ名をプロジェクト名にするので、ごく普通に在りうる名前——が
 * 「台帳に無い実リソース（孤児）」として挙がった。
 *
 * ここに孤児を畳む口を付けていたら、**POの無関係なコンテナを壊していた**。
 * だから見張るのは「他人のものを自分のものと言わないこと」の側。
 *
 * docker を要求しない：所有の記録（STATE_FILE）と `list` の突き合わせは、docker が
 * 無い機械でも確かめられる形にしてある——**docker のある機械でしか回らない見張りは、
 * 無い機械では黙って消える**。
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { EnvironmentPool } from "@banto/environment-pool";

const DRIVER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/banto-environment-pool/src/docker-driver.ts"
);

let stateFile: string;
let tmp: string;

/** ドライバを1回起こす。docker が無ければ `list` は空を返すので、それも確かめられる。 */
function invoke(verb: string, input: unknown): unknown {
  const out = execFileSync("npx", ["tsx", DRIVER, verb], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    env: { ...process.env, BANTO_DOCKER_DRIVER_STATE: stateFile },
    timeout: 60_000,
  });
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "null";
  return JSON.parse(line);
}

// `docker version` は通っても `docker compose ls` は通らない機械がある（compose プラグイン
// 未搭載・socket 未到達）。ドライバが実際に叩くコマンドで確かめないと、「docker はある」と
// 誤判定して走り出し、即座に落ちる（task-0293・監査の検証環境で実測）。
function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["compose", "ls", "--format", "json"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "banto-orphan-own-"));
  stateFile = path.join(tmp, "owned.json");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(stateFile, { force: true });
});

describe("[spec-environment §5] 孤児の判定は自分が作ったものに限る", () => {
  it("**記録が空なら、何も自分のものと言わない**（安全側に倒れる）", (t) => {
    if (!dockerAvailable()) {
      t.skip("docker compose が使えない機械なので、実物での確認は飛ばす");
      return;
    }
    const listed = invoke("list", {});
    assert.ok(Array.isArray(listed));
    assert.equal((listed as unknown[]).length, 0, "記録が無いのに自分のものを名乗ってはいけない");
  });

  it("名前が `-docker` で終わるだけの他人のプロジェクトを拾わない", (t) => {
    if (!dockerAvailable()) {
      t.skip("docker が無い機械なので、実物での確認は飛ばす（記録の側は上の試験が見ている）");
      return;
    }
    const project = "myapp-docker";
    const compose = path.join(tmp, "compose.yaml");
    fs.writeFileSync(
      compose,
      'services:\n  app:\n    image: alpine:3\n    command: ["sleep", "120"]\n'
    );
    execFileSync("docker", ["compose", "-f", compose, "-p", project, "up", "-d"], {
      stdio: "ignore",
      timeout: 120_000,
    });
    try {
      const listed = invoke("list", {}) as Array<{ name?: string }>;
      const names = listed.map((i) => i.name);
      assert.ok(
        !names.includes(project),
        `他人のプロジェクトを自分のものとして挙げてはいけない: ${names.join(", ")}`
      );
    } finally {
      execFileSync("docker", ["compose", "-p", project, "down", "-v"], {
        stdio: "ignore",
        timeout: 120_000,
      });
    }
  });

  it("記録に在っても実在しなければ挙げない（外で消された分を溜めない）", (t) => {
    if (!dockerAvailable()) {
      t.skip("docker compose が使えない機械なので、実物での確認は飛ばす");
      return;
    }
    fs.writeFileSync(stateFile, JSON.stringify(["banto-env-task-gone"]), "utf-8");
    const listed = invoke("list", {}) as unknown[];
    assert.equal(listed.length, 0, "実在しないものを孤児として挙げてはいけない");
    // 記録からも落ちていること（溜め続けない）
    const owned = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as string[];
    assert.deepEqual(owned, [], "実在しない記録は落とす");
  });

  it("壊れた記録でも動く。ただし何も自分のものと言わない（I2）", (t) => {
    if (!dockerAvailable()) {
      t.skip("docker compose が使えない機械なので、実物での確認は飛ばす");
      return;
    }
    fs.writeFileSync(stateFile, "{壊れている", "utf-8");
    const listed = invoke("list", {}) as unknown[];
    assert.equal(listed.length, 0);
  });
});

/**
 * **所有の記録は置き場ごと**（PO報告 2026-08-10）。
 *
 * 記録の既定は `os.tmpdir()/banto-docker-driver-state.json` という**機械に1つの場所**
 * だった。同じ機械で試験を回すと、試験が立てたコンテナが**本番のプール自身のもの**
 * として記録され、本番の台帳には無いので「孤児」として毎回帳場へ知らせが飛んでいた。
 *
 * 所有はプールごとに違う。だから記録も置き場ごとに分ける——プールがドライバへ
 * 置き場を教える（`BANTO_DOCKER_DRIVER_STATE`）。
 */
describe("[spec-environment §5] 所有の記録は置き場ごとに分かれる", () => {
  it("プールはドライバへ自分の置き場を教える", async () => {
    const { EnvironmentPool } = await import("@banto/environment-pool");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-owned-"));
    const pool = new EnvironmentPool({ dataDir });

    // 記録の置き場は**この置き場の中**。機械に1つの既定を指してはいけない
    const env = (pool as unknown as { driverEnv: Record<string, string> }).driverEnv;
    assert.equal(
      env["BANTO_DOCKER_DRIVER_STATE"],
      path.join(dataDir, "docker-driver-owned.json"),
      "所有の記録が置き場の外にある＝別のプールと共有してしまう"
    );
    assert.ok(
      !env["BANTO_DOCKER_DRIVER_STATE"]!.startsWith(os.tmpdir() + path.sep + "banto-docker-driver-state"),
      "機械に1つの既定を指している"
    );

    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("別の置き場のプールは、別の記録を指す（試験と本番が混ざらない）", async () => {
    const { EnvironmentPool } = await import("@banto/environment-pool");
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "env-pool-b-"));
    const envOf = (dir: string): string =>
      (new EnvironmentPool({ dataDir: dir }) as unknown as {
        driverEnv: Record<string, string>;
      }).driverEnv["BANTO_DOCKER_DRIVER_STATE"]!;

    assert.notEqual(envOf(a), envOf(b), "違う置き場のプールが同じ記録を指している");

    for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true });
  });
});

describe("[spec-environment §5] 名前空間", () => {
  it("プロジェクト名は banto のものと分かる形（`banto-env-<envId>`）", async () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/banto-environment-pool/src/docker-driver.ts"),
      "utf-8"
    );
    assert.match(
      src,
      /return `banto-env-\$\{envId\}`/,
      "名前は二重の守りの片方。`<taskId>-docker` は他人と衝突しうる綴りだった"
    );
    // imp-0033: **taskId で名付けない**。同じタスクに環境は複数あり、名前を共有すると
    // 互いのコンテナを作り直す／消す（実際に PO が 502 を2度踏んだ）。
    // 振る舞いで見るのは env-docker-project-per-env.spec.ts
    assert.doesNotMatch(
      src,
      /projectName\(taskId\)/,
      "taskId から名前を作る経路が残っている（同じタスクの2つ目の環境が1つ目を壊す）"
    );
  });
});

/**
 * 照合（`Pool.reconcile`）の2つの取りこぼし（task-0293）。
 *
 * ① 台帳の**畳み済み**エントリは `listLive()` に映らない。だから畳んだ印は付いているが
 *    実体がまだドライバに見えている（畳みの実行中・畳み損ね）環境が「台帳に無い＝孤児」
 *    と誤判定されていた——持ち主は台帳から分かっているので、これは孤児ではない。
 * ② `reconcile` は先に台帳のスナップショットを取り、そのあとで各ドライバの `list` を
 *    子プロセスとして待つ。その待ち時間の間に完了した `provision` は、スナップショットに
 *    載っていない＝必ず孤児と判定されていた（TOCTOU）。
 *
 * **本物のドライバ・本物の Pool で見る**（env-notices.spec.ts と同じ流儀）。ただしこの
 * ファイルの担当範囲は自分だけなので、新しい fixture ファイルは増やさず、ドライバの実体は
 * このテストの実行時に一時ディレクトリへ書き出す（`tests/fixtures/` を増やさない）。
 */
describe("[spec-environment §5] 照合は畳み済みエントリと走行中の provision を取りこぼさない（task-0293）", () => {
  /**
   * 検査専用のドライバ。挙動は環境変数で切り替える：
   *   - `BANTO_TEST_DRIVER_STATE`: 状態ファイル（配列: {name, taskId, envId, created}）
   *   - `BANTO_TEST_DRIVER_TEARDOWN_MODE`: "lagging" なら teardown は成功を返しつつ
   *     状態ファイルから消さない（＝畳んだと報告したのに実体が残る・畳み損ねの再現）
   *   - `BANTO_TEST_DRIVER_LIST_GATE`: "1" なら `list` は状態ファイル横に `.list-started`
   *     を書いてから `.list-go` が現れるまで待つ（TOCTOU を時間の擬装で作るための足場）
   */
  const FAKE_DRIVER_SOURCE = `
import * as fs from "node:fs";

const STATE_FILE = process.env.BANTO_TEST_DRIVER_STATE;
const TEARDOWN_MODE = process.env.BANTO_TEST_DRIVER_TEARDOWN_MODE || "remove";
const LIST_GATE = process.env.BANTO_TEST_DRIVER_LIST_GATE === "1";

function readState() {
  try {
    if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return [];
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch (err) {
    return [];
  }
}

function writeState(entries) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(entries), "utf-8");
}

function readStdin() {
  return new Promise(function (resolve) {
    var data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", function (chunk) { data += chunk; });
    process.stdin.on("end", function () {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch (err) {
        resolve({});
      }
    });
    process.stdin.on("error", function () { resolve({}); });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function main() {
  var verb = process.argv[2];
  var input = await readStdin();

  if (verb === "provision") {
    var taskId = String(input.taskId || "t");
    var envId = String(input.envId || taskId);
    var name = envId + "-fake-env";
    var entries = readState().filter(function (e) { return e.envId !== envId; });
    entries.push({ name: name, taskId: taskId, envId: envId, created: new Date().toISOString() });
    writeState(entries);
    process.stdout.write(JSON.stringify({ handle: { name: name, envId: envId } }) + "\\n");
    return;
  }

  if (verb === "teardown") {
    var handle = input.handle || {};
    if (TEARDOWN_MODE !== "lagging") {
      var remaining = readState().filter(function (e) { return e.envId !== handle.envId; });
      writeState(remaining);
    }
    process.stdout.write(JSON.stringify({}) + "\\n");
    return;
  }

  if (verb === "list") {
    if (LIST_GATE) {
      fs.writeFileSync(STATE_FILE + ".list-started", "1", "utf-8");
      var deadline = Date.now() + 10000;
      while (!fs.existsSync(STATE_FILE + ".list-go") && Date.now() < deadline) {
        await sleep(20);
      }
    }
    var items = readState().map(function (e) {
      return { handle: { name: e.name, envId: e.envId }, name: e.name, created: e.created };
    });
    process.stdout.write(JSON.stringify(items) + "\\n");
    return;
  }

  process.stderr.write("fake-driver: unsupported verb in test: " + verb + "\\n");
  process.exit(1);
}

main().catch(function (err) {
  process.stderr.write("fake-driver fatal: " + String(err) + "\\n");
  process.exit(1);
});
`;

  let root: string;
  let fakeDriver: string;
  let dir: string;
  let dataDir: string;
  let repo: string;
  let stateFile: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "env-reconcile-toctou-"));
    fakeDriver = path.join(root, "fake-driver.ts");
    fs.writeFileSync(fakeDriver, FAKE_DRIVER_SOURCE, "utf-8");
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(root, "case-"));
    dataDir = path.join(dir, "data");
    repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "meta", "environments.yaml"),
      `profiles:\n  fake:\n    driver: "${fakeDriver}"\n    ttl: 1h\n`,
      "utf-8"
    );
    stateFile = path.join(dir, "driver-state.json");
    process.env["BANTO_TEST_DRIVER_STATE"] = stateFile;
    process.env["BANTO_TEST_DRIVER_TEARDOWN_MODE"] = "remove";
    delete process.env["BANTO_TEST_DRIVER_LIST_GATE"];
  });

  afterEach(() => {
    delete process.env["BANTO_TEST_DRIVER_STATE"];
    delete process.env["BANTO_TEST_DRIVER_TEARDOWN_MODE"];
    delete process.env["BANTO_TEST_DRIVER_LIST_GATE"];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function makePool(): Promise<EnvironmentPool> {
    const { EnvironmentPool: Pool } = await import("@banto/environment-pool");
    return new Pool({ dataDir, driverTimeoutMs: 20_000 });
  }

  async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`ファイルが現れませんでした（待ちが機能していない）: ${filePath}`);
  }

  it("[a1・a3] 畳み済みエントリに一致する実体は孤児ではなく畳み損ねとして記録される", async () => {
    process.env["BANTO_TEST_DRIVER_TEARDOWN_MODE"] = "lagging";
    const pool = await makePool();
    const env = await pool.provision({ repoPath: repo, profile: "fake", taskId: "t-lag" });
    // ドライバは畳んだと報告するが（lagging）、状態ファイルからは消さない＝実体が残る
    await pool.teardown(env.envId);

    await pool.runMaintenance();

    assert.deepEqual(
      pool.orphans(),
      [],
      "畳み済みエントリに一致した実体を孤児として報告してはいけない（持ち主は台帳から分かっている）"
    );
    const events = pool.events();
    assert.ok(
      !events.some((e) => e.type === "env_orphans_found"),
      "畳み損ねを孤児の出来事として鳴らしてはいけない"
    );
    const incomplete = events.find((e) => e.type === "env_teardown_incomplete");
    assert.ok(incomplete, "畳み損ねが出来事として残っていない");
    const message = String(incomplete!.data["message"] ?? "");
    assert.ok(
      !message.includes("Banto 以外"),
      `畳み損ねの文面が「他人のもの」という言い方をしている（持ち主は分かっている）: ${message}`
    );
  });

  it("[a2] 台帳のどのエントリにも無い実体は、これまでどおり孤児として報告される（生きているエントリは孤児にならないことも合わせて確かめる）", async () => {
    const pool = await makePool();
    const anchor = await pool.provision({ repoPath: repo, profile: "fake", taskId: "t-anchor" });

    // ドライバの管理下に、台帳が知らない実体を1つ置く。
    // 直近に作られたものは「照合の走行中の provision かもしれない」保険（a5）で
    // 孤児にしないので、ここでは十分に古い created にして保険を踏ませない
    const state = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as Array<Record<string, unknown>>;
    state.push({
      name: "lost-x",
      taskId: "t-lost",
      envId: "env-lost-x",
      created: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");

    await pool.runMaintenance();

    const orphans = pool.orphans();
    assert.ok(
      orphans.some((o) => o.name === "lost-x"),
      `台帳に無い実体を孤児として挙げていない: ${JSON.stringify(orphans)}`
    );
    assert.ok(
      !orphans.some((o) => o.name === `${anchor.envId}-fake-env`),
      "生きている（台帳にある）環境まで孤児として数えている"
    );
    const event = pool.events().find((e) => e.type === "env_orphans_found");
    assert.ok(event, "孤児が出来事として残っていない");
  });

  it("[a5] 照合の走行中に provision された環境は孤児として報告されない（TOCTOU）", async () => {
    process.env["BANTO_TEST_DRIVER_LIST_GATE"] = "1";
    const pool = await makePool();
    // このドライバを照合の対象にするため、先に1つ生きている環境が要る
    // （台帳に載っていないドライバの list はそもそも呼ばれない）
    await pool.provision({ repoPath: repo, profile: "fake", taskId: "t-base" });

    const reconcilePromise = pool.reconcile();

    // list が呼ばれて gate で止まったことを確かめてから、その最中に provision する
    await waitForFile(`${stateFile}.list-started`);
    const race = await pool.provision({ repoPath: repo, profile: "fake", taskId: "t-race" });

    // list を先へ進める（この時点で台帳には race の分が既に足されている）
    fs.writeFileSync(`${stateFile}.list-go`, "1", "utf-8");

    const orphans = await reconcilePromise;
    assert.deepEqual(
      orphans,
      [],
      "照合の走行中に完了した provision を孤児として報告している（取りこぼし②・TOCTOU）"
    );
    assert.deepEqual(pool.orphans(), []);
    assert.ok(pool.list().some((e) => e.envId === race.envId), "台帳には載っていること（前提）");
  });
});
