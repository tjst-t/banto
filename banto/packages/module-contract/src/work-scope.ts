// **仕事を「仕事の組」に入れて起こす**（決定・2026-10-08〜09、ユーザー。`docs/specs/v4-security.md` §1 の段2a）。
//
// Shell のコマンド・サブエージェント・Factory のテストを、コンテナの中の systemd のユーザー単位（`banto-work-jobs.slice` の
// scope）で起こす。組には core が天井（メモリ・プロセス数）を付けているので、仕事がメモリを食い尽くしても組の中だけで止まり、
// Module は巻き込まれない。1件ずつ:
//   - oom_score_adj を +500（カーネルが先に止める。上げるのは誰でもできる——下げるのは権限を絞ったコンテナでは root でも断られる）
//   - memory.oom.group=1（止めるときはその件を丸ごと）
// scope は単位の属性で付けられないので、起こす `sh` が自分で書いてから exec する。`systemd-run --scope` はその場で exec するので、
// pid・標準入出力・プロセスグループは変わらない（呼ぶ側の時間切れ・グループごと止める作りはそのまま動く）。
//
// ユーザーの systemd に繋がらない（バスが無い）・コンテナの外（`BANTO_IN_CONTAINER` が無い）・試して入れられなかった（入れ子の
// コンテナ）なら、組に入れずにそのまま起こす。

import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const WORK_JOBS_SLICE = "banto-work-jobs.slice";
export const WORK_SERVICES_SLICE = "banto-work-services.slice";
/** 仕事の oom_score_adj。Service（+200）より先に、Module（0）よりずっと先に止められる */
export const WORK_OOM_SCORE_ADJ = 500;

export interface WorkScopeOptions {
  /** 単位の名前の頭（例 "shell"・"subagent"・"factory-test"）。後ろに乱数を付ける */
  kind: string;
  /** 子の環境。ユーザーの systemd に繋ぐ変数（XDG_RUNTIME_DIR・DBUS_SESSION_BUS_ADDRESS）を足して返す */
  env?: NodeJS.ProcessEnv;
  /** 試験用：本当にコンテナの中・バスがあるかの確かめを差し替える */
  available?: () => boolean;
  uid?: number;
  /**
   * 止めるときにその件を丸ごと止めるか（memory.oom.group=1、既定 true）。false は Terminal の tmux のサーバ——中に人の
   * セッションが全部入るので、1つのコマンドが食い尽くしただけで全部のシェルを道連れにしない（カーネルが一番大きいものを止める）
   */
  oomGroup?: boolean;
}

export interface WorkScopeLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** 組に入れたか（false なら今までどおりそのまま起こす） */
  scoped: boolean;
  /** 組に入れたときの単位の名前（`<頭>-<乱数>.scope`） */
  unit?: string;
}

function defaultUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * **一度試して覚える**（2026-10-09、実測）。入れ子のコンテナ（E2E）では、ユーザーの systemd が `incus exec` で起きたプロセスを
 * 自分の組へ移せず「Couldn't move process … Permission denied」で scope が作れない（`systemd-run` が 1 で終わり、コマンドは
 * 走らない）。Project のコンテナ（入れ子でない）では移せる。最初に `/bin/true` で試し、だめなら組に入れずに起こす
 * （5 分たったら試し直す）
 */
let probe: { ok: boolean; at: number } | undefined;
const PROBE_RETRY_MS = 5 * 60_000;

function probeScope(uid: number): boolean {
  if (probe && (probe.ok || Date.now() - probe.at < PROBE_RETRY_MS)) return probe.ok;
  const runtime = `/run/user/${uid}`;
  const r = spawnSync(
    "systemd-run",
    ["--user", "--scope", "--quiet", "--collect", `--slice=${WORK_JOBS_SLICE}`, "--", "/bin/true"],
    {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
      timeout: 10_000,
      encoding: "utf8",
    },
  );
  const ok = r.status === 0;
  if (!ok) {
    console.error(`[work-scope] 仕事の組に入れられないので、組に入れずに起こします: ${(r.stderr || r.error?.message || `終了コード ${r.status}`).trim()}`);
  }
  probe = { ok, at: Date.now() };
  return ok;
}

/** 試験用：覚えた結果を忘れる */
export function resetWorkScopeProbe(): void {
  probe = undefined;
}

/** 仕事の組に入れられるか：コンテナの中で、ユーザーの systemd のバスがあり、`BANTO_WORK_SCOPE=0` で外しておらず、試して入れた */
export function workScopeAvailable(uid: number = defaultUid()): boolean {
  if (process.env.BANTO_IN_CONTAINER !== "1") return false;
  if (process.env.BANTO_WORK_SCOPE === "0") return false;
  if (!existsSync(`/run/user/${uid}/bus`)) return false;
  return probeScope(uid);
}

/** 中で oom_score_adj と oom.group を書いてから本物に exec する `sh` の中身 */
const SCOPE_PRELUDE = [
  `echo ${WORK_OOM_SCORE_ADJ} > /proc/self/oom_score_adj 2>/dev/null`,
  'cg=$(sed -n "s/^0:://p" /proc/self/cgroup)',
  '[ -n "$cg" ] && echo 1 > "/sys/fs/cgroup$cg/memory.oom.group" 2>/dev/null',
  'exec "$@"',
].join("; ");
/** oom.group を書かない形（`oomGroup: false`） */
const SCOPE_PRELUDE_NO_GROUP = [`echo ${WORK_OOM_SCORE_ADJ} > /proc/self/oom_score_adj 2>/dev/null`, 'exec "$@"'].join("; ");

/**
 * `command args` を仕事の組の scope で起こす形にして返す。入れられなければそのまま返す
 */
