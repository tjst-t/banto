// systemd のユーザー単位を呼ぶ口（docs/specs/v4-modules.md §4.2「systemd のユーザー単位で動かす」）。
// **試験では差し替える**——Shell の relayClient と同じ穴。

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Systemctl {
  /** `systemctl --user <args>` */
  run(args: string[]): Promise<CommandResult>;
  /** いま待ち受けている TCP のポート（`ss -ltnH`） */
  listeningPorts(): Promise<Set<number>>;
}

function exec(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 ? err.message : "") });
    });
  });
}

/** `ss -ltnH` の出力から、待ち受けているポートを拾う（4列目が `アドレス:ポート`） */
export function parseListening(text: string): Set<number> {
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return ports;
}

export class RealSystemctl implements Systemctl {
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly uid: number = userInfo().uid) {
    // ユーザーの systemd に繋ぐには、そのユーザーの実行時の置き場とバスの場所が要る
    // （Module の環境には入っていない——ログインしていないため）
    const runtime = `/run/user/${uid}`;
    this.env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  }

  run(args: string[]): Promise<CommandResult> {
    return exec("systemctl", ["--user", ...args], this.env);
  }

  async listeningPorts(): Promise<Set<number>> {
    const r = await exec("ss", ["-ltnH"]);
    return r.code === 0 ? parseListening(r.stdout) : new Set();
  }

  /**
   * **ユーザーの systemd を、ログインしていなくても立てておく**（linger）。これが無いとコンテナの起動で
   * サービスが起きない。コンテナの中は sudo がパスワード無しで使える（v4-security.md §2）
   */
  async ensureUserManager(): Promise<void> {
    const user = userInfo().username;
    const linger = await exec("loginctl", ["show-user", String(this.uid), "-p", "Linger", "--value"]);
    if (linger.stdout.trim() !== "yes") {
      const r = await exec("sudo", ["-n", "loginctl", "enable-linger", user]);
      if (r.code !== 0) throw new Error(`ユーザーの systemd を常駐させられませんでした（loginctl enable-linger）: ${r.stderr.trim()}`);
    }
    // 立ち上がるまで待つ（有効にした直後はバスがまだ無い）
    const bus = `/run/user/${this.uid}/bus`;
    for (let i = 0; i < 50; i++) {
      try {
        await access(bus);
        return;
      } catch {
        await new Promise((res) => setTimeout(res, 200));
      }
    }
    throw new Error(`ユーザーの systemd が立ち上がりませんでした（${bus} がありません）`);
  }
}
