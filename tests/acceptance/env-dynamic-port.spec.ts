/**
 * 人が触る環境のホスト側ポートは**固定しない**（PO裁定 2026-08-13）。
 *
 * **困っていたこと。** ホスト側の番号を決めていたのはプロファイル（compose ファイル）だけで
 * （`docker/dev.yaml` の `"4201:4200"`）、Environment Pool も exposer もドライバも
 * 空きを取る処理を持っていなかった。同じプロファイルで2つ立てると：
 *
 *   1. 2本目が bind できずに落ちる（docker）
 *   2. 仮に立っても、中継の上流はどちらも同じ番号——**2つの URL が同じ環境を指す**
 *
 * 2 の方が危い。**PO が別のタスクの画面を見て承認できてしまう**からで、これは第1便で
 * 塞いだ事故（変更が映っていない main の画面を承認させる）と同じ種類のものである。
 *
 * 直した形：**Pool が空きを1つ取って `BANTO_ENV_PORT` で渡し、
 * 「実際にどのポートで公開したか」をドライバが申告する**。申告が無ければ今までどおり
 * `config.port` に落ちるので、既存のプロファイルは1つも変わらない。
 *
 * ここでは process ドライバで見る（docker は要らない・本番資源に触らない）。
 * docker 側の「実際の publish 先を引く」経路は `env-docker-published-port.spec.ts`。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  EnvironmentPool,
  createEnvProxyExposer,
} from "@banto/environment-pool";

// imp-0012: テスト用の一時 state に隔離
const TEST_DRIVER_STATE = path.join(
  os.tmpdir(),
  "banto-process-driver-state-acceptance-dynamic-port.json"
);
process.env["BANTO_PROCESS_DRIVER_STATE"] = TEST_DRIVER_STATE;

/**
 * **割り当てられたポートで待つアプリ**を持つプロファイル（＝新しい書き方）。
 *
 * `$BANTO_ENV_PORT` を参照しているので、process ドライバは「割り当てを使った」と分かる。
 * 中身は**自分に割り当てられたポート番号を返すだけ**の HTTP サーバ
 * ——どの環境に届いたかが本文で分かる（取り違えていれば数字が合わない）。
 */
const DYNAMIC_APP =
  "node -e \"require('http')" +
  ".createServer((_q,s)=>s.end(String(process.env.BANTO_ENV_PORT)))" +
  ".listen(process.env.BANTO_ENV_PORT)\"";

const DYNAMIC_PROFILE =
  "profiles:\n" +
  "  dynamic:\n" +
  "    driver: process\n" +
  "    config:\n" +
  `      cmd: ${DYNAMIC_APP}\n` +
  "      port: 4200\n" +
  "    ttl: 1h\n";

/** 従来の書き方（`BANTO_ENV_PORT` を参照しない）。既存のプロファイルの代表。 */
const STATIC_PROFILE = (port: number): string =>
  "profiles:\n" +
  "  fixed:\n" +
  "    driver: process\n" +
  "    config:\n" +
  "      cmd: sleep 120\n" +
  `      port: ${port}\n` +
  "    ttl: 1h\n";

function repoWith(profiles: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-dynport-repo-"));
  fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "meta", "environments.yaml"), profiles, "utf-8");
  return dir;
}

function newPool(): EnvironmentPool {
  return new EnvironmentPool({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "env-dynport-pool-")),
    driverTimeoutMs: 20_000,
    exposers: {
      proxy: createEnvProxyExposer({
        baseUrl: "/api/environment-pool",
        publicBaseUrl: "https://banto.example",
      }),
    },
  });
}

after(() => {
  fs.rmSync(TEST_DRIVER_STATE, { force: true });
});

