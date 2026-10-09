// **片づけ役を、回のプロセスの組（cgroup）の外で起こす**（追加・2026-10-09、ユーザー要望）。
//
// 片づけ役（`run-reaper.ts`・`own-host-reaper.ts`）は、回が外から殺されても残ってコンテナを消すためにある。以前は
// setsid（別のセッション）で起こしていた——`timeout` や Ctrl-C はプロセスグループにしか届かないので、それで足りていた。
// ところが banto の中では、回は **cgroup ごと止められる**：サブエージェントを止める・Shell の待たないコマンドを止める
// （`cancelCommand`）・Factory の件をやめる、はどれもその仕事の cgroup の全部のプロセスを止める。setsid は cgroup を
// 出ないので、片づけ役も一緒に死に、コンテナが残っていた（2026-10-09 に 14 台・19 台。次の回の始めが拾うまで資源を使う）。
//
// そこで **systemd のユーザー単位（`systemd-run --user`）で起こす**——単位はユーザーの systemd（user@<uid>）の下に
// 新しい cgroup を持つので、呼んだ側の cgroup が止められても巻き添えにならない。ユーザーの systemd は台帳から補助
// グループを読むので incus グループも付く。Shell の待たない形と同じく、環境に `XDG_RUNTIME_DIR` が無いことがあるので
// `/run/user/<uid>` を補う。
//
// ユーザーの systemd に繋がらない（コンテナの外・systemd の無い機械）ときは、今までどおり setsid で起こし、そうしたと
// ログに残す（プロセスグループの打ち切りには今までどおり効く）。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { userInfo } from "node:os";

/** `args` を node で、回の cgroup の外に起こす。出力は `logFile` に足す。どちらで起こしたかを返す */
export function startOutsideRunGroup(unitHint: string, args: string[], logFile: string): "systemd" | "setsid" {
  const uid = userInfo().uid;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  if (existsSync(`${runtime}/bus`)) {
    // 単位の名前は機械の中で重ならないように（同じ名前が残っていると systemd-run が断る）
    const unit = `banto-e2e-${unitHint.replace(/[^A-Za-z0-9_.-]/g, "-")}-${process.pid}-${Date.now()}`;
    const r = spawnSync(
      "systemd-run",
      [
        "--user",
        "--quiet",
        "--collect",
        `--unit=${unit}`,
        `--working-directory=${process.cwd()}`,
        `--property=StandardOutput=append:${logFile}`,
        `--property=StandardError=append:${logFile}`,
        `--setenv=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        `--setenv=HOME=${process.env.HOME ?? ""}`,
        process.execPath,
        ...args,
      ],
      {
        encoding: "utf8",
        input: "",
        timeout: 30_000,
        env: { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
      },
    );
    if (r.status === 0) return "systemd";
    console.warn(
      `[e2e] 片づけ役をユーザーの systemd で起こせませんでした（${(r.stderr || r.error?.message || `終了コード ${r.status}`).trim()}）` +
        "——setsid で起こします。回が cgroup ごと止められると、片づけ役も止まります",
    );
  }
  const out = openSync(logFile, "a");
  spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] }).unref();
  closeSync(out);
  return "setsid";
}
