/**
 * 本物の chromium を起こす `BrowserLauncher` 実装（K2）。
 *
 * **playwright は import しない**。理由は2つ——①追加依存ゼロという設計の前提
 * （`playwright` は devDependency で、`NODE_ENV=production` の職人プロセスでは
 * devDependencies ごと消える事故が実際に起きている） ②要るのは同梱 chromium バイナリの
 * **パスだけ**で、playwright の API そのものは要らない。だから playwright が
 * `~/.cache/ms-playwright` に落とすキャッシュを自前で探す。
 *
 * この1ファイルに4つの段がある——①実行ファイルの探索 ②起動引数の組み立て
 * ③CDP の口（page ターゲット）を掴む ④起こす・落とす・アイドル TTL。
 * ①②③は副作用を切り離した純関数（または注入されたI/Oだけを触る関数）にして、
 * 偽のファイル木・偽の HTTP エンドポイント・偽のプロセスで試験できるようにしてある。
 *
 * I2: どの段階で失敗しても、起こしたプロセスを残さず・何が起きたかを言って落ちる。
 * D5: 判断はここに閉じている。呼び出し側（`session.ts`）は `BrowserLauncher` 契約しか知らない。
 */

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserLauncher, LaunchRequest, LaunchedBrowser } from "./launcher.js";

// ── 既定値（定数はここ1箇所） ────────────────────────────────────────────────

export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
/** `DevToolsActivePort` が書かれるのを待つ上限。 */
export const CHROMIUM_HANDSHAKE_TIMEOUT_MS = 30_000;
/** `SIGTERM` を送ってから `SIGKILL` するまでの猶予。 */
export const CHROMIUM_CLOSE_GRACE_MS = 5_000;

// ── 1. 実行ファイルの探索（純関数） ──────────────────────────────────────────

export interface FindChromiumExecutableOptions {
  /** `BANTO_BROWSER_EXECUTABLE` の値。既定は `process.env.BANTO_BROWSER_EXECUTABLE`。 */
  executableEnv?: string | undefined;
  /** playwright キャッシュの親（`~/.cache` に相当）。既定は `os.homedir()`。試験用。 */
  homeDir?: string;
  /** `PATH`。既定は `process.env.PATH`。試験用。 */
  pathEnv?: string | undefined;
  /** パスの存在確認。既定は `fs.existsSync`。試験用に差し替え可能。 */
  exists?: (candidate: string) => boolean;
  /** ディレクトリの中身（無ければ空配列）。既定は `fs.readdirSync`。試験用に差し替え可能。 */
  listDir?: (dir: string) => string[];
}

export interface ChromiumExecutable {
  path: string;
  source: "env" | "playwright-cache" | "path";
}

const PLAYWRIGHT_CHROMIUM_DIR_PATTERN = /^chromium-(\d+)$/;

/**
 * playwright がキャッシュへ落とす chromium 本体の入ったディレクトリ名。
 * `chrome-linux64`（x64・実機で確認済み）を優先し、`chrome-linux`（他アーキテクチャ向け）も
 * フォールバックで試す——後者は設計時の想定で、この作業を動かした実機には無かった
 * （x64 の playwright は `chrome-linux64` を使う）。
 */
const PLAYWRIGHT_CHROMIUM_CONTENT_DIRS = ["chrome-linux64", "chrome-linux"];

const PATH_EXECUTABLE_NAMES = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
];

function defaultExists(candidate: string): boolean {
  return fs.existsSync(candidate);
}

function defaultListDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * chromium の実行ファイルを探す（純関数）。
 *
 * 優先順: ①`BANTO_BROWSER_EXECUTABLE` ②playwright キャッシュ（`chromium-<revision>` の
 * うち revision が**数値として**最大のもの。`chromium_headless_shell-*` は選ばない）
 * ③`PATH`。どれも見つからなければ、探した場所を全部並べて失敗する（I2）。
 */
