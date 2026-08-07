/**
 * ドライバは呼び出し側の持ち時間を守る（task-0079 / inc-0034）。
 *
 * **元の壊れ方**：同梱の docker ドライバは、内側の `docker compose` 呼び出しに自前の
 * 120 秒を掛けていた（`runCmd` の既定値）。Pool が `resolveRunTimeout` で既定10分・
 * 上限60分を決めても、内側の2分が先に効く。実測：
 *
 *   env.run(cmd="sleep 200", timeoutMs=1_500_000) → **121 秒で exit 255**
 *
 * `docker` は SIGTERM を捕まえて 255 で終わるので、**時間切れが時間切れに見えない**。
 * ゲートは「検証コマンドが 255 で落ちた」と読み、task-0071 の「時間切れなら延ばして
 * 再試行」（exit 124 を見ている）は一度も発火しなかった。loamium の `npm test` は
 * ホストで4分なので、**マージ前ゲートを永久に通れなかった**。
 *
 * ここで見張るのは3つ：
 *   1. 予算がドライバまで届くこと（`runDriverVerb` が input に載せる）
 *   2. 時間切れが 124 で返ること（ゲートが見ている値と一致すること）
 *   3. 予算どおりに切れること（120 秒より短い予算が実際に効く）
 *
 * **どれも直しを戻すと落ちる**ことを確認済み（空振り検体を3度出した反省・task-0074）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  DRIVER_TIMEOUT_EXIT,
  REPORT_MARGIN_MS,
  innerBudgetMs,
} from "../../packages/banto-environment-pool/src/driver-budget.js";
import { runDriverVerb } from "../../packages/banto-environment-pool/src/env-driver-runner.js";
import { VERIFY_TIMEOUT_EXIT } from "../../packages/banto-daemon/src/merge-gate.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_thisDir, "..", "..");
const POOL_SRC = path.join(_repoRoot, "packages", "banto-environment-pool", "src");
const DOCKER_DRIVER_PATH = path.join(POOL_SRC, "docker-driver.ts");
const PROCESS_DRIVER_PATH = path.join(POOL_SRC, "process-driver.ts");
const COMPOSE_FIXTURE = path.join(_repoRoot, "tests", "fixtures", "docker", "test-compose.yaml");
const NODE = process.execPath;

function invokeDriver(
  driverPath: string,
  verb: string,
  input: Record<string, unknown>,
  outerTimeoutMs: number
): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(NODE, ["--import", "tsx", driverPath, verb], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: outerTimeoutMs,
    env: { ...process.env },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function runShell(cmd: string, args: string[]): { exitCode: number; stdout: string } {
  const r = childProcess.spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
  return { exitCode: r.status ?? -1, stdout: (r.stdout as string) ?? "" };
}

// ── 1. 予算がドライバまで届くか ────────────────────────────────────────────────

describe("ドライバの持ち時間：呼び出し側の予算が届く（inc-0034）", () => {
  let tmpDir: string;
  let echoDriver: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-budget-"));
    // 受け取った input をそのまま返すだけの偽ドライバ。
    // **ドライバの中身ではなく「Pool が何を渡すか」を見たい**ので、本物は使わない
    echoDriver = path.join(tmpDir, "echo-driver.mjs");
    fs.writeFileSync(
      echoDriver,
      [
        "#!/usr/bin/env node",
        "import * as fs from 'node:fs';",
        "const raw = fs.readFileSync(0, 'utf8');",
        "process.stdout.write(JSON.stringify({ received: JSON.parse(raw || '{}') }) + '\\n');",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(echoDriver, 0o755);
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runDriverVerb は呼び出し側の持ち時間を input.timeoutMs として渡す", async () => {
    const viaDriver = await runDriverVerb(
      echoDriver,
      "run",
      { handle: { x: 1 }, cmd: "true" },
      600_000
    );
    assert.equal(viaDriver.ok, true, `ドライバ呼び出しが失敗した: ${JSON.stringify(viaDriver)}`);
    const received = (viaDriver as { ok: true; output: { received: Record<string, unknown> } })
      .output.received;

    // **ここが本体**。直す前は input に timeoutMs が載っていなかったので、
    // ドライバは自前の既定（docker なら 120 秒）に落ちるしかなかった
    assert.equal(
      received["timeoutMs"],
      600_000,
      "呼び出し側の持ち時間が input.timeoutMs としてドライバへ渡らなければならない " +
        `（渡ってきたもの: ${JSON.stringify(received)}）`
    );
  });

  it("呼び出し側が自分で timeoutMs を入れていたらそちらを尊重する", async () => {
    const viaDriver = await runDriverVerb(
      echoDriver,
      "run",
      { handle: { x: 1 }, cmd: "true", timeoutMs: 1234 },
      600_000
    );
    assert.equal(viaDriver.ok, true);
    const received = (viaDriver as { ok: true; output: { received: Record<string, unknown> } })
      .output.received;
    assert.equal(received["timeoutMs"], 1234);
  });
});

// ── 2. 時間切れの終了コードが、ゲートが見ている値と一致するか ──────────────────

describe("ドライバの持ち時間：時間切れの終了コード", () => {
  it("DRIVER_TIMEOUT_EXIT はマージ前ゲートの VERIFY_TIMEOUT_EXIT と一致する", () => {
    // 一致していないと、task-0071 の「時間切れなら延ばして再試行」が黙って効かなくなる。
    // 散文の約束ではなく機械で見張る（片方だけ動かせない）
    assert.equal(
      DRIVER_TIMEOUT_EXIT,
      VERIFY_TIMEOUT_EXIT,
      "ドライバが返す時間切れコードと、ゲートが時間切れとみなすコードは同じでなければならない"
    );
  });

  it("innerBudgetMs は報告のための取り分を残す", () => {
    assert.equal(innerBudgetMs({ timeoutMs: 600_000 }), 600_000 - REPORT_MARGIN_MS);
    // 予算が無い／読めないときは縛らない（外側の subprocess timeout が governs）。
    // **ここを短い既定にしたのが元の壊れ方**なので、undefined であることを見る
    assert.equal(innerBudgetMs({}), undefined);
    assert.equal(innerBudgetMs({ timeoutMs: "なにか" }), undefined);
    // 取り分すら取れない短い予算も縛らない
    assert.equal(innerBudgetMs({ timeoutMs: REPORT_MARGIN_MS }), undefined);
  });
});

// ── 3. process ドライバ：予算どおりに切れて 124 を返すか ───────────────────────

describe("process ドライバの run は予算で切って 124 を返す", () => {
  it("予算より長いコマンドは、予算のところで切られ exit 124 になる", () => {
    // 内側の予算 = 12_000 - REPORT_MARGIN_MS(10_000) = 2 秒。コマンドは 30 秒眠る。
    // **直す前は run に制限が無かった**ので、30 秒走り切って exit 0 で返っていた
    const stateFile = path.join(
      os.tmpdir(),
      `banto-proc-driver-state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
    );
    const env = { ...process.env, BANTO_PROCESS_DRIVER_STATE: stateFile };

    // provision（すぐ返る長命プロセス）
    const prov = childProcess.spawnSync(
      NODE,
      ["--import", "tsx", PROCESS_DRIVER_PATH, "provision"],
      {
        input: JSON.stringify({ config: { cmd: "sleep 600" }, taskId: `task-budget-${Date.now()}` }),
        encoding: "utf8",
        timeout: 60_000,
        env,
      }
    );
    assert.equal(prov.status, 0, `provision が失敗した: ${prov.stderr as string}`);
    const handle = (JSON.parse((prov.stdout as string).trim()) as { handle: Record<string, unknown> })
      .handle;

    try {
      const started = Date.now();
      const r = childProcess.spawnSync(
        NODE,
        ["--import", "tsx", PROCESS_DRIVER_PATH, "run"],
        {
          input: JSON.stringify({ handle, cmd: "sleep 30", timeoutMs: 12_000 }),
          encoding: "utf8",
          // 外側は十分長く取る——内側が切ることを見たいので、外側に殺されては意味が無い
          timeout: 120_000,
          env,
        }
      );
      const elapsed = Date.now() - started;
      assert.equal(r.status, 0, `run 自体は正常終了するはず: ${r.stderr as string}`);
      const out = JSON.parse((r.stdout as string).trim()) as { exit: number; log_path: string };

      assert.equal(
        out.exit,
        DRIVER_TIMEOUT_EXIT,
        `予算で切られたら ${DRIVER_TIMEOUT_EXIT}（時間切れ）を返さなければならない。返ってきた: ${out.exit}`
      );
      // 実際に切れていること（30 秒走り切っていないこと）。
      // 終了コードだけ見ていると「たまたま 124 だった」を見逃す
      assert.ok(
        elapsed < 25_000,
        `2 秒の予算で切れていない（${elapsed}ms かかった）。30 秒走り切ったなら切れていない`
      );
    } finally {
      childProcess.spawnSync(NODE, ["--import", "tsx", PROCESS_DRIVER_PATH, "teardown"], {
        input: JSON.stringify({ handle }),
        encoding: "utf8",
        timeout: 30_000,
        env,
      });
      fs.rmSync(stateFile, { force: true });
    }
  });
});

// ── 4. docker ドライバ：120 秒より短い予算が効き、one-off を残さないか ─────────

describe("docker ドライバの run は予算で切り、one-off を残さない", () => {
  const taskId = `task-budget-docker-${Date.now()}`;
  let handle: Record<string, unknown> | undefined;

  before(() => {
    const v = runShell("docker", ["compose", "version"]);
    assert.equal(v.exitCode, 0, "docker compose が使えない（I1: skip しない）");

    const r = invokeDriver(
      DOCKER_DRIVER_PATH,
      "provision",
      { config: { compose: COMPOSE_FIXTURE }, taskId, timeoutMs: 180_000 },
      190_000
    );
    assert.equal(r.exitCode, 0, `provision が失敗した: ${r.stderr}`);
    handle = (JSON.parse(r.stdout.trim()) as { handle: Record<string, unknown> }).handle;
  });

  after(() => {
    if (handle) {
      invokeDriver(DOCKER_DRIVER_PATH, "teardown", { handle, timeoutMs: 60_000 }, 70_000);
    }
  });

  it("予算 25 秒で 90 秒のコマンドは切られ、exit 124 が返る（自前の 120 秒ではない）", () => {
    assert.ok(handle, "provision が先に通っていること");

    // 内側の予算 = 25_000 - 10_000 = 15 秒。コマンドは 90 秒眠る。
    // **直す前は内側が常に 120 秒**だったので 90 秒走り切り、exit 0 で返っていた
    const started = Date.now();
    const r = invokeDriver(
      DOCKER_DRIVER_PATH,
      "run",
      { handle, cmd: "sleep 90", timeoutMs: 25_000 },
      150_000
    );
    const elapsed = Date.now() - started;

    assert.equal(r.exitCode, 0, `run 自体は正常終了するはず: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim()) as { exit: number; log_path: string };

    assert.equal(
      out.exit,
      DRIVER_TIMEOUT_EXIT,
      `予算で切られたら ${DRIVER_TIMEOUT_EXIT} を返さなければならない。返ってきた: ${out.exit}` +
        "（255 なら docker の SIGTERM 終了がそのまま漏れている＝直っていない）"
    );
    assert.ok(
      elapsed < 60_000,
      `15 秒の予算で切れていない（${elapsed}ms）。90 秒走り切ったなら効いていない`
    );

    // **同じ it の中で続けて見る。** 別の it に分けると、時間切れが起きなかったとき
    // （＝直しが効いていないとき）に「残っていない」が素通りしてしまう——
    // 前提が崩れたまま通る検体になる（task-0074 で3度出した空振りと同じ形）
    const project = (handle as { project: string }).project;

    // 時間切れで殺されたクライアントは `--rm` を実行できない。ドライバが片付けたか
    const oneoff = runShell("docker", [
      "ps", "-aq",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", "label=com.docker.compose.oneoff=True",
    ]);
    assert.equal(
      oneoff.stdout.trim(),
      "",
      "時間切れで殺されたクライアントは --rm を実行できないので、ドライバが片付けなければならない" +
        `（残っている: ${oneoff.stdout.trim()}）`
    );

    // **本体は生きていること**。プロジェクト名だけで消すと本体まで巻き込み、
    // 延長して再試行しても「no running containers」で落ちる
    const alive = runShell("docker", [
      "ps", "-q",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", "label=com.docker.compose.oneoff=False",
    ]);
    assert.notEqual(
      alive.stdout.trim(),
      "",
      "one-off の掃除で環境本体まで消してはならない（消すと再試行が成り立たない）"
    );
  });
});
