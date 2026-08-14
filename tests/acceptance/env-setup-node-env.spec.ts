/**
 * 検証環境の子プロセスに、**常駐サービス自身の deploy 姿勢を持ち込まない**（2026-08-13 の事故）。
 *
 * ## 何が起きたか（実機）
 *
 * `banto-environment-pool.service` は `Environment=NODE_ENV=production` で動く。
 * ドライバはその環境をそのまま継ぎ、ドライバが起こす `setup`（`npm ci`）も継いだ。
 * npm は production では devDependencies を入れない。`test-docker` プロファイルは
 * `driver: process`＝**器を作らずホストの作業ツリーでそのまま走る**ので、
 * **稼働中の本体ツリーから tsx / typescript が消えた**。同時に3つ壊れた:
 *   ① 検証が回らない ② 新しい職人が起こせない（ドライバが tsx/dist/loader.mjs を解決できない）
 *   ③ サービスを再起動すると `node --import tsx` で起動不能
 *
 * ## ここで押さえるもの
 *
 * 器（`driverSpawnEnv`）が正しいことではなく、**繋ぎ目**——プールがドライバを起こし、
 * ドライバが `setup` と検証コマンドを起こすところまで、実際に NODE_ENV が消えていること。
 * 同じ型の穴（器は正しいのに繋ぎ目が抜けている）は task-0102 でも踏んだばかりである。
 *
 * driver: process だけを使う（ホストの docker を要らない＝器の中でも回る）。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  EnvironmentPool,
  ENV_NOT_INHERITED_BY_DRIVER,
  driverSpawnEnv,
} from "@banto/environment-pool";

const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-node-env.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
let savedNodeEnv: string | undefined;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-node-env-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
  savedNodeEnv = process.env["NODE_ENV"];
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = savedNodeEnv;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfiles(body: string): void {
  fs.writeFileSync(path.join(repo, "meta", "environments.yaml"), body, "utf-8");
}

function makePool(): EnvironmentPool {
  const p = new EnvironmentPool({ dataDir, driverTimeoutMs: 30_000 });
  pools.push(p);
  return p;
}

/** `$NODE_ENV` を（無ければ空で）ファイルに書くだけのコマンド。 */
function recorderScript(target: string): string {
  return `printf '[%s]' "\${NODE_ENV-}" > '${target}'\n`;
}

// ── 繋ぎ目 a1: setup に production が届かない ────────────────────────────────

describe("[inc/2026-08-13/a1] setup は常駐サービスの NODE_ENV を継がない", () => {
  it("**プール→ドライバ→setup** の端まで production が届かない（npm ci が dev を落とさない）", async () => {
    process.env["NODE_ENV"] = "production";

    const seen = path.join(dir, "setup-node-env.txt");
    const prepare = path.join(dir, "prepare.sh");
    fs.writeFileSync(prepare, recorderScript(seen), "utf-8");

    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        '      cmd: "sleep 30"\n' +
        `    setup: "sh ${prepare}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-node-env" });
    try {
      assert.equal(fs.existsSync(seen), true, "setup が走っていない（試験の前提が崩れている）");
      assert.equal(
        fs.readFileSync(seen, "utf-8"),
        "[]",
        "setup に NODE_ENV=production が届いている＝素の npm ci が devDependencies を落とす"
      );
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("検証コマンド（run）にも届かない——setup だけ塞いでも意味が無い", async () => {
    process.env["NODE_ENV"] = "production";

    const seen = path.join(dir, "run-node-env.txt");
    const record = path.join(dir, "record.sh");
    fs.writeFileSync(record, recorderScript(seen), "utf-8");

    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        '      cmd: "sleep 30"\n' +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-node-env-run" });
    try {
      await pool.run(env.envId, `sh ${record}`);
      assert.equal(fs.existsSync(seen), true, "検証コマンドが走っていない");
      assert.equal(fs.readFileSync(seen, "utf-8"), "[]", "検証コマンドに production が届いている");
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("他の環境変数は継ぐ（落とすのは deploy 姿勢だけ・道具の設定まで奪わない）", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["BANTO_ENV_NODE_ENV_PROBE"] = "keep-me";

    const seen = path.join(dir, "other.txt");
    const prepare = path.join(dir, "prepare-other.sh");
    fs.writeFileSync(
      prepare,
      `printf '[%s]' "\${BANTO_ENV_NODE_ENV_PROBE-}" > '${seen}'\n`,
      "utf-8"
    );

    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        '      cmd: "sleep 30"\n' +
        `    setup: "sh ${prepare}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    const env = await pool.provision({ repoPath: repo, profile: "test", taskId: "t-node-env-keep" });
    try {
      assert.equal(fs.readFileSync(seen, "utf-8"), "[keep-me]", "継ぐべきものまで落としている");
    } finally {
      delete process.env["BANTO_ENV_NODE_ENV_PROBE"];
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });
});

// ── 器そのもの ──────────────────────────────────────────────────────────────

describe("[inc/2026-08-13] 子へ渡す環境の組み立て", () => {
  it("落とすのは deploy 姿勢だけ", () => {
    const out = driverSpawnEnv({ NODE_ENV: "production", PATH: "/usr/bin", HOME: "/home/x" });

    assert.equal("NODE_ENV" in out, false, "NODE_ENV を継いでいる");
    assert.equal(out["PATH"], "/usr/bin");
    assert.equal(out["HOME"], "/home/x");
    assert.deepEqual(ENV_NOT_INHERITED_BY_DRIVER, ["NODE_ENV"]);
  });

  it("明示（credentials）は継承より強い——名指しすれば落とした変数も戻せる", () => {
    const out = driverSpawnEnv(
      { NODE_ENV: "production", TOKEN: "inherited" },
      { TOKEN: "from-credentials", NODE_ENV: "production" }
    );

    assert.equal(out["TOKEN"], "from-credentials");
    assert.equal(out["NODE_ENV"], "production", "明示で名指しした値は通す");
  });

  it("値の無い変数は渡さない（undefined を文字列 'undefined' にしない）", () => {
    const out = driverSpawnEnv({ EMPTY: undefined, SET: "1" });

    assert.equal("EMPTY" in out, false);
    assert.equal(out["SET"], "1");
  });

  it("継承元を書き換えない（呼び出し元の process.env を壊さない）", () => {
    const base = { NODE_ENV: "production", A: "1" };
    driverSpawnEnv(base, { B: "2" });

    assert.deepEqual(base, { NODE_ENV: "production", A: "1" });
  });
});

// ── 設定側（機構だけに頼らない）──────────────────────────────────────────────

describe("[inc/2026-08-13/a2] banto 自身のプロファイルは dev 依存を名指しする", () => {
  it("3つのプロファイルの setup がすべて --include=dev を持つ", () => {
    const yaml = fs.readFileSync(
      path.join(process.cwd(), "meta", "environments.yaml"),
      "utf-8"
    );
    const setups = [...yaml.matchAll(/^\s*setup:\s*"(.+)"\s*$/gmu)].map((m) => m[1] as string);

    assert.equal(setups.length, 3, `setup の数が想定と違う: ${JSON.stringify(setups)}`);
    for (const setup of setups) {
      assert.match(setup, /--include=dev/u, `素の npm ci が残っている: ${setup}`);
    }
  });
});
