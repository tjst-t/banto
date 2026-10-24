// **ブラウザを入れる**（v4-modules.md §4.1「形」）。**普通のブラウザ**を入れる——x86_64 は **Google Chrome**（安定版。
// Playwright の `install chrome` が Google の apt から /opt/google/chrome に入れる。人が使っているのと同じもの）、
// arm64 は Google Chrome が無いので Playwright 同梱の chromium（arm64 は Playwright が組んだ Chromium。置き場は
// Module の置き場の中——`PLAYWRIGHT_BROWSERS_PATH`）。Chrome for Testing（x86_64 の Playwright の chromium）は使わない。
//
// 入っていなければ最初に起こすときに入れる。仮想の画面（Xvfb）・字体・ブラウザが頼るライブラリがコンテナに無ければ、それも
// 入れる（Playwright の install-deps——コンテナの中は sudo できる、v4-security.md §1）。入れられなければ理由つきで断る。
// 日本語の字体（Noto CJK）は起こすたびに確かめ、無ければここで入れる（fonts.ts——入れられなくても断らない）。
// 人の画面を動画で流す GStreamer と python3-gi も同じ形（video.ts——入れられなければ人の画面は JPEG で映す）。音の行き先の
// PulseAudio も同じ（audio.ts——入れられなければ音無しで映す）。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { BrowserError } from "./args.js";
import { CJK_FONT_PACKAGE } from "./fonts.js";
import { VIDEO_PACKAGES } from "./video.js";
import { AUDIO_PACKAGES } from "./audio.js";
import { PASSWORD_POLICY_FILE, PASSWORD_POLICY_JSON } from "./policy.js";

/** Playwright の呼び名（`chrome` は Google Chrome の安定版） */
export const BROWSER_NAME = process.arch === "x64" ? "chrome" : "chromium";
/** install-deps に渡す名前（Xvfb と字体を含む。chrome は apt が頼るものを入れるが、Xvfb と字体は入れない） */
const DEPS_NAME = "chromium";

interface RegistryExecutable {
  executablePath(): string | undefined;
}

/** Google Chrome の在りか（Google の apt の包みが入れる所。Playwright の registry も同じ所を見る） */
const GOOGLE_CHROME = "/opt/google/chrome/chrome";

/**
 * ブラウザの在りか。chromium は Playwright が知っている在りか。**公開の口に無いので playwright-core の中の registry を引く**（版は package.json で
 * 固定——上げたら壊れていないかを tools.integration.test が見る）。`PLAYWRIGHT_BROWSERS_PATH` を置いた後に呼ぶ。入っているかは見ない
 */
export function browserExecutablePath(): string {
  // chrome は入っていないと registry が在りかを返さない——在りかは決まっているので、そのまま返す（無ければ起こすときに入れる）
  if (BROWSER_NAME === "chrome") return GOOGLE_CHROME;
  const require = createRequire(import.meta.url);
  // 中の口なので型は無い——ここで使う1つだけを受ける
  const bundle = require("playwright-core/lib/coreBundle") as { registry: { registry: { findExecutable(name: string): RegistryExecutable | undefined } } };
  const real = bundle.registry.registry.findExecutable(BROWSER_NAME)?.executablePath();
  if (!real) throw new Error(`${BROWSER_NAME} はこの機械の種類では使えません`);
  return real;
}

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
  return runCommand(process.execPath, [playwrightCli(), ...args], `playwright ${args.join(" ")}`, env, what, onProgress);
}

function runCommand(
  command: string,
  args: string[],
  shown: string,
  env: NodeJS.ProcessEnv,
  what: string,
  onProgress?: (message: string) => void,
): Promise<{ code: number | null; tail: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let last = "";
    onProgress?.(what);
    console.error(`[browser] ${what}（${shown}）`);
    const heartbeat = setInterval(() => {
      onProgress?.(`${what}（${Math.round((Date.now() - started) / 1000)} 秒${last ? `：${last.slice(0, 200)}` : ""}）`);
    }, INSTALL_HEARTBEAT_MS);
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
      // Module のログ（host の記録に入る）にも残す——入れたかどうか・何秒かかったかを後から確かめられるように
      console.error(`[browser] ${what}：終了コード ${code}（${Math.round((Date.now() - started) / 1000)} 秒）`);
      resolve({ code, tail });
    });
  });
}

