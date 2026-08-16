/**
 * **資源の名前は環境ごと。健康状態は実物を叩いて答える**（imp-0033・2026-08-15）。
 *
 * ## 何が起きたか（電卓の幹・PO が2度踏んだ）
 *
 * docker ドライバの compose プロジェクト名は `banto-env-<taskId>` だった。taskId は
 * 環境の識別子ではない——同じタスクに環境はいくつも立つ。実際に立った：
 *
 *   1. `review.policy: po` のタスクがレビュー待ちになると、**Kobo が自動で dev 環境を立てる**。
 *      番頭はそれを知らずにレビュー用にもう1つ立てた → プロジェクトが同じなので、
 *      あとから来た `compose up` が前のコンテナを作り直し、**先に立てた env の公開ポートが
 *      実体を失った**。PO はリンクを開いて 502 を踏んだ
 *   2. プロファイルも名前に入っていなかったので、衝突は**プロファイルをまたいでも**起きた。
 *      dev 環境が立っている最中に同じ taskId で `env.verify`（test プロファイル）を回すと、
 *      使い捨て側の後始末の `compose down` が **dev のレビュー環境のコンテナごと消した**
 *
 * さらに悪いのは、どちらの場合も `env.healthcheck` が **「使えます」と答え続けた**こと。
 * ドライバは `docker compose ps` を見ており、プロジェクトは共有されていたので、
 * 実体を奪われた側も**作り直された新しいコンテナ**を見て `ok: true` を返していた。
 * **「使えます」と答えた環境が 502 を返す**——I1 に真っ向から反する。
 *
 * ## ここで見張るもの
 *
 *   (a) 同じ taskId・同じプロファイルで2つ立てても、**先に立てた側が壊れない**
 *   (b) 実体が消えた env の healthcheck が **「使えます」と答えない**
 *   (c) dev 環境を立てたまま同じ taskId で `env.verify` を回しても、**dev 側が生き残る**
 *       （＝使い捨て側の `compose down` の効き先が、自分の env に閉じている）
 *
 * いずれも**実物で見る**：docker に直接聞いてコンテナの在処を確かめ、公開ポートは
 * 実際に叩く。機構の自己申告（`ok: true`）だけを根拠にしない。
 *
 * **ホストの docker が要る**ので `npm test` からは外れる（`npm run test:docker`）。
 * ファイル名の `env-docker-` が除外に効き、package.json の `test:docker` への列挙で実際に回る
 * ——2つを足して初めて回る（`env-docker-provision-setup-order.spec.ts` の注記と同じ）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  EnvironmentPool,
  createEnvProxyExposer,
  probeExposedPort,
} from "@banto/environment-pool";
import { createComposeCleanup } from "../helpers/compose-cleanup.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
/** 中で本当に listen している compose（公開ポートを叩く試験に要る）。 */
const EXPOSED_COMPOSE = path.resolve(_thisDir, "../fixtures/docker/exposed-app-compose.yaml");
/** 使い捨ての検証環境の検体（待つだけ）。`env.verify` はこちらで回す。 */
const WAITING_COMPOSE = path.resolve(_thisDir, "../fixtures/docker/test-compose.yaml");

/** コンテナ側のポート（fixture の `- "4200"` と揃える）。 */
const CONTAINER_PORT = 4200;

/**
 * **同じ taskId** を全部の試験で使う。事故の形がそれだから
 * （Kobo が自動で立てた dev と、番頭が立てたレビュー用と、ゲートの verify）。
 */
const TASK_ID = "task-imp0033";

let dir: string;
let repo: string;
let pool: EnvironmentPool;
/**
 * 片付ける先（I3: 作った者が片付ける）。**立てたら即座にここへ控える**——
 * 控えは名前だけなので、途中で落ちても `after` が畳める（inc-0083・task-0214）。
 */
const cleanup = createComposeCleanup();

function projectOf(envId: string): string {
  // docker ドライバの命名規則（`docker-driver.ts` の `projectName`）。
  // **この綴りそのものが試験の対象**——envId が入っていれば環境ごとに別物になる
  return `banto-env-${envId}`;
}

