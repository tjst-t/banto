// **どこから流しても Incus に繋がる形で走る**（追加・2026-10-08）。
//
// 同じ機械の同じユーザーでも、プロセスが incus グループを持たない形で起こされることがある——ログインし直す前の
// シェル、Shell の待つ形の runCommand、サブエージェントの中（`id` に incus が出ない）。そのまま走ると、回の始め
// （前の回のコンテナの片づけ）で「Incus に繋がりません」と止まるか、Project のコンテナを作る spec が全部落ちる。
//
// そこで Playwright の主プロセスの**最初に**（ロックを取る前に）確かめ、揃える：
//   - 繋がれば何もしない
//   - 繋がらず、グループの台帳（`getent group incus`）では自分が incus に入っているなら、`sudo -n -E -u <自分>` で
//     **同じコマンドを自分で起こし直す**——sudo は台帳から補助グループを読み直すので incus が付く。主グループは
//     変わらない。env（HOME・TMPDIR・BANTO_*）は -E でそのまま、PATH は sudo の secure_path に替えられるので
//     `env PATH=…` で渡し直す
//   - **`sg incus -c` は使わない**——主グループが incus に変わり、E2E が作るフォルダの gid が incus になって、
//     入れ子のマウントで辿れず forkmount が落ちる（`docs/notes/2026-10-03-e2e-seven-failures.md`）
//   - どちらもできない（台帳に入っていない・sudo -n が通らない・起こし直しても繋がらない）なら、理由つきで止める
//     （黙って Incus 無しで走らない——規則2）
//
// 起こし直した子が終わるまで親は待ち、子の終了コードで終わる。親に来た信号（`timeout` の SIGTERM・Ctrl-C）は
// 子へ渡す——親だけ死んで子が走り続けると、`timeout` は終わったつもりで回が残る。
// 親が SIGKILL されたとき（`timeout -s KILL`）は渡せないので、子のほうが親を見張り、居なくなったら自分に SIGINT を
// 送って止まる（Ctrl-C と同じ——Playwright が webServer を止めて片づける）
import { spawn, spawnSync } from "node:child_process";
import { constants, userInfo } from "node:os";
import { isAlive } from "./containers.ts";

const CHECKED_ENV = "BANTO_E2E_INCUS_OK";
const REEXEC_ENV = "BANTO_E2E_INCUS_REEXEC";

function incusReachable(): { ok: boolean; detail: string } {
  // 上限を付ける（incus のクライアントは宙に浮くことがある——`containers.ts`）
  const r = spawnSync("incus", ["project", "get-current"], { encoding: "utf8", input: "", timeout: 30_000 });
  if (r.error) return { ok: false, detail: r.error.message };
  return { ok: r.status === 0, detail: (r.stderr || r.stdout).trim() };
}

function listedInIncusGroup(user: string): boolean {
  const r = spawnSync("getent", ["group", "incus"], { encoding: "utf8", input: "", timeout: 10_000 });
  if (r.status !== 0) return false;
  const members = r.stdout.trim().split(":")[3] ?? "";
  return members.split(",").includes(user);
}

/**
 * Incus に繋がることを確かめる。繋がらなければ incus グループつきで自分を起こし直し、子が終わったら同じ終了コードで
 * 終わる（この関数からは戻らない）。主プロセスで1回だけ——worker・webServer の子は env の印を見て何もしない
 */
