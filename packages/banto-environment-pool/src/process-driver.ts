#!/usr/bin/env node
/**
 * Builtin `process` environment driver — spec-environment §2, §3.
 *
 * Invoked as a subprocess by the daemon:
 *   node --import tsx process-driver.ts <verb>
 *
 * Input:  stdin JSON per spec §2 (field names FIXED per D1)
 * Output: stdout JSON per spec §2
 * Exit:   0 = success, 1 = failure (I2: failures are never swallowed as exit 0)
 *
 * Handle shape: { pid: number, name: string, taskId: string }
 *   - pid: OS pid of the launched process
 *   - name: taskID-prefixed resource name (I3: mandatory prefix for list/cleanup)
 *   - taskId: the task this environment belongs to
 *
 * D6: node:child_process, node:net, node:fs, node:path only (no npm deps).
 * I3: all managed resources carry a `<taskId>-env` naming prefix.
 * I2: teardown is idempotent — already-gone process is a success (exit 0).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as childProcess from "node:child_process";
import * as os from "node:os";

// ── Process state file (for list/idempotent teardown) ────────────────────────
//
// All managed processes are tracked in a JSON file under the system temp dir.
// This allows `list` to enumerate them across separate driver invocations.
// D3: the state file is the single truth for what the process driver manages.
//
// The path is overridable via BANTO_PROCESS_DRIVER_STATE (added option; the
// default path is unchanged). Acceptance tests set it to an isolated file so
// `npm test` never writes to the production state (imp-0012).

const STATE_FILE = process.env["BANTO_PROCESS_DRIVER_STATE"]
  ?? path.join(os.tmpdir(), "banto-process-driver-state.json");

interface ProcessEntry {
  pid: number;
  name: string;
  taskId: string;
  cmd: string;
  port?: number;
  created: string;
  /** どこで動かしたか（決定34d）。プロセスが起き直しても後続の run に同じ場所を渡せる */
  workdir?: string;
}

function readState(): ProcessEntry[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as ProcessEntry[];
  } catch {
    return [];
  }
}

