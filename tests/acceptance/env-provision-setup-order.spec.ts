/**
 * 立てる順序 — **用意（`setup`）は長命のコマンドを起こす前に済ませる**（task-0089）。
 *
 * **実機で踏んだ壊れ方**（2026-08-10）。PO がブラウザで触れる dev プロファイル
 * （vite dev server を docker で立てる）を作ったら provision が失敗した：
 *
 *   1. `compose up -d` が先に走る → node_modules が空 → `vite: not found` → **exit 127**
 *   2. そのあと `setup`（npm ci）が `compose run --rm` で完走する
 *   3. **落ちたコンテナは戻ってこない**——用意はできたが、環境はもう無い
 *
 * 副次で2つ。healthcheck は落ちる直前の running を掴んで `ok: true` と誤報告し、
 * 済んだ印（`.banto-primed`）の書き込みも環境の中で走っていたので一緒に失敗し、
 * `.catch(() => undefined)` で握りつぶされていた。
 *
 * 待つだけのプロファイル（`sleep infinity`）は起動に何も要らないので、この順序でも
 * 成り立っていた——**dev server 系を初めて作るまで見つからなかった**。だからここでは
 * 「起動に用意が要るプロファイル」を検体として置き、順序そのものを見張る。
 *
 * I1: 直しを戻すと落ちることを確認済み（process 側・docker 側とも）。
 *
 * **ここはホストの docker を要らない分だけ**（driver: process）。docker ドライバ側の
 * 同じ検体は `env-docker-provision-setup-order.spec.ts` に在る——マージ前ゲートの器には
 * socket が無いので、`npm run test:docker` へ寄せてある（`meta/environments.yaml` の
 * `test-docker` プロファイル）。このファイルは器の中でも回るものだけを持つ。
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EnvironmentPool } from "@banto/environment-pool";

const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-setup-order.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

let dir: string;
let dataDir: string;
let repo: string;
const pools: EnvironmentPool[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-setup-order-"));
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

function makePool(options: { cacheRoot?: string } = {}): EnvironmentPool {
  const p = new EnvironmentPool({
    dataDir,
    driverTimeoutMs: 30_000,
    ...(options.cacheRoot ? { cacheRoot: options.cacheRoot } : {}),
  });
  pools.push(p);
  return p;
}

// ── a1: 用意が要る長命のコマンドが、起動直後に即死しない ──────────────────────

describe("[task-0089/a1] 用意は長命のコマンドを起こす前に済む（process）", () => {
  it("**起動に用意の成果が要るコマンドでも立つ**（用意より先に起こさない）", async () => {
    // 「用意が済むまで起動できないコマンド」を、ファイル1つで表す。
    // 直す前は provision が `command failed to start` で落ちた——vite の exit 127 と同じ形
    const deps = path.join(dir, "deps");
    const devServer = path.join(deps, "dev-server");
    const prepare = path.join(dir, "prepare.sh");
    const start = path.join(dir, "start.sh");
    fs.writeFileSync(prepare, `mkdir -p '${deps}'\necho ok > '${devServer}'\n`, "utf-8");
    // 用意ができていなければ即座に落ちる（`vite: not found` に当たる）
    fs.writeFileSync(start, `test -f '${devServer}' || exit 127\nexec sleep 60\n`, "utf-8");

    writeProfiles(
      "profiles:\n" +
        "  dev:\n" +
        "    driver: process\n" +
        "    config:\n" +
        `      cmd: "sh ${start}"\n` +
        `    setup: "sh ${prepare}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    const env = await pool.provision({ repoPath: repo, profile: "dev", taskId: "t-order" });
    try {
      assert.equal(fs.existsSync(devServer), true, "用意が済んでいない");
      // **立った直後の疎通が本当に通ること**。用意より先に起こしていた頃は、
      // ここへ来る前に provision ごと落ちていた
      assert.equal(
        env.healthcheck.ok,
        true,
        `使えると言うなら本当に使えること: ${JSON.stringify(env.healthcheck)}`
      );
      // 少し待っても生きている（起動直後の一瞬だけ running を掴んでいない）
      await new Promise((r) => setTimeout(r, 500));
      const later = await pool.healthcheck(env.envId);
      assert.equal(later.ok, true, `起動直後の一瞬だけ生きているのではない: ${JSON.stringify(later)}`);
    } finally {
      await pool.teardown(env.envId).catch(() => undefined);
    }
  });

  it("用意がこけたら長命のコマンドを起こさずに失敗する（I2・I3）", async () => {
    const prepare = path.join(dir, "prepare-fail.sh");
    const started = path.join(dir, "started.txt");
    fs.writeFileSync(prepare, "exit 3\n", "utf-8");
    const start = path.join(dir, "start.sh");
    fs.writeFileSync(start, `echo started > '${started}'\nexec sleep 60\n`, "utf-8");

    writeProfiles(
      "profiles:\n" +
        "  dev:\n" +
        "    driver: process\n" +
        "    config:\n" +
        `      cmd: "sh ${start}"\n` +
        `    setup: "sh ${prepare}"\n` +
        "    ttl: 5m\n"
    );
    const pool = makePool();

    await assert.rejects(
      () => pool.provision({ repoPath: repo, profile: "dev", taskId: "t-order-fail" }),
      (err: Error) => {
        assert.match(err.message, /setup/, `用意でこけたと分かる言葉であること: ${err.message}`);
        return true;
      }
    );
    assert.equal(
      fs.existsSync(started),
      false,
      "用意がこけたのに長命のコマンドを起こしている（半端な環境が外に残る）"
    );
    assert.equal(pool.list({ taskId: "t-order-fail" }).length, 0, "立てられなかった環境を残さない");
  });
});

// ── a3: 済んだ印の書き込み失敗を握りつぶさない ────────────────────────────────

describe("[task-0089/a3] 済んだ印（.banto-primed）の書き込み失敗を握りつぶさない", () => {
  it("印が書けなかったら provision が失敗し、出来事にも残る（I2）", async () => {
    const cacheRoot = path.join(dir, "cache");
    const setupLog = path.join(dir, "setup.log");
    fs.writeFileSync(path.join(repo, "lockfile"), "v1", "utf-8");
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        '      cmd: "sleep 30"\n' +
        `    setup: "echo ran >> ${setupLog}"\n` +
        "    cache:\n" +
        "      key: [lockfile]\n" +
        "      path: deps\n" +
        "    ttl: 5m\n"
    );
    const pool = makePool({ cacheRoot });

    // 1回目は普通に通る（置き場と印がここで出来る）
    const first = await pool.provision({
      repoPath: repo,
      workdir: repo,
      profile: "test",
      taskId: "t-mark-1",
    });
    await pool.teardown(first.envId);

    const keys = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(keys.length, 1, `置き場が1つ出来ているはず: ${JSON.stringify(keys.map((k) => k.name))}`);
    const keyDir = path.join(cacheRoot, keys[0]!.name);
    assert.equal(
      fs.existsSync(path.join(keyDir, ".banto-primed")),
      true,
      "用意が済んだ印が書かれていない（次の provision が毎回やり直す）"
    );

    // **印だけが書けない**状況を作る。印を消して、その場所を行き止まりの symlink に
    // 差し替える——`markPrimed` は置き場を mkdir してから印を open するので、
    // 置き場そのものは無事なまま**印の書き込みだけ**が ENOENT で落ちる。
    //
    // **権限（`chmod 0o555`）では作れない。** マージ前ゲートの器は root で走るので、
    // 読み取り専用ディレクトリでも root は書けてしまい（CAP_DAC_OVERRIDE）、
    // 「書けなかったら失敗する」が確かめられない——ホストでだけ通る検体になる。
    // 行き止まりの symlink は uid に依らないので、器の中でもホストでも同じに落ちる。
    // （`ensureCacheDir` は `existsSync` ＝ symlink を辿って見るので、行き止まりは
    //   「印が無い」と読まれる。つまり用意は飛ばされず、印を書く所まで進む）
    const marker = path.join(keyDir, ".banto-primed");
    fs.rmSync(marker);
    fs.symlinkSync(path.join(dir, "no-such-dir", "primed"), marker);
    await assert.rejects(
      () =>
        pool.provision({ repoPath: repo, workdir: repo, profile: "test", taskId: "t-mark-2" }),
      (err: Error) => {
        // 直す前は `.catch(() => undefined)` で握りつぶされ、provision は成功して返っていた
        assert.match(
          err.message,
          /印|banto-primed/,
          `印を書けなかったと分かる言葉であること: ${err.message}`
        );
        return true;
      },
      "印が書けなかったことを黙って成功に丸めてはならない（I2）"
    );

    const event = pool.events().find((e) => e.type === "env_cache_marker_failed");
    assert.ok(event, "印を書けなかったことが出来事に残らない（気づく契機が無い）");
    assert.ok(
      String(event!.data["reason"] ?? "").length > 0,
      "理由が残っていない（I2）"
    );
    assert.equal(pool.list({ taskId: "t-mark-2" }).length, 0, "使える状態にできなかった環境を残さない");
  });

  it("印はホスト側に書かれる（環境の生死を借りない）", async () => {
    const cacheRoot = path.join(dir, "cache2");
    fs.writeFileSync(path.join(repo, "lockfile"), "v1", "utf-8");
    writeProfiles(
      "profiles:\n" +
        "  test:\n" +
        "    driver: process\n" +
        "    config:\n" +
        '      cmd: "sleep 30"\n' +
        '    setup: "true"\n' +
        "    cache:\n" +
        "      key: [lockfile]\n" +
        "      path: deps\n" +
        "    ttl: 5m\n"
    );
    const pool = makePool({ cacheRoot });
    const env = await pool.provision({
      repoPath: repo,
      workdir: repo,
      profile: "test",
      taskId: "t-mark-host",
    });
    await pool.teardown(env.envId);

    const keys = fs.readdirSync(cacheRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.equal(keys.length, 1);
    assert.equal(
      fs.existsSync(path.join(cacheRoot, keys[0]!.name, ".banto-primed")),
      true,
      "印は置き場（プールのホスト上のディレクトリ）に在ること"
    );
  });
});
