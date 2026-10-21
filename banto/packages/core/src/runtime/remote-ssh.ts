// **実行場所の2つ目——SSH で入る別のサーバ**（決定・2026-10-08、`docs/specs/v4-security.md` §1「Project の実行場所——
// 別のサーバ」、Backlog `remote-runtime-ssh`）。
//
// **Project ごとに SSH の接続を1本**（`ControlMaster`。決定・2026-10-17、v4-security.md §1「SSH の接続は Project ごとに1本」）
// 張り、その上に Module の標準入出力（Module ごとのセッション）と**逆向きのトンネル1本**（向こうの 127.0.0.1 → host の、
// その Project の中継だけを受ける専用の待ち受け）を載せる。接続の表・待ち受け・ソケットの転送・手放す（`release`）は
// どれも「実行場所＋Project」が鍵——同じ実行場所のほかの Project の接続には触らない。繋ぐときに：
//   1. 前提を確かめる（`probePrerequisites`。足りなければ名指しして直し方つきで断る。linger・tmux が無いのは注意だけ）
//   2. 接続を張る（`machine` は `-M -N -R 0:127.0.0.1:<待ち受け>`。向こうの側のポートは sshd に選ばせる。`containers` は
//      トンネルを Project ごとの決まったパスの UNIX ソケットにし、コンテナを用意するときに張る——`ensureTunnel`）
//   3. banto のコードを照合し、違えば新しい置き場に展開して切り替える（`remote-code.ts`。前の版を1つ残す）。
//      送るときは縮めて流し（向こうに zstd があれば zstd、無ければ gzip）、送った量を画面へ知らせる（`onCodeTransfer`）
//
// Module は起動役（`remote-launcher.ts`）を通して、向こうのユーザーの systemd の単位で包んで起こす。落とすときは標準入出力を
// 閉じたうえで `systemctl --user stop`。接続が切れたら、その上の Module は落ちたものとして扱われ（多重化したセッションが
// 一緒に閉じる）、次に要るときに繋ぎ直す——起動役が、残っていた前の Module を止めてから起こす（二重に動かない）。
//
// **Module を起こすときに向こうで sudo しない**。`machine` の root が要る準備は人が行う。`containers` の準備は登録のときに
// core が sudo -n で済ませ（`containers-host.ts`）、繋ぐたびには崩れていないことを確かめるだけ。

import { coreSocketDir, moduleSocketDir } from "./socket-dir.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { PassThrough, Transform, type Readable } from "node:stream";
import zlib from "node:zlib";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { syncShellHome } from "../modules/shell-home.js";
import { SingleFlight } from "../modules/single-flight.js";
import {
  REMOTE_LAUNCHER_REL,
  REMOTE_NODE_REL,
  FileHashCache,
  bundleDigest,
  collectCodeBundle,
  collectTreeEntries,
  computeLayers,
  layerPrefix,
  planLayers,
  remoteAssembleScript,
  remoteDigestCommand,
  remoteSplitPackagesScript,
  remoteSwitchScript,
  sendBytes,
  tarList,
  type BundleEntry,
  type Layer,
} from "./remote-code.js";
import { remoteAddress, type LookupIPv4 } from "./remote-address.js";
import {
  DEFAULT_TIMEOUTS,
  ProjectContainers,
  containerNameFor,
  effectiveInsideIds,
  defaultContainerLimits,
  ensureBaseImage,
  type ContainerVirtualization,
} from "@banto/container";
import {
  AGENT_DEVICE_PREFIX,
  LEGACY_INSIDE_IDS,
  INSIDE_RELAY_PORT,
  RELAY_DEVICE,
  agentInsidePath,
  createOnlyDirScript,
  inodePairsScript,
  insideCommand,
  moduleDiskName,
  parseInodePairs,
  insideShellHomeCommand,
  insideStopUnitCommand,
  vmIncus,
  vmInterfaces,
  vmProjectRunDir,
  vmResources,
  vmUserRunDir,
  relayRoute,
  type InsideIds,
  type VmShell,
} from "./remote-containers.js";
import { REMOTE_LAUNCHER_SCRIPT, moduleUnitName, type LauncherRequest } from "./remote-launcher.js";
import { withMissingBridgeHint } from "./containers-host.js";
import { mayInstallDocker, preparedCheck, type RanCommand } from "./host-autoprep.js";
import type { ProjectWokeCause } from "../project-thread/types.js";
import type { RemoteRuntimes } from "./remote-runtimes.js";
import type { RemoteRuntime } from "./remote-store.js";
import { RuntimeStopError, type PlaceAddress, type PreparedPlace, type RuntimePlace, type RuntimeProcess } from "./runtime.js";
import {
  SshCommandError,
  SshConnectionClosedError,
  remotePathExpr,
  shq,
  sshArgs,
  sshEnv,
  type RuntimeCheck,
  type SshResult,
} from "./ssh.js";
import { REMOTE_RESOURCE_PROBE, type RemoteProbe, type RemoteProbeRaw } from "../remote-resources.js";
import { DEFAULT_PROGRESS_TIMING, SharedProgressTasks, watchProgress, type ProgressListener } from "../agent-binaries/progress.js";

/** 向こうの置き場の根の下の、この banto の置き場の名前（データの置き場ごとに分ける） */
export function remoteOwnerDirName(dataDir: string): string {
  return createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
}

/** Unix ソケットのパスの上限（`sun_path`）。ssh は ControlPath に一時の名前（17 字）を足して作る */
const SOCKET_PATH_LIMIT = 107;
const CONTROL_PATH_SUFFIX = 17;
/**
 * containers の公開で VM に選ぶポートの範囲（決定・2026-10-20、実装者）。よく使われる番号と Linux の一時のポートの範囲
 * （32768〜）を避ける。中から banto への口（29839）はコンテナの中の番号なので VM のポートとはぶつからない
 */
export const PUBLISH_PORT_RANGE = { from: 20000, to: 29999 } as const;
/**
 * **外したばかりの公開の VM のポートは、しばらく選ばない**（追加・2026-10-20、レビュー H1）。外したあとも、公開の実装の Caddy の道は
 * 次の突き合わせ（15 秒ごと）まで前の行き先のまま残りうる——すぐ別の Project に渡すと、前の公開の URL（前の認証の設定）で別の
 * Project のサービスが出る。ほかに空きが無ければ選ぶ（メモリだけ——banto を起こし直すと忘れるが、公開の実装も起き直して突き合わせる）
 */
const RELEASED_PORT_COOLDOWN_MS = 10 * 60_000;
/** host の側の鍵の窓口が消えたか（Vault が閉じたか）を見る間隔 */
const AGENT_WATCH_INTERVAL_MS = 1_000;

export interface RemoteSshRuntimeOptions {
  dataDir: string;
  /** banto のコードの置き場（モノレポの根）。ここから Module に要る分を送る */
  monorepoRoot: string;
  runtimes: RemoteRuntimes;
  /** その Project の実行場所（別のサーバ）の名前。別のサーバでなければ undefined */
  remoteNameOf(projectId: string): string | undefined;
  /** 中継だけを受ける専用の待ち受けを作る（実行場所＋Project ごとに1つ。その Project だけを受ける） */
  createRelayListener(runtimeName: string, projectId: string): Server;
  /** Shell のホームへ写す元（既定は人のホーム。E2E だけが差し替える） */
  shellHomeSource?: string;
  /** 注意（linger・tmux が無い）を受信箱へ。同じものが開いている間は増やさない（`dedupeKey`） */
  notify(n: { projectId: string; dedupeKey: string; title: string; detail: string }): Promise<void>;
  /**
   * **コードを送っている間の進み具合**（追加・2026-10-12、Backlog #269）。送り始め・進むたび（間引いて）に呼び、
   * 使えるようになったら `undefined` で呼ぶ。送れなかったら `failed` に理由を入れて呼ぶ（次に送り始めるか、版が合って
   * いると分かるまで残る）。大きさは縮める前のバイト数
   */
  onCodeTransfer?: (runtimeName: string, progress: CodeTransfer | undefined) => void;
  /**
   * 実行場所に繋がった（張り直せた）。繋がらないお知らせを閉じるのに使う（追加・2026-10-16、`modules/remote-outage.ts`）。
   * `projectId` はその接続の Project（先に送るためだけの接続には無い）
   */
  onConnected?: (runtimeName: string, projectId: string | undefined) => void;
  /** ログ（既定は console） */
  log?: (line: string) => void;
  /** 宛先の名前を IPv4 に引く（既定は host の名前引き。試験だけが差し替える） */
  lookupIPv4?: LookupIPv4;
  /** 送っている途中で、これだけ進まなければ止める（既定は `TRANSFER_STALL_MS`。試験だけが縮める） */
  transferStallMs?: number;
  /**
   * **いまの目録にあるエージェントの本体のフォルダの名前**（追加・2026-10-17、アーキ仕様 §4.1）。繋いだときに、向こうの
   * `<置き場>/agent-binaries/` のうちこれに無いものを消す。渡さなければ片づけない
   */
  agentBinaryDirNames?: () => ReadonlySet<string>;
  /**
   * **containers のコンテナに付ける仮想化（KVM）の設定**（追加・2026-10-20、v4-security.md §1「`containers` で仮想化（KVM）」）。
   * 実行場所が許していなければ null（付いていれば外す）。渡さなければ付けない
   */
  containerVirtualization?: (runtimeName: string, projectId: string) => ContainerVirtualization | null;
  /**
   * **その実行場所で確保した hugepages の合計（バイト）**。メモリの cgroup に数えないので、コンテナのメモリの上限の計算から引く
   * （渡さなければ 0）
   */
  hugepagesReservedBytes?: (runtimeName: string) => number;
  /**
   * containers：VM のユーザーの、コンテナに見せていない場所（既定は `/run/user/<uid>`。試験だけが差し替える——この機械の
   * `/run/user` を使わない）
   */
  vmRunDir?: (uid: number) => string;
  /**
   * containers：その Project が閉じているか（閉じた Project の公開は確かに届かない——閉じるときに道を外すので、残った Caddy の道を
   * 中継をやめる形にさせる。無ければ閉じていない）
   */
  projectClosed?: (projectId: string) => boolean;
  /**
   * containers：その Project は眠っていて、眠らせたときにコンテナを止めてある（出来事を待たれている Module が無い）か。止めるために
   * わざわざ繋がない（繋がらない VM で、もう止まっているコンテナを「止められませんでした」と言わない——レビュー L6）。無ければ false
   */
  stoppedWhileAsleep?: (projectId: string) => boolean;
}

/** コードを送っている途中の1件（縮める前のバイト数） */
export interface CodeTransfer {
  sentBytes: number;
  totalBytes: number;
  startedAt: string;
  /** 送れなかった理由（止まった・接続が切れた）。次に送り始めるまで残す */
  failed?: string;
  /**
   * **コンテナの土台のイメージを作っている段**（追加・2026-10-20、containers。最初の1回は数分）。あればバイト数ではなく
   * この段を見せる
   */
  baseImage?: string;
}

/** 進み具合を知らせる間隔（これより細かくは知らせない） */
const TRANSFER_REPORT_INTERVAL_MS = 500;
/**
 * **送っている途中で、これだけ1バイトも進まなければ止める**。全体の時間では切らない——遅い回線では大きなコードを
 * 送り終えるのに何分もかかる（2026-10-12 の実機で約4分）。止まったことだけを見る
 */
const TRANSFER_STALL_MS = 120_000;

/** 送っている間の進み具合の1件分 */
interface TransferTracker {
  add(bytes: number): void;
  /** 最後に進んでから何ミリ秒か */
  stalledFor(): number;
  sentBytes(): number;
  /** 終わった。`err` があれば送れなかった（理由を残す）、無ければ使える（消す） */
  end(err?: unknown): void;
}

interface RunOptions {
  stdin?: NodeJS.ReadableStream;
  timeoutMs?: number;
  /** 流し込むもの：最後に進んでから何ミリ秒か。渡すと `timeoutMs` ではなく、進まなくなったら止める */
  stalledFor?: () => number;
}

/** MB（小数1桁） */
function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}

/**
 * node の zstd（node 23.8・22.15 から）。入れている `@types/node` がまだ持たないので、使う分だけ形を書く。
 * 無い node では gzip にする
 */
const zstd = zlib as unknown as {
  createZstdCompress?: (opts: { params: Record<number, number> }) => Transform;
  constants: { ZSTD_c_compressionLevel?: number };
};

/** 多重化した ssh が 255 で終わったとき、親の接続も閉じるかを見る間（接続が切れたのか、を見分けるため） */
const MASTER_CLOSE_GRACE_MS = 2_000;

/** 縮め方（向こうに展開するコマンドがあるものを選ぶ） */
type Codec = "zstd" | "gzip" | "none";

/**
 * 接続の表の鍵：実行場所＋Project。Project の無い鍵（`projectId` が undefined）は、先に送るためだけの接続（`warmUp`）
 */
export function remoteConnectionKey(runtimeName: string, projectId: string | undefined): string {
  return `${runtimeName}\0${projectId ?? ""}`;
}

/**
 * **containers のコンテナの番号の宣言**（#457）：外＝VM の SSH ユーザー（U/G）、中も U/G。札の無い前のコンテナ（中 1000）は
 * `legacyInside` で見分け、次に止めるときに付け替える
 */
function containerSpecIds(vm: { uid: number; gid: number }) {
  return { uid: vm.uid, gid: vm.gid, inside: { uid: vm.uid, gid: vm.gid }, legacyInside: LEGACY_INSIDE_IDS };
}

/** 張っている接続1本 */
interface Connection {
  runtimeName: string;
  /** この接続を使う Project。先に送るためだけの接続（`warmUp`）には無い——逆向きのトンネルも張らない */
  projectId?: string;
  runtime: RemoteRuntime;
  controlPath: string;
  knownHostsFile: string;
  master: ChildProcess;
  alive: boolean;
  /** 向こうの 127.0.0.1 の、逆向きのトンネルのポート（先に送るためだけの接続には無い） */
  remotePort: number | undefined;
  /** 向こうの、この banto の置き場（絶対パス） */
  base: string;
  /** 向こうの、いま使う版のコードの置き場（絶対パス） */
  codeDir: string;
  checks: RuntimeCheck[];
  exited: Promise<void>;
  /** 張っているソケットの転送（鍵は host の側のパス）。接続が閉じれば一緒に消える */
  forwards: Map<string, SocketForward>;
  /** 注意（linger・tmux が無い）を出した Project */
  cautioned: Set<string>;
  /** 用意している途中で実行場所の登録が外された */
  removed?: boolean;
  /** containers：この接続の上で Incus を呼ぶ口（装置の書き換えを1本ずつ通すので、接続ごとに1つ） */
  incus?: ProjectContainers;
  /** containers：用意したコンテナ（根・入れ子が変われば用意し直す） */
  container?: { root: string | undefined; nesting: boolean; virtualization: string; ready: Promise<string> };
  /** containers：VM のユーザーの番号（読むのは接続ごとに1回） */
  vmIds?: Promise<{ uid: number; gid: number }>;
  /**
   * containers：コンテナの番号の対応（外＝VM のユーザー・中）。コンテナを作るときの宣言と、あとから足す道（proxy device）が
   * 同じものを使う——中の番号はここにしか書かない
   */
  containerIds?: { uid: number; gid: number; inside: { uid: number; gid: number } };
  /** containers：逆向きのトンネル（Project ごとの決まったパスの UNIX ソケット。張れたらその VM のパス） */
  tunnel?: Promise<string>;
  /** containers：前の接続の鍵の窓口の装置を片づけた（接続ごとに1回——窓口の転送は接続と一緒に消えている） */
  agentDevicesCleared?: true;
}

