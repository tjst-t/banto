// **Project の実行場所**（決定・2026-10-08、`docs/specs/v4-security.md` §1「実行場所は core の中の差し替え口」）。
//
// Module を起こす側なので Module ではなく core の中の口にする。host はここに書いた約束だけを通して
// 「箱」（Project のコンテナ・banto 全体用のコンテナ）を扱い、Incus を直接呼ばない。今の実装は
// この host のコンテナ（`host-container.ts`）だけ。別のサーバはあとで同じ口に足す
//
// **パスは2つの側を分けて持つ**：host の側（host が書く・読む）と、実行場所の側（Module に渡す）。
// コンテナは host と同じパスでマウントするので同じ値になるが、別のサーバでは違う

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ShellHomeSync } from "../modules/shell-home.js";

/** どの箱に置くか（Project ごとに1つ、外から足した banto 全体の Module 用に1つ、同梱の道具用に1つ） */
export interface RuntimePlace {
  /** Project の id、または banto 全体用の箱の id（`Runtime.instancePlaceId`）・道具用の箱の id（`Runtime.toolsPlaceId`） */
  id: string;
  /** Project の根（host の側のパス。banto 全体用・道具用の箱には無い） */
  root?: string;
  /** 中で Docker を使うか（Project ごとの設定） */
  nesting: boolean;
  /**
   * **同梱の道具用の箱**（追加・2026-10-15、`docs/specs/v4-security.md` §1）。中で sudo できなくし、起こす Module が名乗った
   * apt のパッケージを入れてから返す。`id` は `Runtime.toolsPlaceId`
   */
  tools?: { aptPackages: readonly string[] };
}

/**
 * **道具用の箱に名乗ったパッケージを入れられなかった**（追加・2026-10-15）。覚えておき、人が設定の「入れ直す」を押すまで
 * やり直さない（`v4-modules.md` §2.2「失敗したら毎回 apt をやり直さない」）
 */
export class ToolsInstallError extends Error {}

/** 道具用の箱にパッケージを入れているところ・入れられなかったもの（設定の画面に出す） */
export interface ToolsInstallStatus {
  /** いま入れている（同時に1本） */
  installing?: readonly string[];
  /** 入れられなかったもの（名乗ったパッケージの組ごと）。「入れ直す」を押すまでやり直さない */
  failures: ReadonlyArray<{ packages: readonly string[]; reason: string; at: string }>;
}

/** 箱の中で起こすプロセス（パスは実行場所の側） */
export interface RuntimeProcess {
  /** 接続名（`shell-<projectId>` 等）。別のサーバでは、包む systemd の単位の名前になる */
  name: string;
  command: string;
  args: string[];
  cwd: string;
  /** 渡す環境変数はこれだけ（host の環境は引き継がない） */
  env: Record<string, string>;
}

/** 用意できた箱 */
export interface PreparedPlace {
  /** 人とログに出す名前（コンテナの名前） */
  readonly name: string;
  /** node の実行ファイルの、実行場所の側のパス */
  readonly nodePath: string;
  /** 中から banto に届く origin（`http://<アドレス>:<ポート>`。host 中継・Claude のログインの中継の住所の元） */
  readonly bantoOrigin: string;
  /** host の側のパスを、実行場所の側のパスにする（Module に渡す差し込み語はこれで組み立てる） */
  pathInside(hostPath: string): string;
  /**
   * Module の置き場（読み書き）と、取ってきた配布物（読み取り専用。あれば）を用意し、中に見せる。
   * 渡すのは host の側のパス
   */
  prepareModuleDirs(dirs: { dataDir: string; packageDir: string }): Promise<void>;
  /**
   * 鍵の窓口（ssh-agent）を立てる host の側のフォルダ。host の Vault がここに立てたソケットに、中の Module が
   * 届く。`moduleDataDir` は host の側のパス
   */
  socketDirFor(moduleDataDir: string): string;
  /**
   * Vault が `socketDirFor` に立てた窓口（host の側のパス）を、中の Module から届くパスにする。同じパスで見える箱
   * （コンテナ）には無い。別のサーバ：向こうの置き場の `s` へソケットの転送を張り、向こうのパスを返す（窓口が消えたら外す）
   */
  socketPathInside?(hostPath: string): Promise<string>;
  /**
   * Shell 専用のホームを用意し、人が選んだ設定を写す。`resync` は一覧が変わったときに写し直す口。
   * `home` は実行場所の側のパス
   */
  prepareShellHome(
    moduleDataDir: string,
    files: readonly string[],
  ): Promise<{ home: string; sync: ShellHomeSync; resync(files: readonly string[]): Promise<ShellHomeSync> }>;
  /**
   * 中でプロセスを起こすために、host で走らせるコマンド（標準入出力を MCP に繋ぐ）。`transport` があれば、繋ぐときは
   * それを使う（別のサーバ：env を標準入力の最初の1行で渡し、閉じたら向こうの単位を止める）
   */
  processCommand(p: RuntimeProcess): { command: string; args: string[]; transport?: () => Transport };
  /**
   * この箱で起こす Module に足して渡す環境（別のサーバ：`BANTO_NO_SUDO=1`——banto は向こうで sudo しないので、Module も
   * sudo で道具を入れようとせず、入れ方を添えて断る）
   */
  readonly moduleEnv?: Readonly<Record<string, string>>;
}