export function findChromiumExecutable(
  options: FindChromiumExecutableOptions = {}
): ChromiumExecutable {
  const exists = options.exists ?? defaultExists;
  const listDir = options.listDir ?? defaultListDir;
  const tried: string[] = [];

  // ① 環境変数——指定があれば、そこに無くても他の候補へは落ちない
  const executableEnv = options.executableEnv ?? process.env["BANTO_BROWSER_EXECUTABLE"];
  if (executableEnv) {
    if (exists(executableEnv)) return { path: executableEnv, source: "env" };
    throw new Error(
      `BANTO_BROWSER_EXECUTABLE で指定された chromium がありません: ${executableEnv}`
    );
  }

  // ② playwright キャッシュ——revision は文字列比較ではなく数値の大小で選ぶ
  //    （"chromium-999" > "chromium-1200" になってしまうため）
  const cacheDir = path.join(options.homeDir ?? os.homedir(), ".cache", "ms-playwright");
  const revisions = listDir(cacheDir)
    .map((name) => {
      const m = PLAYWRIGHT_CHROMIUM_DIR_PATTERN.exec(name);
      return m && m[1] !== undefined ? { name, revision: Number(m[1]) } : undefined;
    })
    .filter((entry): entry is { name: string; revision: number } => entry !== undefined)
    .sort((a, b) => b.revision - a.revision);
  for (const { name } of revisions) {
    for (const contentDir of PLAYWRIGHT_CHROMIUM_CONTENT_DIRS) {
      const candidate = path.join(cacheDir, name, contentDir, "chrome");
      tried.push(candidate);
      if (exists(candidate)) return { path: candidate, source: "playwright-cache" };
    }
  }

  // ③ PATH
  const pathEnv = options.pathEnv ?? process.env["PATH"] ?? "";
  const pathDirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
  for (const name of PATH_EXECUTABLE_NAMES) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      tried.push(candidate);
      if (exists(candidate)) return { path: candidate, source: "path" };
    }
  }

  throw new Error(
    "chromium の実行ファイルが見つかりません。探した場所:\n" +
      tried.map((p) => `  - ${p}`).join("\n")
  );
}

// ── 2. 起動引数の組み立て（純関数） ──────────────────────────────────────────

export interface BuildChromiumArgsOptions {
  /** 起動ごとの一時 user-data-dir（絶対パス）。 */
  userDataDir: string;
  width?: number;
  height?: number;
  /** 最初に開く URL。既定は `about:blank`。 */
  url?: string;
  /** `DISPLAY` の値。無ければ（`undefined`）headless にする。 */
  display?: string | undefined;
  /** true のときだけ `--no-sandbox` を足す。既定 false。 */
  allowNoSandbox?: boolean;
}

/**
 * chromium の起動引数を組み立てる（純関数）。**ここに無い引数を思いつきで足さない**——
 * 足すならなぜ要るのかをコメントに書く。
 */
export function buildChromiumArgs(options: BuildChromiumArgsOptions): string[] {
  const width = options.width ?? DEFAULT_WINDOW_WIDTH;
  const height = options.height ?? DEFAULT_WINDOW_HEIGHT;

  const args = [
    // ポートは固定しない——他所と衝突する。実ポートは DevToolsActivePort から読む
    "--remote-debugging-port=0",
    // 外に出さない
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
  ];
  // DISPLAY があれば headful（PO が窓を見て触る）。無ければ headless。
  // Xvfb をここで起こすことはしない——あるものに乗るだけ
  if (!options.display) args.push("--headless=new");
  // 2026-08-16 の判定：既定では絶対に付けない。BANTO_BROWSER_ALLOW_NO_SANDBOX=1 が
  // 明示的に立っているときだけ（launch() 側で判定済みのものを受け取るだけ）——
  // 黙って危ない側に倒れない
  if (options.allowNoSandbox) args.push("--no-sandbox");
  args.push(options.url ?? "about:blank");
  return args;
}

// ── 3. CDP の口を掴む ─────────────────────────────────────────────────────

export type DevToolsActivePort =
  | { ready: true; port: number; browserPath: string }
  | { ready: false };

/**
 * `DevToolsActivePort` の中身を解釈する（純関数）。1行目＝ポート番号、2行目＝
 * `/devtools/browser/<id>`。**書き込み途中（1行しか無い・空）は例外にせず `ready: false`
 * を返す**——呼び出し側が待ち直せるように（I2：読めない状態を例外で潰さない）。
 */
export function parseDevToolsActivePort(content: string): DevToolsActivePort {
  const lines = content.split("\n");
  const portLine = lines[0]?.trim();
  const pathLine = lines[1]?.trim();
  if (!portLine || !pathLine) return { ready: false };
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0) return { ready: false };
  return { ready: true, port, browserPath: pathLine };
}

