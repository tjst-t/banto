// **試験の中で止めて起こし直せる host**（追加・2026-10-06、アーキ仕様 §2.5「起こし直しをまたいで続ける」）。
//
// E2E の core（`start-core.ts`）はどの spec も共有していて、Playwright の webServer が持っている——途中で止めると
// ほかの spec が巻き添えになり、片づけ役（`run-reaper.ts`）も core の pid を見ている。起こし直しを見る spec は、
// **自分の置き場・自分の待ち受けで、もう1本 host を起こす**。画面は同じもの（`?bantoHost=` で繋ぐ先を変える）。
//
// 偽にするのは E2E の core と同じく AI だけ（`BANTO_FAKE_RUNNER`）。Module は本物で、Project のコンテナも作る——
// 片づけ（`close`）でこの host のものだけを消す（印 `user.banto.owner` がこの置き場）。

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CREDENTIALS_DIR, FRONTEND_BASE_URL } from "./config.ts";
import { listOwnedContainers, removeContainers } from "./containers.ts";

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
  /** 止めて、この host が作ったコンテナを消す */
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function startOwnHost(): Promise<OwnHost> {
  // **置き場の道は短く、人のホームの下に**（実測・2026-10-06）：Incus は Module の置き場のマウントを、道をつないだ
  // 1つのファイル名で持つ（255 字まで）——E2E の TMPDIR（回の置き場の下）では長すぎて「file name too long」。
  // 一方、人の Incus の project はホーム（passwd のもの。環境変数の HOME ではない）の下しかマウントさせない
  // （`restricted.devices.disk.paths`）——/tmp は「not allowed」
  mkdirSync(join(userInfo().homedir, ".cache"), { recursive: true });
  const dir = mkdtempSync(join(userInfo().homedir, ".cache", "bo-"));
  const dataDir = join(dir, "data");
  const configPath = join(dir, "config", "config.json");
  const claudeDir = join(dir, "claude");
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = child;
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

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => running.once("exit", () => resolve()));
    running.kill(signal);
    await exited;
  };

  await start();
  return {
    url: `http://localhost:${port}`,
    apiUrl,
    token,
    dataDir,
    stop,
    start,
    log: () => output,
    async close() {
      await stop("SIGKILL");
      const mine = listOwnedContainers().filter((c) => c.owner === dataDir).map((c) => c.name);
      const failed = removeContainers(mine, () => undefined);
      if (failed.length > 0) console.warn(`[e2e] 自前の host のコンテナを消せませんでした: ${failed.join(", ")}`);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[e2e] 自前の host の置き場 ${dir} を消せませんでした:`, err);
      }
    },
  };
}