/**
 * 外から中のサービスに届くアドレス（Publish）。確かに届かないなら理由。
 * `exposedOnLan`：そのアドレスは LAN に直に出ている（別のサーバ）——`0.0.0.0` で待ち受けたものは Publish の認証を通らずに
 * LAN から届く。コンテナ（ブリッジの奥）には付かない
 */
export type PlaceAddress = { address: string; exposedOnLan?: true } | { unavailable: string };

/** 止めるのに失敗した（箱が動いたまま残った） */
export class RuntimeStopError extends Error {
  constructor(
    readonly placeName: string,
    readonly reason: string,
  ) {
    super(`${placeName} を止められませんでした：${reason}`);
  }
}

export interface Runtime {
  /** banto 全体用の箱の id */
  readonly instancePlaceId: string;
  /** 同梱の道具用の箱の id（いつもこの host のコンテナ。別のサーバの Project からも中継で届く） */
  readonly toolsPlaceId: string;
  /** 道具用の箱にパッケージを入れている・入れられなかったもの */
  toolsInstallStatus(): ToolsInstallStatus;
  /** 入れられなかったことを忘れる（人が「入れ直す」を押した）。次に起こすときに入れ直す */
  retryToolsInstall(): void;
  /** 前提がそろっているか（起動のログに出す1行） */
  describePrerequisites(): string;
  /** 用意する（無ければ作る・起こす・前提を確かめる）。同時に来ても1回にまとめる */
  prepare(place: RuntimePlace): Promise<PreparedPlace>;
  /** 次に使うとき、箱の状態を確かめ直す（中の Module が止まったとき） */
  forget(placeId: string): void;
  /** 箱を手放す。`stop` なら止める——止められなければ `RuntimeStopError` */
  release(placeId: string, opts: { stop: boolean }): Promise<void>;
  /** 外から Project の箱の中のサービスに届くアドレス（Publish）。分からない（答えが無い）ときは投げる */
  address(projectId: string): Promise<PlaceAddress>;
  /** 中継に来た要求の送り元が、その Project の箱か */
  sourceMatches(projectId: string, remote: string): Promise<boolean>;
  /** Project の箱の状態（設定の画面に出す）。無ければ undefined */
  status(projectId: string): Promise<{ name: string; status: string } | undefined>;
  /** 資源の上限を、動いている箱にも起こし直さずに効かせる */
  applyLimits(placeId: string): Promise<void>;
  /** 上限に当たったかを見張る相手（いま用意できている箱） */
  resourceTargets(): { containerName: string; projectId?: string }[];
  /** その箱の名前（人とログに出す。資源の見張りの鍵にもなる） */
  placeName(placeId: string): string;
  /** host から箱の cgroup を引くための区画の名前（`resources.ts` の `ResourceWatch` が使う） */
  resourceScope(): Promise<string>;
}