/**
 * 多重化した接続に張った UNIX ソケットの転送1本。**転送の端は両側とも短いパス**（データの置き場の `s`）——sshd は向こうの
 * パスへ直に bind・connect するので、Unix ソケットの上限（107 バイト）に収まらないと張れない。Module の置き場
 * （`<置き場>/modules/<接続名>/s`）は Project の id を含んで上限を越える（既定の置き場の根で約 115 バイト）
 */
interface SocketForward {
  /**
   * 何の転送か。鍵の窓口は host の窓口が消えたら外す（`watchAgentSockets`）。トンネルは containers の逆向きのトンネル
   * （host の側は TCP の待ち受け）
   */
  purpose: "agent" | "stream" | "tunnel";
  /** `-L`（host で待ち受けて向こうへ——流れの口）か `-R`（向こうで待ち受けて host へ——鍵の窓口・トンネル） */
  dir: "L" | "R";
  /** host の側のパス（トンネルは `127.0.0.1:<待ち受けのポート>`） */
  hostPath: string;
  /** 向こうの側のパス */
  remotePath: string;
  /** `-L` の先を短いパスにするための symlink の先（connect は symlink を辿る）。向こうの Module の待ち受けの本当のパス */
  remoteTarget?: string;
  /** containers：この転送と一緒に張った proxy device（転送を外すときに外す） */
  device?: { container: string; name: string };
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
  /** 張っている接続（鍵は `remoteConnectionKey`——実行場所＋Project） */
  private readonly connections = new Map<string, Connection>();
  private readonly connecting = new SingleFlight<Connection>();
  /** 中継だけを受ける待ち受け（鍵は接続と同じ。繋ぎ直しても同じものを使い、手放したら閉じる） */
  private readonly listeners = new Map<string, { server: Server; port: number }>();
  /** コード・エージェントの本体を照合・送っている実行場所（同じ実行場所の Project の接続どうしで重ねない——置き場を取り合う） */
  private readonly codeSyncs = new Map<string, Promise<unknown>>();
  private readonly hashes = new FileHashCache();
  private readonly log: (line: string) => void;
  private readonly launcherPath: string;
  private readonly forwarding = new SingleFlight<void>();
  /** 実行場所の登録を外した回数（名前ごと）。繋いでいる途中で外されたかを見る（`connect`） */
  private readonly removals = new Map<string, number>();
  /** Project の接続を手放した回数（鍵は接続と同じ）。繋いでいる途中で手放されたかを見る（`connect`） */
  private readonly releases = new Map<string, number>();
  /** 用意している途中（コードを照合・送っている）の接続（鍵は接続と同じ） */
  private readonly settingUp = new Map<string, Connection>();
  /** いまコードを送っている実行場所（送り終えたら消す） */
  private readonly transfers = new Map<string, CodeTransfer>();
  /** 先に送る順番（一度に1台ずつ。`queueWarmUp`） */
  private warmUpQueue: Promise<void> = Promise.resolve();
  /** 鍵の窓口の転送を外す見張り（窓口のファイルが host から消えたら外す） */
  private agentWatch?: ReturnType<typeof setInterval>;
  /** 資源を読んでいる途中の実行場所（重ねない） */
  private readonly resourceReads = new Set<string>();
  /** containers の公開の道を張る・外す（実行場所ごとに1本ずつ——同じ VM の Project どうしで同じポートを選ばない） */
  private readonly publishing = new Map<string, Promise<unknown>>();
  /** containers の公開で外したばかりの VM のポート（実行場所ごと、ポート → 外した時刻） */
  private readonly releasedPorts = new Map<string, Map<number, number>>();
  /** エージェントの本体を送っているもの（（実行場所・フォルダの名前）ごとに1本。同時の頼みは待たせる） */
  private readonly agentBinarySends = new SharedProgressTasks<string>();
  /** 人が開いたときに Docker を入れるため banto が向こうで行ったこと（実行場所ごと。次に繋いだときの確かめの一覧の最後に出す） */
  private readonly dockerPrepared = new Map<string, RanCommand[]>();
  /** Docker を入れられなかった理由（実行場所ごと。「中で Docker を使う」で断るときに添える。入れられたら消す） */
  private readonly dockerFailures = new Map<string, string>();

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

  /** いまコードを送っている実行場所（繋いだ画面に、その時点の分を渡す） */
  codeTransfers(): Array<{ runtime: string } & CodeTransfer> {
    return [...this.transfers].map(([runtime, t]) => ({ runtime, ...t }));
  }

  /**
   * **先に繋いでコードを送っておく**（追加・2026-10-12、Backlog #269）——実行場所を登録したとき（前提を確かめたあと）に
   * 呼ぶ。最初のターンが送り終わるのを待たずに済む。張った接続（Project の無いもの——トンネルは張らない）は、その実行場所の
   * Project の接続が張れるまで残す（資源を読むのに使う）
   */
  async warmUp(runtimeName: string): Promise<void> {
    // Project の接続がもう張ってあれば、コードはそれが照合している
    if (this.liveOn(runtimeName).length > 0) return;
    await this.connecting.run(this.flightKey(runtimeName, undefined), () => this.connect(runtimeName, undefined));
  }

  /** その実行場所に張っている、生きている接続（Project の接続が先、先に送るためだけの接続は最後） */
  private liveOn(runtimeName: string): Connection[] {
    return [...this.connections.values()]
      .filter((c) => c.runtimeName === runtimeName && c.alive)
      .sort((a, b) => Number(a.projectId === undefined) - Number(b.projectId === undefined));
  }