describe("[PO裁定 2026-08-13] 同じプロファイルを2つ立てても、URL は別々の環境を指す", () => {
  let pool: EnvironmentPool;
  let repoDir: string;
  let a: { envId: string; url?: string; exposedPort?: number };
  let b: { envId: string; url?: string; exposedPort?: number };

  before(async () => {
    pool = newPool();
    repoDir = repoWith(DYNAMIC_PROFILE);
    // **同じプロファイル**を、別のタスクのために2つ。判断待ちが2本並んだ状況そのもの
    a = await pool.provision({
      repoPath: repoDir,
      profile: "dynamic",
      taskId: "task-A",
      projectTag: "p",
      exposeProfilePort: true,
    });
    b = await pool.provision({
      repoPath: repoDir,
      profile: "dynamic",
      taskId: "task-B",
      projectTag: "p",
      exposeProfilePort: true,
    });
  });

  after(async () => {
    for (const env of [a, b]) {
      if (env?.envId) await pool.teardown(env.envId).catch(() => undefined);
    }
    pool.stopMaintenance();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("2本とも立ち、2本とも URL を持つ（2本目が落ちない）", () => {
    assert.ok(a.url, "1本目に触れる場所が無い");
    assert.ok(b.url, "**2本目**に触れる場所が無い——これが直したかったこと");
    assert.equal(pool.list({ projectTag: "p" }).length, 2);
  });

  it("URL が違う（タスクごとに別の入口）", () => {
    assert.notEqual(a.url, b.url);
  });

  /**
   * **これが本題。** URL が違っても上流が同じ番号なら、開いた先は同じ環境になる
   * ——PO が別タスクの画面を見て承認できてしまう。
   */
  it("**上流のポートが違う**（2つの URL が同じ環境を指さない）", () => {
    assert.ok(a.exposedPort, "公開したポートが台帳に無い");
    assert.ok(b.exposedPort, "公開したポートが台帳に無い");
    assert.notEqual(
      a.exposedPort,
      b.exposedPort,
      "2つの環境が同じポートへ中継されている——別タスクの画面を承認できる状態"
    );
  });

  it("プロファイルに書いた番号（コンテナ側 4200）は、そのままホスト側にはならない", () => {
    assert.notEqual(a.exposedPort, 4200);
    assert.notEqual(b.exposedPort, 4200);
  });

  /**
   * 台帳の数字だけでは「別の番号を配った」ことしか言えない。**実際に別の環境へ届くか**を見る。
   * それぞれの環境は自分に割り当てられた番号を返すので、取り違えれば本文で分かる。
   */
  it("実際に届く先も別（それぞれの環境が自分に割り当てられた番号を返す）", async () => {
    // 立ち上がりを待つ（provision の直後だが listen はもう少し後になりうる）
    const read = async (port: number): Promise<string> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          return (await res.text()).trim();
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };
    const textA = await read(a.exposedPort!);
    const textB = await read(b.exposedPort!);
    assert.equal(textA, String(a.exposedPort), "A の入口が A の環境に届いていない");
    assert.equal(textB, String(b.exposedPort), "B の入口が B の環境に届いていない");
    assert.notEqual(textA, textB, "2つの入口が同じ環境に届いている");
  });
});

describe("[PO裁定 2026-08-13] 既存のプロファイルは変わらない（申告が無ければ config.port）", () => {
  it("`BANTO_ENV_PORT` を使わないコマンドは、これまでどおり config.port で公開される", async () => {
    const pool = newPool();
    // 実際に bind はしない（`sleep`）。見たいのは「どの番号で公開したと台帳に載るか」
    const fixedPort = 45999;
    const repoDir = repoWith(STATIC_PROFILE(fixedPort));
    try {
      const env = await pool.provision({
        repoPath: repoDir,
        profile: "fixed",
        taskId: "task-legacy",
        projectTag: "p",
        exposeProfilePort: true,
      });
      assert.equal(
        env.exposedPort,
        fixedPort,
        "申告の無いドライバでプロファイルの番号に落ちていない（既存のプロファイルが壊れる）"
      );
      await pool.teardown(env.envId);
    } finally {
      pool.stopMaintenance();
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("呼び出し側が番号を明示する `expose` は、これまでどおり最優先（既存の口を壊さない）", async () => {
    const pool = newPool();
    const repoDir = repoWith(DYNAMIC_PROFILE);
    try {
      const env = await pool.provision({
        repoPath: repoDir,
        profile: "dynamic",
        taskId: "task-explicit",
        projectTag: "p",
        expose: 46001,
      });
      assert.equal(env.exposedPort, 46001, "明示した番号が無視されている");
      await pool.teardown(env.envId);
    } finally {
      pool.stopMaintenance();
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
