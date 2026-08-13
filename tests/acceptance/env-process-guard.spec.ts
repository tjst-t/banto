/**
 * `driver: process` の見張り — 稼働中の作業ツリーを壊させない（2026-08-13 の事故・A と B）。
 *
 * ## 何が起きたか
 *
 * `test-docker` プロファイルは `driver: process`（器を作らずホストでそのまま走る）＋
 * `setup: npm ci`、対象は稼働中の本体ツリー。常駐サービスの NODE_ENV=production を継いだ
 * `npm ci` が devDependencies を落とし、**tsx / typescript が消えた**——検証が回らない・
 * 新しい職人が起こせない・再起動すると起動不能が同時に起きた。
 *
 * NODE_ENV の持ち込みは別途塞いだ（`env-setup-node-env.spec.ts`）。ここで押さえるのは
 * **その先**——`npm ci` は `--include=dev` を付けても node_modules を消してから入れ直すので、
 * 稼働中のツリーで打てば入れ直しの最中に道具が消える窓が必ず開く。
 *
 * ## 弾き方は「積」
 *
 * **守られた場所 ∧ 破壊的なコマンド**のときだけ弾く（A）。守られた場所で走る無害な setup は
 * 通す——判定を取り違えて健全な検証まで止めるのが一番まずい。弾かなかった破壊的な setup は
 * 記録だけ残す（B）。逃げ道を使って通した回こそ、後から犯人が要る。
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
  PROTECTED_PATHS_ENV,
  destructiveSetupName,
  protectedRootFor,
  protectedRoots,
  refuseDestructiveSetup,
  renderProtectedRefusal,
} from "@banto/environment-pool";

const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-guard.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
let guarded: string;
let savedProtected: string | undefined;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-guard-"));
  dataDir = path.join(dir, "data");
  repo = path.join(dir, "repo");
  // 「稼働中の作業ツリー」に当たる場所。実物（本体ツリー）は試験では使わない
  guarded = path.join(dir, "live-tree");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
  fs.mkdirSync(path.join(guarded, "packages"), { recursive: true });
  savedProtected = process.env[PROTECTED_PATHS_ENV];
  process.env[PROTECTED_PATHS_ENV] = guarded;
});

afterEach(() => {
  for (const p of pools.splice(0)) p.stopMaintenance();
  if (savedProtected === undefined) delete process.env[PROTECTED_PATHS_ENV];
  else process.env[PROTECTED_PATHS_ENV] = savedProtected;
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

/** `setup` と `workdir` だけを変えたプロファイルを1つ書く。 */
function profileWith(setup: string): void {
  writeProfiles(
    "profiles:\n" +
      "  test:\n" +
      "    driver: process\n" +
      "    config:\n" +
      '      cmd: "sleep 30"\n' +
      `    setup: "${setup}"\n` +
      "    ttl: 5m\n"
  );
}

// ── A: 守られた場所では破壊的な setup を弾く ────────────────────────────────

