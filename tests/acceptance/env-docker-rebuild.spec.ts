/**
 * **Dockerfile を直したら、次に立てたとき効く**（inc-0037・task-0084）。
 *
 * task-0075 で「道具立ての契約は Dockerfile」と決めた——ホストに何が入っているかに
 * 検証結果を左右させないための場所。だが docker ドライバは `docker compose up -d` を
 * `--build` なしで呼んでいたので、**compose は「イメージが既に在れば作らない」**。
 * つまり契約は**最初にビルドした時点で凍り**、Dockerfile を直しても永久に効かない。
 *
 * **しかも黙って効かない。** 実測：loamium の Dockerfile を Debian ＋ Chromium に
 * 書き換えてマージ前ゲートを回したが、使われたのは 675MB の古いイメージ
 * （新しいものは 2.33GB）で、PDF のテスト7件は落ちたまま——「直したのに何も変わらない」
 * という、いちばん気づきにくい形。
 *
 * ここでは**同じプロジェクト名で Dockerfile を書き換えて立て直し**、
 * 中身が入れ替わっていることを見る。直しを戻すと落ちる。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import { createComposeCleanup } from "../helpers/compose-cleanup.js";

const _thisDir = path.dirname(fileURLToPath(import.meta.url));
const DOCKER_DRIVER = path.resolve(
  _thisDir,
  "../../packages/banto-environment-pool/src/docker-driver.ts"
);
const NODE = process.execPath;

let dir: string;
const taskId = `task-rebuild-${Date.now()}`;
let handle: Record<string, unknown> | undefined;

/**
 * 立てた compose プロジェクトの控え（inc-0083・task-0214）。
 * ここの取り残しは実測で3件あった（`/tmp/banto-rebuild-*` 由来）——
 * `handle` を握れたときだけ畳んでいたので、**provision がこけた分が丸ごと残っていた**。
 * プロジェクト名は taskId から先に決まるので、**立てる前に控えられる**。
 */
const cleanup = createComposeCleanup();

function invoke(
  verb: string,
  input: Record<string, unknown>,
  outerMs = 300_000
): { exitCode: number; stdout: string; stderr: string } {
  const r = childProcess.spawnSync(NODE, ["--import", "tsx", DOCKER_DRIVER, verb], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: outerMs,
    env: { ...process.env },
  });
  return { exitCode: r.status ?? -1, stdout: (r.stdout as string) ?? "", stderr: (r.stderr as string) ?? "" };
}

/** その中身の Dockerfile でイメージを作る compose を書く。 */
function writeFixture(marker: string): void {
  fs.writeFileSync(
    path.join(dir, "Dockerfile"),
    ["FROM busybox:latest", `RUN echo ${marker} > /marker.txt`].join("\n"),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(dir, "compose.yaml"),
    [
      "services:",
      "  app:",
      "    build:",
      "      context: .",
      "      dockerfile: Dockerfile",
      "    security_opt:",
      "      - apparmor=unconfined",
      '    command: ["sh", "-c", "while true; do sleep 1; done"]',
    ].join("\n"),
    "utf-8"
  );
}

before(() => {
  const v = childProcess.spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(v.status, 0, "docker compose が使えない（I1: skip しない）");
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-rebuild-"));
});

