// **別のサーバで Module を起こす起動役**（決定・2026-10-08、`docs/specs/v4-security.md` §1「Module の起こし方と、確実に止める」）。
//
// 向こうに送る小さな node のスクリプト（`banto-launcher.mjs`）。host は `ssh <宛先> exec <node> <起動役> <単位>` で起こし、
// **標準入力の最初の1行（JSON）**で起こすもの（command・args・cwd・env）を渡す。env はコマンド行（向こうの `ps` で読める）にも
// ファイルにも載らない。
//
// **2段で動く**（2026-10-10、実測で決めた）：`systemd-run --user --scope`・`--pipe`・`--wait` は、SSH のセッションの cgroup から
// ユーザーの systemd へ移せない・呼び元を確かめられないとして断られた（「Job failed」「Access denied」）。ふつうの
// `systemd-run --user`（Shell の待たない形と同じ）だけが通る。そこで：
//   - **外側**（SSH のセッションの中）：最初の1行を1バイトずつ読み（その先の MCP のやり取りを読まない）、同じ名前の単位が
//     残っていれば止め、`systemd-run --user --unit=<単位>` で**内側**を起こす。内側が `/run/user/<uid>/banto/<単位>.sock`
//     （0700 のフォルダ）で待ち受けたら2本繋ぎ、1本目に最初の1行を書いてから標準入出力を、2本目に標準エラーを流す
//   - **内側**（単位の中）：1本目から最初の1行を読み、Module を起こして標準入出力を1本目に、標準エラーを2本目に繋ぐ。
//     Module が終われば単位も終わる（`--collect` で残さない）
// sshd から起こした非対話のセッションには `XDG_RUNTIME_DIR`・`DBUS_SESSION_BUS_ADDRESS` が無いことがあるので、
// `/run/user/<uid>` から自分で組み立てる（Module にも同じものを渡す——Service・Shell の待たない形が使う）。
// 回線が黙って切れると、向こうの sshd が気づくまで前の Module が生き続ける——**起こす前に同じ名前の単位を止める**ので二重に
// ならない。起動役自身の失敗は標準エラーに1行で書いて終わる

