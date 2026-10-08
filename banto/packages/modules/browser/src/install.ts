// **ブラウザを入れる**（v4-modules.md §4.1「形」——Playwright 同梱の chromium-headless-shell。版は Module が使う
// playwright-core に合わせ、Module が入れる）。置き場は Module の置き場の中（`PLAYWRIGHT_BROWSERS_PATH`）。
//
// 入っていなければ最初に起こすときに入れる。ブラウザが頼るライブラリがコンテナに無ければ、それも入れる
// （Playwright の install-deps——コンテナの中は sudo できる、v4-security.md §1）。入れられなければ理由つきで断る。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BrowserError } from "./args.js";

export const BROWSER_NAME = "chromium-headless-shell";

function playwrightCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
}

/**
 * 進捗を送る間隔。host は Module が黙ったまま60秒たつと呼び出しを切る（`agent-proxy.ts` の見張り）——取ってくる・apt は
 * 何も言わずに1分を越えることがある（E2E のフルで実測・2026-10-08）ので、走っている間は決まった間隔で言う
 */
export const INSTALL_HEARTBEAT_MS = 10_000;

/** 走らせて、終わりまで待つ。出力は末尾だけ持つ（失敗の理由に使う）。走っている間は what を進捗で言い続ける */
function run(args: string[], env: NodeJS.ProcessEnv, what: string, onProgress?: (message: string) => void): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let last = "";
    onProgress?.(what);
    const heartbeat = setInterval(() => {
      onProgress?.(`${what}（${Math.round((Date.now() - started) / 1000)} 秒${last ? `：${last.slice(0, 200)}` : ""}）`);
    }, INSTALL_HEARTBEAT_MS);
    const child = spawn(process.execPath, [playwrightCli(), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      const lines = text.split(/\r?\n|\r/).filter((l) => l.trim());
      if (lines.length > 0) last = lines.at(-1)!.trim();
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (err) => {
      clearInterval(heartbeat);
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      resolve({ code, tail });
    });
  });
}

export interface Installer {
  installBrowser(onProgress?: (message: string) => void): Promise<void>;
  installDeps(onProgress?: (message: string) => void): Promise<void>;
}

export function playwrightInstaller(browsersPath: string): Installer {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
  return {
    async installBrowser(onProgress) {
      const r = await run(["install", "--no-progress", BROWSER_NAME], env, `ブラウザ（${BROWSER_NAME}）を入れています`, onProgress);
      if (r.code !== 0) throw new BrowserError(`ブラウザ（${BROWSER_NAME}）を入れられませんでした（終了コード ${r.code}）: ${r.tail.trim().slice(-1500)}`);
    },
    async installDeps(onProgress) {
      const r = await run(["install-deps", BROWSER_NAME], env, "ブラウザが頼るライブラリをコンテナに入れています（apt-get）", onProgress);
      if (r.code !== 0) {
        throw new BrowserError(
          `ブラウザが頼るライブラリを入れられませんでした（終了コード ${r.code}。コンテナから外へ出られるか・sudo できるかを確かめてください）: ${r.tail.trim().slice(-1500)}`,
        );
      }
    },
  };
}

/** 起こしてみて、足りないものがあれば入れてからもう一度だけ起こす */
export async function launchWithInstall<T>(launch: () => Promise<T>, installer: Installer, onProgress?: (message: string) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await launch();
    } catch (err) {
      const message = (err as Error).message;
      if (attempt >= 2) throw err;
      if (/Executable doesn't exist/.test(message)) {
        await installer.installBrowser(onProgress);
        continue;
      }
      if (/missing dependencies|error while loading shared libraries/i.test(message)) {
        await installer.installDeps(onProgress);
        continue;
      }
      throw err;
    }
  }
}