export async function ensureIncusAccess(): Promise<void> {
  if (process.env[CHECKED_ENV]) return;
  const first = incusReachable();
  if (first.ok) {
    process.env[CHECKED_ENV] = "1";
    if (process.env[REEXEC_ENV]) watchParent(Number(process.env[REEXEC_ENV]));
    return;
  }
  const user = userInfo().username;
  const why = `Incus に繋がりません（${first.detail}）`;
  if (process.env[REEXEC_ENV]) {
    throw new Error(`[e2e] ${why}——incus グループつきで起こし直しても繋がりませんでした。incusd が動いているかを確かめてください`);
  }
  if (!listedInIncusGroup(user)) {
    throw new Error(`[e2e] ${why}。${user} は incus グループに入っていません（\`sudo usermod -aG incus ${user}\` のあと、ログインし直す）`);
  }
  if (spawnSync("sudo", ["-n", "true"], { input: "", timeout: 10_000 }).status !== 0) {
    throw new Error(
      `[e2e] ${why}。${user} は incus グループに入っていますが、このプロセスには付いていません（ログインし直す前のシェル等）。` +
        `パスワード無しの sudo も使えないので起こし直せません——\`sudo -E -u ${user} env PATH="$PATH" npx playwright test …\` で流してください`,
    );
  }
  console.log(`[e2e] このプロセスには incus グループが付いていない——sudo -n -E -u ${user} で起こし直す`);
  const child = spawn(
    "sudo",
    ["-n", "-E", "-u", user, "env", `PATH=${process.env.PATH ?? ""}`, `${REEXEC_ENV}=${process.pid}`, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // もう居ない
      }
    });
  }
  const code = await new Promise<number>((resolve) =>
    child.once("exit", (status, signal) => resolve(status ?? 128 + (signal ? constants.signals[signal] : 0))),
  );
  process.exit(code);
}


/** 起こし直した親が居なくなったら止まる（親だけが殺されて、この回が誰にも待たれずに走り続けないように） */
function watchParent(parentPid: number): void {
  if (!isAlive(parentPid)) return;
  setInterval(() => {
    if (isAlive(parentPid)) return;
    console.log(`[e2e] 起こし直す前のプロセス ${parentPid} が居なくなったので止める`);
    process.kill(process.pid, "SIGINT");
  }, 2_000).unref();
}

const REAPER_REEXEC_ENV = "BANTO_E2E_REAPER_INCUS_REEXEC";

/**
 * **片づけ役が Incus に繋がれるようにする**（追加・2026-10-17、Backlog #363）。片づけ役はユーザーの systemd（user@<uid>）の単位で
 * 起こす（`outside-group.ts`）が、その systemd は**起動したときの補助グループのまま**動き続ける。ユーザーを incus グループに入れる前から
 * 動いていた機械（banto-dev-vm：user@1000 は 2026-10-11 から、incus に入れたのはその後）では、そこから起こした片づけ役に incus が
 * 付かず、毎回「Incus に繋がりません」で何も消せずに終わっていた（回のコンテナは次の回の始めが拾うまで残る）。
 *
 * 繋がらなければ、主プロセスと同じく `sudo -n -E -u <自分>` で自分を起こし直す（sudo は台帳から補助グループを読み直す）。片づけ役は
 * 待つだけの短いスクリプトなので、同期で待って子の終了コードで終わる。単位の cgroup の中で起こすので、回の cgroup の外にいる
 * ことは変わらない。起こし直せなければ戻る（呼んだ側が今どおり「繋がりません」をログに残す）。`log` は片づけ役のログ
 */
export function ensureIncusForReaper(log: (line: string) => void): void {
  if (process.env[REAPER_REEXEC_ENV]) return;
  const first = incusReachable();
  if (first.ok) return;
  const user = userInfo().username;
  if (!listedInIncusGroup(user)) return;
  if (spawnSync("sudo", ["-n", "true"], { input: "", timeout: 10_000 }).status !== 0) {
    log(`[e2e] 片づけ役に incus グループが付いていない（${first.detail}）が、パスワード無しの sudo が使えないので起こし直せない`);
    return;
  }
  log(`[e2e] 片づけ役に incus グループが付いていない（ユーザーの systemd が incus に入る前から動いている）——sudo -n -E -u ${user} で起こし直す`);
  const r = spawnSync(
    "sudo",
    ["-n", "-E", "-u", user, "env", `PATH=${process.env.PATH ?? ""}`, `${REAPER_REEXEC_ENV}=1`, process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}
