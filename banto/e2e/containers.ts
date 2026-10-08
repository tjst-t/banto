// **E2E が作ったコンテナを片づける道具**（追加・2026-10-01）。
// 片づけは3か所から呼ぶ——終わるとき（`global-teardown.ts`）、回が死んだのを見届ける片づけ役（`run-reaper.ts`）、
// 次の回の始め（`global-setup.ts`）。どれも札（`user.banto.owner`＝その回のデータの置き場）で引く——人の banto や、
// 別のセッションで走っている E2E のものは消さない。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface OwnedContainer {
  name: string;
  owner: string;
  /** Incus の状態（`Running`・`Stopped` 等） */
  status: string;
}

/**
 * E2E の回のデータの置き場の形。HOME に依らない——サブエージェントの偽のホームで回した回も拾うため。spec が自前で
 * 起こす host（`own-host.ts`）の置き場（回の下の `own-*`）も同じ回のものとして拾う（追加・2026-10-05）
 */
const E2E_OWNER = /\/\.cache\/banto-e2e\/(\d+)\/(?:own-[^/]+\/)?data$/;

/** 札の置き場から、その回の印（Playwright の pid）を読む。E2E のものでなければ null */
export function runIdOf(owner: string): number | null {
  const m = E2E_OWNER.exec(owner);
  return m ? Number(m[1]) : null;
}

/** pid が生きているか。EPERM は「居るが他人のもの」——生きている扱い */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** そのプロセスグループに誰か居るか。EPERM は「居るが他人のもの」——居る扱い */
export function isGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function incus(args: string[]): { status: number | null; stdout: string; stderr: string } {
  // 上限を付ける——incus のクライアントは incusd の側が起こし直されると宙に浮いたまま戻らないことがある（2026-10-08 に実測）
  const r = spawnSync("incus", args, { encoding: "utf8", input: "", timeout: 120_000 });
  if (r.error) return { status: null, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error.message}` };
  return r;
}

/** 札の付いたコンテナの一覧。読めなければ投げる（incus グループが効いていない等） */
export function listOwnedContainers(): OwnedContainer[] {
  const project = incus(["project", "get-current"]);
  if (project.status !== 0) throw new Error(`Incus に繋がりません（incus グループが効いていない？）：${project.stderr.trim()}`);
  const listed = incus(["query", `/1.0/instances?recursion=1&project=${encodeURIComponent(project.stdout.trim())}`]);
  if (listed.status !== 0) throw new Error(`コンテナの一覧を読めません：${listed.stderr.trim()}`);
  return (JSON.parse(listed.stdout) as { name: string; status?: string; config?: Record<string, string> }[]).flatMap((c) => {
    const owner = c.config?.["user.banto.owner"];
    return owner ? [{ name: c.name, owner, status: c.status ?? "?" }] : [];
  });
}

/**
 * 前の回が残したもの（札が E2E の回の置き場で、その回がもう走っていない——置き場が消えた、または印の pid が
 * 生きていない）の名前。`current`（この回の置き場）のものは入れない。別のセッションが同時に回している E2E のものも
 * 入れない
 */
export function staleOwnedContainers(current: string): string[] {
  return listOwnedContainers()
    .filter((c) => {
      const runId = runIdOf(c.owner);
      return runId !== null && c.owner !== current && (!existsSync(c.owner) || !isAlive(runId));
    })
    .map((c) => c.name);
}

/**
 * **コンテナの起動の記録**（`incus info --show-log`、追加・2026-10-08）。コンテナが起きない（`incusd forkstart` で落ちる等）
 * とき、core のログには「起こせなかった」としか出ず、なぜかは Incus の側にしか無い。読めなければ理由を返す
 */
export function containerLog(name: string): string {
  const r = incus(["info", "--show-log", name]);
  return r.status === 0 ? r.stdout : `（incus info --show-log ${name} が失敗：${r.stderr.trim()}）`;
}

/**
 * コンテナを消す。host がまだ触っている（`Instance is busy`）なら少し待って何度か試す。
 * 消したあと、そのコンテナへの `incus exec` が親を失って残っていれば止める——コンテナを消しても
 * クライアント側のプロセスは居残る（2026-10-01 に 17 本残っていたのを実測）
 */
export function removeContainers(names: string[], log: (line: string) => void, attempts = 5): string[] {
  const failed: string[] = [];
  for (const name of names) {
    let last = "";
    let ok = false;
    for (let i = 0; i < attempts && !ok; i++) {
      if (i > 0) sleepSync(2000);
      const r = incus(["delete", "--force", name]);
      ok = r.status === 0 || /not found/i.test(r.stderr);
      last = r.stderr.trim();
    }
    if (ok) killStrayExecs(name);
    else failed.push(name);
    log(ok ? `[e2e] コンテナ ${name} を消した` : `[e2e] コンテナ ${name} を消せませんでした：${last}`);
  }
  return failed;
}

/** `incus exec <name> ...` のクライアントのプロセスを止める */
function killStrayExecs(name: string): void {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return;
  }
  for (const pid of pids) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (argv[0]?.endsWith("incus") && argv[1] === "exec" && argv[2] === name) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // もう居ない
      }
    }
  }
}

/**
 * コマンド行が条件に合うプロセスの**プロセスグループごと**止める（SIGTERM、居残れば SIGKILL）。
 * Playwright は webServer を別のグループで起こすので、Playwright が殺されると webServer は親を失って居残る
 * ——画面のサーバ（`next start`）は子の `next-server` がコマンド行を書き換えるので、グループで止める
 */
export function killProcessGroups(match: (cmdline: string) => boolean, log: (line: string) => void): void {
  const groups = new Set<number>();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      if (!match(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "))) continue;
      // stat の5つ目がプロセスグループ（2つ目のコマンド名は括弧つきで空白を含みうるので、閉じ括弧の後ろから数える）
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const pgid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (pgid > 1 && pgid !== process.pid) groups.add(pgid);
    } catch {
      // 読んでいる間に居なくなった
    }
  }
  for (const pgid of groups) {
    log(`[e2e] 居残ったプロセスグループ ${pgid} を止める`);
    signalGroup(pgid, "SIGTERM");
  }
  if (groups.size === 0) return;
  sleepSync(3000);
  for (const pgid of groups) signalGroup(pgid, "SIGKILL");
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // もう居ない
  }
}

/** pid が居なくなるまで待つ（上限つき）。居なくなれば true */
export function waitGone(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    sleepSync(200);
  }
  return true;
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
