// **ブラウザを画面ありで起こす**（v4-modules.md §4.1「形」「名乗りと言語」、決定・2026-10-10、ユーザー——「普通に人が
// 使っている Chromium に AI も触れるだけ」）。
//
// - コンテナの中に**仮想の画面**（Xvfb）を立て、そこに**普通のブラウザを画面ありで**起こす（headless にしない）
// - **Playwright の launch は使わない**——launch は `--enable-automation`・`--disable-*` の類を足す。ここでは自分で起こし、
//   CDP の口（`--remote-debugging-port`、127.0.0.1——コンテナの中だけ）に connectOverCDP で繋ぐ
// - **名乗り・言語・時刻は本物の値**：User-Agent も Client Hints も上書きしない。言語は `--accept-lang` と LANG・LANGUAGE、
//   時刻は TZ で、ブラウザ自身に設定させる。ページの JS を上書きする細工（webdriver・plugins・WebGL 等）は入れない
// - **`--disable-blink-features=AutomationControlled`** だけは足す——Chrome は CDP の口を開いて起こすと、それだけで
//   navigator.webdriver を true にする（実測・2026-10-10、Chrome 155：口なし false・`--remote-debugging-port` でも
//   `--remote-debugging-pipe` でも true）。人が使う Chrome は口を開いていないので false——その状態に揃える起動の引数
//
// Module が止まらずに消えたとき（SIGKILL）、ブラウザと Xvfb は残る（パイプで繋いでいないので道連れにならない）。次に起こす
// ときに、同じプロファイルを掴んだままのブラウザと、前に立てた Xvfb を止めてから起こす（`killStale`）。

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { inWorkScope } from "@banto/module-contract";
import { writeFontconfig } from "./fonts.js";

/**
 * 仮想の画面の大きさ（よくある画面の大きさ。CSS ピクセル——倍率を掛けた大きさで立てる）。**動画で映せる一番大きな窓**でもある
 * （v4-modules.md §4.1「動画で流す」(a)：Xvfb は「いちばん大きい窓×倍率」。これより大きなページは JPEG で映す）
 */
export const SCREEN = { width: 1920, height: 1080 };
/**
 * 描く倍率（人の画面の devicePixelRatio から。v4-modules.md §4.1「高精細の画面」）。**2 まで**——3 で描いても 1280×800 の
 * ページの絵は 1 MiB に収める上限（2560×1600）で 2 と同じ大きさになり、枚数が減って入力の遅れが延びるだけ（実測・2026-10-11：
 * 動くページで毎秒約22枚→約11枚・押してから次の絵まで約160ms→約230ms・メモリ約90MiB増し）。1 未満（縮めて見ている）は 1。
 * 0.25 刻みに丸める（端末の 2.625 等の半端は描くのに意味が無く、張り直しの元になる）
 */
export const MAX_BROWSER_SCALE = 2;
export function browserScale(dpr: number): number {
  return Math.min(MAX_BROWSER_SCALE, Math.max(1, Math.round(dpr * 4) / 4));
}
/** 起こしてから CDP の口が開くまで待つ上限 */
const START_TIMEOUT_MS = 30_000;
/** 止めるとき、自分で閉じるのを待つ上限（越えたら殺す） */
const STOP_TIMEOUT_MS = 5_000;

export interface ChromeOptions {
  executable: string;
  profileDir: string;
  /** Xvfb の pid を残す置き場（Module が消えた後に残った Xvfb を、次に止める） */
  displayPidFile: string;
  /** 言語の並び（先頭が一番好む言語。identity.ts） */
  languages: string[];
  locale: string;
  timezone: string;
  /** ブラウザにだけ効かせる fontconfig の設定の置き場（起こすたびに locale から書く——fonts.ts） */
  fontconfigFile: string;
  /** 窓の中身（ページ）の大きさ。タブごとの大きさ合わせ（session.ts）とそろえる */
  viewport: { width: number; height: number };
  /**
   * 描く倍率（browserScale で丸めたもの）。**起こすときに決まり、止めるまで変わらない**——`--force-device-scale-factor`。
   * `Emulation.setDeviceMetricsOverride` の deviceScaleFactor では screencast の絵が大きくならない（実測・2026-10-11）
   */
  scale: number;
}

export interface RunningChrome {
  browser: Browser;
  context: BrowserContext;
  /** 仮想の画面の名前（`:99`。動画の取り込みが使う——video.ts） */
  display: string;
  /** 仮想の画面の大きさ（デバイスピクセル）。これより大きなページは取り込めない */
  screen: { width: number; height: number };
  /** 閉じる（ブラウザに閉じてもらい、閉じなければ殺す。Xvfb も止める） */
  close(): Promise<void>;
}

