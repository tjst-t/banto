/**
 * [imp-0028] docker ドライバ — 検証プロファイルのサービスは常駐していること。
 *
 * 入口（test-discipline rule 2）: subprocess。docker ドライバを子プロセスとして
 * 起こし（driver <verb> ＋ stdin JSON）、本物の docker コンテナを観測する。
 *
 * 何を押さえるか（実機・dentaku で踏んだ形）:
 *   `command: ["npm","test"]` のように**走り終えて終了する** compose を検証
 *   プロファイルにすると、
 *     1. provision はコンテナが起きた直後に返る（その瞬間は running なので嘘ではない）
 *     2. 数十秒後にコンテナが終了する
 *     3. 以後の run は `no running containers found` で exit 1
 *   マージ前ゲート（1つの環境で受け入れ基準の本数ぶんコマンドを走らせる）では
 *   「a1 だけ通って a2 以降が全滅」という紛らわしい落ち方になり、
 *   env.verify（立てて1コマンド走らせて畳む）では露見しない。
 *
 * 2段構えで捕まえる:
 *   (1) provision — 起動直後に終わっているものは、その場で断る（常駐が要ると言う）
 *   (2) run / healthcheck — 消えたあとは、終了したサービス名と終了コードを名指しする
 *
 * 本物の docker が要る。無ければ skip ではなく FAIL する（I1、既存の docker 試験と同じ作法）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
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
const FIXTURES = path.join(_repoRoot, "tests", "fixtures", "docker");
const SHORT_LIVED_COMPOSE = path.join(FIXTURES, "short-lived-compose.yaml");
const MIXED_COMPOSE = path.join(FIXTURES, "mixed-lifetime-compose.yaml");
const LONG_LIVED_COMPOSE = path.join(FIXTURES, "test-compose.yaml");
const NODE = process.execPath;

// 所有の記録は**この試験だけの置き場**に隔離する（既定は共有の /tmp の1ファイル）。
// この機械では工場が同じ docker を使っているので、共有の台帳を読み書きすると
// 他人の記録を踏みかねない
const STATE_FILE = fs.mkdtempSync(path.join(os.tmpdir(), "banto-liveness-state-")) + "/owned.json";

// ── Driver invocation helper (mirrors env-docker-run.spec.ts) ─────────────────

function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 60_000
): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(NODE, ["--import", "tsx", DOCKER_DRIVER_PATH, verb], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, BANTO_DOCKER_DRIVER_STATE: STATE_FILE },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function runShell(cmd: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

function assertDockerAvailable(): void {
  const r = runShell("docker", ["compose", "version"]);
  assert.equal(
    r.exitCode,
    0,
    `docker compose is not available on this host — ` +
      `test FAILS as required (I1: no skips). Error: ${r.stderr}`
  );
}

/** compose プロジェクトに属するコンテナ（停止済みを含む）を数える。後始末の確認用。 */
function containerIds(project: string): string[] {
  const r = runShell("docker", [
    "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`,
  ]);
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

// ── (1) provision — 常駐しないサービスはその場で断る ──────────────────────────

describe("[imp-0028] docker provision — 起動直後に終わるサービスは検証プロファイルとして断る", () => {
  const taskId = `task-docker-liveness-short-${Date.now()}`;
  const project = `banto-env-${taskId}`; // projectName() と同じ綴り（docker-driver.ts）

  before(() => {
    assertDockerAvailable();
  });

  after(() => {
    // 断ったあとに残骸が残っていないのがあるべき姿だが、残っていたら試験が掃除する
    const ids = containerIds(project);
    if (ids.length > 0) runShell("docker", ["rm", "-f", ...ids]);
    runShell("docker", ["compose", "-p", project, "-f", SHORT_LIVED_COMPOSE, "down", "-v"]);
  });

  it("command が走り終えて終了する compose では provision が失敗し、原因と直し方を日本語で言う", () => {
    const r = invokeDriver(
      "provision",
      { config: { compose: SHORT_LIVED_COMPOSE }, taskId },
      120_000
    );

    assert.notEqual(
      r.exitCode,
      0,
      `常駐しないサービスの provision は失敗しなければならない ` +
        `（「立った」と返した瞬間からコンテナは消えている）: stdout=${r.stdout}`
    );

    const msg = r.stderr;

    // 何が起きたか — 終了したサービス名と終了コードを名指しする
    assert.match(
      msg,
      /app/,
      `終了したサービス名（app）を名指しすること: ${msg}`
    );
    assert.match(
      msg,
      /exit\s*0/i,
      `終了コードを言うこと: ${msg}`
    );
    // なぜ駄目か — 常駐が要る
    assert.match(msg, /常駐/, `「常駐」が要ると言うこと: ${msg}`);
    // どう直すか — command に書かない／verify に書く
    assert.match(
      msg,
      /command/,
      `compose の command に書くなという指示を含めること: ${msg}`
    );
    assert.match(
      msg,
      /verify/,
      `検証したいコマンドの正しい置き場（env.verify / 受け入れ基準の verify）を示すこと: ${msg}`
    );
  });

  it("断ったときに残骸を残さない（I3: 台帳に載る前なのでここで畳まないと誰も畳めない）", () => {
    assert.deepEqual(
      containerIds(project),
      [],
      "provision を断ったあとに compose プロジェクトのコンテナが残っていてはいけない"
    );
  });
});

// ── (2) 常駐するサービスは従来どおり通る ─────────────────────────────────────

describe("[imp-0028] docker provision — 常駐するサービスは従来どおり通る", () => {
  const taskId = `task-docker-liveness-long-${Date.now()}`;
  let handle: Record<string, unknown> | undefined;

  before(() => {
    assertDockerAvailable();
  });

  after(() => {
    if (handle) invokeDriver("teardown", { handle }, 60_000);
  });

  it("sleep で待つだけの compose は provision が通る（既存プロファイルを壊さない）", () => {
    const r = invokeDriver(
      "provision",
      { config: { compose: LONG_LIVED_COMPOSE }, taskId },
      120_000
    );
    assert.equal(r.exitCode, 0, `常駐する compose の provision は通ること: ${r.stderr}`);

    const out = parseOutput(r.stdout) as { handle?: Record<string, unknown> };
    assert.ok(out.handle, `provision は {handle: {...}} を返すこと: ${r.stdout}`);
    handle = out.handle;
  });
});

// ── (3) 短命な init と常駐サービスが混じっていても落とさない ─────────────────

describe("[imp-0028] docker provision — 短命な init が混じっていても、常駐が1本あれば通る", () => {
  const taskId = `task-docker-liveness-mixed-${Date.now()}`;
  let handle: Record<string, unknown> | undefined;

  before(() => {
    assertDockerAvailable();
  });

  after(() => {
    if (handle) invokeDriver("teardown", { handle }, 60_000);
  });

  it("init が終了していても running が1本あれば provision は通り、終了は注記に残る", () => {
    const r = invokeDriver(
      "provision",
      { config: { compose: MIXED_COMPOSE }, taskId },
      120_000
    );
    assert.equal(
      r.exitCode,
      0,
      `running が1本でもあれば落とさないこと（判定は「全部 running」ではない）: ${r.stderr}`
    );

    const out = parseOutput(r.stdout) as { handle?: Record<string, unknown> };
    assert.ok(out.handle, `provision は {handle: {...}} を返すこと: ${r.stdout}`);
    handle = out.handle;

    // 落とさないが、黙ってもいない（I2: 手掛かりは残す）
    assert.match(
      r.stderr,
      /init/,
      `終了しているサービスは注記に残すこと: ${r.stderr}`
    );
  });
});

// ── (4) 消えたあと — run / healthcheck は理由を名指しする ────────────────────

describe("[imp-0028] docker run/healthcheck — 環境が消えたら終了したサービスと終了コードを名指しする", () => {
  const taskId = `task-docker-liveness-gone-${Date.now()}`;
  let handle: Record<string, unknown> | undefined;

  before(() => {
    assertDockerAvailable();

    const r = invokeDriver(
      "provision",
      { config: { compose: LONG_LIVED_COMPOSE }, taskId },
      120_000
    );
    assert.equal(r.exitCode, 0, `provision failed: ${r.stderr}`);
    handle = (parseOutput(r.stdout) as { handle: Record<string, unknown> }).handle;

    // 外から止める＝「走り終えて終了した」あとと同じ状態を作る。
    // `stop` はコンテナを消さないので、`ps -a` から終了コードが引ける
    const project = handle["project"] as string;
    const composeFile = handle["composeFile"] as string;
    const stopped = runShell("docker", [
      "compose", "-p", project, "-f", composeFile, "stop", "-t", "1",
    ]);
    assert.equal(stopped.exitCode, 0, `docker compose stop failed: ${stopped.stderr}`);
  });

  after(() => {
    if (handle) invokeDriver("teardown", { handle }, 60_000);
  });

  it("run は「終了したサービス名 + 終了コード + 常駐が要る」を言って失敗する", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("run", { handle, cmd: "echo hello" }, 60_000);
    assert.notEqual(r.exitCode, 0, `環境が消えていれば run は失敗すること: ${r.stdout}`);

    const msg = r.stderr;
    assert.match(msg, /app/, `終了したサービス名を名指しすること: ${msg}`);
    assert.match(msg, /exit\s*\d+/i, `終了コードを言うこと: ${msg}`);
    assert.match(msg, /常駐/, `常駐が要ると言うこと: ${msg}`);
    assert.match(msg, /command/, `compose の command を疑えと言うこと: ${msg}`);
  });

  it("healthcheck も ok:false の理由に終了したサービス名と終了コードを載せる", () => {
    assert.ok(handle, "handle must be set");

    const r = invokeDriver("healthcheck", { handle }, 60_000);
    assert.equal(r.exitCode, 0, `healthcheck 自体は 0 で返る（結果は本文）: ${r.stderr}`);

    const out = parseOutput(r.stdout) as { ok?: boolean; detail?: string };
    assert.equal(out.ok, false, `消えた環境は ok:false: ${r.stdout}`);
    const detail = out.detail ?? "";
    assert.match(detail, /app/, `終了したサービス名を名指しすること: ${detail}`);
    assert.match(detail, /exit\s*\d+/i, `終了コードを言うこと: ${detail}`);
    assert.match(detail, /常駐/, `常駐が要ると言うこと: ${detail}`);
  });
});