interface DevToolsTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

function requestDevToolsJson(method: string, url: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * page ターゲットの CDP の口を掴む。
 *
 * `session.ts` は繋いだ接続に `sessionId` を付けず `Page.enable` / `Page.startScreencast` を
 * 送る。ブラウザ級のエンドポイント（`/devtools/browser/<id>`）へ繋ぐと `Page.*` は通らず
 * 面が真っ黒のまま何も起きない（K2 実測）——だから必ず page ターゲットの口を返す。
 */
export async function discoverPageWebSocketUrl(
  httpBaseUrl: string,
  initialUrl?: string
): Promise<string> {
  const list = await requestDevToolsJson("GET", `${httpBaseUrl}/json/list`);
  const targets = Array.isArray(list.body) ? (list.body as DevToolsTarget[]) : [];
  const page = targets.find((t) => t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
  if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;

  const newTargetUrl = `${httpBaseUrl}/json/new?url=${encodeURIComponent(initialUrl ?? "about:blank")}`;
  let created = await requestDevToolsJson("GET", newTargetUrl);
  // 405 を返す chromium 版がある。GET が拒まれたら PUT で叩き直す
  if (created.status === 405) created = await requestDevToolsJson("PUT", newTargetUrl);

  const body = created.body as DevToolsTarget | undefined;
  if (!body || typeof body.webSocketDebuggerUrl !== "string") {
    throw new Error(
      `chromium から page ターゲットの CDP の口を取得できませんでした（${httpBaseUrl}）`
    );
  }
  return body.webSocketDebuggerUrl;
}

// ── 4. 起こす・落とす ────────────────────────────────────────────────────

export interface SpawnChromiumContext {
  executablePath: string;
  args: string[];
  userDataDir: string;
  /** 子プロセスへ渡す環境変数。`CHROME_DEVEL_SANDBOX`（分かるときだけ）等が乗る。 */
  env: NodeJS.ProcessEnv;
}

export type SpawnChromiumFn = (ctx: SpawnChromiumContext) => childProcess.ChildProcess;

function defaultSpawnChromium(ctx: SpawnChromiumContext): childProcess.ChildProcess {
  // detached: true でプロセスグループを作る。chromium はレンダラ等の子を生やすので、
  // 親だけを落としても孤児が残る——close() はグループごと落とす。
  // stderr は pipe——起動に失敗したとき「本当の理由」を言うのに要る（I2）
  return childProcess.spawn(ctx.executablePath, ctx.args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: ctx.env,
  });
}

const SETUID_BIT = 0o4000;

export interface ResolveSandboxEnvOptions {
  /** 実行ファイルの隣の `chrome_sandbox` を確かめる。既定は `fs.statSync`。試験用。 */
  stat?: (candidate: string) => fs.Stats;
  /** 呼び出し元に既にある env（`CHROME_DEVEL_SANDBOX` があれば尊重して上書きしない）。既定は `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 同梱の setuid sandbox helper（`chrome_sandbox`）の在り処を chromium に教える。
 *
 * chromium は実行ファイルの隣を**自動では探さない**——見るのは環境変数
 * `CHROME_DEVEL_SANDBOX` か、ビルド時に埋め込まれた既定（`/usr/local/sbin/chrome-devel-sandbox`）
 * だけ。だから「隣に置いてあるだけ」では使われない（2026-08-16 に実機で踏んだ）。
 *
 * **setuid root でないヘルパを指すと、chromium は「SUID サンドボックスが正しくない」と言って
 * 起動を拒む**——だから root 所有かつ setuid ビットが立っているときだけ足す（純関数、試験可能）。
 */
export function resolveSandboxEnv(
  executablePath: string,
  options: ResolveSandboxEnvOptions = {}
): Record<string, string> {
  const env = options.env ?? process.env;
  if (env["CHROME_DEVEL_SANDBOX"]) return {}; // 呼び出し元の指定を尊重し、上書きしない

  const stat = options.stat ?? ((candidate: string) => fs.statSync(candidate));
  const sandboxHelper = path.join(path.dirname(executablePath), "chrome_sandbox");
  let stats: fs.Stats;
  try {
    stats = stat(sandboxHelper);
  } catch {
    return {};
  }
  const isSetuidRoot = stats.uid === 0 && (stats.mode & SETUID_BIT) !== 0;
  if (!isSetuidRoot) return {};
  return { CHROME_DEVEL_SANDBOX: sandboxHelper };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM"; // 存在はする（権限が無いだけ）
  }
}

/** プロセスグループへ送る。グループが無ければ（既に居ない等）単体へフォールバック。 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 既に居ない
    }
  }
}

/** プロセスグループごと落とす。冪等（既に落ちていれば何もしない）。 */
async function killProcessGroup(pid: number, graceMs: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  signalProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isProcessAlive(pid)) signalProcessGroup(pid, "SIGKILL");
}