/** ブラウザに渡す引数（自動操作の起動の印になるものは入れない——上の説明） */
export function chromeArgs(o: Pick<ChromeOptions, "profileDir" | "languages" | "viewport" | "scale">): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    "--remote-debugging-port=0",
    "--disable-blink-features=AutomationControlled",
    // 中のサンドボックスは使わない（今までと同じ。境界はコンテナ——v4-security.md §1）。コンテナでは名前空間が作れないことがある
    "--no-sandbox",
    // 初めて起こしたときの案内のタブと「既定のブラウザにする」の帯を出さない（人なら一度閉じれば出なくなるもの）
    "--no-first-run",
    "--no-default-browser-check",
    `--accept-lang=${o.languages.join(",")}`,
    // **キオスク形**（タブの帯・アドレスバーの無い全画面の窓）——人の画面は Xvfb の (0,0) からページの大きさだけを取り込んで
    // 動画にする（video.ts）ので、窓の中身がページそのものでないといけない。ページの大きさは窓で決める（session.ts の
    // setViewport——v4-modules.md §4.1「動画で流す」(a)）。窓が Xvfb の左上に来るよう位置も決める
    "--kiosk",
    "--window-position=0,0",
    `--window-size=${o.viewport.width},${o.viewport.height}`,
    // 人の端末の倍率で描く（高精細の画面の人の画面がにじまない）。窓の大きさは CSS ピクセルのまま。1 は付けない（人の
    // Chrome と同じ形）。ページから見える devicePixelRatio もこの値になる（session.ts の setViewport）
    ...(o.scale !== 1 ? [`--force-device-scale-factor=${o.scale}`] : []),
    "about:blank",
  ];
}

/** `ja-JP` → LANG `ja_JP.UTF-8`・LANGUAGE `ja_JP:ja`（Linux のブラウザは画面の言語と Intl をここから決める） */
export function localeEnv(locale: string): { LANG: string; LANGUAGE: string } {
  const [lang, region] = locale.split("-");
  const posix = region ? `${lang}_${region}` : lang!;
  return { LANG: `${posix}.UTF-8`, LANGUAGE: region ? `${posix}:${lang}` : posix };
}

/**
 * ブラウザの環境。**TMPDIR は短い所へ**——画面ありのブラウザは TMPDIR の下に UNIX ソケット（SingletonSocket）を作り、
 * パスが 108 バイトを越えると起きずに落ちる（実測・2026-10-10：banto が Module に渡す TMPDIR で落ちた）。
 * 字体の選び方は `FONTCONFIG_FILE`（fonts.ts——日本語を日本の字形で）
 */
export function chromeEnv(base: NodeJS.ProcessEnv, display: string, locale: string, timezone: string, fontconfigFile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  delete env.LC_ALL;
  delete env.LC_MESSAGES;
  const tmp = tmpdir();
  return { ...env, ...localeEnv(locale), DISPLAY: display, TZ: timezone, TMPDIR: tmp.length > 60 ? "/tmp" : tmp, FONTCONFIG_FILE: fontconfigFile };
}

/** 子が終わるのを待つ（もう終わっていればすぐ） */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * 起こしたブラウザと Xvfb。Module が終わるとき（例外で落ちるときも）に殺す——パイプで繋いでいないので、放っておくと残る。
 * SIGKILL で消えたときはここも走らない（次に起こすときの killStale が拾う）
 */
const live = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of live) child.kill("SIGKILL");
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

/**
 * 前の Module が残したものを止める：同じプロファイルを掴んだままのブラウザ（`SingletonLock` は `<host>-<pid>` を指す）と、
 * 前に立てた Xvfb。残したまま起こすと、新しいブラウザは前のブラウザに URL を渡して自分は終わってしまう
 */
export function killStale(profileDir: string, displayPidFile: string): string[] {
  const killed: string[] = [];
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(join(profileDir, "SingletonLock")))?.[1]);
    if (pid > 0 && alive(pid) && cmdline(pid).includes(profileDir)) {
      process.kill(pid, "SIGKILL");
      killed.push(`ブラウザ（pid ${pid}）`);
    }
  } catch {
    // 鍵が無い——掴んでいるブラウザは無い
  }
  if (existsSync(displayPidFile)) {
    const pid = Number(readFileSync(displayPidFile, "utf8").trim());
    if (pid > 0 && alive(pid) && /Xvfb/.test(cmdline(pid))) {
      process.kill(pid, "SIGKILL");
      killed.push(`Xvfb（pid ${pid}）`);
    }
    rmSync(displayPidFile, { force: true });
  }
  return killed;
}

/** Xvfb を立てる。空いている番号は Xvfb に選ばせる（`-displayfd`） */
/** 仮想の画面の大きさ（デバイスピクセル） */
export function screenPixels(scale: number): { width: number; height: number } {
  return { width: Math.round(SCREEN.width * scale), height: Math.round(SCREEN.height * scale) };
}