describe("[inc/2026-08-13/A] 稼働中の作業ツリーに破壊的な setup を打たせない", () => {
  it("**守られた場所 ＋ npm ci は弾く**（事故の形そのもの）", async () => {
    // 打たれたら分かるようにしておく（弾いたのに走っていた、を見逃さない）
    const ran = path.join(dir, "ran.txt");
    profileWith(`npm ci > ${ran} 2>&1 || true`);
    const pool = makePool();

    await assert.rejects(
      () =>
        pool.provision({
          repoPath: repo,
          profile: "test",
          taskId: "t-guard-block",
          workdir: guarded,
        }),
      (err: Error) => {
        assert.match(err.message, /npm ci/u, `引っかかった語が読めない: ${err.message}`);
        return true;
      }
    );
    assert.equal(fs.existsSync(ran), false, "弾いたのに setup が走っている");
    assert.equal(pool.list({ taskId: "t-guard-block" }).length, 0, "立てられなかった環境を残さない");
  });

  it("守られた場所の**配下**でも弾く（一段下なら安全、ではない）", async () => {
    profileWith("npm ci");
    const pool = makePool();

    await assert.rejects(() =>
      pool.provision({
        repoPath: repo,
        profile: "test",
        taskId: "t-guard-sub",
        workdir: path.join(guarded, "packages"),
      })
    );
  });

  it("**無関係な場所は素通り**（守りが健全な検証を止めない）", async () => {
    const elsewhere = path.join(dir, "worktree");
    fs.mkdirSync(elsewhere, { recursive: true });
    const ran = path.join(dir, "ran-elsewhere.txt");
    profileWith(`echo npm ci > ${ran}`);
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: "t-guard-elsewhere",
      workdir: elsewhere,
    });
    try {
      assert.equal(fs.existsSync(ran), true, "守りと無関係な場所まで止めている");
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("守られた場所でも**無害な setup は通す**（弾くのは積のときだけ）", async () => {
    const ran = path.join(dir, "harmless.txt");
    profileWith(`echo prepared > ${ran}`);
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: "t-guard-harmless",
      workdir: guarded,
    });
    try {
      assert.equal(fs.readFileSync(ran, "utf-8").trim(), "prepared", "無害な setup を止めている");
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("**逃げ道を明示すれば通る**（守りを空にする）", async () => {
    process.env[PROTECTED_PATHS_ENV] = "";
    const ran = path.join(dir, "escaped.txt");
    profileWith(`echo 'npm ci' > ${ran}`);
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: "t-guard-escape",
      workdir: guarded,
    });
    try {
      assert.equal(fs.existsSync(ran), true, "明示の逃げ道が効いていない");
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("断り文には「何が危ないか・なぜ弾いたか・どう通すか」が揃う（I2）", () => {
    const text = renderProtectedRefusal({
      target: "/srv/live",
      root: "/srv/live",
      destructive: "npm ci",
    });

    assert.match(text, /\/srv\/live/u, "どこの話か");
    assert.match(text, /npm ci/u, "何が引っかかったか");
    assert.match(text, /なぜ弾いたか/u);
    assert.match(text, /通すには/u, "次の一手が無ければ人は止まる");
    assert.match(text, /worktree/u, "別の場所で回す道");
    assert.match(text, /npm install --include=dev/u, "破壊的でない代案");
    assert.match(text, new RegExp(PROTECTED_PATHS_ENV, "u"), "承知のうえで通す道");
  });
});

// ── 見張りの器（純関数）──────────────────────────────────────────────────────

describe("[inc/2026-08-13/A] 危ういかどうかの見分け", () => {
  it("破壊的と見なすのは npm ci / rm -r / git clean", () => {
    assert.equal(destructiveSetupName("npm ci --include=dev"), "npm ci");
    assert.equal(destructiveSetupName("rm -rf node_modules && npm i"), "rm -r");
    assert.equal(destructiveSetupName("rm -fr build"), "rm -r");
    assert.equal(destructiveSetupName("git clean -xdf"), "git clean");
  });

  it("普段の用意は破壊的ではない（広く採って健全な検証を止めない）", () => {
    assert.equal(destructiveSetupName("npm install --include=dev"), undefined);
    assert.equal(destructiveSetupName("npm run build"), undefined);
    assert.equal(destructiveSetupName("echo ready"), undefined);
    assert.equal(destructiveSetupName(undefined), undefined);
    assert.equal(destructiveSetupName(""), undefined);
  });

  it("守る場所は環境変数が全て。無ければ既定はドライバの cwd", () => {
    assert.deepEqual(protectedRoots({ [PROTECTED_PATHS_ENV]: "" }, "/srv/live"), []);
    assert.deepEqual(protectedRoots({ [PROTECTED_PATHS_ENV]: "/a:/b" }, "/srv/live"), ["/a", "/b"]);
    assert.deepEqual(protectedRoots({}, "/srv/live"), ["/srv/live"]);
  });

  it("**`/` は既定に採らない**（全部を守る＝全部を止める）", () => {
    assert.deepEqual(protectedRoots({}, "/"), []);
  });

  it("配下は当たり、隣は当たらない（名前の前方一致で取り違えない）", () => {
    const roots = ["/srv/live"];
    assert.equal(protectedRootFor("/srv/live", roots), "/srv/live");
    assert.equal(protectedRootFor("/srv/live/packages/x", roots), "/srv/live");
    assert.equal(protectedRootFor("/srv/live-2", roots), undefined);
    assert.equal(protectedRootFor("/srv/other", roots), undefined);
  });

  it("弾くのは積のときだけ（片方だけでは弾かない）", () => {
    const env = { [PROTECTED_PATHS_ENV]: "/srv/live" };
    const cwd = "/srv/live";

    assert.ok(refuseDestructiveSetup({ target: "/srv/live", setup: "npm ci", env, cwd }));
    assert.equal(
      refuseDestructiveSetup({ target: "/srv/live", setup: "npm install", env, cwd }),
      undefined,
      "守られた場所でも無害なら通す"
    );
    assert.equal(
      refuseDestructiveSetup({ target: "/tmp/wt", setup: "npm ci", env, cwd }),
      undefined,
      "破壊的でも守りの外なら通す"
    );
  });
});

// ── B: 弾かなかった破壊的な setup を記録に残す ──────────────────────────────

describe("[inc/2026-08-13/B] 破壊的な setup は出来事ログに残る", () => {
  it("**通った回**が記録される（逃げ道を使ったときこそ後から犯人が要る）", async () => {
    process.env[PROTECTED_PATHS_ENV] = "";
    const elsewhere = path.join(dir, "worktree");
    fs.mkdirSync(elsewhere, { recursive: true });
    // **本物の `npm ci` は打たない**（試験が実物を壊しに行く形にしない）。
    // 見張りが見るのは setup の字面なので、同じ語を含む無害なコマンドで足りる
    profileWith("echo 'npm ci --include=dev'");
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: "t-guard-record",
      workdir: elsewhere,
    });
    try {
      const events = pool.events().filter((e) => e.type === "env_destructive_setup");
      assert.equal(events.length, 1, "記録が残っていない（次も人手で犯人を探すことになる）");
      const event = events[0]!;
      assert.equal(event.profile, "test", "どのプロファイルが打ったか");
      assert.equal(event.data["command"], "npm ci");
      assert.equal(event.data["driver"], "process");
      assert.equal(event.data["workdir"], elsewhere, "どこで打ったか");
      assert.equal(event.data["taskId"], "t-guard-record");
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("弾かれた回も記録される（断られたことが後から見える）", async () => {
    profileWith("npm ci");
    const pool = makePool();

    await assert.rejects(() =>
      pool.provision({ repoPath: repo, profile: "test", taskId: "t-guard-rec-block", workdir: guarded })
    );

    const events = pool.events().filter((e) => e.type === "env_destructive_setup");
    assert.equal(events.length, 1, "断った回の記録が無い");
    assert.equal(events[0]?.data["workdir"], guarded);
  });

  it("無害な setup では記録しない（ログを意味の無い行で埋めない）", async () => {
    const quiet = path.join(dir, "quiet");
    fs.mkdirSync(quiet, { recursive: true });
    profileWith("echo ready");
    const pool = makePool();

    const env = await pool.provision({
      repoPath: repo,
      profile: "test",
      taskId: "t-guard-quiet",
      workdir: quiet,
    });
    try {
      assert.equal(pool.events().filter((e) => e.type === "env_destructive_setup").length, 0);
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });
});