after(async () => {
  try {
    await cleanup.teardownAll();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("[task-0084] Dockerfile を直したら、立て直したとき効く", () => {
  it("**書き換えた Dockerfile の中身で立ち直る**（古いイメージを使い回さない）", () => {
    // **立てる前に控える**（畳むのは after）。ここが handle 頼みだったせいで
    // `banto-env-task-rebuild-*` が3件残っていた（inc-0083）
    cleanup.trackEnv(taskId, () => {
      if (handle) invoke("teardown", { handle, timeoutMs: 120_000 }, 130_000);
    });

    // 1回目：marker=OLD で立てる
    writeFixture("OLD");
    const first = invoke(
      "provision",
      { config: { compose: path.join(dir, "compose.yaml") }, taskId, envId: taskId, workdir: dir, timeoutMs: 280_000 }
    );
    assert.equal(first.exitCode, 0, `1回目の provision が失敗: ${first.stderr}`);
    handle = (JSON.parse(first.stdout.trim()) as { handle: Record<string, unknown> }).handle;

    const readOld = invoke("run", { handle, cmd: "cat /marker.txt", timeoutMs: 120_000 }, 130_000);
    assert.equal(readOld.exitCode, 0, readOld.stderr);
    const oldOut = JSON.parse(readOld.stdout.trim()) as { exit: number; log_path: string };
    assert.equal(oldOut.exit, 0);
    assert.match(fs.readFileSync(oldOut.log_path, "utf-8"), /OLD/, "1回目の中身が入っていない（前提が崩れている）");

    // 畳んでから、Dockerfile を書き換えて**同じ taskId で**立て直す
    invoke("teardown", { handle, timeoutMs: 120_000 }, 130_000);
    writeFixture("NEW");

    const second = invoke(
      "provision",
      { config: { compose: path.join(dir, "compose.yaml") }, taskId, envId: taskId, workdir: dir, timeoutMs: 280_000 }
    );
    assert.equal(second.exitCode, 0, `2回目の provision が失敗: ${second.stderr}`);
    handle = (JSON.parse(second.stdout.trim()) as { handle: Record<string, unknown> }).handle;

    const readNew = invoke("run", { handle, cmd: "cat /marker.txt", timeoutMs: 120_000 }, 130_000);
    assert.equal(readNew.exitCode, 0, readNew.stderr);
    const newOut = JSON.parse(readNew.stdout.trim()) as { exit: number; log_path: string };
    const body = fs.readFileSync(newOut.log_path, "utf-8");

    // **ここが本体**。`--build` が無いと compose は既存イメージを使い回すので OLD のまま
    assert.match(
      body,
      /NEW/,
      "Dockerfile を直したのに古いイメージが使われている——" +
        "「道具立ての契約は Dockerfile」が、最初にビルドした時点で凍っている（inc-0037）"
    );
    assert.doesNotMatch(body, /OLD/, "古い中身が残っている");
  });
});

describe("[task-0084] worktree の中でも git が動く（inc-0038）", () => {
  let repoDir: string;
  let wtDir: string;
  let wtHandle: Record<string, unknown> | undefined;
  /** この describe が立てるぶんの控え（上の describe とは別勘定）。 */
  const wtCleanup = createComposeCleanup();

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "banto-wt-repo-"));
    const g = (...a: string[]): void => {
      childProcess.execFileSync("git", a, { cwd: repoDir, stdio: "pipe" });
    };
    g("init", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repoDir, "kept.txt"), "x\n");
    g("add", "-A");
    g("commit", "-m", "init");
    // **worktree を作る**。ここが本題——ゲートは常に worktree で検証を回す
    wtDir = path.join(os.tmpdir(), `banto-wt-${Date.now()}`);
    g("worktree", "add", "-b", "task/x", wtDir);

    // worktree の中に compose を置く（bind mount されるのは worktree）
    fs.writeFileSync(
      path.join(wtDir, "compose.yaml"),
      [
        "services:",
        "  app:",
        "    image: alpine:latest",
        "    security_opt:",
        "      - apparmor=unconfined",
        "    working_dir: /app",
        "    volumes:",
        "      - .:/app",
        '    command: ["sh", "-c", "while true; do sleep 1; done"]',
      ].join("\n"),
      "utf-8"
    );
  });

  after(async () => {
    // コンテナを先に畳んでから、bind mount 元のディレクトリを消す
    try {
      await wtCleanup.teardownAll();
    } finally {
      fs.rmSync(wtDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("**worktree でも `git check-ignore` が git として答える**（128 で落ちない）", () => {
    const wtTaskId = `task-wt-${Date.now()}`;
    // 立てる前に控える（provision がこけて実体だけ残る形も拾う）
    wtCleanup.trackEnv(wtTaskId, () => {
      if (wtHandle) invoke("teardown", { handle: wtHandle, timeoutMs: 120_000 }, 130_000);
    });

    const prov = invoke(
      "provision",
      { config: { compose: path.join(wtDir, "compose.yaml") }, taskId: wtTaskId, envId: wtTaskId, workdir: wtDir, timeoutMs: 280_000 }
    );
    assert.equal(prov.exitCode, 0, `provision が失敗: ${prov.stderr}`);
    wtHandle = (JSON.parse(prov.stdout.trim()) as { handle: Record<string, unknown> }).handle;

    // alpine には git を入れて、無視される／されないを両方見る
    const r = invoke(
      "run",
      {
        handle: wtHandle,
        cmd:
          "apk add --no-cache git >/dev/null 2>&1; " +
          "git config --global --add safe.directory '*'; " +
          "git check-ignore ignored.txt >/dev/null; echo ignored=$?; " +
          "git check-ignore kept.txt >/dev/null; echo kept=$?",
        timeoutMs: 240_000,
      },
      250_000
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim()) as { exit: number; log_path: string };
    const body = fs.readFileSync(out.log_path, "utf-8");

    // **128 は git のエラー**（＝git が動いていない）。0/1 は git の答え
    assert.match(
      body,
      /ignored=0/,
      "worktree の中で git が動いていない——`.git` が指す先がコンテナから見えていない（inc-0038）"
    );
    assert.match(body, /kept=1/, "無視されないファイルが 1 で返っていない");
    assert.doesNotMatch(body, /=128/, "git がエラーで落ちている（テストの失敗に化ける形）");
  });
});