/** ホストが終わるときに孤児を残さないための、生きている chromium の pid 台帳。 */
const livePids = new Set<number>();
let exitHookInstalled = false;

function ensureExitHookInstalled(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // exit ハンドラは非同期を待てない——同期でできる範囲（SIGTERM を投げるだけ）に留める。
  // 猶予や SIGKILL・一時ディレクトリの掃除まではできないが、孤児化だけは防げる
  process.on("exit", () => {
    for (const pid of livePids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // 既に居ない
      }
    }
  });
}

/** `proc.exit` の中身。子が終了していなければ `undefined`。 */
export interface ProcessExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** chromium の stderr を末尾だけ溜める（全部は持たない）。 */
function tailStderr(proc: childProcess.ChildProcess, maxChars = 4_000): () => string {
  let buf = "";
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    buf += chunk.toString();
    if (buf.length > maxChars) buf = buf.slice(buf.length - maxChars);
  });
  return () => buf;
}

const NO_SANDBOX_ERROR_PATTERN = /No usable sandbox/;

/** 「選ばれた実行ファイルの隣の chrome_sandbox」を実行時に解決した絶対パスで案内する。 */
function buildSandboxHint(executablePath: string): string {
  const sandboxHelper = path.join(path.dirname(executablePath), "chrome_sandbox");
  return (
    "サンドボックスが使えません。次のどちらかで対処してください:\n" +
    `  1) 同梱の setuid ヘルパを有効にする（要 root）: ` +
    `sudo chown root:root ${sandboxHelper} && sudo chmod 4755 ${sandboxHelper}\n` +
    "  2) 危険性を理解した上で、環境変数 BANTO_BROWSER_ALLOW_NO_SANDBOX=1 を立てて " +
    "--no-sandbox を明示的に許可する"
  );
}

/** stderr の末尾（あれば）と、サンドボックス絡みならその逃げ道を失敗メッセージへ足す。 */
function appendStderrDetail(message: string, stderr: string, executablePath: string): string {
  if (!stderr) return message;
  let detail = `${message}\n--- chromium stderr（末尾） ---\n${stderr}`;
  if (NO_SANDBOX_ERROR_PATTERN.test(stderr)) {
    detail += `\n${buildSandboxHint(executablePath)}`;
  }
  return detail;
}