function containersOf(project: string): string[] {
  const r = childProcess.spawnSync(
    "docker",
    ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Names}}"],
    { encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(r.status, 0, `docker ps が失敗: ${r.stderr}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/** docker ドライバを直に起こす（移行の試験でだけ使う）。 */
function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  stateFile: string
): { exitCode: number; stdout: string; stderr: string } {
  const driverPath = path.resolve(
    _thisDir,
    "../../packages/banto-environment-pool/src/docker-driver.ts"
  );
  const r = childProcess.spawnSync(process.execPath, ["--import", "tsx", driverPath, verb], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, BANTO_DOCKER_DRIVER_STATE: stateFile },
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function requireDockerCompose(): void {
  // I1: docker が使えないなら skip せずに落とす（器の中で回っていれば、ここで気づける）
  const v = childProcess.spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(v.status, 0, "docker compose が使えない（I1: skip しない）");
}

before(() => {
  requireDockerCompose();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-project-per-env-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "meta", "environments.yaml"),
    "profiles:\n" +
      // レビュー用（人が触る＝公開する）
      "  dev:\n" +
      "    driver: docker\n" +
      "    config:\n" +
      `      compose: ${EXPOSED_COMPOSE}\n` +
      `      port: ${CONTAINER_PORT}\n` +
      "    ttl: 10m\n" +
      // 使い捨ての検証用（別プロファイル・同じ taskId で回る）
      "  test:\n" +
      "    driver: docker\n" +
      "    config:\n" +
      `      compose: ${WAITING_COMPOSE}\n` +
      "    ttl: 10m\n",
    "utf-8"
  );
  pool = new EnvironmentPool({
    dataDir: path.join(dir, "data"),
    driverTimeoutMs: 120_000,
    // caddy は要らない（公開の記録が付けば、叩く先はホスト側のポート）
    exposers: {
      proxy: createEnvProxyExposer({
        baseUrl: "/api/environment-pool",
        publicBaseUrl: "https://banto.example",
      }),
    },
  });
});

after(async () => {
  try {
    pool?.stopMaintenance();
    // 台帳に生きたまま残っているものも控えに足す（`pool.verify` のように
    // envId を試験が握っていない経路の畳み損ねを、ここで拾う）
    for (const env of pool?.list() ?? []) {
      cleanup.trackEnv(env.envId, () => pool.teardown(env.envId));
    }
    // 1件が投げても残りは畳む。畳み損ねたらここで落ちる（I2: 残骸を黙って通さない）
    await cleanup.teardownAll();
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function provisionDev(): Promise<{ envId: string; exposedPort?: number; ok: boolean; detail?: string }> {
  const env = await pool.provision({
    repoPath: repo,
    profile: "dev",
    taskId: TASK_ID,
    projectTag: "imp0033",
    exposeProfilePort: true,
  });
  // 立った直後に控える（畳むのは `after`。本文の最後の行に置かない）
  cleanup.track(projectOf(env.envId), () => pool.teardown(env.envId));
  return {
    envId: env.envId,
    ...(env.exposedPort !== undefined ? { exposedPort: env.exposedPort } : {}),
    ok: env.healthcheck.ok,
    ...(env.healthcheck.detail !== undefined ? { detail: env.healthcheck.detail } : {}),
  };
}

// ── (a) 同じ taskId・同じプロファイルで2つ立てても、先に立てた側が壊れない ──────

describe("[imp-0033/a] 同じ taskId で2つ立てても、先に立てた環境が壊れない", () => {
  it("2つ目を立てても、1つ目のコンテナと公開ポートはそのまま生きている", async () => {
    const first = await provisionDev();
    assert.ok(first.exposedPort, "1つ目が公開されていない（この試験の前提が崩れている）");
    assert.equal(first.ok, true, `1つ目が立った時点で使えない: ${first.detail ?? ""}`);

    // 立った直後の実体を控えておく（あとで「同じものが居るか」を見る）
    const firstContainers = containersOf(projectOf(first.envId));
    assert.equal(firstContainers.length, 1, `1つ目のコンテナが1つでない: ${firstContainers.join(",")}`);

    // **同じ taskId・同じプロファイルでもう1つ**。事故のときと同じ頼み方
    const second = await provisionDev();
    assert.notEqual(second.envId, first.envId, "envId が同じ（台帳の主キーが衝突している）");

    // 名前が環境ごとに分かれていること——**実物で見る**。
    // 分かれていなければ、2つ目のコンテナが1つ目のコンテナ「である」
    assert.notEqual(
      projectOf(second.envId),
      projectOf(first.envId),
      "2つの環境が同じ compose プロジェクトを共有している（imp-0033 の根）"
    );
    const secondContainers = containersOf(projectOf(second.envId));
    assert.equal(secondContainers.length, 1, `2つ目のコンテナが1つでない: ${secondContainers.join(",")}`);
    assert.notDeepEqual(
      secondContainers,
      firstContainers,
      "2つの環境が同じコンテナを指している（作り直されている）"
    );

    // **1つ目が壊れていないこと**。まず実体、次に口、最後に機構の答え
    assert.deepEqual(
      containersOf(projectOf(first.envId)),
      firstContainers,
      "1つ目のコンテナが作り直された（先に立てた環境が実体を失っている）"
    );
    const probe = await probeExposedPort(first.exposedPort);
    assert.equal(probe.ok, true, `1つ目の公開ポートが応答しない: ${probe.detail}`);
    const health = await pool.healthcheck(first.envId);
    assert.equal(health.ok, true, `1つ目が使えなくなっている: ${health.detail ?? ""}`);

    // 2つ目もむろん使える（片方を守るために片方を壊す、では意味がない）
    assert.equal(second.ok, true, `2つ目が使えない: ${second.detail ?? ""}`);
  });
});

// ── 移行：旧い綴りで立っている環境を、行方不明にしない ─────────────────────────

describe("[imp-0033/移行] 旧名（banto-env-task-*）の環境は、そのまま操作でき、照合にも出る", () => {
  it("handle に保存された旧い project 名で healthcheck も teardown も通り、list にも出る", () => {
    /**
     * **稼働中の環境は旧名のプロジェクトを持っている。** 綴りを変えたときに壊してはいけない
     * のはここ——新しい綴りで探しに行けば、生きている環境が行方不明になる（畳めもしない＝
     * 金がかかり続ける）。ドライバに直に `banto-env-task-…` を作らせて、**直す前の機構が
     * 残していったのと同じ状態**（handle と所有の記録）から続けられるかを見る。
     *
     * 名前は実在の taskId と衝突しないものを選ぶ（試験が本物の環境を畳まないため）。
     */
    const legacyId = "task-legacy-imp0033";
    const legacyProject = `banto-env-${legacyId}`;
    const stateFile = path.join(dir, "legacy-driver-state.json");

    // **立てる前に控える**。provision が途中でこけて実体だけ残る形も、
    // 下の assert が落ちて finally に届かない形も、これで `after` が拾う
    cleanup.track(legacyProject);

    const prov = invokeDriver(
      "provision",
      { config: { compose: WAITING_COMPOSE }, taskId: legacyId, envId: legacyId },
      stateFile
    );

    let handle: Record<string, unknown> | undefined;

    try {
      assert.equal(prov.exitCode, 0, `旧名での provision が失敗: ${prov.stderr}`);
      handle = (JSON.parse(prov.stdout.trim().split("\n").pop() ?? "{}") as {
        handle: Record<string, unknown>;
      }).handle;
      assert.equal(handle["project"], legacyProject, "この試験が旧い綴りを作れていない（前提が崩れている）");

      // ① handle に入っている名前で操作できる（新しい綴りで探しに行っていない）
      const health = invokeDriver("healthcheck", { handle }, stateFile);
      assert.equal(health.exitCode, 0, `旧名の healthcheck が失敗: ${health.stderr}`);
      assert.equal(
        (JSON.parse(health.stdout.trim()) as { ok?: boolean }).ok,
        true,
        `旧名の環境が使えないと言われた: ${health.stdout}`
      );

      // ② 照合の材料（list）に出る。ここが落ちると、旧名のコンテナは誰にも回収されない
      const list = invokeDriver("list", {}, stateFile);
      assert.equal(list.exitCode, 0, `list が失敗: ${list.stderr}`);
      const names = (JSON.parse(list.stdout.trim()) as Array<{ name?: string }>).map((i) => i.name);
      assert.ok(
        names.includes(legacyProject),
        `旧い綴りが list に出ない（孤児として回収されなくなる）: ${JSON.stringify(names)}`
      );
      assert.ok(
        legacyProject.startsWith("banto-env-") && projectOf("env-x").startsWith("banto-env-"),
        "新旧どちらの綴りも banto-env- で始まること（接頭辞での照合が両方を拾える）"
      );
    } finally {
      // ③ 旧名のまま畳める（I3: 作った者が片付ける）。
      //    handle を握れていなければ機構の口は試せない——控えてあるので `after` が畳む
      if (handle) {
        const down = invokeDriver("teardown", { handle }, stateFile);
        assert.equal(down.exitCode, 0, `旧名の teardown が失敗: ${down.stderr}`);
        assert.deepEqual(containersOf(legacyProject), [], "畳んだのにコンテナが残っている");
      }
    }
  });
});

// ── (b) 実体が消えた env の healthcheck が「使えます」と答えない ────────────────

describe("[imp-0033/b] 実体を失った環境は「使えます」と答えない", () => {
  it("コンテナが作り直されて公開ポートが死んだら、healthcheck は ok を返さない", async () => {
    const env = await provisionDev();
    assert.ok(env.exposedPort, "公開されていない（この試験の前提が崩れている）");
    assert.equal(env.ok, true, `立った時点で使えない: ${env.detail ?? ""}`);

    const project = projectOf(env.envId);
    // 直に `compose up` する先も控える（provisionDev の控えと同じ名前だが、
    // 「この試験が立てたもの」を読み手にも番人にも見えるようにしておく）
    cleanup.track(project);
    const before = containersOf(project);

    /**
     * **事故の再現。** 何かが同じプロジェクトへ `compose up` した状態を作る
     * （実際にやったのは「同じ taskId の2つ目の provision」だった）。コンテナは
     * 作り直され、publish は**新しい番号へ移る**——台帳が案内している番号は死ぬ。
     *
     * ここは docker を直接叩く。プールの経路は (a) で塞いだので、そこからは作れない
     * ——だが**塞いだ経路以外でも起きうる**ことを見張るのがこの試験の役目
     * （人が `docker rm` した・ホストが再起動した、も同じ形になる）。
     */
    const recreate = childProcess.spawnSync(
      "docker",
      ["compose", "-p", project, "-f", EXPOSED_COMPOSE, "up", "-d", "--force-recreate"],
      { encoding: "utf8", timeout: 120_000 }
    );
    assert.equal(recreate.status, 0, `作り直しが失敗: ${recreate.stderr}`);

    const after = containersOf(project);
    assert.equal(after.length, 1, `作り直し後のコンテナが1つでない: ${after.join(",")}`);
    // **ドライバから見える景色**：コンテナは動いている。`docker compose ps` しか見ない
    // healthcheck は、ここで「使えます」と答えていた（それが嘘だった）
    const ps = childProcess.spawnSync(
      "docker",
      ["compose", "-p", project, "-f", EXPOSED_COMPOSE, "ps", "--format", "{{.State}}"],
      { encoding: "utf8", timeout: 30_000 }
    );
    assert.equal(ps.status, 0, `docker compose ps が失敗: ${ps.stderr}`);
    assert.match(
      ps.stdout.trim(),
      /running/,
      "作り直したのにコンテナが running でない（この試験の前提が崩れている）"
    );

    // 台帳が案内している番号は、もう実体を持たない
    const probe = await probeExposedPort(env.exposedPort);
    assert.equal(
      probe.ok,
      false,
      `公開ポート ${env.exposedPort} がまだ応答している（作り直しが効いていない・前提が崩れている）: ${probe.detail}`
    );

    // **ここが本題**：機構は「使えます」と答えてはならない
    const health = await pool.healthcheck(env.envId);
    assert.equal(
      health.ok,
      false,
      "実体を失った環境に ok: true を返した（「使えます」と答えた URL が 502 になる）"
    );
    // 何を見てそう言ったのかが人に届くこと（I1: 理由の無い ok:false で終わらせない）
    assert.match(
      health.detail ?? "",
      new RegExp(String(env.exposedPort)),
      `どのポートを叩いて駄目だったのかが detail に無い: ${health.detail ?? "(空)"}`
    );
  });
});

// ── (c) dev を立てたまま、同じ taskId で verify を回しても dev が生き残る ────────

describe("[imp-0033/c] 使い捨ての検証が、レビュー環境を巻き込んで畳まない", () => {
  it("dev 環境を立てたまま同じ taskId で env.verify を回しても、dev 側が生きている", async () => {
    const dev = await provisionDev();
    assert.ok(dev.exposedPort, "公開されていない（この試験の前提が崩れている）");
    const devContainers = containersOf(projectOf(dev.envId));
    assert.equal(devContainers.length, 1, `dev のコンテナが1つでない: ${devContainers.join(",")}`);

    // **同じ taskId で、別プロファイルの使い捨て**。最後に自分を畳む（`compose down`）
    const verify = await pool.verify({
      repoPath: repo,
      profile: "test",
      taskId: TASK_ID,
      projectTag: "imp0033",
      cmd: "echo verified",
      timeoutMs: 60_000,
    });
    // 使い捨て側は自分で畳む建前だが、**畳み損ねたときの受け皿**を控えておく
    cleanup.trackEnv(verify.envId);
    assert.equal(verify.exit, 0, `検証コマンドが失敗した: ${verify.logTail ?? ""}`);
    assert.equal(verify.tornDown, true, `使い捨て側が畳まれていない: ${verify.teardownError ?? ""}`);

    // **dev 側が巻き込まれていないこと**——畳む前と同じコンテナが、同じまま居る
    assert.deepEqual(
      containersOf(projectOf(dev.envId)),
      devContainers,
      "verify の後始末が dev のレビュー環境のコンテナを消した（imp-0033 の2つ目の症状）"
    );
    const probe = await probeExposedPort(dev.exposedPort);
    assert.equal(probe.ok, true, `dev の公開ポートが応答しない: ${probe.detail}`);
    const health = await pool.healthcheck(dev.envId);
    assert.equal(health.ok, true, `dev が使えなくなっている: ${health.detail ?? ""}`);
  });
});
