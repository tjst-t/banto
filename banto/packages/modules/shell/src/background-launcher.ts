// **起動役を Shell から切り離して起こす口**（決定・2026-10-07、docs/specs/v4-modules.md §2.3「待たない形」）。
// 本物はコンテナの中の systemd のユーザー単位（`systemd-run --user`）。**試験では差し替える**——Service の
// `Systemctl` と同じ穴。

import { execFile, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";
import { WORK_JOBS_SLICE, WORK_OOM_SCORE_ADJ } from "@banto/module-contract";

export interface LaunchTarget {
  /** systemd の単位の名前（`banto-shell-<id>`） */
  unit: string;
  /** コマンドの置き場 */
  dir: string;
  /** 環境のファイル（起動役が読んで消す） */
  envFile: string;
}

export interface BackgroundLauncher {
  /** 起こす前の用意（ユーザーの systemd と、その実行時の置き場）。秘密のファイルを置く前に呼ぶ */
  prepare(): Promise<void>;
  /** 起動役を起こす。返ったら起こすのを頼み終えている（起きたかは `started.json` で見る） */
  start(target: LaunchTarget): Promise<void>;
  /**
   * 止める（cgroup・グループごと SIGTERM、待って残れば SIGKILL）。返ったら止め終えている。**単位の名前だけで止められる**
   * （起動役が started.json を書く前でも）。`pid` は試験の起こし方が、別の Shell が起こしたものを止めるときの手がかり
   */
  stop(target: { unit: string; pid?: number }): Promise<void>;
}

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommandFn = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<Exec>;

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err ? err.message : "") });
    });
  });
}

/** 止めるときに cgroup の残りを待つ時間（過ぎれば systemd が SIGKILL）。`cancelCommand` が長く返らないようにする */
const STOP_TIMEOUT = "10s";

/**
 * **systemd のユーザー単位で起こす**（コンテナの中）。Shell の環境には `XDG_RUNTIME_DIR` が無く、そのままの
 * `systemctl --user` は「Failed to connect to bus」になる（実測・2026-10-07）。Service の `RealSystemctl` と同じく
 * 実行時の置き場とバスを足す。linger が無ければ入れる（コンテナの中は sudo がパスワード無しで使える）
 */
export class SystemdLauncher implements BackgroundLauncher {
  private readonly env: NodeJS.ProcessEnv;
  private ready?: Promise<void>;

  private readonly run: RunCommandFn;
  private readonly busExists: (path: string) => Promise<boolean>;

  constructor(
    private readonly nodePath: string,
    private readonly wrapperPath: string,
    private readonly uid: number = userInfo().uid,
    /** **試験で差し替えるための穴**（systemd を呼ぶ口と、バスがあるかの確かめ）。本番では渡さない */
    hooks: { run?: RunCommandFn; busExists?: (path: string) => Promise<boolean> } = {},
  ) {
    this.run = hooks.run ?? run;
    this.busExists =
      hooks.busExists ??
      (async (path) => {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      });
    const runtime = `/run/user/${uid}`;
    this.env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  }

  /** 秘密を置く tmpfs（ユーザーの実行時の置き場。systemd が 0700 で作る） */
  static runtimeDir(uid: number = userInfo().uid): string {
    return `/run/user/${uid}`;
  }

  prepare(): Promise<void> {
    return this.ensureUserManager();
  }