function writeState(entries: ProcessEntry[]): void {
  // Atomic write: tmp + rename (same pattern as spawn-ledger.ts)
  const tmpPath = `${STATE_FILE}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2), { encoding: "utf8" });
    fs.renameSync(tmpPath, STATE_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

function addEntry(entry: ProcessEntry): void {
  const entries = readState().filter((e) => e.name !== entry.name);
  entries.push(entry);
  writeState(entries);
}

function removeEntry(name: string): void {
  const entries = readState().filter((e) => e.name !== name);
  writeState(entries);
}

// ── Process liveness (mirrors spawn-ledger's isProcessAlive) ─────────────────

/**
 * その pid が**まだ自分が起こしたもの**か。
 *
 * **pid だけでは同一性にならない。** 記録は再起動を越えて残るのに pid は使い回されるので、
 * 古い記録の pid が今は無関係なプロセスを指していることがある（実際に7月の記録2件が
 * 生きているように見えていた）。そのまま teardown すると**他人のプロセスを殺す**——
 * しかもグループごと落とすので巻き込む範囲が広い。
 *
 * 起こしたときのコマンドと突き合わせて確かめる。/proc が読めない環境では pid だけの
 * 判定に落ちる（従来どおり）——そこは踏み込まない。
 */
function isOurs(pid: number, cmd: string | undefined): boolean {
  if (!isAlive(pid)) return false;
  if (!cmd) return true; // 記録にコマンドが無いなら確かめようがない
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    if (raw.length === 0) return true; // 読めたが空（カーネルスレッド等）。判断材料にしない
    // シェル越しに起こすので、記録したコマンドの先頭語が現れていれば自分のものとみなす
    const head = cmd.trim().split(/\s+/)[0] ?? "";
    return raw.includes(cmd.trim()) || (head.length > 0 && raw.includes(head));
  } catch {
    return true; // /proc が無い環境。従来どおり pid だけで判断する
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // exists, different owner
    return false; // ESRCH → gone
  }
}

// ── SIGTERM → SIGKILL idempotent teardown (mirrors killOrphanProcess) ────────

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
 * プロセスグループごと落とす。落とせなければ単体で落とす。
 *
 * **pid だけ殺すと本体が生き残る。** provision は `shell: true` で起こすので、記録される
 * pid はシェルのもの——シェルを殺しても、その下の実サーバは親を失って（PPID=1）動き続ける。
 * `env.teardown` は成功を返すのに実物が残る、という一番まずい形になる（I3：外に残った
 * リソースは費用であり、ここが漏れると仕組み全体の前提が崩れる。実際に踏んだ）。
 *
 * `detached: true` で起こしているので子はプロセスグループのリーダーになる。負の pid へ
 * シグナルを送ればグループ全体に届く。
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // グループ全体
  } catch {
    try {
      process.kill(pid, signal); // グループが無いなら単体で
    } catch { /* already gone */ }
  }
}

async function killProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return; // already gone → idempotent success
  signalTree(pid, "SIGTERM");

  // Wait up to 3 s for SIGTERM, then SIGKILL
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 50));
    if (!isAlive(pid)) return;
  }
  signalTree(pid, "SIGKILL");
  await new Promise<void>((r) => setTimeout(r, 200));
}

// ── Port reachability check ───────────────────────────────────────────────────

function checkPortOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const settle = (val: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(val);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
  });
}

// ── stdin reader ──────────────────────────────────────────────────────────────

async function readStdin(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`process-driver: invalid JSON on stdin: ${String(err)}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

// ── Verb handlers ─────────────────────────────────────────────────────────────

async function handleProvision(input: Record<string, unknown>): Promise<void> {
  const config = input["config"] as Record<string, unknown> | undefined;
  const taskId = input["taskId"] as string | undefined;
  if (!config || !taskId) {
    process.stderr.write("process-driver provision: missing config or taskId\n");
    process.exit(1);
  }

  const cmd = config["cmd"] as string | undefined;
  const port = config["port"] as number | undefined;
  // 決定34d: どこで動かすか。省略時は継承した cwd（従来どおり）
  const workdir = input["workdir"] as string | undefined;
  if (!cmd) {
    process.stderr.write("process-driver provision: config.cmd is required\n");
    process.exit(1);
  }

  // Resource name carries the taskID prefix (I3)
  const name = `${taskId}-env`;

  // Spawn the process. Use shell=true to handle compound commands.
  // D6: node:child_process stdlib.
  const child = childProcess.spawn(cmd, [], {
    shell: true,
    detached: true,  // detach so it outlives this driver invocation
    stdio: ["ignore", "ignore", "ignore"],
    ...(workdir ? { cwd: workdir } : {}),
  });

  // Wait briefly for the process to start and check it hasn't crashed immediately
  await new Promise<void>((r) => setTimeout(r, 200));

  // Check if the child is still alive
  if (child.pid === undefined || !isAlive(child.pid)) {
    process.stderr.write(`process-driver provision: command failed to start: ${cmd}\n`);
    process.exit(1);
  }

  child.unref(); // let it run independently

  const entry: ProcessEntry = {
    pid: child.pid,
    name,
    taskId,
    cmd,
    port,
    created: new Date().toISOString(),
    ...(workdir ? { workdir } : {}),
  };
  addEntry(entry);

  const handle: Record<string, unknown> = { pid: child.pid, name, taskId };
  if (port !== undefined) handle["port"] = port;
  // handle に残すので、後続の run が workdir を渡さなくても同じ場所で動く
  if (workdir) handle["workdir"] = workdir;

  process.stdout.write(JSON.stringify({ handle }) + "\n");
}

async function handleDeploy(input: Record<string, unknown>): Promise<void> {
  // Deploy: for the process driver, deploy is a no-op.
  // The process is already running from provision.
  // artifact_path is accepted but not used (process driver runs in-place).
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver deploy: missing handle\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleHealthcheck(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver healthcheck: missing handle\n");
    process.exit(1);
  }

  const pid = handle["pid"] as number | undefined;
  const port = handle["port"] as number | undefined;

  if (pid === undefined) {
    process.stdout.write(JSON.stringify({ ok: false, detail: "handle missing pid" }) + "\n");
    return;
  }

  // Check process is alive
  if (!isAlive(pid)) {
    process.stdout.write(JSON.stringify({ ok: false, detail: `pid ${pid} not alive` }) + "\n");
    return;
  }

  // If a port is declared, also check TCP reachability
  if (port !== undefined) {
    const open = await checkPortOpen(port);
    if (!open) {
      process.stdout.write(
        JSON.stringify({ ok: false, detail: `port ${port} not reachable` }) + "\n"
      );
      return;
    }
  }

  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

async function handleRun(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  const cmd = input["cmd"] as string | undefined;
  if (!handle || !cmd) {
    process.stderr.write("process-driver run: missing handle or cmd\n");
    process.exit(1);
  }
  // 決定34d: provision と同じ場所で走らせられるようにする。省略時は従来どおり
  const workdir = (input["workdir"] as string | undefined) ?? (handle["workdir"] as string | undefined);

  const pid = handle["pid"] as number | undefined;
  if (pid === undefined || !isAlive(pid)) {
    // I2: non-zero exit when the environment is gone (scenario-1 step 4)
    process.stderr.write("process-driver run: environment not alive\n");
    process.exit(1);
  }

  // Write output to a temp log file.
  // Log file cleanup is deferred to Story S9d7fdb-5 (reconcile/TTL wave) — files accumulate
  // in os.tmpdir() until that story's TTL reconciler removes them.
  const logDir = path.join(os.tmpdir(), "banto-process-driver-logs");
  fs.mkdirSync(logDir, { recursive: true });
  pruneOldLogs(logDir);
  const logPath = path.join(logDir, `run-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);

  // Run the command and capture stdout+stderr
  const result = childProcess.spawnSync(cmd, [], {
    shell: true,
    encoding: "utf8",
    // Large buffer to capture all output
    maxBuffer: 10 * 1024 * 1024,
    ...(workdir ? { cwd: workdir } : {}),
  });

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  fs.writeFileSync(logPath, output, "utf8");

  const exitCode = result.status ?? 1;
  process.stdout.write(JSON.stringify({ exit: exitCode, log_path: logPath }) + "\n");
}

async function handleCollect(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  const dest = input["dest"] as string | undefined;
  if (!handle || !dest) {
    process.stderr.write("process-driver collect: missing handle or dest\n");
    process.exit(1);
  }

  // For the process driver, collect copies any available log files to dest.
  // D3: the driver writes to the dest directory provided; daemon decides the path.
  fs.mkdirSync(dest, { recursive: true });

  const logDir = path.join(os.tmpdir(), "banto-process-driver-logs");
  if (fs.existsSync(logDir)) {
    const taskId = handle["taskId"] as string | undefined;
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith("run-"));
    for (const file of files) {
      // Copy relevant log files to dest
      if (taskId) {
        // Copy all run logs (dest is already task-scoped by daemon)
        fs.copyFileSync(path.join(logDir, file), path.join(dest, file));
      }
    }
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleTeardown(input: Record<string, unknown>): Promise<void> {
  const handle = input["handle"] as Record<string, unknown> | undefined;
  if (!handle) {
    process.stderr.write("process-driver teardown: missing handle\n");
    process.exit(1);
  }

  const pid = handle["pid"] as number | undefined;
  const name = handle["name"] as string | undefined;

  // Idempotent: if pid is undefined or process is already gone, still succeed (I3)
  //
  // **殺す前に自分のものか確かめる。** pid は使い回されるので、古い記録の pid が今は
  // 無関係なプロセスを指していることがある。グループごと落とすため、取り違えると
  // 巻き込む範囲が広い（I3 の裏返し：片付けが他人を壊してはいけない）
  if (pid !== undefined) {
    const recorded = readState().find((e) => e.pid === pid && (!name || e.name === name));
    if (isOurs(pid, recorded?.cmd)) {
      await killProcess(pid);
    } else {
      process.stderr.write(
        `process-driver teardown: pid ${pid} は既に別のプロセスです。殺さず記録だけ片付けます\n`
      );
    }
  }

  // Remove from state file (idempotent — removeEntry handles missing entries)
  if (name) {
    removeEntry(name);
  }

  process.stdout.write(JSON.stringify({}) + "\n");
}

async function handleList(_input: Record<string, unknown>): Promise<void> {
  const entries = readState();

  // **一覧からは落とさず、生死を添える。** 全部返すと照合（spec §5）が死んだ記録まで
  // 「台帳に無い実リソース」と数え、本物の孤児が誤報に埋もれる（実際に136件出た）。
  // かといって落とすと、Kobo の照合が「消えた」と判定する経路の前提が変わる。
  // **足すだけなら誰の判定も壊さない**——見る側が自分で決められる。
  //
  // 記録は書き換えない。list は読み取りで provision / teardown と同時に走るため、
  // 全体を書き戻すと互いの更新を消し合う。掃除は teardown が自分の分だけ行う。
  const items = entries.map((e) => {
    const handle: Record<string, unknown> = { pid: e.pid, name: e.name, taskId: e.taskId };
    if (e.port !== undefined) handle["port"] = e.port;
    // 照合（spec §5）は provision の handle と JSON で突き合わせる。provision は
    // workdir を handle に残す設計（run が使い回す）なので、list も同じ形で返さないと
    // workdir 付きで provision した正規環境を「台帳に無い実リソース」と誤検出する
    if (e.workdir) handle["workdir"] = e.workdir;
    return {
      handle,
      name: e.name,
      created: e.created,
      // まだ自分が起こしたものとして生きているか（pid は使い回されるので突き合わせる）
      alive: isOurs(e.pid, e.cmd),
    };
  });

  process.stdout.write(JSON.stringify(items) + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const verb = process.argv[2];
  if (!verb) {
    process.stderr.write("process-driver: verb argument required\n");
    process.exit(1);
  }

  // Read stdin once for all verbs
  let input: Record<string, unknown>;
  try {
    const raw = await readStdin();
    input = (typeof raw === "object" && raw !== null && !Array.isArray(raw))
      ? (raw as Record<string, unknown>)
      : {};
  } catch (err) {
    process.stderr.write(`process-driver: stdin read error: ${String(err)}\n`);
    process.exit(1);
  }

  try {
    switch (verb) {
      case "provision":
        await handleProvision(input);
        break;
      case "deploy":
        await handleDeploy(input);
        break;
      case "healthcheck":
        await handleHealthcheck(input);
        break;
      case "run":
        await handleRun(input);
        break;
      case "collect":
        await handleCollect(input);
        break;
      case "teardown":
        await handleTeardown(input);
        break;
      case "list":
        await handleList(input);
        break;
      default:
        process.stderr.write(`process-driver: unknown verb: ${verb}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`process-driver ${verb} error: ${String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`process-driver fatal: ${String(err)}\n`);
  process.exit(1);
});
