#!/usr/bin/env node
/**
 * Builtin `docker` environment driver — spec-environment §2, §3.
 *
 * Invoked as a subprocess by the daemon:
 *   node --import tsx docker-driver.ts <verb>
 *
 * Input:  stdin JSON per spec §2 (field names FIXED per D1)
 * Output: stdout JSON per spec §2
 * Exit:   0 = success, 1 = failure (I2: failures are never swallowed as exit 0)
 *
 * Handle shape: { project: string, composeFile: string, name: string, taskId: string, created: string }
 *   - project:     docker compose project name (taskID-prefixed, I3)
 *   - composeFile: absolute path to the compose YAML file
 *   - name:        same as project (taskID-prefixed resource name — I3)
 *   - taskId:      the task this environment belongs to
 *   - created:     ISO-8601 timestamp of provision
 *
 * D6: node:child_process, node:fs, node:path only (no npm deps). docker CLI is
 *     already on the host (same host-tool assumption as the process driver's node/shell).
 *     Reason: D6 "no SDK dep" — shell-out to `docker compose` CLI uses the
 *     installed CLI, inherits compose file compatibility, and avoids the dockerode npm dep.
 * provision input (任意・task-0089):
 *   - setup:          用意のコマンド。**`compose up` の前**に `compose run --rm` で走らせる
 *                     ——長命のコマンド（dev server 等）が用意を要る場合、あとから走らせても
 *                     間に合わない（起動直後に落ちたコンテナは戻ってこない）
 *   - setupTimeoutMs: 用意に掛ける持ち時間（予算と厳しい方を採る）
 *   出力の `setup.ran` が「用意はこちらで済ませた」の申告。プールはこれを見て二度走らせない
 *
 * I3: all managed resources carry a `<taskId>-docker` project name prefix.
 * I2: teardown is idempotent — already-gone project is a success (exit 0).
 * I2: a failed compose command is always surfaced as a non-zero exit (never silent skip).
 *
 * HOST CONSTRAINT: This VM cannot load the docker-default AppArmor profile
 * (/sys/kernel/security unmounted). Containers MUST include security_opt:
 * [apparmor=unconfined] in their compose service definition (supplied by the
 * compose file — the driver passes the file as-is). The run verb uses
 * `docker compose run --rm` (spawns a one-shot container) rather than
 * `docker compose exec` (which fails with AppArmor on this host regardless of
 * the container's security_opt setting).
 */

import * as fs from "node:fs";
import { ensureCacheDir, listCacheDirs, removeCacheDir } from "./cache-dir.js";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import { DRIVER_TIMEOUT_EXIT, QUERY_TIMEOUT_MS, innerBudgetMs } from "./driver-budget.js";

// ── Handle shape ──────────────────────────────────────────────────────────────

interface DockerHandle {
  project: string;      // docker compose project name (taskID-prefixed)
  composeFile: string;  // absolute path to compose YAML
  name: string;         // same as project (I3: named resource identifier)
  taskId: string;
  created: string;      // ISO-8601
  /** どこで動かすか（決定34d）。compose の相対パス解決と run の cwd に使う */
  workdir?: string;
}

// ── Docker compose project naming (I3) ────────────────────────────────────────
//
// プロジェクト名は `banto-env-<taskId>`。
//
// **以前は `<taskId>-docker` だった。** 名前の綴りだけで「自分のもの」を見分けていたので、
// **たまたま `-docker` で終わる他人のプロジェクトを自分のものとして数えていた**
// ——`myapp-docker`（compose は既定でディレクトリ名をプロジェクト名にする）で実測。
// 照合はそれを「台帳に無い実リソース（孤児）」として挙げ、畳む口を作れば**POの無関係な
// コンテナを壊す**ところだった（PO指摘 2026-08-08）。
//
// 名前は二重の守りの片方。所有の真実は §list の台帳（`STATE_FILE`）が持つ。
function projectName(taskId: string): string {
  return `banto-env-${taskId}`;
}

// ── 自分が作ったものの記録（所有の真実）──────────────────────────────────────
//
// **名前から推測しない。作ったものを覚える。** `process` ドライバは最初からこうしており、
// docker ドライバだけが `docker compose ls` の全件から名前で濾していた。
//
// 記録を失ったときは `list` が空を返す＝**孤児を報告しなくなる**。検出は落ちるが、
// 他人のものを自分のものと言うことは無い——**倒れる向きを安全側にしてある**。
const STATE_FILE =
  process.env["BANTO_DOCKER_DRIVER_STATE"] ??
  path.join(os.tmpdir(), "banto-docker-driver-state.json");

function readOwned(): string[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    // I2: 壊れていても動く。空＝何も自分のものと言わない（安全側）
    return [];
  }
}

function writeOwned(projects: readonly string[]): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify([...new Set(projects)], null, 2), "utf8");
  } catch (err) {
    // 記録できなくても provision は続ける（畳めなくなるだけで、立ったものは使える）
    process.stderr.write(`docker-driver: 所有の記録を書けませんでした: ${String(err)}\n`);
  }
}

function rememberOwned(project: string): void {
  writeOwned([...readOwned(), project]);
}

function forgetOwned(project: string): void {
  writeOwned(readOwned().filter((p) => p !== project));
}

// ── Shell-out helper (sync) ───────────────────────────────────────────────────
//
// All compose commands are synchronous — the driver is a one-shot subprocess.
// D6: stdlib child_process.spawnSync only.

interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * 内側の持ち時間で殺したか。**exit だけでは分からない**——`docker` は SIGTERM を
   * 捕まえて 255 で終わるので、時間切れが「コマンドが 255 で落ちた」に化ける（inc-0034）。
   */
  timedOut: boolean;
}

/**
 * compose コマンドを起こす。
 *
 * `timeoutMs` は**必須**（`undefined` を渡すなら明示する）。既定値を持たせていたせいで、
 * 全ての呼び出し箇所が黙って 120 秒に落ちていた（inc-0034）。省略できない形にして、
 * 「渡し忘れ」を型で塞ぐ。`undefined` ＝ 内側では縛らない（外側の subprocess timeout が governs）。
 */
