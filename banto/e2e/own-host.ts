// **試験の中で止めて起こし直せる host**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。
//
// E2E の core（`start-core.ts`）はどの spec も共有していて、Playwright の webServer が持っている——途中で止めると
// ほかの spec が巻き添えになり、片づけ役（`run-reaper.ts`）も core の pid を見ている。起こし直しを見る spec は、
// **自分の置き場・自分の待ち受けで、もう1本 host を起こす**。画面は同じもの（`?bantoHost=` で繋ぐ先を変える）。
//
// 偽にするのは E2E の core と同じく AI だけ（`BANTO_FAKE_RUNNER`）。Module は本物で、Project のコンテナも作る——
// 片づけ（`close`）でこの host のものだけを消す（印 `user.banto.owner` がこの置き場）。
//
// **片づけ損ねない**（追加・2026-10-05、Fable のレビュー）：
//   - host は**自分のプロセスグループで**起こし（detached）、止めるときはグループごと止める——稼働中の systemd
//     （`KillMode=mixed`、実測 M5）が主の終わったあと cgroup に残ったもの（Module・`incus exec` のクライアント）を刈るのと同じ
//   - **片づけ役**（`own-host-reaper.ts`）を別のセッションで起こしておく。spec の worker が居なくなったら（Playwright が
//     外から殺された等）、host のグループを止め、コンテナと置き場を消す
//   - 置き場は E2E の回の置き場の下（`.cache/banto-e2e/<回>/own-*/data`）——札が `containers.ts` の `E2E_OWNER` に合い、
//     片づけ役ごと殺されても次の回の `global-setup.ts` が「前の回が残したもの」として拾う

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CREDENTIALS_DIR, FRONTEND_BASE_URL, CLAUDE_RELAY_CREDENTIALS, SUBAGENT_IMPORT_FILE } from "./config.ts";
import { isGroupAlive, listOwnedContainers, removeContainers } from "./containers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "../packages/core/dist/cli.js");

export interface OwnHost {
  /** 画面から繋ぐ先（Cookie は名前ごとなので localhost） */
  url: string;
  /** 試験から叩く先 */
  apiUrl: string;
  token: string;
  dataDir: string;
  /** host を止める（SIGKILL＝落ちた、SIGTERM＝人が止めた）。止まるまで待つ */
  stop(signal: NodeJS.Signals): Promise<void>;
  /** 同じ置き場・同じ待ち受けで起こし直す。待ち受けを始めるまで待つ */
  start(): Promise<void>;
  /** ここまでの host のログ（落ちたときの手がかり） */
  log(): string;
  /** 止めて、この host が作ったコンテナと置き場を消す。全部やってから、できなかったものをまとめて投げる */
  close(): Promise<void>;
}

/**
 * **自前の host を起こして、終わったら必ず片づける**。`fn` が投げたら、その失敗に host のログの末尾を添えて投げ直す。
 * **片づけが投げても元の失敗を隠さない**——`fn` が失敗していれば片づけの失敗はログに出すだけ、`fn` が通っていれば
 * 片づけの失敗で落とす（残したものは片づけ役・次の回が拾うが、黙らない）
 */