export const REMOTE_LAUNCHER_SCRIPT = `// banto の起動役（host が送ったもの。書き換えても次に繋いだときに送り直される）
import { mkdirSync, readSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";

function fail(message) {
  process.stderr.write("[banto-launcher] " + message + "\\n");
  process.exit(127);
}

const uid = process.getuid();
const runtimeDir = "/run/user/" + uid;
const bus = { XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: "unix:path=" + runtimeDir + "/bus" };
const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

if (process.argv[2] === "--inner") inner(process.argv[3]);
else outer(process.argv[2]);

/** SSH のセッションの中：単位を起こし、標準入出力をソケットで渡す */
function outer(unit) {
  if (!/^[A-Za-z0-9:_.-]+$/.test(String(unit))) fail("単位の名前が不正です: " + unit);
  // 最初の1行だけを読む（1バイトずつ——その先の MCP のやり取りは Module が読む）
  const bytes = [];
  const one = Buffer.alloc(1);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let n;
    try {
      n = readSync(0, one, 0, 1, null);
    } catch (err) {
      if (err.code === "EAGAIN") { Atomics.wait(pause, 0, 0, 5); continue; }
      if (err.code === "EOF") process.exit(0);
      fail("標準入力を読めません: " + err.message);
    }
    if (n === 0) process.exit(0);
    if (one[0] === 10) break;
    bytes.push(one[0]);
    if (bytes.length > 1024 * 1024) fail("最初の1行が長すぎます");
  }
  const line = Buffer.from(bytes);
  try {
    JSON.parse(line.toString("utf8"));
  } catch (err) {
    fail("最初の1行が JSON ではありません: " + err.message);
  }

  const sysEnv = { PATH: basePath, ...bus };
  // 前の Module が残っていれば止める（止めきるまで待つ）
  const stopped = spawnSync("systemctl", ["--user", "stop", unit + ".service"], { env: sysEnv, encoding: "utf8" });
  if (stopped.error) fail("systemctl を起こせません: " + stopped.error.message);
  if (stopped.status !== 0 && !/not loaded|not found/i.test(stopped.stderr)) {
    fail("前の " + unit + " を止められません: " + stopped.stderr.trim());
  }
  spawnSync("systemctl", ["--user", "reset-failed", unit + ".service"], { env: sysEnv, stdio: "ignore" });

  const sockDir = runtimeDir + "/banto";
  mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  const sock = sockDir + "/" + unit + ".sock";
  rmSync(sock, { force: true });
  const started = spawnSync(
    "systemd-run",
    ["--user", "--quiet", "--collect", "--unit=" + unit, "--setenv=PATH=" + basePath, "--", process.execPath, process.argv[1], "--inner", sock],
    { env: sysEnv, encoding: "utf8" },
  );
  if (started.error) fail("systemd-run を起こせません: " + started.error.message);
  if (started.status !== 0) fail("systemd-run で " + unit + " を起こせません: " + started.stderr.trim());

  const dial = (deadline) =>
    new Promise((resolve, reject) => {
      const tryOnce = () => {
        // 標準入力の終わり（host が閉じた）を伝えても、Module の残りの出力は受け取る（半分だけ閉じる）
        const c = connect({ path: sock, allowHalfOpen: true });
        c.once("connect", () => resolve(c));
        c.once("error", (err) => {
          c.destroy();
          if (Date.now() > deadline) reject(err);
          else setTimeout(tryOnce, 50);
        });
      };
      tryOnce();
    });
  (async () => {
    const deadline = Date.now() + 15000;
    const io = await dial(deadline);
    io.write(Buffer.concat([line, Buffer.from("\\n")]));
    const err = await dial(deadline);
    err.pipe(process.stderr);
    io.pipe(process.stdout);
    process.stdin.pipe(io);
    // 出力を流し切ってから終わる
    io.on("close", () => process.stdout.write("", () => process.exit(0)));
    io.on("error", () => process.exit(1));
  })().catch((e) => fail(unit + " に繋げません（単位が起きないか、すぐ終わりました）: " + e.message));
}

/** 単位の中：最初の1行を受け取り、Module を起こして標準入出力をソケットに繋ぐ */
function inner(sock) {
  process.umask(0o077);
  const conns = [];
  let leftover = Buffer.alloc(0);
  let req;
  let child;
  const server = createServer({ allowHalfOpen: true }, (c) => {
    conns.push(c);
    if (conns.length === 1) {
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const nl = buf.indexOf(10);
        if (nl < 0) return;
        c.off("data", onData);
        c.pause();
        try {
          req = JSON.parse(buf.subarray(0, nl).toString("utf8"));
        } catch (err) {
          c.end();
          process.exit(127);
        }
        leftover = buf.subarray(nl + 1);
        maybeStart();
      };
      c.on("data", onData);
    } else {
      server.close();
      rmSync(sock, { force: true });
      maybeStart();
    }
  });
  server.listen(sock);
  // 繋がらないまま残らない
  setTimeout(() => { if (!child) process.exit(1); }, 30000).unref();

  function maybeStart() {
    if (child || !req || conns.length < 2) return;
    const [io, err] = conns;
    const env = { PATH: basePath, USER: process.env.USER || "", LOGNAME: process.env.LOGNAME || "", ...req.env, ...bus };
    child = spawn(req.command, req.args, { cwd: req.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let failed = false;
    child.on("error", (e) => {
      failed = true;
      err.end("[banto-launcher] Module を起こせません（" + req.cwd + "）: " + e.message + "\\n", () => process.exit(127));
    });
    if (leftover.length > 0) child.stdin.write(leftover);
    io.pipe(child.stdin);
    child.stdout.pipe(io);
    child.stderr.pipe(err);
    io.resume();
    child.stdin.on("error", () => undefined);
    io.on("error", () => child.kill("SIGTERM"));
    // 標準出力を読み切ってから（"close"）終わる——"exit" で閉じると、まだ読んでいない出力が落ちる
    child.on("close", (code, signal) => {
      if (failed) return;
      io.end();
      err.end(() => process.exit(code ?? (signal ? 128 : 1)));
    });
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
  }
}
`;

/** 起動役に渡す1行（単位の名前はコマンド行で渡す——秘密ではない） */
export interface LauncherRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 起動役を包む systemd の単位の名前（接続名から決まる。systemd の名前に使える字だけにする） */
export function moduleUnitName(connName: string): string {
  return `banto-mod-${connName.replace(/[^A-Za-z0-9:_.-]/g, "_")}`;
}