function runCmd(
  cmd: string,
  args: string[],
  opts: {
    timeoutMs: number | undefined;
    input?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): CmdResult {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    input: opts.input,
    cwd: opts.cwd,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    maxBuffer: 10 * 1024 * 1024,
    env: opts.env ?? { ...process.env },
  });

  // spawnSync は時間切れのとき error.code === "ETIMEDOUT" を立てる。
  // I2: 殺したことを「コマンドがそう終わった」に見せない
  const timedOut =
    (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";

  return {
    exitCode: result.status ?? -1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
    timedOut,
  };
}

// ── compose command builder ───────────────────────────────────────────────────

/** ログを残す期間。過ぎたものは自分で捨てる（放っておくと際限なく溜まる）。 */
const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000;

/**
 * 自分が書いたログのうち、保存期間を過ぎたものを捨てる。
 *
 * **ここでやるのが自然。** ログを置いた場所を知っているのはドライバだけで、
 * 呼び出し側はパスを受け取るだけ（`run` の `log_path`）。以前は「掃除は別ストーリー」と
 * 書かれたまま実装されず、1,600ファイル以上溜まっていた。
 */
function pruneOldLogs(dir: string): void {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > LOG_RETENTION_MS) fs.rmSync(file, { force: true });
      } catch { /* 消せなくても検証は続ける（best-effort） */ }
    }
  } catch { /* ディレクトリがまだ無い */ }
}

/**
 * Build args for `docker compose -p <project> [-f <file>] <subcommand...>`.
 * Pass composeFile as undefined to omit -f (e.g. for teardown when file may be gone).
 */
function composeArgs(
  project: string,
  composeFile: string | undefined,
  subcommand: string[]
): string[] {
  const args = ["compose", "-p", project];
  if (composeFile) {
    args.push("-f", composeFile);
  }
  args.push(...subcommand);
  return args;
}

// ── stdin reader ──────────────────────────────────────────────────────────────

function readStdinSync(): unknown {
  try {
    const raw = fs.readFileSync(0, "utf8"); // fd 0 = stdin
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`docker-driver: failed to read stdin: ${String(err)}\n`);
    process.exit(1);
  }
}

// ── Verb handlers ─────────────────────────────────────────────────────────────