async function waitForDevToolsActivePort(
  userDataDir: string,
  timeoutMs: number,
  executablePath: string,
  checkExited: () => ProcessExitInfo | undefined,
  readStderrTail: () => string
): Promise<{ port: number; browserPath: string }> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // I2: 30秒待たず、死んだと分かった時点ですぐ・本当の理由で失敗する
    const exitInfo = checkExited();
    if (exitInfo) {
      const reason = exitInfo.signal
        ? `シグナル ${exitInfo.signal} で終了`
        : `終了コード ${exitInfo.code} で終了`;
      throw new Error(
        appendStderrDetail(
          `chromium が CDP の口を掴む前に${reason}しました`,
          readStderrTail(),
          executablePath
        )
      );
    }
    let content: string | undefined;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      content = undefined;
    }
    if (content !== undefined) {
      const parsed = parseDevToolsActivePort(content);
      if (parsed.ready) return parsed;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        appendStderrDetail(
          `chromium が ${timeoutMs}ms 以内に DevToolsActivePort を書きませんでした（${file}）`,
          readStderrTail(),
          executablePath
        )
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface ChromiumLauncherOptions {
  /** 実行ファイルの探索を省き、直接指定する（試験用）。省略時は `findChromiumExecutable()`。 */
  executablePath?: string;
  /** プロセスを起こす関数（試験用に差し替え）。既定は `child_process.spawn`。 */
  spawn?: SpawnChromiumFn;
  /** 一時 user-data-dir の親。既定は `os.tmpdir()`。試験用。 */
  tmpRoot?: string;
  /** `DevToolsActivePort` を待つ上限。既定 `CHROMIUM_HANDSHAKE_TIMEOUT_MS`。 */
  handshakeTimeoutMs?: number;
  /** `SIGTERM` → `SIGKILL` の猶予。既定 `CHROMIUM_CLOSE_GRACE_MS`。 */
  closeGraceMs?: number;
  /** `BANTO_BROWSER_ALLOW_NO_SANDBOX` の値。既定は `process.env.BANTO_BROWSER_ALLOW_NO_SANDBOX`。試験用。 */
  allowNoSandboxEnv?: string | undefined;
  /** `allowNoSandboxEnv` 省略時に読む env。既定は `process.env`。試験用。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 本物の chromium を起こす `BrowserLauncher`。`createBrowserModule()` の既定の launcher。
 */
export function createChromiumLauncher(options: ChromiumLauncherOptions = {}): BrowserLauncher {
  const spawnChromium = options.spawn ?? defaultSpawnChromium;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? CHROMIUM_HANDSHAKE_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? CHROMIUM_CLOSE_GRACE_MS;
  const tmpRoot = options.tmpRoot ?? os.tmpdir();

  return {
    name: "chromium",

    async launch(request: LaunchRequest): Promise<LaunchedBrowser> {
      ensureExitHookInstalled();

      const executablePath = options.executablePath ?? findChromiumExecutable().path;
      const userDataDir = fs.mkdtempSync(path.join(tmpRoot, "banto-browser-"));
      const cleanupDir = (): void => {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      };

      // 2026-08-16 の判定：既定はサンドボックス有効。BANTO_BROWSER_ALLOW_NO_SANDBOX=1 が
      // 明示的に立っているときだけ --no-sandbox を許す（黙って危ない側に倒れない）
      const allowNoSandboxEnv =
        options.allowNoSandboxEnv ?? (options.env ?? process.env)["BANTO_BROWSER_ALLOW_NO_SANDBOX"];
      const sandboxDisabled = allowNoSandboxEnv === "1";
      if (sandboxDisabled) {
        console.warn(
          "[browser] サンドボックス無効で起動しています（BANTO_BROWSER_ALLOW_NO_SANDBOX=1）"
        );
      }

      const args = buildChromiumArgs({
        userDataDir,
        display: process.env["DISPLAY"],
        allowNoSandbox: sandboxDisabled,
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {}),
        ...(request.url !== undefined ? { url: request.url } : {}),
      });

      // 同梱の setuid sandbox helper が使えるなら、chromium に教える（隣に置くだけでは
      // chromium は見ない——CHROME_DEVEL_SANDBOX で明示する必要がある）
      const sandboxEnv = resolveSandboxEnv(executablePath);
      const proc = spawnChromium({
        executablePath,
        args,
        userDataDir,
        env: { ...process.env, ...sandboxEnv },
      });
      proc.on("error", (err: Error) => {
        console.error(`[browser] chromium プロセスで異常: ${err.message}`);
      });
      const readStderrTail = tailStderr(proc);
      let exitInfo: ProcessExitInfo | undefined;
      proc.once("exit", (code, signal) => {
        exitInfo = { code, signal };
      });

      const pid = proc.pid;
      if (pid === undefined) {
        cleanupDir();
        throw new Error(`chromium プロセスを起こせませんでした（${executablePath}）`);
      }
      livePids.add(pid);

      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await killProcessGroup(pid, closeGraceMs);
        livePids.delete(pid);
        cleanupDir();
      };

      try {
        const { port } = await waitForDevToolsActivePort(
          userDataDir,
          handshakeTimeoutMs,
          executablePath,
          () => exitInfo,
          readStderrTail
        );
        const webSocketDebuggerUrl = await discoverPageWebSocketUrl(
          `http://127.0.0.1:${port}`,
          request.url
        );
        return {
          webSocketDebuggerUrl,
          close,
          sandbox: sandboxDisabled ? "disabled" : "enabled",
        };
      } catch (err) {
        // I2: 期限内に口を掴めなかった／page ターゲットが取れなかったら、
        // 起こしたプロセスを残さず片付けてから失敗させる
        await close();
        throw err;
      }
    },
  };
}
