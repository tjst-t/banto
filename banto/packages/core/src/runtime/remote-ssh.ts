// **実行場所の2つ目——SSH で入る別のサーバ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「Project の実行場所——
// 別のサーバ」、Backlog `remote-runtime-ssh`）。
//
// Project ごとに **SSH の接続を1本**（`ControlMaster`）張り、その上に Module の標準入出力（Module ごとのセッション）と
// **逆向きのトンネル1本**（向こうの 127.0.0.1 → host の中継だけを受ける専用の待ち受け）を載せる。繋ぐときに：
//   1. 前提を確かめる（`probePrerequisites`。足りなければ名指しして直し方つきで断る。linger・tmux が無いのは注意だけ）
//   2. 接続を張る（`-M -N -R 0:127.0.0.1:<待ち受け>`。向こうの側のポートは sshd に選ばせる）
//   3. banto のコードを照合し、違えば新しい置き場に展開して切り替える（`remote-code.ts`。前の版を1つ残す）
//
// Module は起動役（`remote-launcher.ts`）を通して、向こうのユーザーの systemd の単位で包んで起こす。落とすときは標準入出力を
// 閉じたうえで `systemctl --user stop`。接続が切れたら、その上の Module は落ちたものとして扱われ（多重化したセッションが
// 一緒に閉じる）、次に要るときに繋ぎ直す——起動役が、残っていた前の Module を止めてから起こす（二重に動かない）。
//
// **向こうで sudo しない**。root が要る準備は人が行う。

import { coreSocketDir } from "./socket-dir.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { syncShellHome } from "../modules/shell-home.js";
import { SingleFlight } from "../modules/single-flight.js";
import { ensureSocketDir } from "./host-container.js";
import {
  REMOTE_LAUNCHER_REL,
  REMOTE_NODE_REL,
  FileHashCache,
  bundleDigest,
  collectCodeBundle,
  collectTreeEntries,
  remoteDigestCommand,
  tarList,
  type BundleEntry,
} from "./remote-code.js";
import { remoteAddress, type LookupIPv4 } from "./remote-address.js";
import { REMOTE_LAUNCHER_SCRIPT, moduleUnitName, type LauncherRequest } from "./remote-launcher.js";
import type { RemoteRuntimes } from "./remote-runtimes.js";
import type { RemoteRuntime } from "./remote-store.js";
import type { PlaceAddress, PreparedPlace, RuntimePlace, RuntimeProcess } from "./runtime.js";
import {
  SshCommandError,
  probePrerequisites,
  remotePathExpr,
  shq,
  sshArgs,
  sshEnv,
  type RuntimeCheck,
  type SshResult,
} from "./ssh.js";

/** Unix ソケットのパスの上限（`sun_path`）。ssh は ControlPath に一時の名前（17 字）を足して作る */
const SOCKET_PATH_LIMIT = 107;
const CONTROL_PATH_SUFFIX = 17;

export interface RemoteSshRuntimeOptions {
  dataDir: string;
  /** banto のコードの置き場（モノレポの根）。ここから Module に要る分を送る */
  monorepoRoot: string;
  runtimes: RemoteRuntimes;
  /** その Project の実行場所（別のサーバ）の名前。別のサーバでなければ undefined */
  remoteNameOf(projectId: string): string | undefined;
  /** 中継だけを受ける専用の待ち受けを作る（実行場所ごとに1つ。受ける Project は待ち受けが聞くたびに引く） */
  createRelayListener(runtimeName: string): Server;
  /** Shell のホームへ写す元（既定は人のホーム。E2E だけが差し替える） */
  shellHomeSource?: string;
  /** 注意（linger・tmux が無い）を受信箱へ。同じものが開いている間は増やさない（`dedupeKey`） */
  notify(n: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  /** ログ（既定は console） */
  log?: (line: string) => void;
  /** 宛先の名前を IPv4 に引く（既定は host の名前引き。試験だけが差し替える） */
  lookupIPv4?: LookupIPv4;
}

/** 張っている接続1本 */
interface Connection {
  runtimeName: string;
  runtime: RemoteRuntime;
  controlPath: string;
  knownHostsFile: string;
  master: ChildProcess;
  alive: boolean;
  /** 向こうの 127.0.0.1 の、逆向きのトンネルのポート */
  remotePort: number;
  /** 向こうの、この banto の置き場（絶対パス） */
  base: string;
  /** 向こうの、いま使う版のコードの置き場（絶対パス） */
  codeDir: string;
  checks: RuntimeCheck[];
  exited: Promise<void>;
}

/** 起動役に最初の1行を渡してから MCP を流す口。閉じたあとに向こうの単位を止める */
class LauncherTransport extends StdioClientTransport {
  private stderrTail = "";