function handleProvision(input: Record<string, unknown>): void {
  const config = input["config"] as Record<string, unknown> | undefined;
  const taskId = input["taskId"] as string | undefined;
  if (!config || !taskId) {
    process.stderr.write("docker-driver provision: missing config or taskId\n");
    process.exit(1);
  }

  const composePath = config["compose"] as string | undefined;
  if (!composePath) {
    process.stderr.write("docker-driver provision: config.compose (path to compose YAML) is required\n");
    process.exit(1);
  }

  // 決定34d: 相対 compose パスは workdir から解決する
  // ——ここが Environment Pool の cwd 固定だったせいで、番頭は「職人が作った worktree で
  // 検証して」を頼めなかった。
  //
  // **workdir が無いときの落ち先は repoPath**（task-0074）。自分の cwd に落とすと、
  // Environment Pool を独立サービスにした時点で「banto のリポジトリ」を指すようになり、
  // **受け持つプロジェクトとは何の関係もない場所**で compose を探すことになる。
  // プロファイルは `<repoPath>/meta/environments.yaml` から読んだのだから、
  // そこに書かれた相対パスの基点は repoPath。実測で踏んだ：
  //   env.verify(repoPath=<loamium>, profile="test") が
  //   `<banto>/docker/test.yaml がありません` で落ちた
  const workdir = input["workdir"] as string | undefined;
  const repoPath = input["repoPath"] as string | undefined;
  const composeFile = path.isAbsolute(composePath)
    ? composePath
    : path.resolve(workdir ?? repoPath ?? process.cwd(), composePath);

  if (!fs.existsSync(composeFile)) {
    process.stderr.write(`docker-driver provision: compose file not found: ${composeFile}\n`);
    process.exit(1);
  }

  const project = projectName(taskId);

  // `docker compose up -d --build` — starts all services in the background.
  //
  // **`--build` が要る**（inc-0037）。付けないと compose は「イメージが既に在れば作らない」
  // ので、**Dockerfile を直しても永久に効かない**。task-0075 で「道具立ての契約は
  // Dockerfile」と決めたのに、その契約が最初にビルドした時点で凍る——しかも黙って。
  //
  // 実測：loamium の Dockerfile を Debian ＋ Chromium に書き換えてゲートを回したが、
  // 使われたのは 675MB の古いイメージ（新しいものは 2.33GB）で、PDF のテスト7件は
  // 落ちたまま。「直したのに何も変わらない」という、いちばん気づきにくい形だった。
  //
  // 毎回付けても、変わっていなければレイヤキャッシュが効くので安い。
  // **イメージのビルドを含みうる**ので、呼び出し側の予算（task-0075 の 10 分）を使う。
  // 環境より長生きする置き場（spec §5.2）。**compose ファイルが受け取る形にして渡す**——
  // 名前付きボリュームは compose のプロジェクト名が前置されてタスクごとに別物になるので、
  // 共有するなら bind mount で場所そのものを渡すほかない。
  //
  // compose 側は `${BANTO_CACHE_DIR:-...}` で受ける。**書いていない compose では
  // 何も起きない**（環境変数を無視するだけ）＝既存のプロファイルを壊さない。
  const cacheKey = input["cacheKey"] as string | undefined;
  const cacheRoot = input["cacheRoot"] as string | undefined;
  let cache: { dir: string; primed: boolean } | undefined;
  if (cacheKey && cacheRoot) {
    cache = ensureCacheDir(cacheRoot, cacheKey);
  }

  const budget = innerBudgetMs(input);
  const clock = startBudget(budget);
  const cacheEnv = cache ? { ...process.env, BANTO_CACHE_DIR: cache.dir } : undefined;

  // **用意（`setup`）は `up` の前に済ませる**（task-0089・実機で踏んだ）。
  //
  // 以前はプールが「`up -d` のあと `compose run --rm` で setup」の順に回していた。
  // **待つだけのプロファイル（`sleep infinity`）でしか成り立たない順序**で、
  // dev server を起こすプロファイル（vite 等）では起動時に node_modules が空 →
  // `vite: not found` で **exit 127 で即死**する。setup はそのあと完走するが、
  // **落ちたコンテナは戻ってこない**。しかも healthcheck は running だった一瞬を掴んで
  // 「使えます」と誤報告していた。
  //
  // 用意を先に済ませれば、長命のコマンドは最初から揃った状態で起きる。
  // 待つだけのプロファイルにとっては順序が変わるだけで、見える振る舞いは同じ。
  const setup = readSetup(input);
  let setupRan = false;
  if (setup && !cache?.primed) {
    runSetupBeforeUp({
      project,
      composeFile,
      setup: setup.cmd,
      ...(workdir ? { workdir } : {}),
      ...(cacheEnv ? { env: cacheEnv } : {}),
      timeoutMs: capBudget(clock.remaining(), setup.timeoutMs),
    });
    setupRan = true;
  }

  // **用意に使ったぶんを差し引いた残り**で立てる。同じ予算を各コマンドに丸ごと渡すと
  // 合計が予算を超え、外側の subprocess timeout に殺されて理由が残らない
  const upTimeout = clock.remaining();
  const r = runCmd("docker", composeArgs(project, composeFile, ["up", "-d", "--build"]), {
    timeoutMs: upTimeout,
    ...(workdir ? { cwd: workdir } : {}),
    ...(cacheEnv ? { env: cacheEnv } : {}),
  });
  if (r.timedOut) {
    // I2: 時間切れを「compose が落ちた」と混同しない。何秒で切ったかまで言う
    process.stderr.write(
      `docker-driver provision: docker compose up が ${Math.round((upTimeout ?? 0) / 1000)} 秒で時間切れ ` +
        `（イメージのビルドが長い可能性があります）:\n${r.stderr}\n`
    );
    process.exit(1);
  }
  if (r.exitCode !== 0) {
    process.stderr.write(
      `docker-driver provision: docker compose up failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  // 立ったものを自分のものとして覚える（所有の真実。名前から推測しない）
  rememberOwned(project);

  const created = new Date().toISOString();
  const handle: DockerHandle = {
    project,
    composeFile,
    name: project,
    taskId,
    created,
    ...(workdir ? { workdir } : {}),
  };

  /**
   * **実際に publish されたホスト側のポート**（番頭判断 2026-08-13）。
   *
   * これを返すのが要点：compose のホスト側を固定しなくてよくなる
   * （`ports: - "4200"` と書けば docker が空きを割り当てる）。固定していたころは
   * 同じプロファイルを2つ立てると2本目が bind できず、しかも中継の上流が同じ番号なので
   * **2つの URL が同じ環境を指していた**。
   *
   * 探し方は「`config.port`（＝**コンテナ側**のポート）を publish しているもの」。
   * 見つからなければ何も返さない——プールは今までどおり `config.port` に落ちるので、
   * ホスト側を固定している既存の compose は1つも壊れない。
   */
  const publishedPort = findPublishedPort(project, composeFile, config, workdir);

  // spec §5.2.2: 置き場に既に中身があるか。プールはこれを見て `setup` を飛ばす。
  // `setup.ran` は「用意はこちらで済ませた」の申告——プールはこれを見て二度走らせない
  process.stdout.write(
    JSON.stringify({
      handle,
      ...(publishedPort !== undefined ? { publishedPort } : {}),
      ...(cache ? { cache: { primed: cache.primed } } : {}),
      ...(setup ? { setup: { ran: setupRan } } : {}),
    }) + "\n"
  );
}

/**
 * 立ったスタックの中で、**コンテナ側 `config.port` を publish しているホスト側の番号**を引く。
 *
 * `docker compose ps --format json` は compose のバージョンによって
 * 「1行1オブジェクト（JSON Lines）」と「配列1つ」の両方があるので、どちらも読む。
 * **引けなければ `undefined`**——「分からない」を番号で埋めない（プール側は
 * プロファイルの値に落ちるので、公開そのものは従来どおり続く）。
 */
function findPublishedPort(
  project: string,
  composeFile: string,
  config: Record<string, unknown> | undefined,
  workdir: string | undefined
): number | undefined {
  const target = Number((config as { port?: unknown } | undefined)?.port);
  if (!Number.isFinite(target) || target <= 0) return undefined;

  const r = runCmd("docker", composeArgs(project, composeFile, ["ps", "--format", "json"]), {
    timeoutMs: QUERY_TIMEOUT_MS,
    ...(workdir ? { cwd: workdir } : {}),
  });
  if (r.exitCode !== 0) return undefined;

  const rows: Array<Record<string, unknown>> = [];
  for (const line of r.stdout.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) rows.push(...(parsed as Array<Record<string, unknown>>));
      else if (parsed && typeof parsed === "object") rows.push(parsed as Record<string, unknown>);
    } catch {
      // 1行だけ壊れていても他の行は読める。**黙って全部捨てない**
    }
  }

  for (const row of rows) {
    const publishers = row["Publishers"];
    if (!Array.isArray(publishers)) continue;
    for (const p of publishers as Array<Record<string, unknown>>) {
      if (Number(p["TargetPort"]) !== target) continue;
      const published = Number(p["PublishedPort"]);
      if (Number.isFinite(published) && published > 0) return published;
    }
  }
  return undefined;
}

/**
 * `up` の前に用意を走らせる（task-0089）。こけたら**残骸を残さず** exit 1。
 *
 * `compose run --rm` は本体を起こさずに one-off コンテナを立てるので、`up` の前でも
 * 使える（ネットワークとボリュームはここで作られ、あとの `up` がそれを掴む）。
 *
 * I2: 用意の失敗も時間切れも、黙って `up` へ進まない——**用意できていない環境を
 *     「立った」と言わない**のがこの直しの目的そのもの。
 */
function runSetupBeforeUp(opts: {
  project: string;
  composeFile: string;
  setup: string;
  workdir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number | undefined;
}): void {
  const { project, composeFile, setup, workdir, env, timeoutMs } = opts;

  // **先にビルドする**（inc-0037 と同じ理由）。`up -d --build` まで待つと、用意だけが
  // 古いイメージで走る——道具立ての契約は Dockerfile なので、そこがずれたら意味が無い。
  // ビルド対象が無い compose では compose が警告を出して 0 で返る（実測）
  const built = runCmd("docker", composeArgs(project, composeFile, ["build"]), {
    timeoutMs,
    ...(workdir ? { cwd: workdir } : {}),
    ...(env ? { env } : {}),
  });
  if (built.timedOut || built.exitCode !== 0) {
    cleanupAfterFailedSetup(project, composeFile, timeoutMs);
    process.stderr.write(
      `docker-driver provision: setup の前のイメージのビルドに失敗しました` +
        `（${built.timedOut ? "時間切れ" : `exit ${built.exitCode}`}）:\n${built.stderr}\n`
    );
    process.exit(1);
  }

  const serviceName = resolveServiceName(project, composeFile);
  if (!serviceName) {
    cleanupAfterFailedSetup(project, composeFile, timeoutMs);
    process.stderr.write(
      `docker-driver provision: setup を走らせるサービス名が ${composeFile} から決まりません\n`
    );
    process.exit(1);
  }

  // `run` 動詞と同じ形で走らせる（worktree の git も同じように見せる。inc-0038）
  const gitdirMount = resolveWorktreeGitdirMount(workdir);
  const r = runCmd(
    "docker",
    composeArgs(project, composeFile, [
      "run", "--rm", "--no-TTY",
      ...(gitdirMount ? ["-v", `${gitdirMount}:${gitdirMount}:ro`] : []),
      serviceName, "sh", "-c", setup,
    ]),
    {
      timeoutMs,
      ...(workdir ? { cwd: workdir } : {}),
      ...(env ? { env } : {}),
    }
  );
  if (r.timedOut || r.exitCode !== 0) {
    cleanupAfterFailedSetup(project, composeFile, timeoutMs);
    process.stderr.write(
      `docker-driver provision: setup が失敗しました` +
        `（${r.timedOut ? "時間切れ" : `exit ${r.exitCode}`}）: ${setup}\n` +
        `${r.stdout}\n${r.stderr}\n`
    );
    process.exit(1);
  }
}

/**
 * 用意でこけたときの後始末。**まだ台帳に載っていない**ので、ここで畳まないと
 * 誰も畳めない（I3：外に残るリソースはいちばん高くつく）。
 */
function cleanupAfterFailedSetup(
  project: string,
  composeFile: string,
  timeoutMs: number | undefined
): void {
  runCmd("docker", composeArgs(project, composeFile, ["down", "-v"]), { timeoutMs });
  const leftovers = runCmd("docker", [
    "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`,
  ], { timeoutMs: QUERY_TIMEOUT_MS });
  const ids = leftovers.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (ids.length > 0) runCmd("docker", ["rm", "-f", ...ids], { timeoutMs });
}