export async function withOwnHost<T>(fn: (host: OwnHost) => Promise<T>): Promise<T> {
  const host = await startOwnHost();
  let failed = false;
  try {
    return await fn(host);
  } catch (err) {
    failed = true;
    const error = err instanceof Error ? err : new Error(String(err));
    error.message = `${error.message}\n\n--- 自前の host のログ（末尾）---\n${host.log().slice(-4000)}`;
    throw error;
  } finally {
    try {
      await host.close();
    } catch (cleanupErr) {
      if (!failed) throw cleanupErr;
      console.warn("[e2e] 自前の host を片づけられませんでした（元の失敗を先に出します）:", cleanupErr);
    }
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startOwnHost(): Promise<OwnHost> {
  // **置き場の道は短く、人のホームの下に**（実測・2026-10-05）：Incus は Module の置き場のマウントを、道をつないだ
  // 1つのファイル名で持つ（255 字まで）——E2E の TMPDIR（回の置き場の下の tmp）では長すぎて「file name too long」。
  // 一方、人の Incus の project はホーム（passwd のもの。環境変数の HOME ではない）の下しかマウントさせない
  // （`restricted.devices.disk.paths`）——/tmp は「not allowed」。回の印（Playwright の pid）の下に置く
  const runDir = join(userInfo().homedir, ".cache", "banto-e2e", process.env.BANTO_E2E_RUN_ID!);
  mkdirSync(runDir, { recursive: true });
  const dir = mkdtempSync(join(runDir, "own-"));
  const dataDir = join(dir, "data");
  const configPath = join(dir, "config", "config.json");
  const claudeDir = join(dir, "claude");
  const pidFile = join(dir, "host.pid");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(claudeDir, { recursive: true });
  const port = await freePort();
  const sandboxPort = await freePort();
  const token = "e2e-own-host-token";
  writeFileSync(
    configPath,
    JSON.stringify({
      dataDir,
      port,
      authToken: token,
      sandboxPort,
      sandboxPublicUrl: `http://127.0.0.1:${sandboxPort}`,
      allowedEmbedderOrigins: [FRONTEND_BASE_URL],
      uiOrigin: FRONTEND_BASE_URL,
    }),
  );
  // 片づけ役：この worker が居なくなったら host のグループを止め、コンテナと置き場を消す。置き場が消えたら（ふつうに
  // `close` した）何もせずに終わる
  {
    const reaperLog = openSync(join(runDir, "own-host-reaper.log"), "a");
    spawn(process.execPath, [join(HERE, "own-host-reaper.ts"), String(process.pid), dir], {
      detached: true,
      stdio: ["ignore", reaperLog, reaperLog],
    }).unref();
    closeSync(reaperLog);
  }
  let child: ChildProcess | undefined;
  let output = "";
  const apiUrl = `http://127.0.0.1:${port}`;

  const start = async (): Promise<void> => {
    if (child && child.exitCode === null && child.signalCode === null) throw new Error("host はもう動いています");
    child = spawn(process.execPath, [CLI], {
      env: {
        ...process.env,
        BANTO_CONFIG_PATH: configPath,
        BANTO_FAKE_RUNNER: join(HERE, "fake-runner.ts"),
        // claude CLI に人の `~/.claude` を触らせない（E2E の core と同じ）
        CLAUDE_CONFIG_DIR: claudeDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: CLAUDE_CREDENTIALS_DIR,
        // サブエージェントも E2E の core と同じ偽物に（`start-core.ts`。取り込み元のファイルはこの回の core が置いた
        // もの）。Project のコンテナの中の Module に偽物の印だけを渡す（追加・2026-10-05）
        BANTO_SUBAGENT_FAKE_AGENT: "1",
        BANTO_CONTAINER_ENV_PASSTHROUGH: "BANTO_SUBAGENT_FAKE_AGENT",
        BANTO_CLAUDE_RELAY_CREDENTIALS: CLAUDE_RELAY_CREDENTIALS,
        BANTO_SUBAGENT_FAKE_IMPORT_FILE: SUBAGENT_IMPORT_FILE,
      },
      // 自分のプロセスグループで（グループごと止めるため・Playwright に届く信号の巻き添えにならないため）
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = child;
    if (started.pid !== undefined) writeFileSync(pidFile, String(started.pid));
    started.stdout!.on("data", (b: Buffer) => (output += b.toString()));
    started.stderr!.on("data", (b: Buffer) => (output += b.toString()));
    // **待ち受けを始めたかは host に聞く**（ログの文言に頼らない）。先に死んだら、そのログを持って落ちる
    for (let i = 0; i < 300; i++) {
      if (started.exitCode !== null || started.signalCode !== null) {
        throw new Error(`host が起きる前に終わりました（${started.exitCode ?? started.signalCode}）\n${output.slice(-3000)}`);
      }
      const ok = await fetch(`${apiUrl}/healthz`).then((r) => r.ok).catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`host が30秒で待ち受けを始めません\n${output.slice(-3000)}`);
  };

  /**
   * 止める。SIGKILL（落ちた）はグループごと。SIGTERM（人が止めた）は host にだけ送り、host が終わったら残りを
   * グループごと SIGKILL（`KillMode=mixed` と同じ）。グループが居なくなるまで待つ
   */
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    const running = child;
    if (!running?.pid) return;
    const pgid = running.pid;
    if (running.exitCode === null && running.signalCode === null) {
      const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
      process.kill(signal === "SIGKILL" ? -pgid : pgid, signal);
      await exited;
    }
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // グループにもう誰も居ない
    }
    for (let i = 0; i < 100 && isGroupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
    if (isGroupAlive(pgid)) throw new Error(`host のプロセスグループ ${pgid} が10秒で止まりません`);
  };

  const close = async (): Promise<void> => {
    const problems: string[] = [];
    await stop("SIGKILL").catch((err: unknown) => problems.push(`host を止められません：${(err as Error).message}`));
    try {
      const mine = listOwnedContainers().filter((c) => c.owner === dataDir).map((c) => c.name);
      const failed = removeContainers(mine, () => undefined);
      if (failed.length > 0) problems.push(`コンテナを消せません：${failed.join(", ")}`);
    } catch (err) {
      problems.push(`コンテナの一覧を読めません：${(err as Error).message}`);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      problems.push(`置き場 ${dir} を消せません：${(err as Error).message}`);
    }
    if (problems.length > 0) throw new Error(`[e2e] 自前の host の片づけ：${problems.join("／")}`);
  };

  try {
    await start();
  } catch (err) {
    await close().catch((cleanupErr: unknown) => console.warn("[e2e] 起きなかった自前の host を片づけられませんでした:", cleanupErr));
    throw err;
  }
  return {
    url: `http://localhost:${port}`,
    apiUrl,
    token,
    dataDir,
    stop,
    start,
    log: () => output,
    close,
  };
}