  constructor(
    params: StdioServerParameters,
    private readonly prelude: LauncherRequest,
    private readonly afterClose: () => Promise<void>,
    label: string,
  ) {
    super({ ...params, stderr: "pipe" });
    // 向こうの Module・起動役・ssh の言葉は host のログに出し、起こせなかったときの理由に添える
    this.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-2000);
      for (const line of text.split("\n")) if (line.trim()) console.error(`[${label}] ${line}`);
    });
  }

  /** 最後に出た標準エラー（起こせなかったときに理由として添える） */
  lastStderr(): string {
    return this.stderrTail.trim();
  }

  override async start(): Promise<void> {
    await super.start();
    // 最初の1行は JSON（MCP のやり取りと同じく1行の JSON にする——`send` が改行まで書く）。
    // `send` は JSON-RPC の形を見ないので、起動役への1行をそのまま渡せる
    await super.send(this.prelude as unknown as Parameters<StdioClientTransport["send"]>[0]);
  }

  override async close(): Promise<void> {
    await super.close();
    await this.afterClose();
  }
}

export class RemoteSshRuntime {
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new SingleFlight<Connection>();
  private readonly listeners = new Map<string, { server: Server; port: number }>();
  private readonly hashes = new FileHashCache();
  private readonly log: (line: string) => void;
  private readonly launcherPath: string;

  constructor(private readonly opts: RemoteSshRuntimeOptions) {
    this.log = opts.log ?? ((line) => console.log(line));
    // 起動役は banto のコードと一緒に送る（版の鍵に入る）。host の置き場に中身どおりの名前で書いておく
    const dir = join(opts.dataDir, "remote-runtimes", ".launcher");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.launcherPath = join(dir, `banto-launcher-${createHash("sha256").update(REMOTE_LAUNCHER_SCRIPT).digest("hex").slice(0, 12)}.mjs`);
    if (!existsSync(this.launcherPath)) writeFileSync(this.launcherPath, REMOTE_LAUNCHER_SCRIPT, { mode: 0o644 });
  }

  /** その Project が別のサーバで動くか */
  handles(placeId: string): boolean {
    return this.opts.remoteNameOf(placeId) !== undefined;
  }

  async prepare(place: RuntimePlace): Promise<PreparedPlace> {
    const name = this.opts.remoteNameOf(place.id);
    if (!name) throw new Error(`${place.id} は別のサーバの Project ではありません`);
    const conn = await this.ensureConnection(name, place);
    return this.preparedFrom(conn);
  }

  /**
   * 外から向こうのサービスに届くアドレス（Publish）：登録した宛先の LAN のアドレス。繋がない——向こうのサービスには
   * SSH を通さず LAN から直に届くので、届くかは公開の実装がそのポートで確かめる
   */
  address(projectId: string): Promise<PlaceAddress> {
    const name = this.opts.remoteNameOf(projectId);
    if (!name) throw new Error(`${projectId} は別のサーバの Project ではありません`);
    return remoteAddress(name, this.opts.runtimes.get(name)?.host, this.opts.lookupIPv4);
  }

  /** 接続が切れていれば、次に要るときに繋ぎ直す（繋がっていれば何もしない——Module が1つ落ちただけで全部を張り直さない） */
  forget(placeId: string): void {
    const name = this.opts.remoteNameOf(placeId);
    const conn = name ? this.connections.get(name) : undefined;
    if (conn && !conn.alive) this.connections.delete(conn.runtimeName);
  }

