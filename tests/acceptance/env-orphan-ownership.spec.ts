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

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
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
  it("**記録が空なら、何も自分のものと言わない**（安全側に倒れる）", () => {
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

  it("記録に在っても実在しなければ挙げない（外で消された分を溜めない）", () => {
    fs.writeFileSync(stateFile, JSON.stringify(["banto-env-task-gone"]), "utf-8");
    const listed = invoke("list", {}) as unknown[];
    assert.equal(listed.length, 0, "実在しないものを孤児として挙げてはいけない");
    // 記録からも落ちていること（溜め続けない）
    const owned = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as string[];
    assert.deepEqual(owned, [], "実在しない記録は落とす");
  });

  it("壊れた記録でも動く。ただし何も自分のものと言わない（I2）", () => {
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
  it("プロジェクト名は banto のものと分かる形（`banto-env-<taskId>`）", async () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/banto-environment-pool/src/docker-driver.ts"),
      "utf-8"
    );
    assert.match(
      src,
      /return `banto-env-\$\{taskId\}`/,
      "名前は二重の守りの片方。`<taskId>-docker` は他人と衝突しうる綴りだった"
    );
  });
});
