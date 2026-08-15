/**
 * docker ドライバは、**実際に publish されたホスト側のポートを申告する**
 * （番頭判断 2026-08-13）。
 *
 * これが無かったころ、ホスト側の番号を決めていたのは compose ファイルだけだった
 * （`docker/dev.yaml` の `"4201:4200"`）。同じプロファイルで2つ立てると2本目が bind
 * できずに落ち、しかも中継の上流は同じ番号なので**2つの URL が同じ環境を指した**。
 *
 * 直した形：compose のホスト側を書かず（`- "4200"`）docker に空きを選ばせ、
 * ドライバが `docker compose ps --format json` で実際の publish 先を引いて返す。
 * プールはその番号で中継する（返らなければ従来どおり `config.port`）。
 *
 * **docker が要る**ので `npm test` からは外れる（`npm run test:docker` で走る）。
 * 使うのは busybox と自前の compose プロジェクト（`banto-env-<taskId>`）だけで、
 * 稼働中の環境やポートには触らない。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const DOCKER_DRIVER_PATH = path.join(
  _repoRoot,
  "packages",
  "banto-environment-pool",
  "src",
  "docker-driver.ts"
);
const COMPOSE_FIXTURE = path.join(
  _repoRoot,
  "tests",
  "fixtures",
  "docker",
  "published-port-compose.yaml"
);
const NODE = process.execPath;

/** コンテナ側のポート（fixture の `ports: - "4200"` と揃える）。 */
const CONTAINER_PORT = 4200;

const TASK_A = "dynport-a";
const TASK_B = "dynport-b";

function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 120_000
): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(NODE, ["--import", "tsx", DOCKER_DRIVER_PATH, verb], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function provision(taskId: string): { publishedPort?: number; handle: Record<string, unknown> } {
  const r = invokeDriver("provision", {
    config: { compose: COMPOSE_FIXTURE, port: CONTAINER_PORT },
    taskId,
    // imp-0033: compose プロジェクト名は envId で決まる。ここでは taskId と同じ値を渡して
    // 従来と同じ綴り（`banto-env-<TASK_A>`）にし、この試験が見たいものだけを見る
    envId: taskId,
  });
  assert.equal(r.exitCode, 0, `provision が失敗: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
    publishedPort?: number;
    handle: Record<string, unknown>;
  };
  return out;
}

function teardown(taskId: string): void {
  invokeDriver("teardown", {
    handle: { project: `banto-env-${taskId}`, name: `banto-env-${taskId}`, taskId },
  });
}

after(() => {
  // I3: 作った者が片付ける。失敗しても他方を試みる
  for (const taskId of [TASK_A, TASK_B]) {
    try {
      teardown(taskId);
    } catch {
      // 既に畳んであれば成功（冪等）
    }
  }
});

describe("[番頭判断 2026-08-13] docker は実際の publish 先を申告する", () => {
  it("ホスト側を固定しない compose で立てると、割り当てられた番号が返る", () => {
    const out = provision(TASK_A);
    assert.ok(out.publishedPort, "publishedPort が返っていない（プールは config.port に落ちる）");
    assert.notEqual(
      out.publishedPort,
      CONTAINER_PORT,
      "コンテナ側の番号がそのままホスト側になっている（固定 publish のまま）"
    );

    // **申告した番号が実物と一致すること**——docker に直接聞いて突き合わせる
    const asked = childProcess.spawnSync(
      "docker",
      ["compose", "-p", `banto-env-${TASK_A}`, "-f", COMPOSE_FIXTURE, "port", "app", String(CONTAINER_PORT)],
      { encoding: "utf-8", timeout: 30_000 }
    );
    assert.equal(asked.status, 0, `docker compose port が失敗: ${asked.stderr}`);
    const actual = Number((asked.stdout ?? "").trim().split(":").pop());
    assert.equal(out.publishedPort, actual, "申告した番号が実際の publish 先と違う");
  });

  it("同じ compose で2つ立てても、2本目が立ち、別の番号になる", () => {
    const b = provision(TASK_B);
    assert.ok(b.publishedPort, "2本目に publishedPort が無い");
    // 1本目は前の it で立っている（after で両方畳む）
    const a = provision(TASK_A); // 冪等：同じ project なので立ち上げ直しても同じ番号
    assert.notEqual(
      a.publishedPort,
      b.publishedPort,
      "2つの環境が同じホスト側ポートを使っている——中継すると同じ画面が出る"
    );
  });
});