async function startDisplay(pidFile: string, scale: number): Promise<{ display: string; process: ChildProcess }> {
  let xvfb: ChildProcess;
  // 倍率を掛けて立てる——ページから見える screen（CSS ピクセル）が倍率に関わらず 1920×1080 になる（掛けないと 2 倍で
  // 960×540 になり、窓より小さな画面という人の機械に無い形になる）
  const px = screenPixels(scale);
  const size = `${px.width}x${px.height}x24`;
  try {
    xvfb = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", size, "-nolisten", "tcp"], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(`Host system is missing dependencies to run browsers（Xvfb を起こせません: ${(err as Error).message}）`);
  }
  let stderr = "";
  xvfb.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-2000)));
  const display = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`仮想の画面（Xvfb）が ${START_TIMEOUT_MS / 1000} 秒で立ちませんでした: ${stderr.trim()}`)), START_TIMEOUT_MS);
    xvfb.stdio[3]!.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(`:${out.trim()}`);
      }
    });
    xvfb.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // 入っていない——Playwright と同じ文言にして、launchWithInstall にライブラリ（Xvfb を含む）を入れさせる
      reject(err.code === "ENOENT" ? new Error("Host system is missing dependencies to run browsers（Xvfb がありません）") : err);
    });
    xvfb.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`仮想の画面（Xvfb）が立ち上がる前に終わりました（終了コード ${code}）: ${stderr.trim()}`));
    });
  });
  mkdirSync(join(pidFile, ".."), { recursive: true });
  writeFileSync(pidFile, String(xvfb.pid));
  return { display, process: xvfb };
}

/** ブラウザが CDP の口を開くまで待つ（プロファイルの `DevToolsActivePort` に番号を書く）。先に終わったら理由つきで投げる */
async function waitForPort(chrome: ChildProcess, profileDir: string, output: () => string): Promise<number> {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      // ライブラリが足りないときの文言（`error while loading shared libraries`）は launchWithInstall が見て入れる
      throw new Error(`ブラウザが立ち上がる前に終わりました（終了コード ${chrome.exitCode ?? chrome.signalCode}）: ${output().trim().slice(-1500)}`);
    }
    if (existsSync(file)) {
      const port = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (port > 0) return port;
    }
    if (Date.now() > deadline) throw new Error(`ブラウザが ${START_TIMEOUT_MS / 1000} 秒で CDP の口を開きませんでした: ${output().trim().slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 仮想の画面を立て、ブラウザを起こして繋ぐ。失敗したら起こしたものは全部止めてから投げる */
export async function startChrome(o: ChromeOptions, connect: (endpoint: string) => Promise<Browser>): Promise<RunningChrome> {
  if (!existsSync(o.executable)) throw new Error(`Executable doesn't exist at ${o.executable}`);
  const stale = killStale(o.profileDir, o.displayPidFile);
  if (stale.length > 0) console.error(`[browser] 前の Module が残したものを止めました: ${stale.join("・")}`);
  mkdirSync(o.profileDir, { recursive: true });
  rmSync(join(o.profileDir, "DevToolsActivePort"), { force: true });
  writeFontconfig(o.fontconfigFile, o.locale);
  const xvfb = await startDisplay(o.displayPidFile, o.scale);
  let chrome: ChildProcess | undefined;
  live.add(xvfb.process);
  /** 止める。graceMs はブラウザが自分で終わるのを待つ時間（越えたら SIGTERM、さらに越えたら SIGKILL） */
  const stopAll = async (graceMs: number) => {
    if (chrome && !(await exited(chrome, graceMs))) {
      chrome.kill("SIGTERM");
      if (!(await exited(chrome, STOP_TIMEOUT_MS))) chrome.kill("SIGKILL");
    }
    xvfb.process.kill("SIGTERM");
    live.delete(xvfb.process);
    if (chrome) live.delete(chrome);
    rmSync(o.displayPidFile, { force: true });
  };
  try {
    // 入れられるなら仕事の組（banto-work-jobs.slice）で起こす——メモリが尽きても組の中だけで止まる（work-scope の説明）
    const launch = inWorkScope(o.executable, chromeArgs(o), { kind: "browser", env: chromeEnv(process.env, xvfb.display, o.locale, o.timezone, o.fontconfigFile) });
    chrome = spawn(launch.command, launch.args, { env: launch.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (c: Buffer) => (output = (output + c.toString()).slice(-8000));
    chrome.stdout!.on("data", take);
    chrome.stderr!.on("data", take);
    const spawned = chrome;
    live.add(spawned);
    // ブラウザが自分で終わった（落ちた）——画面も止める。Module のログに残す
    spawned.once("exit", (code, signal) => {
      xvfb.process.kill("SIGTERM");
      rmSync(o.displayPidFile, { force: true });
      console.error(`[browser] ブラウザが終わりました（${code ?? signal}）`);
    });
    const port = await waitForPort(spawned, o.profileDir, () => output);
    const browser = await connect(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("ブラウザに繋いだが、プロファイルの文脈がありません");
    return {
      browser,
      context,
      display: xvfb.display,
      screen: screenPixels(o.scale),
      async close() {
        // 閉じてもらう（プロファイルを書き終えてから終わる）。返事を待たずに終わるので、終わるのを待つ
        await browser
          .newBrowserCDPSession()
          .then((s) => s.send("Browser.close"))
          .catch(() => undefined); // もう繋がっていない——下で殺す
        await stopAll(STOP_TIMEOUT_MS);
        await browser.close().catch(() => undefined);
      },
    };
  } catch (err) {
    await stopAll(0);
    throw err;
  }
}