export interface Installer {
  installBrowser(onProgress?: (message: string) => void): Promise<void>;
  installDeps(onProgress?: (message: string) => void): Promise<void>;
  /** 日本語の字体（fonts-noto-cjk）を入れる（fonts.ts の ensureCjkFont が、無いときだけ呼ぶ） */
  installFonts(onProgress?: (message: string) => void): Promise<void>;
  /** 動画で流す GStreamer と python3-gi を入れる（video.ts の ensureVideo が、無いときだけ呼ぶ） */
  installVideo(onProgress?: (message: string) => void): Promise<void>;
  /** 音の行き先の PulseAudio を入れる（audio.ts の ensureAudio が、無いときだけ呼ぶ） */
  installAudio(onProgress?: (message: string) => void): Promise<void>;
  /** パスワードの企業向けポリシーを書く（policy.ts の ensurePasswordPolicy が、無いときだけ呼ぶ） */
  installPasswordPolicy(onProgress?: (message: string) => void): Promise<void>;
}

/** sudo でファイルを書く（企業向けポリシー。apt-get とは違う書き方なので aptInstall とは別に用意する）。失敗は理由つきで投げる */
async function sudoWriteFile(file: string, content: string, env: NodeJS.ProcessEnv, what: string, onProgress?: (message: string) => void): Promise<void> {
  const dir = dirname(file);
  const script = `mkdir -p ${dir} && cat > ${file} <<'BANTO_EOF'\n${content}BANTO_EOF\n`;
  let r: { code: number | null; tail: string };
  try {
    r = await runCommand("sudo", ["-n", "sh", "-c", script], `sudo でファイルを書く（${file}）`, env, what, onProgress);
  } catch (err) {
    throw new BrowserError((err as NodeJS.ErrnoException).code === "ENOENT" ? "sudo がありません" : (err as Error).message);
  }
  if (r.code !== 0) throw new BrowserError(`終了コード ${r.code}: ${r.tail.trim().slice(-500)}`);
}

/** sudo で apt-get install する。失敗は理由つきで投げる */
async function aptInstall(packages: string[], env: NodeJS.ProcessEnv, what: string, onProgress?: (message: string) => void): Promise<void> {
  const script = `apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ${packages.join(" ")}`;
  let r: { code: number | null; tail: string };
  try {
    r = await runCommand("sudo", ["-n", "sh", "-c", script], `sudo apt-get install ${packages.join(" ")}`, env, what, onProgress);
  } catch (err) {
    throw new BrowserError((err as NodeJS.ErrnoException).code === "ENOENT" ? "sudo がありません" : (err as Error).message);
  }
  if (r.code !== 0) throw new BrowserError(`終了コード ${r.code}: ${r.tail.trim().slice(-500)}`);
}

export function playwrightInstaller(browsersPath: string): Installer {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
  return {
    async installBrowser(onProgress) {
      const r = await run(["install", "--no-progress", BROWSER_NAME], env, `ブラウザ（${BROWSER_NAME}）を入れています`, onProgress);
      if (r.code !== 0) throw new BrowserError(`ブラウザ（${BROWSER_NAME}）を入れられませんでした（終了コード ${r.code}）: ${r.tail.trim().slice(-1500)}`);
    },
    async installDeps(onProgress) {
      const r = await run(["install-deps", DEPS_NAME], env, "仮想の画面（Xvfb）・字体・ブラウザが頼るライブラリをコンテナに入れています（apt-get）", onProgress);
      if (r.code !== 0) {
        throw new BrowserError(
          `ブラウザが頼るライブラリを入れられませんでした（終了コード ${r.code}。コンテナから外へ出られるか・sudo できるかを確かめてください）: ${r.tail.trim().slice(-1500)}`,
        );
      }
    },
    async installFonts(onProgress) {
      // fontconfig も足す——無いと入ったかを fc-list で確かめられない（wqy-zenhei が頼るので install-deps の後ならある）
      await aptInstall([CJK_FONT_PACKAGE, "fontconfig"], env, "日本語の字体（Noto CJK）をコンテナに入れています（apt-get）", onProgress);
    },
    async installVideo(onProgress) {
      await aptInstall(VIDEO_PACKAGES, env, "人の画面を動画で流す GStreamer をコンテナに入れています（apt-get）", onProgress);
    },
    async installAudio(onProgress) {
      await aptInstall(AUDIO_PACKAGES, env, "人の画面に音を流す PulseAudio をコンテナに入れています（apt-get）", onProgress);
    },
    async installPasswordPolicy(onProgress) {
      await sudoWriteFile(PASSWORD_POLICY_FILE, PASSWORD_POLICY_JSON, env, "パスワードの企業向けポリシーを書いています", onProgress);
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
