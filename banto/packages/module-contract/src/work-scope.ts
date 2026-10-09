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
import { spawnSync } from "node:child_process";
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
      SCOPE_PRELUDE,
      "banto-work",
      command,
      ...args,
    ],
    env: { ...base, XDG_RUNTIME_DIR: base.XDG_RUNTIME_DIR ?? runtime, DBUS_SESSION_BUS_ADDRESS: base.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtime}/bus` },
    scoped: true,
    unit: `${unit}.scope`,
  };
}