  async start(target: LaunchTarget): Promise<void> {
    await this.ensureUserManager();
    // **コマンドも環境も単位に書かない**——コマンドは置き場の job.json、環境は tmpfs のファイル（起動役が読んで消す）。
    // `--setenv` は `systemctl show` で読める
    const r = await this.run(
      "systemd-run",
      [
        "--user",
        `--unit=${target.unit}`,
        // 終わった単位を残さない（終わり方は起動役が exit.json に書く）
        "--collect",
        "--quiet",
        // 起動役を exec できたところで返る——起こせなければ systemd-run が失敗する（黙って起動待ちで止まらない）
        "--property=Type=exec",
        `--property=TimeoutStopSec=${STOP_TIMEOUT}`,
        // **仕事の組**（段2a、`docs/specs/v4-security.md` §1）——天井の中で、カーネルが先に止め、止めるときは丸ごと
        `--slice=${WORK_JOBS_SLICE}`,
        `--property=OOMScoreAdjust=${WORK_OOM_SCORE_ADJ}`,
        "--property=OOMPolicy=kill",
        "--",
        this.nodePath,
        this.wrapperPath,
        target.dir,
        target.envFile,
      ],
      this.env,
    );
    if (r.code !== 0) {
      // **用意できたことを覚え続けない**（訂正・2026-10-07、Fable のレビュー）——ユーザーの systemd が落ちた・バスに繋がらない
      // まま覚えていると、以後ずっと確かめ直さずに失敗する。次の呼び出しで確かめ直す
      this.ready = undefined;
      throw new Error(`systemd-run で起こせませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
    }
  }

  async stop(target: { unit: string }): Promise<void> {
    const r = await this.run("systemctl", ["--user", "stop", `${target.unit}.service`], this.env);
    // もう終わって片づいた単位は「not loaded」——止める相手がいないだけ
    if (r.code !== 0 && !/not loaded|not found/i.test(r.stderr)) {
      throw new Error(`systemctl --user stop で止められませんでした: ${r.stderr.trim() || `終了コード ${r.code}`}`);
    }
  }

  /**
   * **ログインしていなくてもユーザーの systemd を立てておく**。まず linger（Service の `ensureUserManager` と同じ）。
   * **入れ子のコンテナでは logind に繋がらず linger を入れられない**（実測・2026-10-07：E2E のコンテナの中では root の
   * `loginctl enable-linger` も「Access denied」。PID 1 には繋がる）——そのときは `user@<uid>.service` を直に起こす。
   * どちらでも足りないときは、両方の理由を添えて断る
   */
  private ensureUserManager(): Promise<void> {
    this.ready ??= (async () => {
      const bus = `/run/user/${this.uid}/bus`;
      const busUp = async (tries: number) => {
        for (let i = 0; i < tries; i++) {
          if (await this.busExists(bus)) return true;
          await new Promise((res) => setTimeout(res, 200));
        }
        return false;
      };
      if (await busUp(1)) return;
      const problems: string[] = [];
      const linger = await this.run("sudo", ["-n", "loginctl", "enable-linger", userInfo().username]);
      if (linger.code !== 0) {
        problems.push(`loginctl enable-linger: ${linger.stderr.trim()}`);
        console.error(`[shell] linger を入れられませんでした（user@${this.uid}.service を直に起こします）: ${linger.stderr.trim()}`);
        const started = await this.run("sudo", ["-n", "systemctl", "start", `user@${this.uid}.service`]);
        if (started.code !== 0) problems.push(`systemctl start user@${this.uid}.service: ${started.stderr.trim()}`);
      }
      if (await busUp(50)) return;
      throw new Error(`ユーザーの systemd が立ち上がりませんでした（${bus} がありません。${problems.join("／") || "linger は入りました"}）`);
    })().catch((err: unknown) => {
      // 失敗は覚えない——人が直したあとの次の呼び出しで、もう一度確かめる
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }
}

/**
 * **試験用**：起動役を Shell から切り離した子（自分のプロセスグループ）として起こす。Shell のプロセスを捨てても
 * 起動役は残る——起こし直しをまたぐ試験に使う。本番では使わない（コンテナの外で待たない形は断る）
 */
export class DetachedLauncher implements BackgroundLauncher {
  /** 単位の名前 → 起こした起動役の pid（自分のグループの頭）。systemd の単位の名前で止めるのと同じ口にする */
  private readonly pids = new Map<string, number>();

  constructor(
    private readonly nodePath: string,
    private readonly wrapperPath: string,
  ) {}

  async prepare(): Promise<void> {}

  async start(target: LaunchTarget): Promise<void> {
    const child = spawn(this.nodePath, [this.wrapperPath, target.dir, target.envFile], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid !== undefined) this.pids.set(target.unit, child.pid);
    child.unref();
  }

  async stop(target: { unit: string; pid?: number }): Promise<void> {
    const pid = this.pids.get(target.unit) ?? target.pid;
    if (pid === undefined) return;
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      return;
    }
    for (let waited = 0; waited < 10_000 && alive(); waited += 50) await new Promise((r) => setTimeout(r, 50));
    if (alive()) process.kill(-pid, "SIGKILL");
  }
}
