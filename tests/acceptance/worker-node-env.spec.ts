/**
 * 工房の deploy 姿勢を職人へ押し付けない（imp-0043・d）。
 *
 * ## 何を守っているか
 *
 * `banto-worker-pool.service` は `Environment=NODE_ENV=production` で動く。職人は
 * 子プロセスなのでそれを継いでいた。すると職人の手元で `npm install` が
 * 「up to date, audited 1 package」と答えるだけで node_modules が作られない
 * （npm は production では devDependencies を落とす。dentaku の依存は全部そちら）。
 *
 * 職人はこれに詰まり、凌ぎとして作業ツリーの `node_modules` を本体チェックアウトへ
 * symlink した。その symlink が検証環境（docker）を壊し、マージ前ゲートが3タスク連続で
 * 落ちた（task-0020・0021・0023）。**根はこの環境変数**。
 *
 * 環境プール側は同じ穴を先に塞いである（`ENV_NOT_INHERITED_BY_DRIVER` /
 * `driverSpawnEnv`・`env-setup-node-env.spec.ts`）。ここは**工房→職人の経路**の分。
 *
 * I1: 直しを戻すと落ちることを確認済み。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { workerSpawnEnv, ENV_NOT_INHERITED_BY_WORKER } from "@banto/worker-pool";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(_thisDir, "..", "..");

// ── a1: 職人へ渡る env に NODE_ENV が入らない ────────────────────────────────

describe("[imp-0043/a1] 職人へ渡る env に NODE_ENV が含まれない", () => {
  it("**キーごと消える**（空文字ではない。空文字は npm から見て別の意味になりうる）", () => {
    const env = workerSpawnEnv({ NODE_ENV: "production", PATH: "/usr/bin" });

    assert.equal(
      "NODE_ENV" in env,
      false,
      "NODE_ENV はキーごと消えていなければならない（空文字で残すのは不可）"
    );
    assert.equal(env["PATH"], "/usr/bin", "ほかの環境変数はそのまま継ぐ");
  });

  it("落とす対象は NODE_ENV（プールの綴りと同じ形で持つ）", () => {
    assert.deepEqual([...ENV_NOT_INHERITED_BY_WORKER], ["NODE_ENV"]);
  });

  it("明示は継承より強い——`extraEnv` で名指しすれば戻る", () => {
    const env = workerSpawnEnv({ NODE_ENV: "production" }, { NODE_ENV: "test" });
    assert.equal(env["NODE_ENV"], "test");
  });

  it("`extraEnv` は継承の上に重なる", () => {
    const env = workerSpawnEnv({ A: "1", B: "2" }, { B: "3", C: "4" });
    assert.deepEqual(env, { A: "1", B: "3", C: "4" });
  });

  it("値が undefined の環境変数は落ちる（spawn へ渡せる形にする）", () => {
    const env = workerSpawnEnv({ A: "1", B: undefined });
    assert.deepEqual(env, { A: "1" });
  });
});

// ── a2: 合流点はひとつ ────────────────────────────────────────────────────────
//
// 純関数が正しくても、**呼んでいない経路**があれば同じ穴が残る。職人を起こす
// ドライバは2つ（claude-agent と pi）あり、片方だけ直すのがいちばん起きやすい。

describe("[imp-0043/a2] 職人を起こす経路はすべて workerSpawnEnv を通る", () => {
  const drivers = ["claude-agent-driver.ts", "pi-rpc-driver.ts"];

  for (const file of drivers) {
    it(`${file} は spawn の env を workerSpawnEnv で作る`, () => {
      const src = fs.readFileSync(
        path.join(repoRoot, "packages", "banto-worker-pool", "src", file),
        "utf8"
      );

      assert.match(
        src,
        /env:\s*workerSpawnEnv\(process\.env,/,
        `${file} が workerSpawnEnv を通していない`
      );
      assert.equal(
        /env:\s*\{\s*\.\.\.process\.env/.test(src),
        false,
        `${file} に process.env を素通しする spawn が残っている`
      );
    });
  }
});