/** provision の入力から `setup`（と、それに掛ける持ち時間）を読む。 */
function readSetup(input: Record<string, unknown>): { cmd: string; timeoutMs?: number } | undefined {
  const cmd = input["setup"];
  if (typeof cmd !== "string" || cmd.trim().length === 0) return undefined;
  const raw = input["setupTimeoutMs"];
  const timeoutMs = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
  return { cmd, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/**
 * 使い切った分を差し引いて残りを返す時計。
 *
 * provision が内側で何本もコマンドを起こすようになった以上、**同じ予算を各コマンドに
 * 丸ごと渡すと合計が予算を超える**——外側の subprocess timeout に殺され、
 * 何で落ちたか分からない失敗になる。
 */
function startBudget(budget: number | undefined): { remaining: () => number | undefined } {
  if (budget === undefined) return { remaining: () => undefined };
  const deadline = Date.now() + budget;
  // 残り 0 は「縛らない」と区別が付かないので、最低 1ms は返す（必ず即時に切れる）
  return { remaining: () => Math.max(1, deadline - Date.now()) };
}

/** 2つの持ち時間の厳しい方（どちらも無ければ縛らない）。 */
function capBudget(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * compose のサービス名を決める（`run` と `setup` で同じ決め方を使う）。
 *
 * D6: YAML パーサを足さない。compose ファイルの形は決まっている（`services:` の直下）ので
 * 正規表現で足りる。読めない・書いていないときは走っているコンテナのラベルから拾う。
 */
function resolveServiceName(project: string, composeFile: string): string | undefined {
  try {
    const raw = fs.readFileSync(composeFile, "utf8");
    const match = raw.match(/^services:\s*\n\s+([a-zA-Z0-9_-]+)\s*:/m);
    if (match) return match[1];
  } catch {
    // 読めなければラベルから拾う
  }
  const psResult = runCmd("docker", [
    "ps",
    "--filter", `label=com.docker.compose.project=${project}`,
    "--format", "{{.Label \"com.docker.compose.service\"}}",
  ], { timeoutMs: QUERY_TIMEOUT_MS });
  if (psResult.exitCode === 0 && psResult.stdout.trim()) {
    return psResult.stdout.trim().split("\n")[0]?.trim();
  }
  return undefined;
}

function handleDeploy(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver deploy: missing handle\n");
    process.exit(1);
  }
  // Deploy is a no-op for the docker driver.
  // The compose environment is already running from provision.
  // artifact_path is accepted but not used.
  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleHealthcheck(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver healthcheck: missing handle\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // Use `docker compose ps --format json` to check container states.
  // If all containers are in a running/healthy state → ok: true.
  // If no containers or any is not running → ok: false.
  const r = runCmd("docker", composeArgs(project, composeFile, ["ps", "--format", "json"]), {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        detail: `docker compose ps failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
      }) + "\n"
    );
    return;
  }

  const raw = r.stdout.trim();
  if (!raw) {
    // No containers running
    process.stdout.write(
      JSON.stringify({ ok: false, detail: "no containers found for project" }) + "\n"
    );
    return;
  }

  // docker compose ps --format json outputs one JSON object per line (NDJSON) or a JSON array.
  // Normalize to an array.
  let containers: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      containers = parsed as Array<Record<string, unknown>>;
    } else {
      // Single object
      containers = [parsed as Record<string, unknown>];
    }
  } catch {
    // May be NDJSON (one object per line)
    try {
      containers = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch (err2) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          detail: `could not parse docker compose ps output: ${String(err2)}`,
        }) + "\n"
      );
      return;
    }
  }

  if (containers.length === 0) {
    process.stdout.write(
      JSON.stringify({ ok: false, detail: "no containers found for project" }) + "\n"
    );
    return;
  }

  // Check all containers are in "running" state
  const notRunning = containers.filter((c) => {
    const state = (c["State"] as string | undefined)?.toLowerCase();
    return state !== "running";
  });

  if (notRunning.length > 0) {
    const detail = notRunning
      .map((c) => `${String(c["Name"] ?? "?")}=${String(c["State"] ?? "?")}`)
      .join(", ");
    process.stdout.write(
      JSON.stringify({ ok: false, detail: `containers not running: ${detail}` }) + "\n"
    );
    return;
  }

  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

function handleRun(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  const cmd = input["cmd"] as string | undefined;
  if (!handle || !cmd) {
    process.stderr.write("docker-driver run: missing handle or cmd\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // Before running, verify the compose project has at least one running container.
  // I2: if the project is torn down (no running containers), run must fail with
  // a non-zero exit — not silently succeed by spinning up new containers.
  // This mirrors the process driver's liveness check (isAlive(pid)) before run.
  const psCheck = runCmd("docker", composeArgs(project, composeFile, ["ps", "--format", "json"]), {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (psCheck.exitCode !== 0) {
    process.stderr.write(
      `docker-driver run: compose project "${project}" not accessible ` +
        `(exit ${psCheck.exitCode}): ${psCheck.stderr}\n`
    );
    process.exit(1);
  }

  // Check if there are running containers
  const psRaw = psCheck.stdout.trim();
  let runningCount = 0;
  if (psRaw) {
    try {
      const parsed = JSON.parse(psRaw);
      const containers = Array.isArray(parsed) ? parsed : [parsed];
      runningCount = containers.filter((c: Record<string, unknown>) => {
        const state = (c["State"] as string | undefined)?.toLowerCase();
        return state === "running";
      }).length;
    } catch {
      // NDJSON format
      try {
        const lines = psRaw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        for (const line of lines) {
          const c = JSON.parse(line) as Record<string, unknown>;
          const state = (c["State"] as string | undefined)?.toLowerCase();
          if (state === "running") runningCount++;
        }
      } catch { /* no running containers parseable */ }
    }
  }

  if (runningCount === 0) {
    // I2: environment not alive → fail with non-zero exit
    process.stderr.write(
      `docker-driver run: no running containers found for project "${project}" ` +
        `(environment may have been torn down or not yet provisioned)\n`
    );
    process.exit(1);
  }

  // First determine the service name from the compose file to use with compose run.
  // We pick the first service in the compose file.
  // D1: the compose file is the user's source of truth for what's in the environment.
  const serviceName = resolveServiceName(project, composeFile);

  if (!serviceName) {
    process.stderr.write(`docker-driver run: could not determine service name for project ${project}\n`);
    process.exit(1);
  }

  // Write output to a taskId-scoped temp log file so concurrent tasks do not
  // cross-contaminate each other's collected logs.
  // Log file cleanup is deferred to Story S9d7fdb-5 (reconcile/TTL wave).
  const logDir = path.join(os.tmpdir(), "banto-docker-driver-logs");
  fs.mkdirSync(logDir, { recursive: true });
  pruneOldLogs(logDir);
  const logPath = path.join(
    logDir,
    `${handle.taskId}-run-${Date.now()}-${Math.random().toString(36).slice(2)}.log`
  );

  // Use `docker compose run --rm <service> sh -c <cmd>` to execute a command
  // inside a fresh one-shot container that shares the compose environment.
  //
  // NOTE: `docker compose exec` is NOT used here because on this host the
  // docker daemon fails to run exec with the AppArmor check even when
  // the container has security_opt: [apparmor=unconfined]. `compose run --rm`
  // spawns a one-shot sibling container from the service definition (which
  // inherits the security_opt) and exits with the command's exit code.
  //
  // SEMANTIC CONSEQUENCE: a one-shot sibling shares volumes+network but NOT the
  // running container's writable layer, so `run` does not observe in-container
  // filesystem state written after `provision`; revisit (use `compose exec`)
  // when the host can load AppArmor profiles. Tracked as a backlog item by the
  // sprint. (I2: non-zero exit is not swallowed — it is returned faithfully in
  // the response body.)
  // 決定34d: compose を解決した場所で回す。handle に残した workdir を既定にするので、
  // 後続の run が毎回 workdir を渡さなくても provision と同じ場所で動く
  const runWorkdir = (input["workdir"] as string | undefined) ?? handle.workdir;

  // **worktree の中では git が動かない**（inc-0038・実機で踏んだ）。
  //
  // マージ前ゲートは職人の worktree で検証を回す。worktree の `.git` は
  // ディレクトリではなく**ファイル**で、`gitdir: <本体のパス>` と書いてある。
  // その先はホストのパスなので、コンテナの中からは存在しない：
  //
  //   fatal: not a git repository: /home/.../loamium/.git/worktrees/task-task-0005
  //
  // git を呼ぶテストは**全部**これで落ちる。しかも `git check-ignore` は 128 を返し、
  // テストは「無視されなかった」（1）と読む——**git が動いていないことが、
  // テストの失敗に化ける**（loamium で実際に2件そうだった）。
  //
  // 本体の `.git` を**同じ絶対パスに**読み取り専用で見せれば解ける。読み取り専用なのは、
  // 検証コマンドが他人のリポジトリの履歴を書き換えられては困るため（検証は読む仕事）。
  const gitdirMount = resolveWorktreeGitdirMount(runWorkdir);
  const runCacheKey = input["cacheKey"] as string | undefined;
  const runCacheRoot = input["cacheRoot"] as string | undefined;
  const runCacheDir =
    runCacheKey && runCacheRoot ? ensureCacheDir(runCacheRoot, runCacheKey).dir : undefined;
  // **持ち時間は呼び出し側の予算から**（task-0079）。ここが自前の 120 秒だったせいで、
  // 2分を超える検証コマンドは全て「exit 255」で落ちていた（inc-0034）。
  const budget = innerBudgetMs(input);
  const r = runCmd(
    "docker",
    composeArgs(project, composeFile, [
      "run", "--rm", "--no-TTY",
      ...(gitdirMount ? ["-v", `${gitdirMount}:${gitdirMount}:ro`] : []),
      serviceName, "sh", "-c", cmd,
    ]),
    {
      timeoutMs: budget,
      ...(runWorkdir ? { cwd: runWorkdir } : {}),
      // provision と同じ置き場を見せる。渡さないと compose は既定の場所を掴み、
      // **用意したものが `run` から見えない**（spec §5.2）
      ...(runCacheDir ? { env: { ...process.env, BANTO_CACHE_DIR: runCacheDir } } : {}),
    }
  );

  // Capture combined stdout+stderr as the log
  const output = (r.stdout) + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  fs.writeFileSync(logPath, output, "utf8");

  if (r.timedOut) {
    // **時間切れは時間切れとして返す**（exit 124）。`docker` は SIGTERM を捕まえて 255 で
    // 終わるので、そのまま渡すと「検証コマンドが 255 で落ちた」に化ける——マージ前ゲートの
    // 「時間切れなら延ばして再試行」（task-0071）は 124 を見ているので、化けると発火しない。
    //
    // **殺したクライアントは one-off コンテナを片付けない**（task-0074）。`--rm` を消すのは
    // クライアント側なので、ここで消さないと延長して再試行する間ずっと走り続ける。
    // teardown のラベル掃除は環境を畳むときまで来ないので、それでは遅い。
    removeOneOffContainers(project, budget);
    // **試しに畳んでみる**（best-effort）。one-off だけが繋がっていたネットワークなら
    // ここで消える。本体のサービスがまだ繋がっていれば「使用中」で失敗するだけ
    // ——それは正しい（本体を生かしたまま、その入れ物を消してはいけない）。
    // teardown が最終的な安全網（removeLeftoverNetworks）なので、ここで消せなくても困らない。
    removeLeftoverNetworks(project, budget);
    process.stdout.write(
      JSON.stringify({ exit: DRIVER_TIMEOUT_EXIT, log_path: logPath }) + "\n"
    );
    return;
  }

  // I2: exit code is reported as-is, never normalized to 0 on failure
  process.stdout.write(JSON.stringify({ exit: r.exitCode, log_path: logPath }) + "\n");
}

/**
 * worktree なら、本体の `.git` の場所を返す（inc-0038）。
 *
 * worktree の `.git` は `gitdir: <本体>/.git/worktrees/<名前>` と書かれた**ファイル**。
 * その `<本体>/.git` を同じ絶対パスで見せれば、コンテナの中でも git が動く。
 *
 * 通常のリポジトリ（`.git` がディレクトリ）なら何も要らない——bind mount に含まれている。
 * 読めない・形が違うときは `undefined`（**推測で mount しない**）。
 */
function resolveWorktreeGitdirMount(workdir: string | undefined): string | undefined {
  if (!workdir) return undefined;
  const dotGit = path.join(workdir, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined; // git 管理下ではない
  }
  if (stat.isDirectory()) return undefined; // 普通のリポジトリ。既に見えている

  let text: string;
  try {
    text = fs.readFileSync(dotGit, "utf8");
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return undefined;

  // `<本体>/.git/worktrees/<名前>` から `<本体>/.git` を取り出す
  const gitdir = match[1]!;
  const idx = gitdir.indexOf(`${path.sep}worktrees${path.sep}`);
  const mainGitDir = idx >= 0 ? gitdir.slice(0, idx) : gitdir;
  if (!path.isAbsolute(mainGitDir) || !fs.existsSync(mainGitDir)) return undefined;
  return mainGitDir;
}

/**
 * この compose プロジェクトに残っている one-off コンテナを消す。
 *
 * `docker compose run --rm` の `--rm` はクライアント側の後始末なので、クライアントを
 * 殺すとコンテナだけが残る（task-0074 で実測）。teardown も同じ掃除をするが、
 * **時間切れの直後に消しておかないと、延長して再試行する間ずっと二重に走る**。
 *
 * **`oneoff=True` で必ず絞る。** プロジェクト名だけで消すと、`sleep infinity` で
 * 生かしてある本体のコンテナまで巻き込む——環境が死に、延長して再試行しても
 * 「no running containers found」で落ちる。teardown 側が絞らずに消してよいのは、
 * その時点で `compose down` が本体を落とした後だから。
 *
 * I2: 消せなかったことは黙らせない。ただし run 自体の結果（時間切れ）は返す
 * ——掃除の失敗で「時間切れだった」という事実を落とさない。
 */
function removeOneOffContainers(project: string, timeoutMs: number | undefined): void {
  const leftovers = runCmd(
    "docker",
    [
      "ps", "-aq",
      "--filter", `label=com.docker.compose.project=${project}`,
      "--filter", "label=com.docker.compose.oneoff=True",
    ],
    { timeoutMs }
  );
  const ids = leftovers.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (ids.length === 0) return;
  const rm = runCmd("docker", ["rm", "-f", ...ids], { timeoutMs });
  if (rm.exitCode !== 0) {
    process.stderr.write(
      `docker-driver run: 時間切れのあと残った one-off コンテナを消せませんでした` +
        `（exit ${rm.exitCode}）:\n${rm.stderr}\n`
    );
  }
}

/**
 * この compose プロジェクトに残っているネットワークを消す（inc-0053）。
 *
 * `docker compose down -v` はネットワークも畳むはずだが、実測で27個の
 * `banto-env-task-{oneoff,wt}-*_default` ネットワークが残っていた。原因は teardown 側
 * ではなく、**teardown が走らない経路**（run が制限時間で殺されたときの one-off が
 * ネットワークに繋がったまま残り、その後 down がネットワークを畳もうとしても
 * 「使用中」で失敗する、あるいは teardown 自体が呼ばれないまま終わる）。
 *
 * ここは畳んだ**あと**の安全網。名前の綴りではなく `com.docker.compose.project` ラベル
 * で自分のプロジェクトのものだけを拾う——名前の推測は他人のネットワークを巻き込む
 * （`projectName` 冒頭のコメントと同じ理由）。
 *
 * I2 の例外：**消せなくても teardown 自体は失敗にしない**（呼び出し側の指定）。
 * 使用中（他プロセスがまだ繋がっている）は珍しくなく、そのたびに teardown が
 * 失敗扱いになると「畳めた」が信用できなくなる。ログにだけ残す。
 */
function removeLeftoverNetworks(project: string, timeoutMs: number | undefined): void {
  const found = runCmd(
    "docker",
    ["network", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
    { timeoutMs }
  );
  const ids = found.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (ids.length === 0) return;
  const rm = runCmd("docker", ["network", "rm", ...ids], { timeoutMs });
  if (rm.exitCode !== 0) {
    // I2: 消せなかったことは黙らせない。ただし呼び出し元（run/teardown）の成否は変えない（best-effort）
    process.stderr.write(
      `docker-driver: プロジェクト "${project}" の残ったネットワークを消せませんでした（exit ${rm.exitCode}）:\n${rm.stderr}\n`
    );
  }
}

function handleCollect(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  const dest = input["dest"] as string | undefined;
  if (!handle || !dest) {
    process.stderr.write("docker-driver collect: missing handle or dest\n");
    process.exit(1);
  }

  // D3: daemon decides the dest path; driver writes to it.
  fs.mkdirSync(dest, { recursive: true });

  // Collect only run log files belonging to this task (taskId-prefixed filenames).
  // Log files are named `${taskId}-run-<timestamp>-<random>.log` (written in
  // handleRun). The taskId prefix ensures two concurrent tasks do not
  // cross-contaminate each other's collected logs.
  // Log file cleanup is deferred (Story S9d7fdb-5).
  const { taskId } = handle;
  const taskLogPrefix = `${taskId}-run-`;
  const logDir = path.join(os.tmpdir(), "banto-docker-driver-logs");
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith(taskLogPrefix));
    for (const file of files) {
      fs.copyFileSync(path.join(logDir, file), path.join(dest, file));
    }
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleTeardown(input: Record<string, unknown>): void {
  const handle = input["handle"] as DockerHandle | undefined;
  if (!handle) {
    process.stderr.write("docker-driver teardown: missing handle\n");
    process.exit(1);
  }

  const { project, composeFile } = handle;

  // `docker compose down -v` stops and removes containers, networks, and volumes.
  // Idempotent: exits 0 even if the project no longer exists (I3).
  // We first try with the compose file; if that's gone, fall back to project-only.
  // 畳むのも呼び出し側の予算で。ボリューム削除は大きいと時間がかかる
  const budget = innerBudgetMs(input);
  let r: CmdResult;
  if (composeFile && fs.existsSync(composeFile)) {
    r = runCmd("docker", composeArgs(project, composeFile, ["down", "-v"]), { timeoutMs: budget });
  } else {
    // Compose file may be gone or was never known — use project name only.
    // `docker compose -p <proj> down -v` without -f still works for teardown.
    r = runCmd("docker", composeArgs(project, undefined, ["down", "-v"]), { timeoutMs: budget });
  }

  if (r.exitCode !== 0) {
    // I2: teardown failure is always surfaced as a non-zero exit
    process.stderr.write(
      `docker-driver teardown: docker compose down failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  // **`down` は one-off コンテナを消さない**（task-0074・実測）。
  //
  // `run` は `docker compose run --rm` の一時コンテナ（ラベル `oneoff=True`）で動く。
  // `--rm` を消すのは**クライアント側**なので、run が制限時間で殺されるとクライアントごと
  // 落ち、コンテナだけが残る。`compose down` は oneoff を対象にしないため、
  // **畳んだつもりでコンテナが走り続ける**——`tornDown: true` を返しながら外で動いている、
  // という I3 の不変条件がいちばん破れてはいけない形で破れる。
  //
  // 実測：`env.verify` の run が切られたあと、one-off が9分以上走り続けていた。
  //（task-0074 は「run の10分上限で切られた」と書いたが、実際に切っていたのは
  //  ドライバ自前の 120 秒だった——inc-0034 で判明。掃除が要ることは変わらない）
  const leftovers = runCmd("docker", [
    "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`,
  ], { timeoutMs: QUERY_TIMEOUT_MS });
  const ids = leftovers.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (ids.length > 0) {
    const rm = runCmd("docker", ["rm", "-f", ...ids], { timeoutMs: budget });
    if (rm.exitCode !== 0) {
      // I2: 消せなかったことを成功に見せない
      process.stderr.write(
        `docker-driver teardown: 残った one-off コンテナを消せませんでした（exit ${rm.exitCode}）:\n${rm.stderr}\n`
      );
      process.exit(1);
    }
  }

  // コンテナを全部消し切ってから（ネットワークはコンテナが繋がっている間は消せない）。
  // best-effort — 消せなくても teardown の成否は変えない
  removeLeftoverNetworks(project, budget);

  // 畳み切ってから記録を落とす（先に落とすと、失敗したものが誰の持ち物でもなくなる）
  forgetOwned(project);

  process.stdout.write(JSON.stringify({}) + "\n");
}

function handleList(_input: Record<string, unknown>): void {
  // **自分が作ったものだけを返す**（spec §2「ドライバが管理下に持つ全リソース」）。
  //
  // 以前は `docker compose ls` の全件から名前が `-docker` で終わるものを残していた。
  // それは所有の**推測**で、他人のプロジェクトを巻き込む（`myapp-docker` で実測）。
  // いまは記録（STATE_FILE）と実在（compose ls）の**積**を返す。

  const r = runCmd("docker", ["compose", "ls", "--format", "json"], {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    process.stderr.write(
      `docker-driver list: docker compose ls failed (exit ${r.exitCode}):\n${r.stderr}\n`
    );
    process.exit(1);
  }

  const raw = r.stdout.trim();
  let projects: Array<Record<string, unknown>> = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        projects = parsed as Array<Record<string, unknown>>;
      } else if (typeof parsed === "object" && parsed !== null) {
        projects = [parsed as Record<string, unknown>];
      }
    } catch {
      // Empty or malformed output → empty list (idempotent)
    }
  }

  // 記録に在るものだけ。記録が空なら何も自分のものと言わない（安全側に倒す）
  const owned = new Set(readOwned());
  const managed = projects.filter((p) => {
    const name = p["Name"] as string | undefined;
    return typeof name === "string" && owned.has(name);
  });

  // 記録に在るのに実在しないものは、外で消された分。記録から落として溜めない
  const alive = new Set(managed.map((p) => p["Name"] as string));
  const stale = [...owned].filter((name) => !alive.has(name));
  if (stale.length > 0) writeOwned([...alive]);

  // Build the list output shape per spec §2: [{handle, name, created}]
  // D3: handle is opaque to daemon; we return the project name as the lookup key.
  // Since `docker compose ls` does not return creation timestamps, we use a sentinel
  // ISO-8601 string derived from when the container was started.
  // To get creation time, we query docker ps for the project.
  const items = managed.map((p) => {
    const name = p["Name"] as string;

    // Try to get the creation time and working dir from docker ps.
    // compose は生成したコンテナに com.docker.compose.project.working_dir ラベルで
    // compose を実行した場所（= provision に渡された workdir）を残す。
    const psResult = runCmd("docker", [
      "ps", "-a",
      "--filter", `label=com.docker.compose.project=${name}`,
      "--format", "{{.CreatedAt}}\t{{.Label \"com.docker.compose.project.working_dir\"}}",
      "--no-trunc",
    ], { timeoutMs: QUERY_TIMEOUT_MS });

    let created = new Date().toISOString(); // fallback
    let workdir: string | undefined;
    if (psResult.exitCode === 0 && psResult.stdout.trim()) {
      const firstLine = psResult.stdout.trim().split("\n")[0]?.trim();
      if (firstLine) {
        const [createdAtRaw, workdirRaw] = firstLine.split("\t").map((s) => s.trim());
        if (createdAtRaw) {
          // Docker CreatedAt format: "2026-07-24 14:00:00 +0000 UTC"
          // Parse and convert to ISO-8601
          const parsed = new Date(createdAtRaw);
          if (!isNaN(parsed.getTime())) {
            created = parsed.toISOString();
          }
        }
        if (workdirRaw) workdir = workdirRaw;
      }
    }

    // The handle for list items: minimal shape that allows teardown if needed
    const handle: Record<string, unknown> = {
      project: name,
      composeFile: (p["ConfigFiles"] as string | undefined) ?? "",
      name,
      taskId: name.replace(/-docker$/, ""), // reverse-engineer taskId from project name
      created,
    };
    // 照合（spec §5）は provision の handle と JSON で突き合わせる（spec §2：list の handle は
    // provision の handle と一致しなければならない）。provision は workdir が渡されたときだけ
    // handle に残すので、list も同じく渡されたときだけ残す。compose は省略時もラベルに実行時
    // cwd を残すため、cwd と等しい場合は「渡されなかった」とみなす（provision と list は同じ
    // Environment Pool が同じ cwd で起動する——runner は cwd を渡さず継承させる）
    if (workdir && workdir !== process.cwd()) handle["workdir"] = workdir;

    return { handle, name, created };
  });

  process.stdout.write(JSON.stringify(items) + "\n");
}


// ── 環境より長生きする置き場（spec-environment §5.2）─────────────────────────
//
// 実体はプールのホスト上のディレクトリ（`cache-dir.ts`）。**在るかどうかはここが真**で、
// 最後に使った時刻はプールの台帳が持つ——ボリュームにもディレクトリにも「最後に使った」は
// 無いので導出できない。

function handleCacheList(input: Record<string, unknown>): void {
  const cacheRoot = input["cacheRoot"] as string | undefined;
  // 根を渡されなければ持っていない。**空を返すのが正しい**（黙って別の場所を探さない）
  const entries = cacheRoot ? listCacheDirs(cacheRoot) : [];
  process.stdout.write(JSON.stringify({ entries }) + "\n");
}

/**
 * 置き場を消す。**作ったのはコンテナ（root）なので、消すのもコンテナに頼む。**
 *
 * 実測で踏んだ（2026-08-08）：コンテナは root で走るので、bind mount した置き場の中身は
 * **ホストから見て root 所有**になる。プールは root ではないので `rm` が EACCES で落ち、
 * **上限が黙って効かなくなる**——上限の仕組みを先に入れるという条件が、いちばん効いて
 * ほしいドライバで空振りする形だった。
 *
 * 素の `fs` を先に試すのは、まだ何も書かれていない置き場（自分が mkdir しただけ）を
 * わざわざコンテナを起こして消さないため。
 */
function handleCacheRemove(input: Record<string, unknown>): void {
  const cacheRoot = input["cacheRoot"] as string | undefined;
  const key = input["key"] as string | undefined;
  // 冪等必須（`teardown` と同じ規約）。指すものが無いのは成功
  if (!cacheRoot || !key) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safe.length === 0) {
    process.stdout.write(JSON.stringify({}) + "\n");
    return;
  }
  try {
    removeCacheDir(cacheRoot, key);
  } catch {
    // root 所有の中身が残っている。**作った側の権限で消す**
    const root = path.resolve(cacheRoot);
    const r = runCmd(
      "docker",
      ["run", "--rm", "-v", `${root}:/banto-cache`, "alpine:3", "rm", "-rf", `/banto-cache/${safe}`],
      { timeoutMs: 120_000 }
    );
    if (r.exitCode !== 0) {
      // I2: 消せなかったことを成功に見せない。プールが出来事として残す
      process.stderr.write(
        `docker-driver cache-remove: ${safe} を消せませんでした (exit ${r.exitCode}):\n${r.stderr}\n`
      );
      process.exit(1);
    }
  }
  process.stdout.write(JSON.stringify({}) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const verb = process.argv[2];
  if (!verb) {
    process.stderr.write("docker-driver: verb argument required\n");
    process.exit(1);
  }

  // Read stdin (synchronous — this is a one-shot subprocess)
  const raw = readStdinSync();
  const input: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  try {
    switch (verb) {
      case "provision":
        handleProvision(input);
        break;
      case "deploy":
        handleDeploy(input);
        break;
      case "healthcheck":
        handleHealthcheck(input);
        break;
      case "run":
        handleRun(input);
        break;
      case "collect":
        handleCollect(input);
        break;
      case "teardown":
        handleTeardown(input);
        break;
      case "cache-list":
        handleCacheList(input);
        break;
      case "cache-remove":
        handleCacheRemove(input);
        break;
      case "list":
        handleList(input);
        break;
      default:
        process.stderr.write(`docker-driver: unknown verb: ${verb}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`docker-driver ${verb} error: ${String(err)}\n`);
    process.exit(1);
  }
}

main();
