/**
 * **リンクされたワークツリーでも、器の中で git が動くこと**（inc-0038・2026-08-15）。
 *
 * マージ前ゲートも監査も、職人が作った**ワークツリー**を検証環境（docker）に見せて
 * 受け入れ条件のコマンドを走らせる。ワークツリーの `.git` はディレクトリではなく
 * `gitdir: <本体>/.git/worktrees/<名前>` と書かれた**ファイル**で、その先はホストの
 * 絶対パス——compose が渡すのが `..:/app` だけだと器の中には存在しない。結果、
 *
 *   fatal: not a git repository   （exit 128）
 *
 * となり、git を呼ぶテスト（`tests/acceptance/source-hygiene.spec.ts` 等）は
 * **ワークツリーでは必ず落ちる**。しかも「git が動いていない」ではなく
 * 「テストが失敗した」という顔で落ちるので、原因に辿り着けない。
 *
 * 直しは**器の側**：共通 git ディレクトリを**ホストと同じ絶対パス**に read-only で
 * 見せる（ドライバが `BANTO_GIT_COMMON_DIR` を渡し、compose がそれを mount する）。
 * テストを器に合わせて弱めない——検証環境はワークツリーを写したものであるべき。
 *
 * **本物の `docker/test.yaml` と `docker/Dockerfile.test` で確かめる**。写しではなく
 * 中身をそのまま持ってくるので、compose から mount 行が消えればここが落ちる。
 * ただし**この repo 自身にワークツリーを生やしはしない**（共有の `.git` を触るのは
 * 副作用が大きい）——tmp に独立したリポジトリを作り、その中でワークツリーを切る。
 *
 * **`workdir` を渡さずに provision する**のも意図的。`env.verify` の `workdir` は任意で、
 * `repoPath` だけで呼ばれることがある。そのとき `run` は基点を持たないので、
 * 共通 git ディレクトリは **provision で決めて handle で持ち回る**必要がある。
 *
 * docker を実際に叩くので `npm run test:docker` 側（`npm test` の除外に載る
 * `env-docker-` 始まりの名前）。docker が無ければ skip せず**落ちる**（I1）。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, "..", "..");
const DOCKER_DRIVER_PATH = path.join(
  repoRoot,
  "packages",
  "banto-environment-pool",
  "src",
  "docker-driver.ts"
);
const NODE = process.execPath;

function invokeDriver(
  verb: string,
  input: Record<string, unknown>,
  timeoutMs = 180_000
): { exitCode: number; stdout: string; stderr: string } {
  const r = childProcess.spawnSync(NODE, ["--import", "tsx", DOCKER_DRIVER_PATH, verb], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  return {
    exitCode: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

function git(cwd: string, args: string[]): void {
  const r = childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_NAME: "banto", GIT_AUTHOR_EMAIL: "banto@example.invalid",
           GIT_COMMITTER_NAME: "banto", GIT_COMMITTER_EMAIL: "banto@example.invalid" },
  });
  assert.equal(r.status, 0, `git ${args.join(" ")} が失敗しました: ${r.stderr}`);
}

describe("[inc-0038] 検証環境の器は、リンクされたワークツリーでも git が動く", () => {
  const stamp = `${Date.now()}`;
  const envId = `gitwt${stamp}`;
  let tmpRoot: string;
  let worktree: string;
  let handle: Record<string, unknown> | undefined;

  before(() => {
    // docker が無ければ skip せず落ちる（I1）
    const dv = childProcess.spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
    assert.equal(dv.status, 0, `docker compose が使えません（I1: skip しない）: ${dv.stderr}`);

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "banto-gitwt-"));
    const main = path.join(tmpRoot, "main");
    worktree = path.join(tmpRoot, "wt");

    // 本物の compose / Dockerfile をそのまま持ってくる（写しを書かない）
    fs.mkdirSync(path.join(main, "docker"), { recursive: true });
    for (const f of ["test.yaml", "Dockerfile.test"]) {
      fs.copyFileSync(path.join(repoRoot, "docker", f), path.join(main, "docker", f));
    }
    fs.writeFileSync(path.join(main, "tracked.txt"), "検証環境から見えるべきファイル\n");

    git(main, ["init", "-q", "-b", "main"]);
    git(main, ["add", "-A"]);
    git(main, ["commit", "-q", "-m", "fixture"]);
    git(main, ["worktree", "add", "-q", "-b", "wt", worktree]);

    // 前提の確認：ワークツリーの `.git` は**ファイル**（ここが崩れると試験の意味が無い）
    assert.ok(
      fs.statSync(path.join(worktree, ".git")).isFile(),
      "ワークツリーの .git がファイルでない＝この試験が狙っている形になっていない"
    );

    // **`workdir` は渡さない**（`repoPath` だけ）。上の説明のとおり、これが狙い
    const r = invokeDriver(
      "provision",
      {
        config: { compose: path.join(worktree, "docker", "test.yaml") },
        taskId: `task-${envId}`,
        envId,
        repoPath: worktree,
      },
      600_000
    );
    assert.equal(r.exitCode, 0, `provision が失敗しました (exit ${r.exitCode}): ${r.stderr}`);
    handle = (JSON.parse(r.stdout.trim()) as { handle: Record<string, unknown> }).handle;
  });

  after(() => {
    if (handle) invokeDriver("teardown", { handle }, 120_000);
    if (!tmpRoot) return;
    // **消すのも docker に頼む**。docker は bind mount の載り先（`/app/node_modules` や
    // `/app/packages/<pkg>/node_modules`、置き場の小部屋）がホスト側に無ければ
    // **root で作る**ので、こちらの権限では消せないものが混じる。compose が何を載せるかを
    // ここに書き写して先回りで作るより、丸ごと docker に消させるほうが写しが増えない
    childProcess.spawnSync(
      "docker",
      ["run", "--rm", "--security-opt", "apparmor=unconfined", "-v", `${tmpRoot}:/x`,
       "busybox:latest", "sh", "-c", "rm -rf /x/main /x/wt"],
      { encoding: "utf8", timeout: 60_000 }
    );
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("器の中の `git ls-files` が exit 0 で、追跡しているファイルを返す", () => {
    assert.ok(handle, "handle が無い（provision が通っていない）");
    const r = invokeDriver("run", { handle, cmd: "git ls-files" }, 120_000);
    assert.equal(r.exitCode, 0, `driver run 自体が失敗しました: ${r.stderr}`);

    const out = JSON.parse(r.stdout.trim()) as { exit: number; log_path: string };
    const log = fs.readFileSync(out.log_path, "utf-8");
    assert.equal(
      out.exit,
      0,
      `器の中で git ls-files が exit ${out.exit}。共通 git ディレクトリが同じ絶対パスに ` +
        `見えていない可能性がある（docker/test.yaml の BANTO_GIT_COMMON_DIR の mount と、` +
        `docker-driver の provision がそれを渡しているかを見よ）:\n${log}`
    );
    assert.match(log, /tracked\.txt/, `git ls-files の出力に追跡ファイルが無い:\n${log}`);
  });

  it("器の中の `git rev-parse --git-common-dir` が、ホスト側と同じ絶対パスを指す", () => {
    assert.ok(handle, "handle が無い（provision が通っていない）");
    const r = invokeDriver(
      "run",
      { handle, cmd: "git rev-parse --path-format=absolute --git-common-dir" },
      120_000
    );
    assert.equal(r.exitCode, 0, `driver run 自体が失敗しました: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim()) as { exit: number; log_path: string };
    const log = fs.readFileSync(out.log_path, "utf-8");
    assert.equal(out.exit, 0, `器の中で git rev-parse が exit ${out.exit}:\n${log}`);
    // **同じ絶対パスに置く**のが直しの要点。器の中の答えがホストの綴りと一致すること
    assert.ok(
      log.includes(path.join(tmpRoot, "main", ".git")),
      `器の中の共通 git ディレクトリがホスト側と食い違う（期待 ${path.join(tmpRoot, "main", ".git")}）:\n${log}`
    );
  });
});
