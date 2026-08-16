/**
 * 検証を立てる前に、ワークツリー直下に残った node_modules の symlink を外す（task-0240）。
 *
 * ## 何が起きたか（2026-08-16 の実測）
 *
 * task-0222・task-0230 は3回落ちたうち2回が同じ形だった。中身は無罪。
 *
 * 職人が「袋の中で試験を回すため」に作業ツリー直下の `node_modules` を本体チェックアウト
 * （`/home/ubuntu/ghq/github.com/tjst-t/banto/node_modules`）への symlink にしていて、
 * 報告後もそれが消されずに残っていた。docker はワークツリーを bind mount で見せるだけ
 * なので、コンテナの中からはホストのその絶対パス（symlink の指し先）を指せない。
 * `@banto/*`（npm workspaces のリンク）が1つも解決できず、対象の spec だけでなく
 * `pi-harness.spec.ts` など無関係な既存 spec も含めて48件が
 * `Cannot find package '@banto/core'`（`ERR_MODULE_NOT_FOUND`）で落ちた。
 *
 * 番頭がリンクを外しただけで通ることも実測済み（env.verify: 外す前 exit 1 → 外した後 exit 0）。
 *
 * ## 直し方とここでの確かめ方
 *
 * 直しは `docker-driver.ts` の `stripWorktreeNodeModulesSymlink`——compose を読む前
 * （`assertVolumeTargetsAreNotSymlinks` の直前）に、基点直下の `node_modules` が
 * symlink なら `fs.unlinkSync` でリンクだけを外す。
 *
 * **本物の docker を立てずに確かめる。** `docker` という名前の偽の実行ファイルを PATH の
 * 先頭に挿して `docker compose` の呼び出しを差し替える——実際のコンテナは一切作らない。
 * `config --format json` には空の compose 解決を返し、`up -d --build` はわざと exit 1 に
 * して以降（`docker compose ps` を要る liveness 確認）へ進ませない。symlink を外す処理は
 * `up` より前で完結するので、これで fs 上の効果とログだけを見れば足りる。
 *
 * I1: 直しを戻す（`stripWorktreeNodeModulesSymlink` の呼び出しを消す）と a1 が落ちることを
 * 確認済み。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
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
const NODE = process.execPath;

let dir: string;
let repo: string;
let composeFile: string;
let binDir: string;
let fakeDockerLog: string;
let setupMarker: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-worktree-node-modules-symlink-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo, { recursive: true });

  // resolveServiceName はファイルを正規表現で読むだけ（docker を起こさない）ので、
  // 「services:\n  <name>:」の形にしておけば setup（a5）でも docker には訊きに行かない。
  composeFile = path.join(repo, "test-compose.yaml");
  fs.writeFileSync(
    composeFile,
    "services:\n  app:\n    image: busybox:latest\n    volumes:\n      - .:/app\n",
    "utf-8"
  );

  // **本物の docker は使わない**——PATH の先頭に挿す偽の `docker`。
  // compose のサブコマンドだけを見て、実行したことをログへ積む。
  binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fakeDockerLog = path.join(dir, "fake-docker.log");
  setupMarker = path.join(dir, "setup-ran.marker");
  const fakeDocker = path.join(binDir, "docker");
  fs.writeFileSync(
    fakeDocker,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${fakeDockerLog}"`,
      "case \"$*\" in",
      // symlink の確認（assertVolumeTargetsAreNotSymlinks）が読む compose の解決。
      // volumes を空にして返す＝そのチェックは何もしない（このテストの対象ではない）。
      "  *'config --format json'*) echo '{\"services\":{}}'; exit 0 ;;",
      // setup の前のビルド（runSetupBeforeUp）。
      "  *' build'*) exit 0 ;;",
      // setup 本体（compose run --rm ... sh -c <setup>）。実際には走らせず、
      // 「呼ばれたこと」だけを marker に残す——飛ばされていないことを見たいだけなので足りる。
      `  *'run --rm'*) echo ran >> "${setupMarker}"; exit 0 ;;`,
      // **わざと失敗させる**。symlink を外す処理は up より前で完結しているので、
      // これで docker compose ps（liveness 確認）まで進ませずに済む。
      "  *'up -d --build'*) exit 1 ;;",
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    "utf-8"
  );
  fs.chmodSync(fakeDocker, 0o755);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function runProvision(input: Record<string, unknown>): { exitCode: number; stdout: string; stderr: string } {
  const r = childProcess.spawnSync(NODE, ["--import", "tsx", DOCKER_DRIVER_PATH, "provision"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env["PATH"] ?? ""}` },
  });
  return {
    exitCode: r.status ?? -1,
    stdout: (r.stdout as string) ?? "",
    stderr: (r.stderr as string) ?? "",
  };
}

function baseInput(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    envId: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    taskId: `t-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    config: { compose: composeFile },
    workdir: repo,
    repoPath: repo,
    ...extra,
  };
}

// ── a1・a2・a3: symlink は外す。実体もリンク先も触らない ────────────────────────

describe("[task-0240/a1,a2,a3] 立てる前に node_modules の symlink だけを外す", () => {
  it("a1: 基点直下の node_modules が symlink なら、外れる", () => {
    const elsewhere = path.join(dir, "shared-node-modules");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "marker"), "original", "utf-8");
    const link = path.join(repo, "node_modules");
    fs.symlinkSync(elsewhere, link);

    const r = runProvision(baseInput());

    // up をわざと失敗させているので exitCode は 0 にならない——それはこのテストの対象外。
    // 見たいのは「symlink がもう無い」こと。
    let stillSymlink = false;
    try {
      stillSymlink = fs.lstatSync(link).isSymbolicLink();
    } catch {
      stillSymlink = false; // 消えていれば lstat 自体が ENOENT になる
    }
    assert.equal(stillSymlink, false, `symlink が外れていない: ${r.stderr}`);
  });

  it("a2: リンク先の実体は消えない", () => {
    const elsewhere = path.join(dir, "shared-node-modules");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "marker"), "original", "utf-8");
    fs.symlinkSync(elsewhere, path.join(repo, "node_modules"));

    runProvision(baseInput());

    assert.equal(fs.existsSync(elsewhere), true, "リンク先の実体ディレクトリごと消えた");
    assert.equal(
      fs.readFileSync(path.join(elsewhere, "marker"), "utf-8"),
      "original",
      "リンク先の中身が変わった"
    );
  });

  it("a3: node_modules が本物のディレクトリなら触らない", () => {
    const real = path.join(repo, "node_modules");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, "marker"), "kept", "utf-8");

    runProvision(baseInput());

    assert.equal(fs.lstatSync(real).isSymbolicLink(), false, "本物のディレクトリが symlink 扱いされた");
    assert.equal(fs.existsSync(real), true, "本物のディレクトリが消えた");
    assert.equal(fs.readFileSync(path.join(real, "marker"), "utf-8"), "kept", "本物の中身が変わった");
  });
});

// ── a4: 黙って外さない ──────────────────────────────────────────────────────────

describe("[task-0240/a4] 外したことが理由と共に記録に残る", () => {
  it("外した symlink のパスと、なぜ外すかの理由がログ（stderr）に残る", () => {
    const elsewhere = path.join(dir, "shared-node-modules");
    fs.mkdirSync(elsewhere, { recursive: true });
    const link = path.join(repo, "node_modules");
    fs.symlinkSync(elsewhere, link);

    const r = runProvision(baseInput());

    assert.match(r.stderr, /symlink/, `symlink だと言っていない: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(link.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `外した場所を名指ししていない: ${r.stderr}`);
    // 「なぜ」——コンテナの中からは指せないので @banto/* が壊れる、という理由
    assert.match(r.stderr, /@banto/, `外す理由を言っていない: ${r.stderr}`);
  });

  it("symlink が無ければ何も言わない（本物のディレクトリを外したかのように誤報しない）", () => {
    fs.mkdirSync(path.join(repo, "node_modules"), { recursive: true });

    const r = runProvision(baseInput());

    assert.doesNotMatch(r.stderr, /node_modules.*symlink/, `symlink が無いのに外したと言っている: ${r.stderr}`);
  });
});

// ── a5: 外したあとも用意（setup）が飛ばされない ─────────────────────────────────

describe("[task-0240/a5] symlink を外したあとも setup が飛ばされない", () => {
  it("cache を使わない通常の provision では、symlink を外したあとも setup が走る", () => {
    fs.symlinkSync(path.join(dir, "shared-node-modules"), path.join(repo, "node_modules"));
    fs.mkdirSync(path.join(dir, "shared-node-modules"), { recursive: true });

    const r = runProvision(baseInput({ setup: "echo preparing" }));

    assert.equal(fs.existsSync(setupMarker), true, `setup（compose run --rm）が呼ばれていない: ${r.stderr}\n${r.stdout}`);
    const log = fs.readFileSync(fakeDockerLog, "utf-8");
    assert.match(log, /run --rm/, `docker compose run --rm が呼ばれた形跡が無い:\n${log}`);
  });
});