  /**
   * **裏で先に送る（一度に1台ずつ）**（追加・2026-10-12、Backlog #278）——banto が起きたとき（使っている Project がある
   * 実行場所の分）と、実行場所を登録したときに呼ぶ。版が変わると次に使うときにコード（約 850MB）を送り直すことになり、
   * 送り終わるまで Module が起きない（2026-10-12 の実機で「Subagent が死んだまま」に見えた）。並べて送ると線を取り合って
   * どれも遅くなるので、前のが終わってから次を始める。**失敗しても次へ進む**（理由はログと、送り始めていれば画面の
   * 「送れませんでした」に残る。最初に使うときに送り直す）。終わったら（成否に依らず）返る
   */
  queueWarmUp(runtimeName: string): Promise<void> {
    const next = this.warmUpQueue.then(async () => {
      // 順番が来るまでに外された実行場所には繋がない
      if (!this.opts.runtimes.get(runtimeName)) return;
      try {
        await this.warmUp(runtimeName);
      } catch (err) {
        this.log(
          `[host] 別のサーバ「${runtimeName}」へ先にコードを送れませんでした（最初に使うときに送り直します）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    this.warmUpQueue = next;
    return next;
  }

  /**
   * **別のサーバの資源を読む**（追加・2026-10-14、`remote-resources.ts`）。登録してある実行場所ごとに、張ってある接続の上で
   * 向こうの node に読み取りを走らせる。**読むためだけには繋がない**——繋いでいなければ「繋いでいません」。同じ実行場所の
   * 読み取りは重ねない（前のが終わっていなければ、その回は前の結果を返さず「読んでいる途中」にする）
   */
  async readResources(): Promise<RemoteProbe[]> {
    return Promise.all(
      this.opts.runtimes.list().map(async (r): Promise<RemoteProbe> => {
        const address = `${r.user}@${r.host}`;
        const conn = this.liveOn(r.name)[0];
        if (!conn) return { runtime: r.name, address, unavailable: "繋いでいません（この実行場所の Project を使うと繋ぎます）" };
        if (this.resourceReads.has(r.name)) return { runtime: r.name, address, unavailable: "読んでいる途中です" };
        this.resourceReads.add(r.name);
        try {
          const script = `exec ${shq(`${conn.codeDir}/bin/node`)} - <<'BANTO_PROBE_EOF'\n${REMOTE_RESOURCE_PROBE}\nBANTO_PROBE_EOF\n`;
          const out = await this.run(conn, script, { timeoutMs: 8_000 });
          if (out.code !== 0) return { runtime: r.name, address, unavailable: `読めませんでした：${out.stderr.trim().slice(0, 200) || `終了コード ${out.code}`}` };
          return { runtime: r.name, address, raw: JSON.parse(out.stdout) as RemoteProbeRaw };
        } catch (err) {
          return { runtime: r.name, address, unavailable: `読めませんでした：${err instanceof Error ? err.message : String(err)}` };
        } finally {
          this.resourceReads.delete(r.name);
        }
      }),
    );
  }

  async prepare(place: RuntimePlace): Promise<PreparedPlace> {
    const name = this.opts.remoteNameOf(place.id);
    if (!name) throw new Error(`${place.id} は別のサーバの Project ではありません`);
    const conn = await this.ensureConnection(name, place);
    if (conn.runtime.mode !== "containers") return this.preparedFrom(conn, this.machineOrigin(conn));
    const container = await this.ensureProjectContainer(conn, place);
    return this.preparedInContainer(conn, container, (await this.containerIdsOf(conn)).inside);
  }

  /**
   * 外から向こうのサービスに届くアドレス（Publish）：登録した宛先の LAN のアドレス。machine は繋がない——向こうのサービスには
   * SSH を通さず LAN から直に届くので、届くかは公開の実装がそのポートで確かめる。**containers でサービスのポートを渡されたら**、
   * VM のポートからコンテナの中へ繋ぐ道を張って、その VM のポートを返す（`publishedAddress`）
   */
  address(projectId: string, port?: number): Promise<PlaceAddress> {
    const name = this.opts.remoteNameOf(projectId);
    if (!name) throw new Error(`${projectId} は別のサーバの Project ではありません`);
    if (port !== undefined && this.modeOf(name, remoteConnectionKey(name, projectId)) === "containers") {
      // 閉じた Project の道は閉じるときに外した（VM のポートはほかの Project に渡りうる）——確かに届かないと返し、公開の実装に
      // 中継をやめさせる（この機械のコンテナが止まっているときと同じ）。繋がない
      if (this.opts.projectClosed?.(projectId)) return Promise.resolve({ unavailable: `Project ${projectId} は閉じています（公開の道は外しました）` });
      return this.publishedAddress(name, projectId, port);
    }
    return remoteAddress(name, this.opts.runtimes.get(name)?.host, this.opts.lookupIPv4);
  }

  /**
   * **containers の公開の道**（v4-security.md §1「道」の公開）：装置 `banto-pub-<サービスのポート>`（`bind=host
   * listen=tcp:0.0.0.0:<VM のポート> connect=tcp:127.0.0.1:<サービスのポート>`）。VM のポートは、止まっているものも含め区画の全コンテナの
   * 装置と VM で待ち受けているポートを避けて選ぶ。張ってあればそのポートを使い続ける（覚えない——装置が真実）。**眠らせても外さない**
   * （止まったコンテナの装置は待ち受けない。外すと眠っている間にほかの Project に番号を取られる）——止まっていれば `{unavailable}` を
   * 返し、装置は残す。**読むためだけには繋がない**：繋いでいなければ確かめられない（投げる——公開の実装は道に触らない。道は Incus の
   * 設定なので、繋いでいなくても届き続ける）
   */
  private async publishedAddress(name: string, projectId: string, port: number): Promise<PlaceAddress> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`サービスのポート ${port} がおかしいです`);
    const conn = this.connections.get(remoteConnectionKey(name, projectId));
    if (!conn?.alive) throw new Error(`別のサーバ「${name}」の Project ${projectId} には繋いでいないので、公開の道を確かめられません（Module が起きると繋ぎます）`);
    const lan = await remoteAddress(name, conn.runtime.host, this.opts.lookupIPv4);
    if (!("address" in lan)) return lan;
    const incus = this.incusOf(conn);
    const container = containerNameFor(projectId);
    const device = `banto-pub-${port}`;
    return this.onePublishAtATime(name, async (): Promise<PlaceAddress> => {
      const st = await incus.state(container);
      if (!st) return { unavailable: `コンテナ ${container} がありません（その Project の Module がまだ一度も起きていない）` };
      if (st.status !== "Running") return { unavailable: `コンテナ ${container} は動いていません（${st.status}）——公開の道は残しています` };
      const listen = /^tcp:.*:(\d+)$/.exec(st.devices[device]?.["listen"] ?? "")?.[1];
      let vmPort = listen !== undefined ? Number(listen) : undefined;
      if (vmPort === undefined) {
        const taken = new Set([...(await incus.hostProxyPorts()), ...(await this.vmListeningPorts(conn))]);
        // 外したばかりの番号は、ほかに空きがあれば選ばない（前の公開の Caddy の道がまだ向いているかもしれない）
        const now = Date.now();
        const released = this.releasedPorts.get(name) ?? new Map<number, number>();
        for (const [p, at] of released) if (now - at >= RELEASED_PORT_COOLDOWN_MS) released.delete(p);
        for (const skipReleased of [true, false]) {
          for (let p = PUBLISH_PORT_RANGE.from; p <= PUBLISH_PORT_RANGE.to && vmPort === undefined; p++) {
            if (!taken.has(p) && !(skipReleased && released.has(p))) vmPort = p;
          }
        }
        if (vmPort === undefined) throw new Error(`別のサーバ「${name}」で公開に使える VM のポートが残っていません（${PUBLISH_PORT_RANGE.from}〜${PUBLISH_PORT_RANGE.to}）`);
      }
      // 張ってあっても形を合わせる（番号の対応が変わった等）。同じなら何もしない
      await incus.ensureProxy(container, device, { bind: "host", listen: `tcp:0.0.0.0:${vmPort}`, connect: `tcp:127.0.0.1:${port}` }, await this.containerIdsOf(conn));
      if (listen === undefined) this.log(`[host] 別のサーバ「${name}」の Project ${projectId} のポート ${port} を、VM のポート ${vmPort} で公開する道を張りました`);
      return { address: lan.address, port: vmPort, exposedOnLan: true };
    });
  }

  /**
   * **公開をやめたとき・閉じるとき、containers の公開の道を外す**（v4-security.md §1「道」の公開。眠らせても外さないので、外すのは
   * ここだけ）。`port` が無ければその Project の公開の道を全部。繋いでいなければ外すために繋ぎ、外し終えたらその接続（と中継の待ち受け）を
   * 閉じる（眠っている・閉じた Project に接続を残さない——レビュー L1）。machine は道を張らないので何もしない
   */
  async releasePublishedPort(projectId: string, port?: number): Promise<void> {
    const name = this.opts.remoteNameOf(projectId);
    if (!name || this.modeOf(name, remoteConnectionKey(name, projectId)) !== "containers") return;
    const live = this.connections.get(remoteConnectionKey(name, projectId));
    if (live?.alive) return this.removePublishedDevices(live, name, projectId, port);
    const conn = await this.connecting.run(this.flightKey(name, projectId), () => this.connect(name, projectId));
    try {
      await this.removePublishedDevices(conn, name, projectId, port);
    } finally {
      // 外すためだけに張った接続は閉じる。そのあいだに Module を起こす用意が同じ接続を使い始めていたら（コンテナを用意し始めた）残す
      if (!conn.container && this.connections.get(remoteConnectionKey(name, projectId)) === conn) await this.release(projectId);
    }
  }

  private async removePublishedDevices(conn: Connection, name: string, projectId: string, port: number | undefined): Promise<void> {
    const incus = this.incusOf(conn);
    const match = port === undefined ? (d: string) => /^banto-pub-\d+$/.test(d) : (d: string) => d === `banto-pub-${port}`;
    const container = containerNameFor(projectId);
    const gone = await this.onePublishAtATime(name, async () => {
      // 外す前に待ち受けていた VM のポートを読んでおく（しばらく選ばない——`RELEASED_PORT_COOLDOWN_MS`）
      const before = (await incus.state(container))?.devices ?? {};
      const removed = await incus.removeDevices(container, match);
      const released = this.releasedPorts.get(name) ?? new Map<number, number>();
      for (const d of removed) {
        const vmPort = /^tcp:.*:(\d+)$/.exec(before[d]?.["listen"] ?? "")?.[1];
        if (vmPort !== undefined) released.set(Number(vmPort), Date.now());
      }
      this.releasedPorts.set(name, released);
      return removed;
    });
    if (gone.length > 0) this.log(`[host] 別のサーバ「${name}」の Project ${projectId} の公開の道を外しました（${gone.join("・")}）`);
  }

  /** 同じ実行場所の公開の道の張り外しを1本ずつ通す */
  private onePublishAtATime<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.publishing.get(name) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.publishing.set(name, run);
    void run.finally(() => {
      if (this.publishing.get(name) === run) this.publishing.delete(name);
    }).catch(() => undefined);
    return run;
  }

  /** VM で待ち受けている TCP のポート（`ss` が無ければ空——装置を足すときに Incus が断る） */
  private async vmListeningPorts(conn: Connection): Promise<Set<number>> {
    const r = await this.run(conn, "command -v ss >/dev/null 2>&1 || exit 0\nss -Hltn 2>/dev/null | awk '{print $4}'\n", { timeoutMs: 15_000 });
    return new Set([...r.stdout.matchAll(/:(\d+)$/gm)].map((m) => Number(m[1])));
  }

  /** 接続が切れていれば、次に要るときに繋ぎ直す（繋がっていれば何もしない——Module が1つ落ちただけで全部を張り直さない） */
  forget(placeId: string): void {
    const name = this.opts.remoteNameOf(placeId);
    if (!name) return;
    const key = remoteConnectionKey(name, placeId);
    const conn = this.connections.get(key);
    if (conn && !conn.alive) this.connections.delete(key);
    // containers：次に使うとき、コンテナの様子を確かめ直す（止められた・消された）
    if (conn) delete conn.container;
  }

  /**
   * 手放す：**その Project の**接続を閉じ、待ち受けも閉じる（Module は呼び元が先に落としている。向こうの機械は止めない）。
   * 同じ実行場所のほかの Project の接続には触らない。**containers で `stop` なら、先にその Project のコンテナを止める**
   * （眠らせる・閉じる——この機械のコンテナと同じ。v4-security.md §1「他の仕組みとの関係」）。止められなければ、接続は閉じた
   * うえで `RuntimeStopError`（呼び元が受信箱で言う）
   */
  async release(placeId: string, opts: { stop?: boolean } = {}): Promise<void> {
    const name = this.opts.remoteNameOf(placeId);
    if (!name) return;
    const key = remoteConnectionKey(name, placeId);
    let stopError: RuntimeStopError | undefined;
    // 眠らせたときに止めてあって、そのあと繋いでいない（＝起こしていない）なら、止めるために繋がない
    const alreadyStopped = !this.connections.get(key)?.alive && this.opts.stoppedWhileAsleep?.(placeId) === true;
    if (alreadyStopped && opts.stop) this.log(`[host] 別のサーバ「${name}」の Project ${placeId} のコンテナは眠らせたときに止めてあるので、止めに行きません`);
    if (opts.stop && !alreadyStopped && this.modeOf(name, key) === "containers") {
      try {
        await this.stopProjectContainer(name, placeId);
      } catch (err) {
        stopError = new RuntimeStopError(`別のサーバ「${name}」のコンテナ ${containerNameFor(placeId)}`, err instanceof Error ? err.message : String(err));
      }
    }
    await this.closeConnectionOf(key);
    if (stopError) throw stopError;
  }

  /** その鍵（実行場所＋Project）の接続と待ち受けを閉じる */
  private async closeConnectionOf(key: string): Promise<void> {
    // 繋いでいる途中の接続（まだ表に入っていない）に「手放された」と分かるようにする——待ち受けはここで閉じるので、
    // そのまま表に入ると閉じた待ち受けへのトンネルを張った接続が残る
    this.releases.set(key, (this.releases.get(key) ?? 0) + 1);
    const conn = this.connections.get(key);
    if (conn) {
      this.connections.delete(key);
      await closeConnection(conn);
    }
    this.closeListener(key);
  }

  /**
   * **移す先のコンテナを用意する**（v4-security.md §1「`containers` との間で移す」の 3.、#464）。作るときと同じ手（土台のイメージ・
   * pool・idmap・port_isolation・道）を、**移している Project・移す先の根で**呼ぶ——移している間は Project の記録が元の実行場所・
   * 元の根のままなので、`prepare` の形（記録から実行場所と根を引く）では呼べない。接続は（移す先・Project）が鍵で、成功ならそのまま
   * 使い（切り替えたあとの `prepare` が同じ接続を拾う）、失敗なら呼び元が `closeMoveTarget` で閉じる。
   *
   * 根と**写す Module の置き場の全部**を disk device で見せ（Module の置き場は Module を起こすときにしか付けないので、ここで付ける）、
   * VM と中の inode を比べて見えていることを確かめる（`mountIsStale` と同じ手）。退かせて作り直したフォルダを前からあったコンテナが
   * 古い装置で掴んでいれば、付け直す。返すのはコンテナの名前と中の番号（展開・印・`git worktree repair` を中でするため）
   */
  async prepareMoveTarget(
    runtimeName: string,
    place: { id: string; root: string; nesting: boolean },
    moduleDirs: readonly string[],
  ): Promise<{ container: string; inside: InsideIds }> {
    const key = remoteConnectionKey(runtimeName, place.id);
    const live = this.connections.get(key);
    const conn = live?.alive ? live : await this.connecting.run(this.flightKey(runtimeName, place.id), () => this.connect(runtimeName, place.id));
    if (conn.runtime.mode !== "containers") throw new Error(`別のサーバ「${runtimeName}」は Project ごとのコンテナ（containers）ではありません`);
    this.refuseUnusable(conn, place);
    // 前の接続で用意したものを使わない（根が違う・装置が古い）——確かめ直す
    if (conn.container && conn.container.root !== place.root) delete conn.container;
    const container = await this.ensureProjectContainer(conn, place);
    const { inside } = await this.containerIdsOf(conn);
    const incus = this.incusOf(conn);
    const dirs = [place.root, ...moduleDirs];
    const read = async () =>
      parseInodePairs(await this.mustRun(conn, "移す先のフォルダが中から見えるかを確かめられ", inodePairsScript(container, dirs)), dirs.length);
    const before = await read();
    // 根は `ensure` が付けている。古いフォルダを掴んでいれば（根を作り直した）付け直す。Module の置き場は全部ここで付ける
    await Promise.all(
      dirs.map((dir, i) => {
        const p = before[i]!;
        const stale = p.inside !== undefined && p.inside !== p.vm;
        if (i === 0) return stale ? incus.ensureDisk(container, "project", dir, { remount: true }) : Promise.resolve();
        return incus.ensureDisk(container, moduleDiskName(dir), dir, { remount: stale });
      }),
    );
    const after = await read();
    const unseen = dirs.filter((_, i) => !after[i]!.vm || after[i]!.vm !== after[i]!.inside);
    if (unseen.length > 0) {
      throw new Error(`別のサーバ「${runtimeName}」のコンテナ ${container} に、移す先のフォルダが見えていません（${unseen.join("・")}）`);
    }
    this.log(`[host] 別のサーバ「${runtimeName}」に移す先のコンテナ ${container} を用意しました（根 ${place.root}・Module の置き場 ${moduleDirs.length} 個）`);
    return { container, inside };
  }

  /**
   * **移す先の接続を閉じる**（移せなかったとき・起き直して片づけるとき）。今の `release` は Project の記録から実行場所を引くが、
   * 移せなかった Project の記録は元の実行場所のまま——実行場所を指して閉じる。繋いでいなければ何もしない（繋がない）
   */
  async closeMoveTarget(runtimeName: string, projectId: string): Promise<void> {
    await this.closeConnectionOf(remoteConnectionKey(runtimeName, projectId));
  }

  /** 実行場所の動かし方（張っている接続があればその登録、無ければ今の登録） */
  private modeOf(name: string, key: string): RemoteRuntime["mode"] | undefined {
    return this.connections.get(key)?.runtime.mode ?? this.opts.runtimes.get(name)?.mode;
  }

  /**
   * **containers：その Project のコンテナを止める**（穏やかに止め、上限を過ぎたら強制停止——`ProjectContainers.stop`）。接続が
   * 無ければ止めるために繋ぐ（接続を閉じてもコンテナと中の Service は動いたまま——banto を起こし直したあと等）。無いコンテナ・
   * 止まっているコンテナには何もしない
   */
  private async stopProjectContainer(name: string, projectId: string): Promise<void> {
    const key = remoteConnectionKey(name, projectId);
    const live = this.connections.get(key);
    const conn = live?.alive ? live : await this.connecting.run(this.flightKey(name, projectId), () => this.connect(name, projectId));
    // 止めたついでに、まだ中の番号が前のもの（#368 の 1000）なら1回だけ U に付け替える（#457。止まったまま返る）
    await this.incusOf(conn).stopAndMigrate(containerNameFor(projectId), containerSpecIds(await this.vmIds(conn)));
    // 次に使うときは、止まったコンテナを起こすところから確かめ直す（中の番号も読み直す）
    delete conn.container;
    delete conn.containerIds;
    this.log(`[host] 別のサーバ「${name}」の Project ${projectId} のコンテナを止めました`);
  }

  /** 実行場所を外したとき：先に送るために張った接続が残っていれば閉じる（用意している途中・送っている途中でも止める） */
  async closeRuntime(runtimeName: string): Promise<void> {
    // 繋いでいる途中の接続（まだどこにも掴めない段のものも）に「外された」と分かるようにする
    this.removals.set(runtimeName, (this.removals.get(runtimeName) ?? 0) + 1);
    // 外した実行場所の「送っています／送れませんでした」は画面に残さない
    this.clearTransfer(runtimeName);
    // 用意している途中（先に送っている最中など）なら、その接続を閉じて止める——送っている ssh が切れ、送り込みは
    // 「外されたのでやめました」で終わる
    // 鍵は「名前\0Project」——名前に \0 は入らない
    const onRuntime = (key: string) => key.startsWith(`${runtimeName}\0`);
    const pending = [...this.settingUp].filter(([key]) => onRuntime(key)).map(([, c]) => c);
    for (const c of pending) c.removed = true;
    await Promise.all(pending.map(closeConnection));
    const conns = [...this.connections].filter(([key]) => onRuntime(key));
    for (const [key] of conns) this.connections.delete(key);
    await Promise.all(conns.map(([, c]) => closeConnection(c)));
    for (const key of [...this.listeners.keys()]) if (onRuntime(key)) this.closeListener(key);
  }

  /** 終わるとき：張っている接続を全部閉じる */
  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map(closeConnection));
    this.connections.clear();
  }

  /** プロセスが終わるとき（同期で）：張っている接続の ssh を落とす */
  killAll(): void {
    for (const c of this.connections.values()) if (c.alive) c.master.kill("SIGTERM");
  }

  // ── 接続 ────────────────────────────────────────────────────────────────

  private async ensureConnection(name: string, place: RuntimePlace): Promise<Connection> {
    const existing = this.connections.get(remoteConnectionKey(name, place.id));
    const conn = existing?.alive ? existing : await this.connecting.run(this.flightKey(name, place.id), () => this.connect(name, place.id));
    this.refuseUnusable(conn, place);
    this.raiseCautions(conn, place);
    return conn;
  }

  /** 繋いだ接続でも、この Project の設定では使えない（中で Docker を使うのに docker が無い）なら断る */
  private refuseUnusable(conn: Connection, place: RuntimePlace): void {
    const docker = conn.checks.find((c) => c.id === "docker");
    if (place.nesting && docker && docker.status !== "ok") {
      const failure = this.dockerFailures.get(conn.runtimeName);
      throw new Error(
        `別のサーバ「${conn.runtimeName}」で Module を起こせません——この Project は「中で Docker を使う」設定ですが、` +
          `${docker.detail ?? "Docker が使えません。"}（直し方：${docker.fix ?? "向こうで Docker を入れる"}）` +
          (failure ? `\nbanto が入れようとしましたが、できませんでした：${failure}` : ""),
      );
    }
  }

  /**
   * **「中で Docker を使う」Project を人が作る・開くときに、Docker を入れる**（`machine`。v4-security.md §1「足りないものは banto が
   * 入れる」の 5a.、Backlog #414）。Module を起こす前に呼ぶ。人が開いた・送ったとき（`cause`）だけで、自動化・届いたもので起きた
   * ときは何もしない（Module を起こすところで今どおり断る）。前の確かめで Docker が使えていれば繋がない。入れたら（グループを
   * 替えたら）その Project の接続を閉じる——多重化した SSH の親は古いグループのままで、次に繋ぐときの確かめで Docker を見直す。
   * **投げない**：入れられなければログに残し、断るときの文に理由を添える。入れたら true
   */
  async installDockerForPerson(projectId: string, nesting: boolean, cause: ProjectWokeCause): Promise<boolean> {
    const name = this.opts.remoteNameOf(projectId);
    if (!name || !nesting || !mayInstallDocker(cause)) return false;
    const key = remoteConnectionKey(name, projectId);
    if (this.modeOf(name, key) === "containers") return false;
    const live = this.connections.get(key);
    const docker = (live?.alive ? live.checks : this.opts.runtimes.get(name)?.checks)?.find((c) => c.id === "docker");
    if (docker?.status === "ok") return false;
    let ran: RanCommand[];
    try {
      ran = await this.opts.runtimes.installDocker(name, cause);
      this.dockerFailures.delete(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dockerFailures.set(name, message);
      this.log(`[host] 別のサーバ「${name}」に Docker を入れられませんでした（Project ${projectId}）：${message}`);
      return false;
    }
    if (ran.length === 0) return false;
    this.dockerPrepared.set(name, [...(this.dockerPrepared.get(name) ?? []), ...ran]);
    this.log(`[host] 別のサーバ「${name}」に Docker を使えるようにしました（Project ${projectId} を人が開いた）：${ran.map((r) => r.display).join(" ／ ")}`);
    await this.closeConnectionOf(key);
    return true;
  }

  /**
   * 繋ぐのを1本にまとめる鍵。**登録を外した回数・手放した回数を含める**——外したあとに同じ名前で登録し直したら、外す前に
   * 始まった繋ぎ（前の host 向け）に相乗りしない。手放したあとに使い直したら、手放す前に始まった繋ぎ（手放されたので
   * 断って終わる）に相乗りしない
   */
  private flightKey(name: string, projectId: string | undefined): string {
    const key = remoteConnectionKey(name, projectId);
    return `${key}\0${this.removals.get(name) ?? 0}\0${this.releases.get(key) ?? 0}`;
  }

  /** 繋ぐ（`projectId` が無ければ、先に送るためだけの接続——逆向きのトンネルを張らない） */
  private async connect(name: string, projectId: string | undefined): Promise<Connection> {
    const key = remoteConnectionKey(name, projectId);
    // **繋いでいる途中で登録を外されたか**を見る印（修正・2026-10-12、レビュー）。外す側（`closeRuntime`）は、まだ前提を
    // 確かめている・親の接続を待っている段の接続を掴めない（`settingUp` に入る前）。そのまま完走させると、外した実行場所
    // （や、同じ名前で登録し直した別の host）に古い接続が残り、そこで Module が起きる。始めたときの回数と比べて断る
    const generation = this.removals.get(name) ?? 0;
    const removed = () => (this.removals.get(name) ?? 0) !== generation;
    // 同じく**繋いでいる途中で手放されたか**（修正・2026-10-18、レビュー）。手放す側（`release`）は表に入る前の接続を
    // 掴めず、待ち受けだけを閉じる——表に入れる前に見て断る
    const releasedAtStart = this.releases.get(key) ?? 0;
    const released = () => (this.releases.get(key) ?? 0) !== releasedAtStart;
    const listener = projectId !== undefined ? await this.listenerFor(name, projectId) : undefined;
    const started = performance.now();
    const conn = await this.opts.runtimes.withConnection(name, async (r, files) => {
      // 1. 前提を確かめる（Module を起こす前に。v4-security.md §1「前提の確かめ」。containers は準備が崩れていないことを
      //    確かめるだけで、sudo しない）
      const { checks, result } = await this.opts.runtimes.probeChecks(r, files, r.hostKey.type, "verify");
      if (checks.length === 0) throw new SshCommandError(`${r.user}@${r.host} に繋げませんでした`, result);
      // 人が開いたときに Docker を入れたなら、確かめの一覧の最後に「banto が向こうで行ったこと」（次に繋いだときの確かめで消える）
      const prepared = this.dockerPrepared.get(name);
      this.dockerPrepared.delete(name);
      await this.opts.runtimes.recordChecks(name, prepared ? [...checks, preparedCheck(prepared)] : checks);
      const failed = checks.filter((c) => c.status === "fail");
      if (failed.length > 0) {
        throw new Error(
          `別のサーバ「${name}」で Module を起こせません——前提が足りません：` +
            failed.map((c) => `${c.label}：${c.detail ?? "足りません"}${c.fix ? `（直し方：${c.fix.replace(/\n/g, " ")}）` : ""}`).join(" ／ "),
        );
      }
      // containers の Project の Module は、Project のコンテナの中で起こす（`prepare`→`preparedInContainer`）。VM のユーザーで
      // 直に起こさない——その Project の AI が sudo できるユーザーになる

      // 2. 接続を1本張る（多重化・逆向きのトンネル）
      const controlPath = this.controlPathFor(name, projectId);
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
          // **machine のトンネルは向こうの側も TCP**（番号は sshd に選ばせる）。Module は `bantoOrigin` の http で繋ぐ——
          // UNIX ソケットにすると Module の側に繋ぎ方が要る。その実行場所の Project は1つなので、番号の取り違い
          // （v4-security.md §1、Fable の A3）は起きない。containers では Project ごとの決まったパスのソケットにし、
          // コンテナを用意するときに張る（`ensureTunnel`——張る前に置き場を作り古いソケットを消すので、ここでは張れない）
          ...(listener && r.mode !== "containers" ? ["-R", `0:127.0.0.1:${listener.port}`] : []),
          "--",
          r.host,
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: sshEnv() },
      );
      const { remotePort, exited, stderrTail } = await waitMasterReady(master, controlPath, { tunnel: listener !== undefined && r.mode !== "containers" });
      const conn: Connection = {
        runtimeName: name,
        ...(projectId !== undefined ? { projectId } : {}),
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
        forwards: new Map(),
        cautioned: new Set(),
      };
      void exited.then(() => {
        conn.alive = false;
        if (this.connections.get(key) === conn) this.connections.delete(key);
        const why = stderrTail().split("\n").filter((l) => l.trim() && !/^Allocated port/.test(l)).slice(-3).join(" ");
        this.log(`[host] 別のサーバ「${name}」${forWhom(projectId)}との SSH の接続が閉じました（終了コード ${master.exitCode ?? master.signalCode}${why ? `：${why}` : ""}）`);
      });
      // 用意している途中の接続も、登録を外したら閉じられるようにしておく（`closeRuntime`）
      this.settingUp.set(key, conn);
      // ここまで（前提の確かめ・親の接続を待つ間）に外されていたら、コードを送らずにやめる
      const removedBeforeSync = removed();
      if (removedBeforeSync) conn.removed = true;
      try {
        if (removedBeforeSync) throw new Error(`実行場所「${name}」が外されたので、繋ぐのをやめました`);
        // 3. 向こうの置き場を決め、コードを照合する
        conn.base = await this.resolveBase(conn);
        // 照合と、エージェントの本体の古い版の片づけは、同じ実行場所の送り込みと重ねない（片づけが、ほかの Project の接続が
        // 送っている途中の本体の置き場を消さない）
        conn.codeDir = await this.oneSyncAtATime(name, async () => {
          const codeDir = await this.syncCode(conn);
          await this.pruneAgentBinaries(conn);
          return codeDir;
        });
        if (conn.removed) throw new Error(`実行場所「${name}」が外されたので、繋ぐのをやめました`);
      } catch (err) {
        master.kill("SIGTERM");
        await exited;
        // 送っている途中で外された（`closeRuntime` が親を閉じた）なら、ssh の「途中で閉じました」ではなく外されたことを理由にする
        throw conn.removed && !removedBeforeSync ? new Error(`実行場所「${name}」が外されたので、コードを送るのをやめました`) : err;
      } finally {
        if (this.settingUp.get(key) === conn) this.settingUp.delete(key);
      }
      return conn;
    });
    // 最後にもう一度：返ってくるまでの間に外されていたら、張った接続を残さない
    if (removed()) {
      await closeConnection(conn);
      throw new Error(`実行場所「${name}」が外されたので、繋ぐのをやめました`);
    }
    if (released()) {
      await closeConnection(conn);
      throw new Error(`別のサーバ「${name}」${forWhom(projectId)}の接続は、繋いでいる途中で手放されたので、繋ぐのをやめました`);
    }
    // **鍵の窓口は閉じない**（未実装・2026-10-10）：Vault に窓口を閉じる口がまだ無い。多重化した接続は張ったあと鍵を使わない
    this.connections.set(key, conn);
    // Project の接続が張れたら、先に送るためだけの接続は要らない（コードはこの接続が照合した・資源もこれで読める）
    if (projectId !== undefined) void this.closeWarmUp(name);
    this.opts.onConnected?.(name, projectId);
    this.log(
      `[host] 別のサーバ「${name}」${forWhom(projectId)}に繋ぎました（${Math.round(performance.now() - started)}ms・` +
        (!listener
          ? "先に送るためだけ・"
          : conn.runtime.mode === "containers"
            ? `トンネルは用意するときに Project のソケットへ → 中継の待ち受け 127.0.0.1:${listener.port}・`
            : `向こうの 127.0.0.1:${conn.remotePort} → 中継の待ち受け 127.0.0.1:${listener.port}・`) +
        `コード ${basename(conn.codeDir)}）`,
    );
    return conn;
  }

  /**
   * **向こうの CPU が AVX2 を持つか**（追加・2026-10-17、アーキ仕様 §4.1）——繋いだときの前提の確かめで覚えたもの。分からなければ
   * 持たないとする（baseline はどこでも動く）
   */
  remoteHasAvx2(projectId: string): boolean {
    return this.liveConnection(projectId, "エージェントの本体を選べ").checks.find((c) => c.id === "cpu-avx2")?.value === "1";
  }

  /**
   * **banto が取ってきたエージェントの本体を、向こうに見せる**（追加・2026-10-17、アーキ仕様 §4.1「別のサーバへの見せ方」）。置き場は
   * 塗り（`code/layers/`）とは別の `<置き場>/agent-binaries/<同じ名前>/`——塗りは版の `.layers` に載らないものを片づけるので、そこに
   * 置くと次の送り込みで消える。**使うたびに**向こうの中身を `syncPackageDir` と同じ digest で照合し（向こうの AI が書き換えうる。
   * 1本なので軽い）、合えば送らない。送るのは（実行場所・フォルダの名前）ごとに1本だけ。返すのは向こうの実行ファイルのパス
   */
  async ensureAgentBinary(
    projectId: string,
    binary: { name: string; hostDir: string; fileName: string; title: string },
    onProgress?: ProgressListener,
  ): Promise<string> {
    const conn = this.liveConnection(projectId, `${binary.title} の本体を送れ`);
    // 同じ実行場所のコードの照合・送り込み（と、繋いだときの本体の古い版の片づけ）とは重ねない——別の Project の接続が
    // 繋いだときの片づけが、送っている途中の置き場（`.incoming-*`）を消さない
    return this.agentBinarySends.run(
      `${conn.runtimeName}\0${binary.name}`,
      (emit) => this.oneSyncAtATime(conn.runtimeName, () => this.sendAgentBinary(conn, binary, emit)),
      onProgress,
    );
  }

  private async sendAgentBinary(conn: Connection, binary: { name: string; hostDir: string; fileName: string; title: string }, emit: ProgressListener): Promise<string> {
    const remoteDir = `${conn.base}/agent-binaries/${binary.name}`;
    const remoteFile = `${remoteDir}/${binary.fileName}`;
    const digest = await bundleDigest(collectTreeEntries(binary.hostDir), this.hashes);
    const now = await this.mustRun(
      conn,
      `${binary.title} の本体を確かめられ`,
      [
        `if [ -d ${shq(remoteDir)} ]; then printf 'digest=%s\\n' "$(${remoteDigestCommand(shq(remoteDir))})"; fi`,
        "command -v zstd >/dev/null 2>&1 && echo zstd=1",
        "command -v gzip >/dev/null 2>&1 && echo gzip=1",
        "exit 0",
        "",
      ].join("\n"),
      { timeoutMs: 120_000 },
    );
    if (/^digest=(.*)$/m.exec(now)?.[1] === digest) return remoteFile;

    const codec: Codec =
      /^zstd=1$/m.test(now) && zstd.createZstdCompress && zstd.constants.ZSTD_c_compressionLevel !== undefined ? "zstd" : /^gzip=1$/m.test(now) ? "gzip" : "none";
    const hostFile = join(binary.hostDir, binary.fileName);
    const total = statSync(hostFile).size;
    let sent = 0;
    let movedAt = performance.now();
    const tracker: TransferTracker = {
      add: (n) => {
        sent += n;
        movedAt = performance.now();
      },
      stalledFor: () => performance.now() - movedAt,
      sentBytes: () => sent,
      end: () => undefined,
    };
    // 進まないときに止めるのは送る ssh（`run` の stalledFor）——ここは知らせるだけ
    const watcher = watchProgress({
      timing: { ...DEFAULT_PROGRESS_TIMING, giveUpMs: Number.POSITIVE_INFINITY },
      bytes: () => sent,
      describe: (b) => `別のサーバ「${conn.runtimeName}」に ${binary.title} の本体を送っています（${mb(b)} / ${mb(total)}MB）`,
      report: emit,
      giveUp: () => undefined,
    });
    const staging = `${remoteDir}.incoming-${randomBytes(4).toString("hex")}`;
    const started = performance.now();
    try {
      await this.sendStream(
        conn,
        `${binary.title} の本体を送れ`,
        createReadStream(hostFile),
        `mkdir -p ${shq(staging)} && cat > ${shq(`${staging}/${binary.fileName}`)} && chmod 755 ${shq(`${staging}/${binary.fileName}`)}`,
        codec,
        tracker,
      );
      const got = await this.mustRun(conn, `送った ${binary.title} の本体を確かめられ`, `printf '%s\\n' "$(${remoteDigestCommand(shq(staging))})"\n`, {
        timeoutMs: 120_000,
      });
      if (got.trim() !== digest) {
        throw new Error(
          `別のサーバ「${conn.runtimeName}」に送った ${binary.title} の本体が、向こうで違う中身になりました（送った版 ${digest.slice(0, 12)}・向こう ${got.trim().slice(0, 12)}）`,
        );
      }
      await this.mustRun(
        conn,
        `送った ${binary.title} の本体を置け`,
        `mkdir -p ${shq(`${conn.base}/agent-binaries`)} && rm -rf -- ${shq(remoteDir)} && mv -- ${shq(staging)} ${shq(remoteDir)}\n`,
      );
      this.log(`[host] 別のサーバ「${conn.runtimeName}」に ${binary.title} の本体を送りました（${binary.name}・${mb(total)}MB・${Math.round(performance.now() - started)}ms）`);
      return remoteFile;
    } catch (err) {
      await this.run(conn, `rm -rf -- ${shq(staging)}\n`, { timeoutMs: 30_000 });
      throw err;
    } finally {
      watcher.stop();
    }
  }

  /** **繋いだときに**、向こうの `<置き場>/agent-binaries/` のうち、いまの目録に無い版と送りかけのものを消す */
  private async pruneAgentBinaries(conn: Connection): Promise<void> {
    const keep = this.opts.agentBinaryDirNames?.();
    if (!keep) return;
    const out = await this.mustRun(
      conn,
      "エージェントの本体の古い版を片づけられ",
      [
        `d=${shq(`${conn.base}/agent-binaries`)}`,
        `[ -d "$d" ] || exit 0`,
        `for x in "$d"/* "$d"/.incoming-*; do`,
        `  [ -e "$x" ] || continue`,
        `  case "$(basename "$x")" in ${[...keep].map(shq).join("|") || "''"}) continue ;; esac`,
        `  rm -rf -- "$x" && printf 'removed=%s\\n' "$(basename "$x")"`,
        "done",
        "exit 0",
        "",
      ].join("\n"),
    );
    const removed = [...out.matchAll(/^removed=(.*)$/gm)].map((m) => m[1]!).filter((n) => !n.startsWith(".incoming-"));
    if (removed.length > 0) this.log(`[host] 別のサーバ「${conn.runtimeName}」の、いまの目録に無いエージェントの本体を消しました（${removed.join("・")}）`);
  }

  /** 先に送るためだけに張った接続を閉じる */
  private async closeWarmUp(name: string): Promise<void> {
    const key = remoteConnectionKey(name, undefined);
    const warm = this.connections.get(key);
    if (!warm) return;
    this.connections.delete(key);
    await closeConnection(warm);
  }

  /**
   * **同じ実行場所のコードの照合・送り込みは1本ずつ**——Project の接続が同時に張られても、版の置き場（`<版>-<連番>`）と
   * 塗りの置き場を取り合わない。あとの方は、前のが送り終えた版を照合するだけになる。エージェントの本体の送り込みと、その
   * 古い版の片づけ（`<置き場>/agent-binaries/`）も同じ列に並べる——片づけが送っている途中のものを消さない
   */
  private oneSyncAtATime<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.codeSyncs.get(name) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.codeSyncs.set(name, run);
    void run.finally(() => {
      if (this.codeSyncs.get(name) === run) this.codeSyncs.delete(name);
    }).catch(() => undefined);
    return run;
  }

  /**
   * ControlPath（短く——Unix ソケットの上限に ssh の一時の名前を足して収まること）。実行場所＋Project ごと（先に送るため
   * だけの接続は実行場所の名前だけから）
   */
  private controlPathFor(name: string, projectId: string | undefined): string {
    const dir = coreSocketDir(this.opts.dataDir);
    const path = join(dir, `cm-${createHash("sha256").update(projectId !== undefined ? remoteConnectionKey(name, projectId) : name).digest("hex").slice(0, 10)}`);
    if (Buffer.byteLength(path) + CONTROL_PATH_SUFFIX > SOCKET_PATH_LIMIT) {
      throw new Error(
        `SSH の接続の窓口のパスが長すぎて作れません（${path}。Unix ソケットは ${SOCKET_PATH_LIMIT} バイトまで）——banto のデータの置き場を短いパスにしてください`,
      );
    }
    return path;
  }

  /** 実行場所＋Project ごとの、中継だけを受ける待ち受け（127.0.0.1。繋ぎ直しても同じポートを使い続ける） */
  private async listenerFor(name: string, projectId: string): Promise<{ server: Server; port: number }> {
    const key = remoteConnectionKey(name, projectId);
    const existing = this.listeners.get(key);
    if (existing) return existing;
    const server = this.opts.createRelayListener(name, projectId);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref();
    const entry = { server, port: (server.address() as AddressInfo).port };
    // 待ち受けている間に手放された（同時に `listenerFor` が走っていた）なら、先にできた方を使う
    const raced = this.listeners.get(key);
    if (raced) {
      server.close();
      return raced;
    }
    this.listeners.set(key, entry);
    return entry;
  }

  /** 待ち受けを閉じる（その Project を手放した・実行場所を外した） */
  private closeListener(key: string): void {
    const l = this.listeners.get(key);
    if (!l) return;
    this.listeners.delete(key);
    l.server.close();
  }

  /** linger・tmux が無いことは断らず、受信箱に注意を出す */
  private raiseCautions(conn: Connection, place: RuntimePlace): void {
    if (conn.cautioned.has(place.id)) return;
    conn.cautioned.add(place.id);
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
  private run(conn: Connection, script: string, opts: RunOptions = {}): Promise<SshResult> {
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
      const { stalledFor } = opts;
      // 流し込むもの（`stalledFor` あり）は全体の時間では切らず、進まなくなったら止める
      const timer = stalledFor
        ? setInterval(() => {
            const limit = this.opts.transferStallMs ?? TRANSFER_STALL_MS;
            if (stalledFor() < limit) return;
            stderr += `\n（${Math.round(limit / 1000)} 秒のあいだ1バイトも送れなかったので止めました）`;
            child.kill("SIGKILL");
          }, 1_000)
        : setTimeout(() => {
            stderr += `\n（${Math.round((opts.timeoutMs ?? 60_000) / 1000)} 秒で終わらなかったので止めました）`;
            child.kill("SIGKILL");
          }, opts.timeoutMs ?? 60_000);
      child.on("error", (err) => (stderr += err.message));
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(timer);
        resolve({ code: code ?? 255, stdout, stderr });
      });
      child.stdin.on("error", () => undefined);
      // 流し込むものが途中で壊れたら（読めない・縮められない）、半端なものを向こうに渡さず止める
      opts.stdin?.on("error", (err: Error) => {
        stderr += `\n（送るものを読めませんでした：${err.message}）`;
        child.kill("SIGKILL");
      });
      if (opts.stdin) opts.stdin.pipe(child.stdin);
      else child.stdin.end(script);
    });
  }

  private async mustRun(conn: Connection, what: string, script: string, opts: RunOptions = {}): Promise<string> {
    const r = await this.run(conn, script, opts);
    // **接続が切れたのか、向こうのコマンドが失敗したのかを見分ける**（修正・2026-10-12）。接続が切れると、その上の ssh
    // （終了コード 255）と親の接続のどちらが先に終わったと見えるかは決まらない。255 で親がまだ生きて見えるなら、親が
    // 閉じるかを少しだけ見てから理由を決める（先に 255 を見ると「ssh の終了コード 255」だけになり、何が起きたか分からない）
    if (r.code === 255 && conn.alive) {
      await Promise.race([conn.exited, new Promise((resolve) => setTimeout(resolve, MASTER_CLOSE_GRACE_MS).unref())]);
    }
    if (r.code !== 0 && !conn.alive) {
      throw new SshConnectionClosedError(`別のサーバ「${conn.runtimeName}」で${what}ませんでした——SSH の接続が途中で閉じました`);
    }
    if (r.code !== 0) throw new SshCommandError(`別のサーバ「${conn.runtimeName}」で${what}ませんでした`, r);
    return r.stdout;
  }

  // ── ソケットの転送（v4-security.md §1「ソケットの転送」）──────────────────

  /**
   * **流れの口**：host の短いパスで待ち受け、向こうの `<置き場>/modules/<接続名>/s/stream.sock` へ転送する（`-L`）。
   * 返すのは host の側のパス（host はここへ流れごとに繋ぐ）。向こうの待ち受けは繋ぐたびに引かれるので、Module が
   * 起こし直されても張り直さなくてよい
   */
  async streamSocketPath(projectId: string, connName: string, remoteSocketRel: string): Promise<string> {
    const conn = this.liveConnection(projectId, "流れの口を繋げ");
    const name = `st-${createHash("sha256").update(connName).digest("hex").slice(0, 10)}`;
    const hostPath = this.shortSocketPath(name);
    // containers：転送の先（Module の置き場の中）は中の AI が symlink に差し替えられる——VM のユーザー（incus グループ）として
    // 辿ると Incus の管理用の口にも届く。VM では proxy device が待ち受け、中で繋ぐ（`streamIntoContainer`）
    if (conn.runtime.mode === "containers") return this.streamIntoContainer(conn, name, hostPath, `${conn.base}/modules/${connName}/${remoteSocketRel}`);
    // 向こうの待ち受けは Module の置き場（長い）。短い symlink を置いて、sshd にはそちらへ繋がせる
    await this.addForward(conn, {
      purpose: "stream",
      dir: "L",
      hostPath,
      remotePath: `${conn.base}/s/${name}`,
      remoteTarget: `${conn.base}/modules/${connName}/${remoteSocketRel}`,
    });
    return hostPath;
  }

  /**
   * **containers の流れの口**（v4-security.md §1「道」——**向きが逆**。Module が中で待ち受け、host が繋ぐ。Fable の B3）：VM の
   * `<置き場>/s/st-<印>`（コンテナに見せていない）で proxy device（`bind=host`）が待ち受け、中の Module の待ち受けへ繋ぐ。`connect` は
   * **中で辿られる**ので、中の AI が置き場を symlink に差し替えても、繋がるのは中の権限で届く先だけ。host はそこへ `-L` で転送する。
   * 待ち受けの置き場は VM のディスクにあるので、VM やコンテナを起こし直しても装置はそのまま待ち受けられる——外さない
   */
  private async streamIntoContainer(conn: Connection, name: string, hostPath: string, insidePath: string): Promise<string> {
    const container = await conn.container?.ready;
    if (!container) throw new Error(`別のサーバ「${conn.runtimeName}」のコンテナがまだ用意できていません（流れの口を繋げません）`);
    const ids = await this.containerIdsOf(conn);
    const vmPath = `${conn.base}/s/${name}`;
    // 先に置き場を作って転送を張り（`-L` は繋ぐたびに先を引く）、それから VM の待ち受け（装置）を張る
    await this.addForward(conn, { purpose: "stream", dir: "L", hostPath, remotePath: vmPath });
    await this.incusOf(conn).ensureProxy(container, `banto-${name}`, { bind: "host", listen: `unix:${vmPath}`, connect: `unix:${insidePath}` }, ids);
    return hostPath;
  }

  /**
   * **鍵の窓口**：Vault が host の側（Module の置き場の `s`）に立てた ssh-agent を、向こうの置き場の `s` へ転送する（`-R`。
   * 名前は host のパスから決める——同じ窓口は同じ名前）。返すのは向こうの側のパス（Module に渡す `socketPath`）。
   * host の窓口が消えたら（Vault が閉じた）転送も外す
   */
  private async forwardAgentSocket(conn: Connection, hostPath: string): Promise<string> {
    if (!conn.alive) throw new Error(`別のサーバ「${conn.runtimeName}」に鍵の窓口を見せられません——SSH の接続が閉じています`);
    const remotePath = `${conn.base}/s/a-${createHash("sha256").update(hostPath).digest("hex").slice(0, 12)}`;
    await this.addForward(conn, { purpose: "agent", dir: "R", hostPath, remotePath });
    this.watchAgentSockets();
    return remotePath;
  }

  /**
   * **containers の鍵の窓口**（v4-security.md §1「道」の ssh-agent）：Vault が host に立てた窓口を、VM だけの場所の Project ごとの
   * ソケットへ `-R` で転送し、proxy device（`bind=instance`）でコンテナの中の短いパスに出す。名前は host のパスから決める
   * （Module から来た文字列を使わない）。返すのは中のパス（Module に渡す `socketPath`）。host の窓口が消えたら転送と装置を外す
   */
  private async forwardAgentIntoContainer(conn: Connection, container: string, hostPath: string): Promise<string> {
    if (!conn.alive) throw new Error(`別のサーバ「${conn.runtimeName}」に鍵の窓口を見せられません——SSH の接続が閉じています`);
    const ids = await this.containerIdsOf(conn);
    const mark = createHash("sha256").update(hostPath).digest("hex").slice(0, 12);
    const vmPath = `${this.vmProjectDir(conn, ids.uid)}/a-${mark}.sock`;
    const inside = agentInsidePath(mark);
    const device = { container, name: `${AGENT_DEVICE_PREFIX}${mark}` };
    await this.addForward(conn, { purpose: "agent", dir: "R", hostPath, remotePath: vmPath, device });
    await this.incusOf(conn).ensureProxy(container, device.name, { bind: "instance", listen: `unix:${inside}`, connect: `unix:${vmPath}` }, ids);
    this.watchAgentSockets();
    return inside;
  }

  /**
   * **Project の箱の中で argv を1つ流す**（追加・2026-10-20、Backlog #466——Repositories のブランチを運ぶ git、`remote-git.ts`）。
   * machine は VM のユーザー（箱そのもの）、containers はコンテナの中のユーザー（`incus exec`、条件3——VM のユーザーでは流さない）。
   * 標準入出力はバイトのまま。標準出力が `maxStdoutBytes` を越えたら止めて `overflow`。Module が起きていない（接続が無い）なら投げる
   */
  async runInProject(
    projectId: string,
    argv: readonly string[],
    opts: { stdin?: Buffer; maxStdoutBytes: number; timeoutMs: number },
  ): Promise<{ code: number; stdout: Buffer; stderr: string; overflow?: true }> {
    const conn = this.liveConnection(projectId, "git を流せ");
    let remote: string;
    if (conn.runtime.mode === "containers") {
      const container = await conn.container?.ready;
      if (!container) throw new Error(`別のサーバ「${conn.runtimeName}」のコンテナがまだ用意できていません（git を流せません）`);
      remote = insideCommand(container, (await this.containerIdsOf(conn)).inside, argv);
    } else {
      remote = `exec ${argv.map(shq).join(" ")}`;
    }
    return new Promise((resolve) => {
      const child = spawn("ssh", [...this.muxArgs(conn), "--", conn.runtime.host, remote], { stdio: ["pipe", "pipe", "pipe"], env: sshEnv() });
      const chunks: Buffer[] = [];
      let size = 0;
      let overflow = false;
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => {
        if (overflow) return;
        size += c.length;
        if (size > opts.maxStdoutBytes) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(c);
      });
      child.stderr.on("data", (c: Buffer) => (stderr = (stderr + String(c)).slice(-8000)));
      const timer = setTimeout(() => {
        stderr += `\n（${Math.round(opts.timeoutMs / 1000)} 秒で終わらなかったので止めました）`;
        child.kill("SIGKILL");
      }, opts.timeoutMs);
      child.on("error", (err) => (stderr += err.message));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 255, stdout: Buffer.concat(chunks), stderr, ...(overflow ? { overflow: true as const } : {}) });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.stdin ?? Buffer.alloc(0));
    });
  }

  private liveConnection(projectId: string, what: string): Connection {
    const name = this.opts.remoteNameOf(projectId);
    const conn = name ? this.connections.get(remoteConnectionKey(name, projectId)) : undefined;
    if (!name || !conn?.alive) throw new Error(`別のサーバ「${name ?? projectId}」で${what}ません——SSH の接続がありません（Module が起きていません）`);
    return conn;
  }

  /** host の側の短い窓口のパス（データの置き場の `s`。Unix ソケットの上限を越えるなら断る） */
  private shortSocketPath(fileName: string): string {
    const dir = coreSocketDir(this.opts.dataDir);
    const path = join(dir, fileName);
    if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
      throw new Error(`ソケットの転送の窓口のパスが長すぎて作れません（${path}。Unix ソケットは ${SOCKET_PATH_LIMIT} バイトまで）——banto のデータの置き場を短いパスにしてください`);
    }
    return path;
  }

  /** 転送を張る（同じものが張ってあれば何もしない。同時の要求は1回にまとめる） */
  private async addForward(conn: Connection, f: SocketForward): Promise<void> {
    if (Buffer.byteLength(f.remotePath) > SOCKET_PATH_LIMIT) {
      throw new Error(
        `別のサーバ「${conn.runtimeName}」の窓口のパスが長すぎて転送できません（${f.remotePath}。Unix ソケットは ${SOCKET_PATH_LIMIT} バイトまで）——実行場所の置き場の根を短いパスにしてください`,
      );
    }
    const key = `${f.dir}:${f.hostPath}`;
    if (conn.forwards.has(key)) return;
    await this.forwarding.run(`${remoteConnectionKey(conn.runtimeName, conn.projectId)}\0${key}`, async () => {
      if (conn.forwards.has(key)) return;
      // 待ち受ける側に同じパスのファイルが残っていれば先に消す（外した転送の窓口のファイルは残る——sshd の
      // `StreamLocalBindUnlink` は root の設定なので頼らない）。`-L` の先は向こうの短い symlink（machine）か、proxy device が
      // VM で待ち受けるソケット（containers——Incus が張るので消さない）。置き場は途中のフォルダも VM のユーザーだけのものにする
      const remoteDir = `"$(dirname ${shq(f.remotePath)})"`;
      if (f.dir === "L") rmSync(f.hostPath, { force: true });
      await this.mustRun(
        conn,
        "ソケットの転送の置き場を用意でき",
        `umask 077 && mkdir -p -- ${remoteDir} && chmod 700 ${remoteDir}` +
          (f.remoteTarget ? ` && ln -sfn -- ${shq(f.remoteTarget)} ${shq(f.remotePath)}\n` : f.dir === "R" ? ` && rm -f -- ${shq(f.remotePath)}\n` : "\n"),
      );
      const r = await this.control(conn, "forward", f);
      if (r.code !== 0) throw new SshCommandError(`別のサーバ「${conn.runtimeName}」へのソケットの転送を張れませんでした`, r);
      conn.forwards.set(key, f);
    });
  }

  /** 転送を外す（向こうに残った窓口のファイルも消す） */
  private async cancelForward(conn: Connection, key: string): Promise<void> {
    const f = conn.forwards.get(key);
    if (!f) return;
    conn.forwards.delete(key);
    if (!conn.alive) return;
    const r = await this.control(conn, "cancel", f);
    if (r.code !== 0 && conn.alive) this.log(`[host] 別のサーバ「${conn.runtimeName}」のソケットの転送を外せませんでした: ${r.stderr.trim().slice(-300)}`);
    if (f.dir === "R") await this.run(conn, `rm -f -- ${shq(f.remotePath)}\n`, { timeoutMs: 30_000 });
    else rmSync(f.hostPath, { force: true });
    // containers：一緒に張った proxy device も外す（窓口が閉じたら外す——v4-security.md §1「道」）
    const { device } = f;
    if (device && conn.incus) {
      await conn.incus
        .removeDevices(device.container, (d) => d === device.name)
        .catch((err: unknown) => this.log(`[host] 別のサーバ「${conn.runtimeName}」のコンテナ ${device.container} の道 ${device.name} を外せませんでした: ${String(err)}`));
    }
  }

  /** 多重化した接続の親に、転送を張る・外すよう頼む（`-O forward`／`-O cancel`） */
  private control(conn: Connection, op: "forward" | "cancel", f: SocketForward): Promise<SshResult> {
    const spec = f.dir === "L" ? `${f.hostPath}:${f.remotePath}` : `${f.remotePath}:${f.hostPath}`;
    return new Promise((resolve) => {
      const child = spawn("ssh", [...this.muxArgs(conn), "-O", op, `-${f.dir}`, spec, "--", conn.runtime.host], {
        stdio: ["ignore", "pipe", "pipe"],
        env: sshEnv(),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += String(c)));
      child.stderr.on("data", (c: Buffer) => (stderr += String(c)));
      child.on("error", (err) => (stderr += err.message));
      child.on("close", (code) => resolve({ code: code ?? 255, stdout, stderr }));
    });
  }

  /** **Vault が窓口を閉じたら転送も外す**——host の側の窓口のファイルが消えたことで知る（Vault に閉じたと知らせる口は無い） */
  private watchAgentSockets(): void {
    if (this.agentWatch) return;
    this.agentWatch = setInterval(() => {
      let remaining = 0;
      for (const conn of this.connections.values()) {
        for (const [key, f] of conn.forwards) {
          if (f.purpose !== "agent") continue;
          if (existsSync(f.hostPath)) remaining++;
          else void this.cancelForward(conn, key).catch((err: unknown) => this.log(`[host] 鍵の窓口の転送を外せませんでした: ${String(err)}`));
        }
      }
      if (remaining === 0) {
        clearInterval(this.agentWatch);
        this.agentWatch = undefined;
      }
    }, AGENT_WATCH_INTERVAL_MS);
    this.agentWatch.unref();
  }

  /** 向こうの、この banto の置き場（置き場の根の下に、データの置き場ごとに分ける——`owner` と同じ） */
  private async resolveBase(conn: Connection): Promise<string> {
    const owner = remoteOwnerDirName(this.opts.dataDir);
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
   * （版の鍵＋連番）に組んでから切り替える——同じ版で走っている Module の足元を差し替えない。前の版を1つ残す。
   * 送るのは向こうに無い（か、書き換えられていた）塗りだけ（Backlog #298——ふだんの更新ではコードの数MB）。依存は
   * パッケージごとの塗りで、向こうに無いパッケージだけを1本の tar で送る（Backlog #325）。向こうとの往復は
   * パッケージの数によらない（問い合わせ・照合・分ける・組む・切り替えが、それぞれ1回）
   */
  private async syncCode(conn: Connection): Promise<string> {
    const entries = collectCodeBundle(this.opts.monorepoRoot, { nodePath: process.execPath, launcherPath: this.launcherPath });
    const digest = await bundleDigest(entries, this.hashes);
    const layers = await computeLayers(entries, this.hashes);
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
        // 送るときの縮め方を選ぶため、向こうで展開できるものを聞いておく
        "command -v zstd >/dev/null 2>&1 && echo zstd=1",
        "command -v gzip >/dev/null 2>&1 && echo gzip=1",
        "exit 0",
        "",
      ].join("\n"),
      { timeoutMs: 180_000 },
    );
    const cur = /^cur=(.*)$/m.exec(state)?.[1] ?? "";
    const remoteDigest = /^digest=(.*)$/m.exec(state)?.[1];
    if (cur.startsWith(`${prefix}-`) && remoteDigest === digest) {
      // 前に送れなかった印が残っていれば消す（向こうの版はもう合っている）
      this.clearTransfer(conn.runtimeName);
      return `${code}/${cur}`;
    }

    const why = !cur ? "初めて" : !cur.startsWith(`${prefix}-`) ? "版が変わった" : "向こうで書き換えられていた";
    const dirs = [...state.matchAll(/^dir=(.*)$/gm)].map((m) => m[1]!);
    const n = Math.max(0, ...dirs.filter((d) => d.startsWith(`${prefix}-`)).map((d) => Number(d.slice(prefix.length + 1)) || 0)) + 1;
    const next = `${prefix}-${n}`;
    // 向こうにある塗りを、使う前に照合する（向こうの AI が書き換えうる）。鍵の頭が合うものだけを計算する
    const have = await this.mustRun(
      conn,
      "コードの塗りを確かめられ",
      [
        `L=${shq(`${code}/layers`)}`,
        `mkdir -p "$L"`,
        `for d in ${[...new Set(layers.map((l) => layerPrefix(l.kind, l.digest)))].map((prefix) => `"$L"/${shq(prefix)}*`).join(" ")}; do`,
        `  [ -d "$d" ] || continue`,
        `  printf 'layer=%s\\t%s\\n' "$(basename "$d")" "$(${remoteDigestCommand('"$d"')})"`,
        "done",
        "exit 0",
        "",
      ].join("\n"),
      { timeoutMs: 300_000 },
    );
    const remoteLayers = new Map([...have.matchAll(/^layer=([^\t\n]+)\t(.*)$/gm)].map((m) => [m[1]!, m[2]!] as const));
    const plan = planLayers(layers, remoteLayers).map((p, i) => ({ ...p, ...layers[i]! }));
    const toSend = plan.filter((p) => p.send);
    const sendPkgs = toSend.filter((l) => l.kind === "pkg");
    const sendWhole = toSend.filter((l) => l.kind !== "pkg");
    const sending = performance.now();
    // 縮め方：向こうに展開するコマンドがあるもの（zstd は host の node が持っていれば）
    const codec: Codec =
      /^zstd=1$/m.test(state) && zstd.createZstdCompress && zstd.constants.ZSTD_c_compressionLevel !== undefined ? "zstd" : /^gzip=1$/m.test(state) ? "gzip" : "none";
    // 分母は送る塗りの合計（コードだけなら数MB）。送る塗りが無ければ（向こうで組み直すだけ）出さない
    const transfer = toSend.length > 0 ? this.startTransfer(conn.runtimeName, sendBytes(toSend)) : undefined;
    // **確かめて切り替え終えるまで「送っています」のままにする**——消えたら使える、という意味にする（送り終えてから
    // 向こうで確かめる間に消すと、人には終わったように見えて Module はまだ起きない）
    // 送れなかったら、その理由を同じ行に残す（次に送り始めるまで）——黙って消すと、人には終わったように見える
    try {
      let wireBytes = 0;
      if (sendPkgs.length > 0) wireBytes += await this.sendPackages(conn, `${code}/layers`, sendPkgs, codec, transfer!);
      for (const layer of sendWhole) wireBytes += await this.sendLayer(conn, `${code}/layers`, layer, codec, transfer!);
      const rawBytes = transfer?.sentBytes() ?? 0;
      const dir = await this.assembleAndSwitch(conn, { digest, code, cur, next, layers: plan.map((p) => ({ name: p.name, path: p.path })) });
      if (transfer) transfer.end();
      else this.clearTransfer(conn.runtimeName);
      const what =
        toSend.length === 0
          ? "送った塗りは無く組み直しだけ"
          : `送った塗り ${[...sendWhole.map((l) => l.kind), ...(sendPkgs.length > 0 ? [`パッケージ ${sendPkgs.length} 個`] : [])].join("・")}・` +
            `${toSend.reduce((sum, l) => sum + l.entries.length, 0)} 件・` +
            `${mb(rawBytes)}MB を ${codec === "none" ? "縮めずに" : `${codec} で ${mb(wireBytes)}MB に縮めて`}`;
      this.log(`[host] 別のサーバ「${conn.runtimeName}」にコードを送りました（${why}・版 ${next}・${what}・${Math.round(performance.now() - sending)}ms）`);
      return dir;
    } catch (err) {
      transfer?.end(err);
      throw err;
    }
  }

  /**
   * 向こうに無いパッケージを1本の tar で送り、向こうでパッケージごとの塗りに分けて、確かめてから名前を付ける
   * （往復は送るのと分けるのとで2回——パッケージの数によらない）。返すのは線に流したバイト数
   */
  private async sendPackages(conn: Connection, layersDir: string, pkgs: ReadonlyArray<Layer & { name: string }>, codec: Codec, transfer: TransferTracker): Promise<number> {
    const incoming = `.incoming-${randomBytes(4).toString("hex")}`;
    const wire = await this.sendTree(conn, pkgs.flatMap((l) => l.entries), `${layersDir}/${incoming}`, codec, transfer);
    const out = await this.mustRun(conn, "送った依存を確かめられ", remoteSplitPackagesScript({ layersDir, incoming, packages: pkgs }), { timeoutMs: 300_000 });
    const bad = [...out.matchAll(/^bad=([^\t\n]+)\t(.*)$/gm)].map((m) => {
      const pkg = pkgs.find((l) => l.name === m[1]);
      return `${pkg?.path ?? m[1]}（送った版 ${pkg?.digest.slice(0, 12) ?? "?"}・向こう ${m[2]!.slice(0, 12)}）`;
    });
    if (bad.length > 0) throw new Error(`別のサーバ「${conn.runtimeName}」に送った依存が、向こうで違う中身になりました：${bad.join("、")}`);
    return wire;
  }

  /** 1つの塗り（コード・node）を向こうの塗りの置き場に送り、確かめてから名前を付ける。返すのは線に流したバイト数 */
  private async sendLayer(
    conn: Connection,
    layersDir: string,
    layer: Layer & { name: string },
    codec: Codec,
    transfer: TransferTracker,
  ): Promise<number> {
    const staging = `${layersDir}/.incoming-${randomBytes(4).toString("hex")}`;
    let wire = 0;
    if (layer.kind === "node") {
      const nodeTo = `${staging}/${REMOTE_NODE_REL}`;
      wire += await this.sendStream(
        conn,
        "node を送れ",
        createReadStream(process.execPath),
        `mkdir -p "$(dirname ${shq(nodeTo)})" && cat > ${shq(nodeTo)} && chmod 755 ${shq(nodeTo)}`,
        codec,
        transfer,
      );
    } else {
      wire += await this.sendTree(conn, layer.entries, staging, codec, transfer);
      if (layer.entries.some((e) => e.rel === REMOTE_LAUNCHER_REL)) {
        wire += await this.sendStream(conn, "起動役を送れ", createReadStream(this.launcherPath), `cat > ${shq(`${staging}/${REMOTE_LAUNCHER_REL}`)}`, codec, transfer);
      }
    }
    const sent = await this.mustRun(conn, "送ったコードを確かめられ", `printf '%s\\n' "$(${remoteDigestCommand(shq(staging))})"\n`, {
      timeoutMs: 300_000,
    });
    if (sent.trim() !== layer.digest) {
      throw new Error(
        `別のサーバ「${conn.runtimeName}」に送ったコード（${layer.kind}）が、向こうで違う中身になりました（送った版 ${layer.digest.slice(0, 12)}・向こう ${sent.trim().slice(0, 12)}）`,
      );
    }
    await this.mustRun(conn, "送ったコードに名前を付けられ", `mv ${shq(staging)} ${shq(`${layersDir}/${layer.name}`)}\n`);
    return wire;
  }

  /** 塗りから新しい版の置き場を組み、向こうで確かめてから切り替える（`syncCode` の後半） */
  private async assembleAndSwitch(
    conn: Connection,
    p: { digest: string; code: string; cur: string; next: string; layers: ReadonlyArray<{ name: string; path: string }> },
  ): Promise<string> {
    const staging = `.incoming-${randomBytes(4).toString("hex")}`;
    const out = await this.mustRun(conn, "コードの版を組め", remoteAssembleScript({ code: p.code, staging, layers: p.layers }), { timeoutMs: 300_000 });
    const got = /^digest=(.*)$/m.exec(out)?.[1] ?? "";
    if (got !== p.digest) {
      throw new Error(`別のサーバ「${conn.runtimeName}」で組んだコードが、送った版と違う中身になりました（送った版 ${p.digest.slice(0, 12)}・向こう ${got.slice(0, 12)}）`);
    }
    // 切り替えて、いまの版と前の版のほか（と、どちらも参照しない塗り）を消す
    await this.mustRun(conn, "コードを切り替えられ", remoteSwitchScript({ code: p.code, staging, next: p.next, cur: p.cur, layers: p.layers }));
    return `${p.code}/${p.next}`;
  }

  /** 一覧のファイルと symlink を tar で流して、向こうのフォルダに展開する。返すのは線に流したバイト数 */
  private async sendTree(conn: Connection, entries: readonly BundleEntry[], remoteDir: string, codec: Codec, transfer: TransferTracker): Promise<number> {
    const tar = spawn("tar", ["-C", this.opts.monorepoRoot, "--null", "--no-recursion", "-cf", "-", "-T", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let tarErr = "";
    tar.stderr.on("data", (c: Buffer) => (tarErr += String(c)));
    tar.stdin.on("error", () => undefined);
    tar.stdin.end(tarList(entries));
    const tarDone = new Promise<number>((resolve) => tar.on("close", (code) => resolve(code ?? 1)));
    // **送る側（ssh）の結果は、すぐに受けておく**（修正・2026-10-12、レビュー）——止めた（進まない・登録を外した・接続が
    // 切れた）とき ssh が先に失敗する。tar は書き出し先が止まって塞がったまま終わらないので、tar を待ってから ssh の結果を
    // 見る順だと、ssh の失敗が誰にも受けられずに core ごと落ち（unhandledRejection）、tar を待つ側は永久に返らなかった
    const sending = this.sendStream(conn, "コードを送れ", tar.stdout, `mkdir -p ${shq(remoteDir)} && tar -C ${shq(remoteDir)} -xf -`, codec, transfer).then(
      (wire) => ({ ok: true as const, wire }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    const first = await Promise.race([sending, tarDone.then((code) => ({ tarCode: code }))]);
    if ("ok" in first && !first.ok) {
      // ssh が先に失敗した：tar を止めて（塞がっているので自分では終わらない）、終わったのを見てから ssh の理由で止まる
      tar.kill("SIGKILL");
      await tarDone;
      throw first.err;
    }
    const tarCode = await tarDone;
    const sent = await sending;
    // tar が失敗したなら、その理由で止める（向こうの「途中で切れた」より先に読む）
    if (tarCode !== 0) throw new Error(`送るコードを tar にまとめられませんでした：${tarErr.trim().slice(-500)}`);
    if (!sent.ok) throw sent.err;
    return sent.wire;
  }

  /**
   * **縮めて流し、向こうで展開して `sink`（sh の式。展開したものを標準入力で読む）に渡す**。数えるのは縮める前のバイト数
   * （`transfer`）。全体の時間では切らず、進まなくなったら止める（`TRANSFER_STALL_MS`）。返すのは線に流したバイト数
   */
  private async sendStream(conn: Connection, what: string, source: Readable, sink: string, codec: Codec, transfer: TransferTracker): Promise<number> {
    let wire = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        transfer.add(chunk.length);
        cb(null, chunk);
      },
    });
    // 速さを優先した段（host の 1 コアで回線より十分速い。実測は Backlog #269 のコミットの文）
    const compressor =
      codec === "zstd"
        ? zstd.createZstdCompress!({ params: { [zstd.constants.ZSTD_c_compressionLevel!]: 3 } })
        : codec === "gzip"
          ? zlib.createGzip({ level: 1 })
          : new PassThrough();
    const onWire = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        wire += chunk.length;
        cb(null, chunk);
      },
    });
    // 途中のどれかが壊れたら、流れの終わり（ssh の標準入力）に伝える——`run` がそれを見て ssh を止める
    for (const [from, to] of [
      [source, counted],
      [counted, compressor],
      [compressor, onWire],
    ] as const) {
      from.on("error", (err: Error) => to.destroy(err));
    }
    source.pipe(counted).pipe(compressor).pipe(onWire);
    const unpack = codec === "zstd" ? "zstd -dcq | " : codec === "gzip" ? "gzip -dc | " : "";
    try {
      await this.mustRun(conn, what, `${unpack}{ ${sink}; }`, { stdin: onWire, stalledFor: transfer.stalledFor });
    } catch (err) {
      // 止まった（ssh が終わった）なら、流れの上流も閉じる——閉じないと、書き出し先を失った流れが止まったまま残り、
      // 元（tar の出力・node のファイル）を握り続ける
      for (const stream of [onWire, compressor, counted, source]) stream.destroy();
      throw err;
    }
    return wire;
  }

  /** 送っている間の進み具合を覚え、間引いて知らせる */
  private startTransfer(runtimeName: string, totalBytes: number): TransferTracker {
    const t: CodeTransfer = { sentBytes: 0, totalBytes, startedAt: new Date().toISOString() };
    this.transfers.set(runtimeName, t);
    let reportedAt = 0;
    let movedAt = performance.now();
    const report = () => {
      reportedAt = performance.now();
      this.opts.onCodeTransfer?.(runtimeName, { ...t });
    };
    report();
    return {
      add: (n) => {
        // 見積もりを越えて数えない（分母は tar の形からの見積もり）
        t.sentBytes = Math.min(t.totalBytes, t.sentBytes + n);
        movedAt = performance.now();
        if (movedAt - reportedAt >= TRANSFER_REPORT_INTERVAL_MS) report();
      },
      stalledFor: () => performance.now() - movedAt,
      sentBytes: () => t.sentBytes,
      end: (err) => {
        if (this.transfers.get(runtimeName) !== t) return;
        if (err === undefined) {
          this.clearTransfer(runtimeName);
          return;
        }
        t.failed = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        report();
      },
    };
  }

  /** 送っている途中・送れなかった印を消して、画面に知らせる */
  private clearTransfer(runtimeName: string): void {
    if (!this.transfers.delete(runtimeName)) return;
    this.opts.onCodeTransfer?.(runtimeName, undefined);
  }

  // ── 用意できた箱 ────────────────────────────────────────────────────────

  /** machine：中から banto に届く origin（向こうの 127.0.0.1 の、sshd が選んだトンネルの番号） */
  private machineOrigin(conn: Connection): string {
    if (conn.remotePort === undefined) throw new Error(`別のサーバ「${conn.runtimeName}」の接続に逆向きのトンネルがありません（先に送るためだけの接続です）`);
    return `http://127.0.0.1:${conn.remotePort}`;
  }

  private preparedFrom(conn: Connection, bantoOrigin: string): PreparedPlace {
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
      bantoOrigin,
      pathInside,
      async prepareModuleDirs({ dataDir: moduleDataDir, packageDir }) {
        await self.mustRun(conn, "Module の置き場を作れ", `mkdir -p ${shq(pathInside(moduleDataDir))} && chmod 700 ${shq(pathInside(moduleDataDir))}`);
        if (existsSync(packageDir) && statSync(packageDir).isDirectory()) await self.syncPackageDir(conn, packageDir, pathInside(packageDir));
      },
      // 鍵の窓口（ssh-agent）は Vault が host の側に立て、中継が向こうの置き場の `s` へ転送する（`socketPathInside`）。
      // host の側の窓口は向こうに見せるものではない（転送の元）ので、Module の置き場ではなく core の短い置き場の下に
      // Module ごとのフォルダで立てる——置き場が深いと Unix ソケットの 107 バイトを越えた（E2E、2026-10-11）
      socketDirFor: (moduleDataDir) => moduleSocketDir(coreSocketDir(dataDir), moduleDataDir),
      socketPathInside(hostPath) {
        const own = coreSocketDir(dataDir);
        if (!hostPath.startsWith(`${dataDir}/`) && !hostPath.startsWith(`${own}/`)) {
          throw new Error(`鍵の窓口 ${hostPath} は banto の置き場の外です——別のサーバへ転送しません`);
        }
        return self.forwardAgentSocket(conn, hostPath);
      },
      async prepareShellHome(moduleDataDir, files) {
        const home = `${pathInside(moduleDataDir)}/home`;
        const resync = (f: readonly string[]) => self.sendShellHome(conn, moduleDataDir, home, f);
        return { home, sync: await resync(files), resync };
      },
      // **向こうで sudo しない**（v4-security.md §1「前提の確かめ」）——Module にもそう伝える（Terminal は tmux が無ければ、
      // sudo で入れずに入れ方を添えて断る）
      moduleEnv: { BANTO_NO_SUDO: "1" },
      processCommand(p: RuntimeProcess) {
        // 道具用の箱はいつもこの host のコンテナ（v4-security.md §2）——向こうで root の Module は起こさない
        if (p.asRoot) throw new Error(`${p.name} を別のサーバで root として起こすことはできません`);
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

  // ── containers：Project のコンテナ ───────────────────────────────────────

  /** この接続の上で VM に台本を流す口 */
  private vmShell(conn: Connection): VmShell {
    return (script, opts) => this.run(conn, script, opts ?? {});
  }

  /**
   * **Project のコンテナを用意する**（v4-security.md §1「コンテナの作りと上限」）。無ければ VM の上の土台のイメージから作り、
   * VM のユーザーの uid/gid を中の番号に対応させ、`<置き場>/code` を丸ごと読み取り専用・根をそのまま見せ、NIC を隔て、
   * 中から banto への道（proxy device）を張る。上限は VM の資源で計算する。名前・札・アドレスは毎回 Incus に聞く（覚えるのは
   * 「この接続で用意した」ことだけ）
   */
  private ensureProjectContainer(conn: Connection, place: RuntimePlace): Promise<string> {
    const cur = conn.container;
    const virtualization = this.opts.containerVirtualization?.(conn.runtimeName, place.id);
    const virtKey = JSON.stringify(virtualization ?? null);
    if (cur && cur.root === place.root && cur.nesting === place.nesting && cur.virtualization === virtKey) return cur.ready;
    // ブリッジが VM から消えていて起こせなければ「確かめ直す」を案内する（Backlog #427）
    const ready = this.createProjectContainer(conn, place, virtualization).catch((err: unknown) => Promise.reject(withMissingBridgeHint(err)));
    conn.container = { root: place.root, nesting: place.nesting, virtualization: virtKey, ready };
    // 失敗したら覚えない（次に使うときにやり直す）
    ready.catch(() => {
      if (conn.container?.ready === ready) delete conn.container;
    });
    return ready;
  }

  private async createProjectContainer(conn: Connection, place: RuntimePlace, virtualization: ContainerVirtualization | null | undefined): Promise<string> {
    if (!place.root) throw new Error(`別のサーバ「${conn.runtimeName}」の Project ${place.id} に根がありません`);
    if (place.tools) throw new Error("道具用の箱は別のサーバには置きません");
    const shell = this.vmShell(conn);
    const run = vmIncus(shell);
    const incus = this.incusOf(conn);
    const ids = await this.vmIds(conn);
    // 中から banto への道の先（その Project のトンネルのソケット）。張ってからコンテナを用意する（装置が繋ぐ先）
    const tunnel = await this.ensureTunnel(conn);
    const image = await this.ensureVmBaseImage(conn, run);
    const { name, inside } = await incus.ensure({
      projectId: place.id,
      root: place.root,
      // 版はパスで選ぶ（版を替えても装置を付け直さない——眠っているコンテナが消えた版を指して起きられなくなるのを避ける）
      bantoDir: `${conn.base}/code`,
      nodePath: `${conn.codeDir}/${REMOTE_NODE_REL}`,
      nodeVersion: process.version,
      nesting: place.nesting,
      image,
      owner: this.opts.dataDir,
      ...containerSpecIds(ids),
      portIsolation: true,
      proxies: { [RELAY_DEVICE]: relayRoute(tunnel) },
      limits: await this.containerLimitsOn(conn.runtimeName, shell),
      ...(virtualization !== undefined ? { virtualization } : {}),
    });
    // いまこのコンテナで使う中の番号（まだ付け替えていなければ前の番号）。あとから足す道・起こし方はこれに従う
    conn.containerIds = { ...ids, inside };
    // 前の接続で張った鍵の窓口の装置を外す（窓口の転送は接続と一緒に消えている。窓口は Vault が開き直したときに張り直す）。
    // 接続ごとに1回——同じ接続で用意し直す（`forget`）ときに、いま使っている窓口を外さない
    if (!conn.agentDevicesCleared) {
      conn.agentDevicesCleared = true;
      const gone = await incus.removeDevices(name, (d) => d.startsWith(AGENT_DEVICE_PREFIX));
      if (gone.length > 0) this.log(`[host] 別のサーバ「${conn.runtimeName}」のコンテナ ${name} から、前の接続の鍵の窓口の道を外しました（${gone.join("・")}）`);
    }
    return name;
  }

  /** VM の資源で計算した上限（hugepages の合計はメモリから引く——hugepages はメモリの cgroup に数えない） */
  private async containerLimitsOn(runtimeName: string, shell: VmShell) {
    const vm = await vmResources(shell);
    const reserved = this.opts.hugepagesReservedBytes?.(runtimeName) ?? 0;
    return defaultContainerLimits({ ...vm, memoryBytes: vm.memoryBytes - reserved });
  }

  /** この接続の上で Incus を呼ぶ口（装置の書き換えを1本ずつ通すので、接続ごとに1つ） */
  private incusOf(conn: Connection): ProjectContainers {
    const shell = this.vmShell(conn);
    return (conn.incus ??= new ProjectContainers(vmIncus(shell), DEFAULT_TIMEOUTS, vmInterfaces(shell)));
  }

  /**
   * コンテナの番号の対応（外＝VM のユーザー・中）。**中の番号はここにしか書かない**——コンテナの宣言と、あとから足す道（鍵の窓口・
   * 流れの口・公開）が同じものを使う
   */
  private async containerIdsOf(conn: Connection): Promise<{ uid: number; gid: number; inside: { uid: number; gid: number } }> {
    if (conn.containerIds) return conn.containerIds;
    const { uid, gid } = await this.vmIds(conn);
    // 中の番号はコンテナごと（札の無い前のコンテナは、付け替えるまで前の番号）。無ければ新しく作るときの番号（U）
    const st = conn.projectId !== undefined ? await this.incusOf(conn).state(containerNameFor(conn.projectId)) : undefined;
    return (conn.containerIds = { uid, gid, inside: effectiveInsideIds(st?.config, containerSpecIds({ uid, gid })) });
  }

  /** VM のユーザーの番号（接続ごとに1回読む） */
  private vmIds(conn: Connection): Promise<{ uid: number; gid: number }> {
    const read = (conn.vmIds ??= (async () => {
      const out = await this.mustRun(conn, "ユーザーの番号を読め", "id -u\nid -g\n");
      const [uid, gid] = out.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error(`別のサーバ「${conn.runtimeName}」のユーザーの番号を読めませんでした：${out.trim()}`);
      return { uid: uid!, gid: gid! };
    })());
    read.catch(() => {
      if (conn.vmIds === read) delete conn.vmIds;
    });
    return read;
  }

  /** その接続の Project の、VM だけの場所（コンテナに見せていない） */
  private vmProjectDir(conn: Connection, uid: number): string {
    if (conn.projectId === undefined) throw new Error(`別のサーバ「${conn.runtimeName}」の先に送るためだけの接続には Project の置き場がありません`);
    return vmProjectRunDir((this.opts.vmRunDir ?? vmUserRunDir)(uid), conn.projectId);
  }

  /**
   * **containers の逆向きのトンネル**（v4-security.md §1「SSH の接続は Project ごとに1本」）：VM の側は番号ではなく Project ごとの
   * 決まったパスの UNIX ソケット（`<VM だけの場所>/t.sock`）——`-R 0:…` だと、ある Project の接続が切れている間に同じ番号が
   * 別の Project に割り当てられ、残っているコンテナから別の Project の待ち受けに届く（Fable の A3）。パスが決まっているので、
   * 繋ぎ直しても中から banto への道（proxy device）を変えない。張る前に置き場を作り、古いソケットを消す（`addForward`）。
   * 接続ごとに1回。返すのは VM のソケットのパス
   */
  private ensureTunnel(conn: Connection): Promise<string> {
    const projectId = conn.projectId;
    const listener = projectId !== undefined ? this.listeners.get(remoteConnectionKey(conn.runtimeName, projectId)) : undefined;
    if (!listener) return Promise.reject(new Error(`別のサーバ「${conn.runtimeName}」${forWhom(projectId)}の中継の待ち受けがありません（手放されました）`));
    const tunnel = (conn.tunnel ??= (async () => {
      const { uid } = await this.vmIds(conn);
      const socket = `${this.vmProjectDir(conn, uid)}/t.sock`;
      await this.addForward(conn, { purpose: "tunnel", dir: "R", hostPath: `127.0.0.1:${listener.port}`, remotePath: socket });
      this.log(`[host] 別のサーバ「${conn.runtimeName}」${forWhom(projectId)}のトンネルを張りました（向こうの ${socket} → 中継の待ち受け 127.0.0.1:${listener.port}）`);
      return socket;
    })());
    tunnel.catch(() => {
      if (conn.tunnel === tunnel) delete conn.tunnel;
    });
    return tunnel;
  }

  /** VM の上の土台のイメージ（VM ごとに1つ）。作るあいだは段を画面に出す */
  private async ensureVmBaseImage(conn: Connection, run: ReturnType<typeof vmIncus>): Promise<string> {
    const name = conn.runtimeName;
    let started: CodeTransfer | undefined;
    try {
      const alias = await ensureBaseImage(run, 900_000, {
        key: `remote:${name}`,
        extractNodeTar: async (tmp, tarPath) => {
          await this.mustRun(conn, "土台のイメージに node を置け", `exec incus exec ${shq(tmp)} -- tar -C /usr/local --no-same-owner -xf -`, {
            stdin: createReadStream(tarPath),
            timeoutMs: 600_000,
          });
        },
        onStep: (step) => {
          started ??= { sentBytes: 0, totalBytes: 0, startedAt: new Date().toISOString() };
          started.baseImage = step;
          this.transfers.set(name, started);
          this.opts.onCodeTransfer?.(name, { ...started });
          this.log(`[host] 別のサーバ「${name}」でコンテナの土台のイメージを作っています：${step}`);
        },
      });
      if (started) this.clearTransfer(name);
      return alias;
    } catch (err) {
      if (started && this.transfers.get(name) === started) {
        started.failed = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        this.opts.onCodeTransfer?.(name, { ...started });
      }
      throw err;
    }
  }

  /**
   * **コンテナの中で Module を起こす箱**。パスは machine と同じ（VM のパスのまま、中にも同じパスで見せる）。違うのは：
   * Module の置き場はその Project のコンテナにだけ見せる・Shell のホームは中で展開する・起こすのは
   * `incus exec <c> --user <中の番号> -- <起動役>`・単位を止めるのも中で・中から banto へは中の 127.0.0.1 の決めたポート
   * （proxy device がその Project のトンネルのソケットへ繋ぐ）・鍵の窓口は中の `/run` に出す
   */
  private preparedInContainer(conn: Connection, container: string, inside: InsideIds): PreparedPlace {
    // 中継と Claude のログインの中継の住所：コンテナの中の 127.0.0.1（VM の 127.0.0.1 は中からは届かない——自分のネットワーク
    // 名前空間を持つ）
    const base = this.preparedFrom(conn, `http://127.0.0.1:${INSIDE_RELAY_PORT}`);
    const self = this;
    const incus = this.incusOf(conn);
    const nodePath = `${conn.codeDir}/${REMOTE_NODE_REL}`;
    const launcherPath = `${conn.codeDir}/${REMOTE_LAUNCHER_REL}`;
    /** Module の置き場を見せ終えるまで（Shell のホームはその中で展開する） */
    const mounts = new Map<string, Promise<void>>();
    const diskName = moduleDiskName;
    const { moduleEnv: _noSudo, ...rest } = base;
    return {
      ...rest,
      // 中では sudo できる（この機械のコンテナと同じ）——BANTO_NO_SUDO は渡さない
      name: `別のサーバ「${conn.runtimeName}」のコンテナ ${container}`,
      nodePath,
      prepareModuleDirs({ dataDir: moduleDataDir, packageDir }) {
        const done = (async () => {
          const dir = base.pathInside(moduleDataDir);
          // まだ見せていなければ VM のユーザーで作るだけ（symlink は辿らない）。中身は中から
          await self.mustRun(conn, "Module の置き場を作れ", createOnlyDirScript(dir));
          const disks = [incus.ensureDisk(container, diskName(dir), dir)];
          if (existsSync(packageDir) && statSync(packageDir).isDirectory()) {
            // 配布物は読み取り専用で見せる——中から書き換えられないので、VM のユーザーで置き換えてよい
            const remote = base.pathInside(packageDir);
            // **コンテナが今の VM のフォルダを見ていなければ付け直す**：置き換えはフォルダごと差し替える（rename）ので、付いたままの
            // 装置は消した古いフォルダを指し続け、中からは空に見える（Module が起きられない）。配布物の置き場は同じ VM の全 Project で
            // 共有なので、「この接続が置き換えたか」では決めない——ほかの Project の接続が置き換えた分も、ここで拾う
            await self.syncPackageDir(conn, packageDir, remote);
            const stale = await self.mountIsStale(conn, container, remote);
            disks.push(incus.ensureDisk(container, diskName(remote), remote, { readonly: true, remount: stale }));
          }
          await Promise.all(disks);
        })();
        mounts.set(moduleDataDir, done);
        return done;
      },
      // 鍵の窓口（ssh-agent）：VM だけの場所へ転送し、proxy device で中の `/run` に出す（host の側の確かめは machine と同じ）
      socketPathInside(hostPath) {
        const own = coreSocketDir(self.opts.dataDir);
        if (!hostPath.startsWith(`${self.opts.dataDir}/`) && !hostPath.startsWith(`${own}/`)) {
          return Promise.reject(new Error(`鍵の窓口 ${hostPath} は banto の置き場の外です——別のサーバへ転送しません`));
        }
        return self.forwardAgentIntoContainer(conn, container, hostPath);
      },
      async prepareShellHome(moduleDataDir, files) {
        await mounts.get(moduleDataDir);
        const home = `${base.pathInside(moduleDataDir)}/home`;
        const resync = (f: readonly string[]) => self.sendShellHome(conn, moduleDataDir, home, f, container);
        return { home, sync: await resync(files), resync };
      },
      processCommand(p: RuntimeProcess) {
        if (p.asRoot) throw new Error(`${p.name} を別のサーバのコンテナで root として起こすことはできません`);
        const command = p.command === process.execPath ? nodePath : p.command;
        const unit = moduleUnitName(p.name);
        const prelude: LauncherRequest = { command, args: p.args, cwd: p.cwd, env: p.env };
        // 中のユーザーとして起動役を起こす。単位は中のユーザーの systemd（env・合言葉は最初の1行で渡す）
        const args = [...self.muxArgs(conn), "--", conn.runtime.host, insideCommand(container, inside, [nodePath, launcherPath, unit])];
        return {
          command: "ssh",
          args,
          transport: () =>
            new LauncherTransport(
              { command: "ssh", args, env: sshEnv() as Record<string, string> },
              prelude,
              () => self.stopUnit(conn, unit, container),
              `${p.name}@${conn.runtimeName}/${container}`,
            ),
        };
      },
    };
  }

  /** 落とした Module の単位を止める（接続が切れていれば、次に起こすときに起動役が止める） */
  private async stopUnit(conn: Connection, unit: string, container?: string): Promise<void> {
    if (!conn.alive) return;
    const r = await this.run(
      conn,
      container
        ? `${insideStopUnitCommand(container, (await this.containerIdsOf(conn)).inside, unit)}\n`
        : `u=$(id -u); XDG_RUNTIME_DIR=/run/user/$u DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$u/bus systemctl --user stop ${shq(`${unit}.service`)}\n`,
      { timeoutMs: 30_000 },
    );
    if (r.code !== 0 && !/not loaded|not found/i.test(r.stderr) && conn.alive) {
      this.log(`[host] 別のサーバ「${conn.runtimeName}」の ${unit} を止められませんでした: ${r.stderr.trim().slice(-300)}`);
    }
  }

  /** registry から取ってきた配布物を送る（中身が違えば置き換える） */
  /**
   * **コンテナに付いているフォルダが、VM の今のフォルダと違うか**（inode で比べる。bind mount は付けたときのフォルダを見続ける）。
   * 中にまだ付いていない（中で引けない）なら false——付けるのは `ensureDisk` がする
   */
  private async mountIsStale(conn: Connection, container: string, dir: string): Promise<boolean> {
    const out = await this.mustRun(
      conn,
      "配布物のフォルダを確かめられ",
      [
        `printf 'vm=%s\\n' "$(stat -c %i -- ${shq(dir)})"`,
        `printf 'in=%s\\n' "$(incus exec ${shq(container)} -- stat -c %i -- ${shq(dir)} 2>/dev/null)"`,
        "",
      ].join("\n"),
    );
    const vm = /^vm=(\d+)$/m.exec(out)?.[1];
    const inside = /^in=(\d+)$/m.exec(out)?.[1];
    if (!vm) throw new Error(`別のサーバ「${conn.runtimeName}」の配布物のフォルダ ${dir} を読めませんでした`);
    return inside !== undefined && inside !== vm;
  }

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
  private async sendShellHome(conn: Connection, moduleDataDir: string, home: string, files: readonly string[], container?: string) {
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
    const nodePath = `${conn.codeDir}/${REMOTE_NODE_REL}`;
    await this.mustRun(
      conn,
      "Shell のホームを送れ",
      // containers：ホームは見せたフォルダの中——消すのも展開するのも中のユーザーで（条件3）
      container
        ? insideShellHomeCommand(container, (await this.containerIdsOf(conn)).inside, home, nodePath, removeOld)
        : `mkdir -p ${shq(home)} && chmod 700 ${shq(home)} && ${shq(nodePath)} -e ${shq(removeOld)} ${shq(home)} && tar -C ${shq(home)} -xf -`,
      { stdin: tar.stdout },
    );
    return sync;
  }
}

/**
 * 親の接続が用意できるまで待つ：逆向きのトンネルのポート（ssh が標準エラーに出す「Allocated port N」。トンネルを張る
 * ときだけ）と、多重化の窓口ができたこと。先に終わったら、ssh の言葉を添えて投げる
 */
function waitMasterReady(
  master: ChildProcess,
  controlPath: string,
  opts: { tunnel: boolean },
): Promise<{ remotePort: number | undefined; exited: Promise<void>; stderrTail: () => string }> {
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
      } else resolve({ remotePort: port, exited, stderrTail: () => stderr.slice(-2000) });
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
      if ((port !== undefined || !opts.tunnel) && existsSync(controlPath)) finish();
    }, 50);
    const timer = setTimeout(
      () => finish(new SshCommandError("SSH の接続を張れませんでした", { code: 255, stdout: "", stderr: `${stderr}\n（30 秒で用意ができませんでした）` })),
      30_000,
    );
  });
}

/** 接続を閉じて、閉じ終わるのを待つ */
async function closeConnection(conn: Connection): Promise<void> {
  if (!conn.alive) return;
  conn.master.kill("SIGTERM");
  await conn.exited;
}

/** ログに添える、どの Project の接続か */
function forWhom(projectId: string | undefined): string {
  return projectId !== undefined ? `（Project ${projectId}）` : "（先に送るため）";
}