export function inWorkScope(command: string, args: readonly string[], opts: WorkScopeOptions): WorkScopeLaunch {
  const uid = opts.uid ?? defaultUid();
  const base = opts.env ?? process.env;
  const ok = opts.available ? opts.available() : workScopeAvailable(uid);
  if (!ok) return { command, args: [...args], env: base, scoped: false };
  const runtime = `/run/user/${uid}`;
  const unit = `banto-${opts.kind}-${randomBytes(4).toString("hex")}`;
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unit}`,
      `--slice=${WORK_JOBS_SLICE}`,
      "--",
      "/bin/sh",
      "-c",
      opts.oomGroup === false ? SCOPE_PRELUDE_NO_GROUP : SCOPE_PRELUDE,
      "banto-work",
      command,
      ...args,
    ],
    env: { ...base, XDG_RUNTIME_DIR: base.XDG_RUNTIME_DIR ?? runtime, DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus` },
    scoped: true,
    unit: `${unit}.scope`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// **仕事の組を止める・片づける**（追加・2026-10-23、Backlog #294）。
//
// 組（scope）は中のプロセスが全部居なくなるまで残る。起こした本人（`systemd-run` が exec したもの）が終わっても、自分の
// プロセスグループを抜けた子（`setsid`・`ssh-agent -D`・E2E が後ろに回したもの）は組に残る——グループで止めても届かない
// （実測・2026-10-23：Project のコンテナに banto-subagent-*.scope が40、残っていたのは ssh-agent・tail -F・E2E の子）。
// 止めるのは組ごと（`systemctl --user kill`）。memory.oom.group はメモリを食い尽くしたときにしか効かない。

/** 組を止めるときの環境（ユーザーの systemd に繋ぐ変数） */
export function workScopeEnv(base: NodeJS.ProcessEnv = process.env, uid: number = defaultUid()): NodeJS.ProcessEnv {
  const runtime = `/run/user/${uid}`;
  return { ...base, XDG_RUNTIME_DIR: base.XDG_RUNTIME_DIR ?? runtime, DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus` };
}

function systemctlUser(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
    });
  });
}

/** 組がまだ居るか（中にプロセスが残っている）。`--collect` で起こしたので、空になれば片づいて読み込まれていない */
async function scopeAlive(unit: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await systemctlUser(["show", "--property=ActiveState", "--value", unit], env);
  if (r.code !== 0) throw new Error(`仕事の組 ${unit} を確かめられませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
  const state = r.stdout.trim();
  return state === "active" || state === "activating" || state === "deactivating" || state === "reloading";
}

/**
 * **組を丸ごと止める**：中の全プロセスに SIGTERM → `graceMs` 待って残れば SIGKILL → 居なくなるまで待つ。返ったら止まって
 * いる（もう無い組は何もしない）。止められなければ投げる。`systemctl stop` は単位の既定（90 秒）まで待つので、自分で送る
 */
export async function stopWorkScope(unit: string, opts: { env?: NodeJS.ProcessEnv; graceMs?: number } = {}): Promise<void> {
  const env = opts.env ?? workScopeEnv();
  const waits = { SIGTERM: opts.graceMs ?? 10_000, SIGKILL: 5_000 };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    if (!(await scopeAlive(unit, env))) return;
    const r = await systemctlUser(["kill", `--signal=${signal}`, unit], env);
    if (r.code !== 0 && !/not loaded|not found|not active/i.test(r.stderr)) {
      throw new Error(`仕事の組 ${unit} を止められませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
    }
    for (let waited = 0; waited < waits[signal]; waited += 100) {
      if (!(await scopeAlive(unit, env))) return;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  if (await scopeAlive(unit, env)) throw new Error(`仕事の組 ${unit} に SIGKILL を送っても、プロセスが残っています`);
}

/** いまある組のうち、`banto-<kind>-` で始まるもの（単位の名前） */
export async function listWorkScopes(kind: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<string[]> {
  const env = opts.env ?? workScopeEnv();
  const r = await systemctlUser(["list-units", "--type=scope", "--all", "--plain", "--no-legend", "--full", `banto-${kind}-*.scope`], env);
  if (r.code !== 0) throw new Error(`仕事の組の一覧を読めませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
  return r.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((unit) => unit.startsWith(`banto-${kind}-`) && unit.endsWith(".scope"));
}

/**
 * **起きたときに、前の走行が残した組を片づける**（Backlog #294）。Module が止まると（banto の起こし直し）、走らせていた
 * 仕事の組は誰も止めずに残る。`keep` が true を返す組（記録にあって、ほかの道で始末するもの）は残す。組に入れられない
 * 所（コンテナの外・入れ子）では何もしない。止められなかった組は理由ごと返す（呼ぶ側がログに出す）
 */
export async function sweepWorkScopes(
  kind: string,
  opts: { keep?: (unit: string) => boolean; env?: NodeJS.ProcessEnv; available?: () => boolean; graceMs?: number } = {},
): Promise<{ stopped: string[]; failed: Array<{ unit: string; error: string }> }> {
  if (!(opts.available ? opts.available() : workScopeAvailable())) return { stopped: [], failed: [] };
  const env = opts.env ?? workScopeEnv();
  const targets = (await listWorkScopes(kind, { env })).filter((unit) => !opts.keep?.(unit));
  const stopped: string[] = [];
  const failed: Array<{ unit: string; error: string }> = [];
  await Promise.all(
    targets.map(async (unit) => {
      try {
        await stopWorkScope(unit, { env, ...(opts.graceMs !== undefined ? { graceMs: opts.graceMs } : {}) });
        stopped.push(unit);
      } catch (err) {
        failed.push({ unit, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );
  return { stopped, failed };
}