  /** 手放す：接続を閉じる（Module は呼び元が先に落としている。向こうの機械は止めない） */
  async release(placeId: string): Promise<void> {
    const name = this.opts.remoteNameOf(placeId);
    const conn = name ? this.connections.get(name) : undefined;
    if (!conn) return;
    this.connections.delete(conn.runtimeName);
    if (conn.alive) {
      conn.master.kill("SIGTERM");
      await conn.exited;
    }
  }

  /** 終わるとき：張っている接続を全部閉じる */
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map(async (c) => {
      if (c.alive) {
        c.master.kill("SIGTERM");
        await c.exited;
      }
    }));
    this.connections.clear();
  }

  /** プロセスが終わるとき（同期で）：張っている接続の ssh を落とす */
  killAll(): void {
    for (const c of this.connections.values()) if (c.alive) c.master.kill("SIGTERM");
  }

  // ── 接続 ────────────────────────────────────────────────────────────────

  private async ensureConnection(name: string, place: RuntimePlace): Promise<Connection> {
    const existing = this.connections.get(name);
    if (existing?.alive) {
      this.refuseUnusable(existing, place);
      return existing;
    }
    const conn = await this.connecting.run(name, () => this.connect(name, place));
    this.refuseUnusable(conn, place);
    return conn;
  }

  /** 繋いだ接続でも、この Project の設定では使えない（中で Docker を使うのに docker が無い）なら断る */
  private refuseUnusable(conn: Connection, place: RuntimePlace): void {
    const docker = conn.checks.find((c) => c.id === "docker");
    if (place.nesting && docker && docker.status !== "ok") {
      throw new Error(
        `別のサーバ「${conn.runtimeName}」で Module を起こせません——この Project は「中で Docker を使う」設定ですが、` +
          `${docker.detail ?? "Docker が使えません。"}（直し方：${docker.fix ?? "向こうで Docker を入れる"}）`,
      );
    }
  }

  private async connect(name: string, place: RuntimePlace): Promise<Connection> {
    const listener = await this.listenerFor(name);
    const started = performance.now();
    const conn = await this.opts.runtimes.withConnection(name, async (r, files) => {
      // 1. 前提を確かめる（Module を起こす前に。v4-security.md §1「前提の確かめ」）
      const { checks, result } = await probePrerequisites(r, files, r.hostKey.type, r.dataRoot);
      if (checks.length === 0) throw new SshCommandError(`${r.user}@${r.host} に繋げませんでした`, result);
      await this.opts.runtimes.recordChecks(name, checks);
      const failed = checks.filter((c) => c.status === "fail");
      if (failed.length > 0) {
        throw new Error(
          `別のサーバ「${name}」で Module を起こせません——前提が足りません：` +
            failed.map((c) => `${c.label}：${c.detail ?? "足りません"}${c.fix ? `（直し方：${c.fix.replace(/\n/g, " ")}）` : ""}`).join(" ／ "),
        );
      }

      // 2. 接続を1本張る（多重化・逆向きのトンネル）
      const controlPath = this.controlPathFor(name);
      rmSync(controlPath, { force: true });
      const master = spawn(
        "ssh",
        [
          ...sshArgs(r, files, r.hostKey.type),
          "-M",
          "-N",
          "-o", `ControlPath=${controlPath}`,
          "-o", "ControlPersist=no",
          "-o", "ExitOnForwardFailure=yes",
          "-R", `0:127.0.0.1:${listener.port}`,
          "--",
          r.host,
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: sshEnv() },
      );
      const { remotePort, exited, stderrTail } = await waitMasterReady(master, controlPath);
      const conn: Connection = {
        runtimeName: name,
        runtime: r,
        controlPath,
        knownHostsFile: files.knownHostsFile,
        master,
        alive: true,
        remotePort,
        base: "",
        codeDir: "",
        checks,
        exited,
      };
      void exited.then(() => {
        conn.alive = false;
        if (this.connections.get(name) === conn) this.connections.delete(name);
        const why = stderrTail().split("\n").filter((l) => l.trim() && !/^Allocated port/.test(l)).slice(-3).join(" ");
        this.log(`[host] 別のサーバ「${name}」との SSH の接続が閉じました（終了コード ${master.exitCode ?? master.signalCode}${why ? `：${why}` : ""}）`);
      });
      try {
        // 3. 向こうの置き場を決め、コードを照合する
        conn.base = await this.resolveBase(conn);
        conn.codeDir = await this.syncCode(conn);
      } catch (err) {
        master.kill("SIGTERM");
        await exited;
        throw err;
      }
      return conn;
    });
    // **鍵の窓口は閉じない**（未実装・2026-10-10）：Vault に窓口を閉じる口がまだ無い。多重化した接続は張ったあと鍵を使わない
    this.connections.set(name, conn);
    this.raiseCautions(conn, place);
    this.log(
      `[host] 別のサーバ「${name}」に繋ぎました（${Math.round(performance.now() - started)}ms・向こうの 127.0.0.1:${conn.remotePort} → 中継の待ち受け 127.0.0.1:${listener.port}・コード ${basename(conn.codeDir)}）`,
    );
    return conn;
  }

  /** ControlPath（短く——Unix ソケットの上限に ssh の一時の名前を足して収まること） */
  private controlPathFor(name: string): string {
    const dir = coreSocketDir(this.opts.dataDir);
    const path = join(dir, `cm-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`);
    if (Buffer.byteLength(path) + CONTROL_PATH_SUFFIX > SOCKET_PATH_LIMIT) {
      throw new Error(
        `SSH の接続の窓口のパスが長すぎて作れません（${path}。Unix ソケットは ${SOCKET_PATH_LIMIT} バイトまで）——banto のデータの置き場を短いパスにしてください`,
      );
    }
    return path;
  }

  /** 実行場所ごとの、中継だけを受ける待ち受け（127.0.0.1。繋ぎ直しても同じポートを使い続ける） */
  private async listenerFor(name: string): Promise<{ server: Server; port: number }> {
    const existing = this.listeners.get(name);
    if (existing) return existing;
    const server = this.opts.createRelayListener(name);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    const entry = { server, port: (server.address() as AddressInfo).port };
    this.listeners.set(name, entry);
    return entry;
  }

  /** linger・tmux が無いことは断らず、受信箱に注意を出す */
  private raiseCautions(conn: Connection, place: RuntimePlace): void {
    for (const id of ["linger", "tmux"]) {
      const c = conn.checks.find((x) => x.id === id);
      if (!c || c.status !== "warn") continue;
      void this.opts
        .notify({
          projectId: place.id,
          dedupeKey: `remote-runtime-caution:${place.id}:${id}`,
          title: `別のサーバ「${conn.runtimeName}」：${c.label}`,
          detail: `${c.detail ?? ""}${c.fix ? ` 直し方（向こうで）：${c.fix}` : ""}`.trim(),
        })
        .catch((err: unknown) => this.log(`[host] 注意を受信箱に出せませんでした: ${String(err)}`));
    }
  }

  // ── 多重化した接続の上で流す ─────────────────────────────────────────────

  /** 多重化した接続を使う ssh の引数（宛先の手前まで）。親が居なければ繋がずに落ちる（鍵を持たない） */
  private muxArgs(conn: Connection): string[] {
    const r = conn.runtime;
    return [
      "-F", "/dev/null",
      "-o", `ControlPath=${conn.controlPath}`,
      "-o", "ControlMaster=no",
      "-o", `UserKnownHostsFile=${conn.knownHostsFile}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "HostKeyAlias=banto-runtime",
      "-o", "ForwardAgent=no",
      "-o", "ForwardX11=no",
      "-o", "IdentitiesOnly=yes",
      "-o", "IdentityAgent=none",
      "-o", "IdentityFile=none",
      "-o", "BatchMode=yes",
      // 親が居なければ、素の接続に落ちずにここで終わる（鍵も持たないので「Permission denied」という別の理由に化ける）
      "-o", "ProxyCommand=false",
      "-p", String(r.port),
      "-l", r.user,
      "-T",
    ];
  }

  /** 向こうで台本を流す（台本は標準入力で。`input` を渡すなら、台本のあとではなく標準入力そのものとして渡す） */
  private run(conn: Connection, script: string, opts: { stdin?: NodeJS.ReadableStream; timeoutMs?: number } = {}): Promise<SshResult> {
    if (!conn.alive) return Promise.resolve({ code: 255, stdout: "", stderr: "SSH の接続が閉じています" });
    const remote = opts.stdin ? `sh -c ${shq(script)}` : "sh -s";
    return new Promise((resolve) => {
      const child = spawn("ssh", [...this.muxArgs(conn), "--", conn.runtime.host, remote], {
        stdio: ["pipe", "pipe", "pipe"],
        env: sshEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += String(c)));
      child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
      const timer = setTimeout(() => {
        stderr += `\n（${Math.round((opts.timeoutMs ?? 60_000) / 1000)} 秒で終わらなかったので止めました）`;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 60_000);
      child.on("error", (err) => (stderr += err.message));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 255, stdout, stderr });
      });
      child.stdin.on("error", () => undefined);
      if (opts.stdin) opts.stdin.pipe(child.stdin);
      else child.stdin.end(script);
    });
  }

  private async mustRun(conn: Connection, what: string, script: string, opts: { stdin?: NodeJS.ReadableStream; timeoutMs?: number } = {}): Promise<string> {
    const r = await this.run(conn, script, opts);
    if (r.code !== 0 && !conn.alive) {
      throw new Error(`別のサーバ「${conn.runtimeName}」で${what}ませんでした——SSH の接続が途中で閉じました`);
    }
    if (r.code !== 0) throw new SshCommandError(`別のサーバ「${conn.runtimeName}」で${what}ませんでした`, r);
    return r.stdout;
  }

  /** 向こうの、この banto の置き場（置き場の根の下に、データの置き場ごとに分ける——`owner` と同じ） */
  private async resolveBase(conn: Connection): Promise<string> {
    const owner = createHash("sha256").update(this.opts.dataDir).digest("hex").slice(0, 12);
    const out = await this.mustRun(
      conn,
      "置き場を作れ",
      `set -e\nb=${remotePathExpr(conn.runtime.dataRoot)}/${owner}\nmkdir -p "$b" && chmod 700 "$b" && cd -P -- "$b" && printf 'base=%s\\n' "$(pwd -P)"\n`,
    );
    const base = /^base=(\/.*)$/m.exec(out)?.[1];
    if (!base) throw new Error(`別のサーバ「${conn.runtimeName}」の置き場の場所を読めませんでした`);
    return base;
  }

  /**
   * **banto のコードを照合し、違えば送る**（接続を張ったときに1回）。いまの版の置き場に上書きせず、新しい置き場
   * （版の鍵＋連番）に展開してから切り替える——同じ版で走っている Module の足元を差し替えない。前の版を1つ残す
   */
  private async syncCode(conn: Connection): Promise<string> {
    const entries = collectCodeBundle(this.opts.monorepoRoot, { nodePath: process.execPath, launcherPath: this.launcherPath });
    const digest = await bundleDigest(entries, this.hashes);
    const prefix = digest.slice(0, 16);
    const code = `${conn.base}/code`;
    const state = await this.mustRun(
      conn,
      "コードの版を確かめられ",
      [
        `c=${shq(code)}`,
        `mkdir -p "$c"`,
        `cur=$(cat "$c/current" 2>/dev/null || true)`,
        `printf 'cur=%s\\n' "$cur"`,
        `if [ -n "$cur" ] && [ -d "$c/$cur" ]; then printf 'digest=%s\\n' "$(${remoteDigestCommand(`"$c/$cur"`)})"; fi`,
        `for d in "$c"/*/; do [ -d "$d" ] && printf 'dir=%s\\n' "$(basename "$d")"; done`,
        "exit 0",
        "",
      ].join("\n"),
      { timeoutMs: 180_000 },
    );
    const cur = /^cur=(.*)$/m.exec(state)?.[1] ?? "";
    const remoteDigest = /^digest=(.*)$/m.exec(state)?.[1];
    if (cur.startsWith(`${prefix}-`) && remoteDigest === digest) return `${code}/${cur}`;

    const why = !cur ? "初めて" : !cur.startsWith(`${prefix}-`) ? "版が変わった" : "向こうで書き換えられていた";
    const dirs = [...state.matchAll(/^dir=(.*)$/gm)].map((m) => m[1]!);
    const n = Math.max(0, ...dirs.filter((d) => d.startsWith(`${prefix}-`)).map((d) => Number(d.slice(prefix.length + 1)) || 0)) + 1;
    const next = `${prefix}-${n}`;
    const staging = `.incoming-${randomBytes(4).toString("hex")}`;
    const sending = performance.now();
    await this.sendTree(conn, entries, `${code}/${staging}`);
    const nodeTo = `${code}/${staging}/${REMOTE_NODE_REL}`;
    await this.mustRun(conn, "node を送れ", `mkdir -p "$(dirname ${shq(nodeTo)})" && cat > ${shq(nodeTo)} && chmod 755 ${shq(nodeTo)}`, {
      stdin: createReadStream(process.execPath),
      timeoutMs: 300_000,
    });
    await this.mustRun(conn, "起動役を送れ", `cat > ${shq(`${code}/${staging}/${REMOTE_LAUNCHER_REL}`)}`, {
      stdin: createReadStream(this.launcherPath),
    });
    const sent = await this.mustRun(conn, "送ったコードを確かめられ", `printf '%s\\n' "$(${remoteDigestCommand(shq(`${code}/${staging}`))})"\n`, {
      timeoutMs: 180_000,
    });
    if (sent.trim() !== digest) {
      throw new Error(`別のサーバ「${conn.runtimeName}」に送ったコードが、向こうで違う中身になりました（送った版 ${digest.slice(0, 12)}・向こう ${sent.trim().slice(0, 12)}）`);
    }
    // 切り替えて、いまの版と前の版のほかを消す
    await this.mustRun(
      conn,
      "コードを切り替えられ",
      [
        "set -e",
        `c=${shq(code)}`,
        `mv "$c"/${shq(staging)} "$c"/${shq(next)}`,
        `printf '%s\\n' ${shq(cur)} > "$c/previous"`,
        `printf '%s\\n' ${shq(next)} > "$c/current.tmp" && mv "$c/current.tmp" "$c/current"`,
        `for d in "$c"/* "$c"/.incoming-*; do`,
        `  [ -d "$d" ] || continue`,
        `  n=$(basename "$d")`,
        `  [ "$n" = ${shq(next)} ] || [ "$n" = ${shq(cur)} ] || rm -rf -- "$d"`,
        "done",
        "",
      ].join("\n"),
    );
    this.log(
      `[host] 別のサーバ「${conn.runtimeName}」にコードを送りました（${why}・版 ${next}・${entries.length} 件・${Math.round(performance.now() - sending)}ms）`,
    );
    return `${code}/${next}`;
  }

  /** 一覧のファイルと symlink を tar で流して、向こうのフォルダに展開する */
  private async sendTree(conn: Connection, entries: readonly BundleEntry[], remoteDir: string): Promise<void> {
    const tar = spawn("tar", ["-C", this.opts.monorepoRoot, "--null", "--no-recursion", "-cf", "-", "-T", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let tarErr = "";
    tar.stderr.on("data", (c: Buffer) => (tarErr += String(c)));
    tar.stdin.end(tarList(entries));
    const tarDone = new Promise<number>((resolve) => tar.on("close", (code) => resolve(code ?? 1)));
    const r = await this.run(conn, `mkdir -p ${shq(remoteDir)} && tar -C ${shq(remoteDir)} -xf -`, { stdin: tar.stdout, timeoutMs: 600_000 });
    const tarCode = await tarDone;
    if (tarCode !== 0) throw new Error(`送るコードを tar にまとめられませんでした：${tarErr.trim().slice(-500)}`);
    if (r.code !== 0) throw new SshCommandError(`別のサーバ「${conn.runtimeName}」にコードを送れませんでした`, r);
  }

  // ── 用意できた箱 ────────────────────────────────────────────────────────

  private preparedFrom(conn: Connection): PreparedPlace {
    const { dataDir, monorepoRoot } = this.opts;
    const nodePath = `${conn.codeDir}/${REMOTE_NODE_REL}`;
    const launcherPath = `${conn.codeDir}/${REMOTE_LAUNCHER_REL}`;
    /** host の側のパスを向こうのパスにする（banto のコード→いまの版の置き場、データの置き場→向こうの置き場。根は向こうのパスのまま） */
    const pathInside = (hostPath: string): string => {
      const prefixes: Array<[string, string]> = [
        [monorepoRoot, conn.codeDir],
        [dataDir, conn.base],
      ];
      prefixes.sort((a, b) => b[0].length - a[0].length);
      for (const [from, to] of prefixes) {
        if (hostPath === from) return to;
        if (hostPath.startsWith(`${from}/`)) return `${to}${hostPath.slice(from.length)}`;
      }
      return hostPath;
    };
    const self = this;
    return {
      name: `別のサーバ「${conn.runtimeName}」`,
      nodePath,
      bantoOrigin: `http://127.0.0.1:${conn.remotePort}`,
      pathInside,
      async prepareModuleDirs({ dataDir: moduleDataDir, packageDir }) {
        await self.mustRun(conn, "Module の置き場を作れ", `mkdir -p ${shq(pathInside(moduleDataDir))} && chmod 700 ${shq(pathInside(moduleDataDir))}`);
        if (existsSync(packageDir) && statSync(packageDir).isDirectory()) await self.syncPackageDir(conn, packageDir, pathInside(packageDir));
      },
      // 鍵の窓口（ssh-agent）を向こうに見せるのはソケットの転送（Backlog `remote-runtime-sockets`）。それまでは host の側の置き場
      socketDirFor: (moduleDataDir) => ensureSocketDir(moduleDataDir),
      async prepareShellHome(moduleDataDir, files) {
        const home = `${pathInside(moduleDataDir)}/home`;
        const resync = (f: readonly string[]) => self.sendShellHome(conn, moduleDataDir, home, f);
        return { home, sync: await resync(files), resync };
      },
      // **向こうで sudo しない**（v4-security.md §1「前提の確かめ」）——Module にもそう伝える（Terminal は tmux が無ければ、
      // sudo で入れずに入れ方を添えて断る）
      moduleEnv: { BANTO_NO_SUDO: "1" },
      processCommand(p: RuntimeProcess) {
        // 宣言が host の node を名指ししていても、向こうに送った node を使う
        const command = p.command === process.execPath ? nodePath : p.command;
        const unit = moduleUnitName(p.name);
        const prelude: LauncherRequest = { command, args: p.args, cwd: p.cwd, env: p.env };
        // 向こうのコマンド行に載るのは node・起動役のパスと単位の名前だけ（env・合言葉は最初の1行で渡す）
        const args = [...self.muxArgs(conn), "--", conn.runtime.host, `exec ${shq(nodePath)} ${shq(launcherPath)} ${shq(unit)}`];
        return {
          command: "ssh",
          args,
          transport: () =>
            new LauncherTransport(
              { command: "ssh", args, env: sshEnv() as Record<string, string> },
              prelude,
              () => self.stopUnit(conn, unit),
              `${p.name}@${conn.runtimeName}`,
            ),
        };
      },
    };
  }

  /** 落とした Module の単位を止める（接続が切れていれば、次に起こすときに起動役が止める） */
  private async stopUnit(conn: Connection, unit: string): Promise<void> {
    if (!conn.alive) return;
    const r = await this.run(
      conn,
      `u=$(id -u); XDG_RUNTIME_DIR=/run/user/$u DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$u/bus systemctl --user stop ${shq(`${unit}.service`)}\n`,
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0 && !/not loaded|not found/i.test(r.stderr) && conn.alive) {
      this.log(`[host] 別のサーバ「${conn.runtimeName}」の ${unit} を止められませんでした: ${r.stderr.trim().slice(-300)}`);
    }
  }

  /** registry から取ってきた配布物を送る（中身が違えば置き換える） */
  private async syncPackageDir(conn: Connection, hostDir: string, remoteDir: string): Promise<void> {
    const entries = collectTreeEntries(hostDir);
    const digest = await bundleDigest(entries, this.hashes);
    const now = await this.run(conn, `[ -d ${shq(remoteDir)} ] && printf '%s\\n' "$(${remoteDigestCommand(shq(remoteDir))})"\nexit 0\n`, { timeoutMs: 120_000 });
    if (now.stdout.trim() === digest) return;
    const staging = `${remoteDir}.incoming-${randomBytes(4).toString("hex")}`;
    const tar = spawn("tar", ["-C", hostDir, "--null", "--no-recursion", "-cf", "-", "-T", "-"], { stdio: ["pipe", "pipe", "inherit"] });
    tar.stdin.end(entries.map((e) => `${e.rel}\0`).join(""));
    await this.mustRun(conn, "配布物を送れ", `mkdir -p ${shq(staging)} && tar -C ${shq(staging)} -xf - && rm -rf -- ${shq(remoteDir)} && mv ${shq(staging)} ${shq(remoteDir)}`, {
      stdin: tar.stdout,
      timeoutMs: 600_000,
    });
  }

  /**
   * **Shell のホームを送る**。host の置き場で整え（資格情報を外す規則は同じ・git の設定の向け直し先は向こうのホーム）、
   * 向こうで前に送ったもの（記録の一覧）を消してから展開する。Shell の中で作られたもの（キャッシュ等）には触らない
   */
  private async sendShellHome(conn: Connection, moduleDataDir: string, home: string, files: readonly string[]) {
    const stage = join(this.opts.dataDir, "remote-runtimes", conn.runtimeName, "shell-home", basename(moduleDataDir));
    rmSync(stage, { recursive: true, force: true });
    const sync = await syncShellHome(stage, files, {
      ...(this.opts.shellHomeSource ? { sourceHome: this.opts.shellHomeSource } : {}),
      targetHome: home,
    });
    const tar = spawn("tar", ["-C", stage, "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
    // 前に送ったもの（.banto-shell-home.json の copied）を消す。外へ出る名前は無視する
    const removeOld =
      `const fs=require("fs"),p=process.argv[1];let c=[];try{c=JSON.parse(fs.readFileSync(p+"/.banto-shell-home.json","utf8")).copied||[]}catch{}` +
      `for(const r of c){if(typeof r!=="string"||r.startsWith("/")||r.split("/").includes(".."))continue;fs.rmSync(p+"/"+r,{recursive:true,force:true})}`;
    await this.mustRun(
      conn,
      "Shell のホームを送れ",
      `mkdir -p ${shq(home)} && chmod 700 ${shq(home)} && ${shq(`${conn.codeDir}/${REMOTE_NODE_REL}`)} -e ${shq(removeOld)} ${shq(home)} && tar -C ${shq(home)} -xf -`,
      { stdin: tar.stdout },
    );
    return sync;
  }
}

/**
 * 親の接続が用意できるまで待つ：逆向きのトンネルのポート（ssh が標準エラーに出す「Allocated port N」）と、
 * 多重化の窓口ができたこと。先に終わったら、ssh の言葉を添えて投げる
 */
function waitMasterReady(
  master: ChildProcess,
  controlPath: string,
): Promise<{ remotePort: number; exited: Promise<void>; stderrTail: () => string }> {
  let stderr = "";
  const exited = new Promise<void>((resolve) => master.once("close", () => resolve()));
  return new Promise((resolve, reject) => {
    let port: number | undefined;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (err) {
        master.kill("SIGTERM");
        reject(err);
      } else resolve({ remotePort: port!, exited, stderrTail: () => stderr.slice(-2000) });
    };
    master.stderr?.on("data", (c: Buffer) => {
      stderr += String(c);
      const m = /Allocated port (\d+) for remote forward/.exec(stderr);
      if (m) port = Number(m[1]);
    });
    master.once("close", (code) =>
      finish(new SshCommandError("SSH の接続を張れませんでした", { code: code ?? 255, stdout: "", stderr })),
    );
    master.once("error", (err) => finish(err));
    const poll = setInterval(() => {
      if (port !== undefined && existsSync(controlPath)) finish();
    }, 50);
    const timer = setTimeout(
      () => finish(new SshCommandError("SSH の接続を張れませんでした", { code: 255, stdout: "", stderr: `${stderr}\n（30 秒で用意ができませんでした）` })),
      30_000,
    );
  });
}
