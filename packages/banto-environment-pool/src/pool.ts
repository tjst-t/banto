/**
 * Environment Pool 本体（ADR-0010 決定32・34・task-0034）。
 *
 * **Kobo を経由しない経路がここで初めて成立する。** 既存実装は `(projectTag, taskId,
 * profileName)` を鍵にし、`repoPath` を Kobo の `ProjectRegistry` から引いていた——
 * つまり決定32c（番頭は `env.*` を直接呼べる）が絵に描いた餅だった。ここでは
 * **`envId` が主キー**で、`repoPath` は呼び出し側が渡す（決定34b・c）。
 *
 * **`verify` の teardown は finally で回す。** 途中で失敗して抜けても畳む——高位1本を
 * 作る一番の理由がこれ（I3：外部リソースの消し忘れは金銭的実害で、本仕様で最も
 * 優先度の高い機構）。畳めなかったときは `tornDown: false` と理由を返し、成功に見せない。
 *
 * D3: 生きている環境の真実は台帳。quota は台帳から導出する（別カウンタを持たない）。
 * I2: ドライバの失敗・上限超過・畳み損ねは、黙って成功にしない。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EnvExposer, EnvHandle, EnvProfile } from "@banto/core";
import { EnvLedger, countLiveByProfile, type EnvLedgerEntry } from "./env-ledger.js";
import { EnvEventLog, type EnvEvent, type EnvEventInput, type EnvEventType } from "./event-log.js";
import {
  runDriverVerb,
  resolveDriverPath,
  DEFAULT_DRIVER_TIMEOUT_MS,
  DEFAULT_PROVISION_TIMEOUT_MS,
} from "./env-driver-runner.js";
import { decryptSops, resolveCredentialsPath } from "./sops.js";
import {
  assertCacheCeiling,
  checkAdhocDriver,
  clampTtl,
  resolveLimits,
  resolveRunTimeout,
  type EnvLimits,
} from "./limits.js";
import {
  CacheLedger,
  computeCacheKey,
  planSweep,
  type DriverCacheEntry,
} from "./cache-store.js";
import { loadProfile, listProfiles } from "./profiles.js";

/** ログの返し方。全文は番頭の文脈を埋め、パスだけでは番頭が結果を判断できない。 */
const DEFAULT_LOG_TAIL_LINES = 40;

export interface EnvironmentPoolOptions {
  /** 台帳の置き場。 */
  dataDir: string;
  /** 既定とハード上限の上書き（決定34f）。 */
  limits?: Partial<EnvLimits>;
  /** ドライバ1動詞あたりの制限時間。 */
  driverTimeoutMs?: number;
  /**
   * `provision` だけの制限時間（既定 `DEFAULT_PROVISION_TIMEOUT_MS`）。
   * プロファイルが `build:` を持つとイメージのビルドを含むため、他の動詞より長く待つ。
   */
  provisionTimeoutMs?: number;
  /** sops の鍵ファイル（credentials の復号に使う。決定32d）。 */
  sopsAgeKeyFile?: string;
  /**
   * TTL 執行と照合の間隔（既定 60 秒）。`startMaintenance()` を呼んだときだけ回る。
   */
  maintenanceIntervalMs?: number;
  /**
   * 期限切れを畳むときの試行回数（既定 3・spec §5「teardown失敗はリトライし」）。
   * 一度の失敗で諦めると、一時的な失敗が「畳み損ね」として確定してしまう。
   */
  teardownRetryLimit?: number;
  /**
   * 同じプロセスで知らせを受ける口（サービスのログへ出すために `bin.ts` が使う）。
   *
   * **会話への経路はこれではない**（task-0067）。独立サービスになってからは、番頭は
   * `env.events` を引きに行く——別プロセスのコールバックは張れず、張れたとしても
   * 番頭が落ちている間の知らせが消える（決定29c が職人で不採用にしたのと同じ理由）。
   * ここに残っているのは、単体で立てたときにサービスのログへ出すための口。
   */
  onAttention?: (message: string) => void;
  /**
   * 環境を外から見えるようにする口（決定39）。渡さないと `expose` を頼まれても断る。
   * 配置によって手段が変わるので、ここで差し替える。
   */
  exposer?: EnvExposer;
  /**
   * 公開方式ごとの口（G9 (b)）。
   *
   * `exposeMode` による選択を Environment Pool が行う。`proxy` は必ず、
   * `caddy` は設定が揃っているとき（settings の network に caddyAdmin +
   * envDomain）だけ渡す——auto は「caddy があれば caddy、無ければ proxy」。
   * 従来の単一の `exposer` と同時には渡さない。
   */
  exposers?: { proxy: EnvExposer; caddy?: EnvExposer };
  /**
   * `collect` の回収先の親（既定 `<dataDir>/collected`）。
   *
   * **置き場所は Pool が決める**（spec §3.1・imp-0007 の裁定）。呼び出し側にパスを
   * 書かせると、番頭が任意の絶対パスを指定でき、場所の砦（決定36g）を通らない穴になる
   * ——`worker.delegate` の `worktreePath` と同じ形の穴を、もう1つ作ることになる。
   */
  collectRoot?: string;
  /**
   * 環境より長生きする置き場の根（spec §5.2）。既定 `<dataDir>/env-cache`。
   *
   * `collectRoot` と同じ理由で**プールが決める**——呼び出し側に書かせない。
   */
  cacheRoot?: string;
}

/** 環境を1つ用意するときの指定。プロファイル経由かアドホックかのどちらか。 */
export interface ProvisionRequest {
  /** プロファイルの在り処（決定34c）。`profile` を使うときは必須。 */
  repoPath?: string;
  /** プロファイル名。 */
  profile?: string;
  /** アドホック指定のドライバ（決定34e）。`profile` と同時には使えない。 */
  driver?: string;
  /** アドホック指定の設定ブロック。 */
  config?: Record<string, unknown>;
  /** どこで動かすか（決定34d・絶対パス）。 */
  workdir?: string;
  /** 何の検証かを台帳とログに残すラベル（決定34b）。 */
  taskId?: string;
  projectTag?: string;
  /** アドホックの TTL。上限に丸められる。プロファイル経由では無視される。 */
  ttlMs?: number;
  /**
   * このポートを外から見えるようにする（決定39）。
   *
   * **呼び出し側が明示する。** ドライバの handle / config は不透明なので、
   * Environment Pool が覗いてポートを当てることはしない。
   */
  expose?: number;
  /**
   * **プロファイルがポートを持つなら公開する**（決定59）。
   *
   * レビューのために立てる環境は「PO が触れること」が目的で、どのポートかは
   * プロファイルの都合——**呼び出し側（Kobo）に番号を知らせない**ための口。
   * Kobo が `config.port` を読む形にすると、決定60a（他モジュールの内部を読まない）が崩れる。
   *
   * ポートを持たないプロファイル（監査用のテスト環境など、触る面が無いもの）では、
   * **公開せずに立てる**——環境ごと失敗にはしない。公開しなかったことはログに出る。
   */
  exposeProfilePort?: boolean;
  /**
   * 公開方式（G9 (b)）。既定 `auto`。
   *
   * - `auto`: caddy の口が設定されていれば caddy、無ければ proxy
   * - `proxy` / `caddy`: 明示指定（auto より優先）。設定されていない方式を
   *   指定すると理由つきで断る
   */
  exposeMode?: ExposeMode;
}

export interface EnvSummary {
  envId: string;
  /** プロファイル名。アドホックは `adhoc:<driver>`（spec §3.1 の `profile` 列）。 */
  profile: string;
  driver: string;
  taskId: string;
  projectTag: string;
  workdir?: string;
  createdAt: string;
  ttlDeadline: string;
  /** spec §5 の状態。`live` = 生きている、`torn-down` = 畳んだ、`teardown-failed` = 畳み損ね。 */
  state: "live" | "torn-down" | "teardown-failed";
  /** 外から見られるURL（`expose` を頼んだときだけ）。 */
  url?: string;
  /** 公開しているポート。 */
  exposedPort?: number;
  /** 公開方式（`banto-proxy` / `caddy`。G9 (b)）。 */
  exposer?: string;
}

/** `env.provision` の返り（spec §3.1）。立てた直後に使える状態かも併せて返す。 */
export interface ProvisionResult extends EnvSummary {
  /**
   * 立てた直後の疎通確認。
   *
   * **provision の一部として回す**（spec §3.1）——立ったが使えない環境を返して、
   * 次の `run` の失敗で初めて気づく、という順序にしない。
   */
  healthcheck: { ok: boolean; detail?: string };
}

export interface RunResult {
  envId: string;
  exit: number;
  logPath: string;
  /** ログの末尾。上限行数で切り、切ったことを明示する（`worker.attach` と同じ扱い）。 */
  logTail: string;
  truncated: boolean;
}

export interface VerifyResult {
  envId: string;
  profile: string;
  /**
   * 検証コマンドの終了コード。
   *
   * I2: **走らせるところまで到達しなかった場合も 0 にしない**。環境が立たなかった・
   * healthcheck が通らなかったときは 0 以外になり、`failure` に理由が入る——
   * 「確かめていない」を「通った」と読ませない。
   */
  exit: number;
  logPath: string;
  /** ログの末尾。上限行数で切り、切ったことを明示する。 */
  logTail: string;
  truncated: boolean;
  /** 畳めたか。**畳めなかったら成功に見せない**（I3）。 */
  tornDown: boolean;
  teardownError?: string;
  /** healthcheck が通ったか。 */
  healthy: boolean;
  healthDetail?: string;
  /** 成果物の置き場（`collect: true` のときだけ）。読み取り専用の場所として登録されている。 */
  collected?: string;
  /** コマンドを走らせるまでに落ちた理由（落ちていなければ無い）。 */
  failure?: string;
}

/** アドホック環境の台帳上のプロファイル名。プロファイル経由と区別できるようにする。 */
export const ADHOC_PROFILE_PREFIX = "adhoc:";

/** 公開方式（G9 (b)）。既定 `auto` は「caddy の口があれば caddy、無ければ proxy」。 */
export type ExposeMode = "auto" | "proxy" | "caddy";

/** `provision` の出力のうち、置き場に関する部分（spec §5.2.2・任意）。 */
interface CacheProvisionOutput {
  cache?: { primed?: boolean };
}

/**
 * sh に渡す1語として囲む。**置き場の場所はプロファイルが書いた文字列**なので、
 * そのまま連結するとコマンドが割れる。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class EnvironmentPool {
  private readonly ledger: EnvLedger;
  private limits: EnvLimits;
  private readonly timeoutMs: number;
  /** 立てるときだけの制限時間（イメージのビルドを含みうる。task-0075）。 */
  private readonly provisionTimeoutMs: number;
  private sopsAgeKeyFile: string | undefined;
  /** 公開方式ごとの口（G9 (b)）。従来の単一 `exposer` は proxy としてここへ畳む。 */
  private readonly exposers: { proxy?: EnvExposer; caddy?: EnvExposer };
  private readonly collectRoot: string;
  /** 台帳が壊れていた場合の説明。黙って空の台帳で動き出さないため（I2）。 */
  readonly ledgerCorruption: string | null;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private maintenanceRunning = false;
  private readonly maintenanceIntervalMs: number;
  private readonly teardownRetryLimit: number;
  private readonly onAttention: ((message: string) => void) | undefined;
  /** 同じことを何度も知らせないための記録（毎分の tick で繰り返さない）。 */
  private readonly notified = new Set<string>();
  /** 照合で見つかった孤児（台帳に無い実リソース）。画面と番頭に見せる。 */
  /**
   * 照合で見つかった孤児。**畳めるように handle も持つ**——名前だけでは畳めず、
   * 呼ぶ側に handle を組み立てさせると「不透明な handle」（spec §2）が崩れる。
   */
  private orphanList: Array<{ driver: string; name: string; created: string; handle?: EnvHandle }> = [];
  /** 衛生に関わる出来事の追記専用ログ（task-0067）。番頭はここを引きに来る。 */
  private readonly eventLog: EnvEventLog;
  /** イベントログが壊れていた場合の説明（I2）。 */
  readonly eventLogCorruption: string | null;
  /**
   * 置き場（`cache`・spec §5.2）の帳簿。**最後に使った時刻だけ**を持つ——
   * 在るかどうかはドライバが真で、時刻はドライバから導出できない。
   */
  private readonly cacheLedger: CacheLedger;
  /** 置き場の根。**プールが決める**（ドライバでも呼び出し側でもない）。 */
  private readonly cacheRoot: string;
  /**
   * ドライバへ渡す環境変数。**所有の記録を置き場ごとに分ける**（PO報告 2026-08-10）。
   *
   * docker ドライバは「自分が作ったプロジェクト」を記録しておき、`list` でそれだけを
   * 返す（名前で推測しないための守り・inc-0043）。ところがその記録の既定が
   * `os.tmpdir()/banto-docker-driver-state.json` という**機械に1つの場所**だった。
   *
   * 結果、同じ機械で試験を回すと**試験が立てたコンテナが本番のプール自身のものとして
   * 記録され**、本番の台帳には無いので「台帳に無い実リソース＝孤児」として毎回帳場へ
   * 知らせが飛んでいた。所有はプールごとに違うので、記録も置き場ごとに分ける。
   *
   * **process ドライバも同じ**（PO報告 2026-08-11）。docker だけ分けて process を
   * 置き去りにしていたので、`again-env` / `k0-env` のように試験や一度きりの環境が
   * 本番の孤児として上がり続けた——**片方だけ直すと直したつもりになる**。
   */
  private readonly driverEnv: Record<string, string>;

  constructor(options: EnvironmentPoolOptions) {
    const opened = EnvLedger.open(options.dataDir);
    this.ledger = opened.ledger;
    this.ledgerCorruption = opened.corruptionError;
    const openedEvents = EnvEventLog.open(options.dataDir);
    this.eventLog = openedEvents.log;
    this.eventLogCorruption = openedEvents.corruptionError;
    this.limits = resolveLimits(options.limits);
    this.timeoutMs = options.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;
    this.provisionTimeoutMs =
      options.provisionTimeoutMs ?? Math.max(this.timeoutMs, DEFAULT_PROVISION_TIMEOUT_MS);
    this.sopsAgeKeyFile = options.sopsAgeKeyFile;
    // I2: どちらも渡すのは曖昧——黙って片方を優先しない
    if (options.exposer && options.exposers) {
      throw new Error("exposer と exposers は同時に指定できません（どちらか一方）。");
    }
    this.exposers = options.exposers ?? (options.exposer ? { proxy: options.exposer } : {});
    this.collectRoot = options.collectRoot ?? path.join(options.dataDir, "collected");
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000;
    this.teardownRetryLimit = Math.max(1, options.teardownRetryLimit ?? 3);
    this.onAttention = options.onAttention;
    // **上限の検査は組み立てのときに1度だけ。** 設定から上限を外せてしまうと、
    // PO の条件（上限の仕組みを先に入れる）が設定1行で無効になる（spec §5.2.3）
    assertCacheCeiling(this.limits);
    this.cacheLedger = new CacheLedger(options.dataDir);
    // 場所を決めるのはプール（§6 の `dest` と同じ規則）。ドライバにも呼び出し側にも選ばせない
    this.cacheRoot = options.cacheRoot ?? path.join(options.dataDir, "env-cache");
    this.driverEnv = {
      BANTO_DOCKER_DRIVER_STATE: path.join(options.dataDir, "docker-driver-owned.json"),
      BANTO_PROCESS_DRIVER_STATE: path.join(options.dataDir, "process-driver-owned.json"),
    };
  }

  // ── TTL 執行と照合（spec-environment §5・決定32e）────────────────────────
  //
  // **ここに無いと誰も片付けない。** spec §5 は「制限の執行は Environment Pool の台帳が
  // 行う」と定めている——番頭が Kobo 無しで provision できる以上、Kobo 側の tick だけでは
  // 番頭が立てた環境が対象外になる（台帳が別なので実際にそうなっていた。番頭の指摘で発覚）。
  //
  // 外部リソースの消し忘れは金銭的実害で、本仕様で最も優先度の高い機構（I3）。

  /**
   * TTL 執行と照合を回し始める。**呼ばないと期限は効かない**——だから
   * `env.provision` の返り文も、回っているときだけ「自動で畳まれます」と言う。
   */
  startMaintenance(): void {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, this.maintenanceIntervalMs);
    // ホストの終了を妨げない
    this.maintenanceTimer.unref?.();
  }

  /** 止める。テストとホストの片付けで使う。 */
  stopMaintenance(): void {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
  }

  /** TTL 執行と照合が回っているか。番頭に見せる（回っていないなら期限は効かない）。 */
  isMaintaining(): boolean {
    return this.maintenanceTimer !== undefined;
  }

  /** 照合で見つかった孤児。台帳に無いのに実在するリソース。 */
  orphans(): Array<{ driver: string; name: string; created: string }> {
    // handle は外へ出さない（不透明・呼ぶ側は名前で指す）
    return this.orphanList.map(({ driver, name, created }) => ({ driver, name, created }));
  }

  /**
   * 期限切れを畳み、実リソースと台帳を突き合わせる。
   *
   * I2: 1件の失敗で残りを止めない。畳み損ねは台帳に印が残る（`teardown-failed`）。
   */
  async runMaintenance(): Promise<{ tornDown: string[]; failed: string[]; orphans: number }> {
    // 前の回が終わっていないなら重ねない（畳んでいる最中にもう一度畳もうとしない）
    if (this.maintenanceRunning) return { tornDown: [], failed: [], orphans: this.orphanList.length };
    this.maintenanceRunning = true;
    const tornDown: string[] = [];
    const failed: string[] = [];
    try {
      const now = Date.now();
      for (const entry of this.ledger.listLive()) {
        if (new Date(entry.ttlDeadline).getTime() > now) continue;

        // spec §5: 一度の失敗で諦めない。畳めないのが一時的なことはある
        let lastError: string | undefined;
        let done = false;
        for (let attempt = 1; attempt <= this.teardownRetryLimit && !done; attempt += 1) {
          try {
            await this.teardown(entry.envId);
            done = true;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < this.teardownRetryLimit) {
              await new Promise((r) => setTimeout(r, 200 * attempt));
            }
          }
        }

        if (done) {
          tornDown.push(entry.envId);
          // task-0067: **畳んだのは呼び出し側ではない**＝畳み忘れ。console.warn だけだと
          // サービスのログに沈むので、番頭が引ける出来事として残す
          this.attention(
            `expired:${entry.envId}`,
            "env_expired",
            `検証環境 ${entry.envId}（${entry.profileName}）を期限切れで畳みました。` +
              "使い終わったら env.teardown で畳んでください——期限まで残ると、その分は動き続けます。",
            { envId: entry.envId, profile: entry.profileName, data: { driver: entry.driver } }
          );
        } else {
          // I2: 畳み損ねを黙らせない。台帳には teardown-failed が残り、番頭へも知らせる
          failed.push(entry.envId);
          console.error(
            `[env] 期限切れの ${entry.envId} を ${this.teardownRetryLimit} 回試しても畳めませんでした: ${String(lastError)}`
          );
          this.attention(
            `teardown-failed:${entry.envId}`,
            "env_teardown_failed",
            `検証環境 ${entry.envId}（${entry.profileName}）を${this.teardownRetryLimit}回試しても畳めませんでした。` +
              `外にリソースが残っている可能性があります。理由: ${String(lastError)}`,
            {
              envId: entry.envId,
              profile: entry.profileName,
              data: {
                driver: entry.driver,
                attempts: this.teardownRetryLimit,
                error: String(lastError),
              },
            }
          );
        }
      }
      this.sweep();
      const orphans = await this.reconcile();
      /**
       * **1件ずつ数える**（PO報告 2026-08-11）。
       *
       * 合図を「その回に見つかった集合」で作っていたので、**同じ孤児が何度も上がった**
       * ——他の孤児が1つ増減するだけで鍵が変わり、既に知らせたものが混ざったまま
       * また流れる（実測：同じ 1 件が 26 回）。帳場はそれで埋まっていた。
       *
       * 数えるのは名前。**まだ知らせていないものが1件でもあるときだけ**知らせ、
       * 消えた孤児は忘れる（また現れたら改めて知らせる・`watchStaleBranches` と同じ形）。
       */
      const seen = new Set(orphans.map((o) => `orphan:${o.driver}/${o.name}`));
      for (const key of [...this.notified]) {
        if (key.startsWith("orphan:") && !seen.has(key)) this.notified.delete(key);
      }
      const fresh = orphans.filter((o) => !this.notified.has(`orphan:${o.driver}/${o.name}`));
      if (fresh.length > 0) {
        for (const o of fresh) this.notified.add(`orphan:${o.driver}/${o.name}`);
        this.eventLog.append({
          type: "env_orphans_found",
          data: {
            // **知らせるのは新しく見つかった分だけ。** 全部並べると、既に知らせたものが
            // 毎回混ざって「また増えた」と読める
            orphans: fresh,
            message:
              `台帳に無い検証環境のリソースが ${fresh.length} 件あります（${fresh
                .map((o) => o.name)
                .join(", ")}）。Banto が把握していないものなので、消してよいか確かめてください`,
          },
        });
        this.onAttention?.(
          `台帳に無い検証環境のリソースが ${fresh.length} 件あります（${fresh
            .map((o) => o.name)
            .join(", ")}）`
        );
      }
    } finally {
      this.maintenanceRunning = false;
    }
    return { tornDown, failed, orphans: this.orphanList.length };
  }

  /**
   * 成果物を捨てる（番頭の判断で・PO提案 2026-08-01）。
   *
   * **台帳は対象にしない。** 台帳は「番頭が何を立てたか」の記録で、番頭に消させるのは
   * 自分の監査記録を編集させるのと同じ（I1）。期間で機械的に刈るのは構わないが、
   * 判断で消す対象にはしない。成果物は中身であって記録ではないので、番頭が捨ててよい。
   *
   * **パスは受け取らない。** 環境の id か「何日より古いもの」だけ。任意のパスを受けると
   * `env.collect` の `dest` で塞いだ穴をまた開けることになる。
   *
   * I2: どちらも指定されなければ何もせず断る——「全部消して」を既定にしない。
   *     全部消したいなら `olderThanDays: 0` と明示する。
   */
  cleanupArtifacts(request: { envId?: string; olderThanDays?: number }): {
    removed: Array<{ envId: string; bytes: number }>;
    bytesFreed: number;
  } {
    const byId = request.envId;
    const days = request.olderThanDays;
    if (byId === undefined && days === undefined) {
      throw new Error(
        "どれを捨てるか指定してください（envId か olderThanDays）。全部捨てるなら olderThanDays: 0 です。"
      );
    }

    const removed: Array<{ envId: string; bytes: number }> = [];
    if (!fs.existsSync(this.collectRoot)) {
      // 名指しなら「無い」と言う。まとめて捨てる指定なら、何も無いのは異常ではない
      if (byId !== undefined) {
        throw new Error(`環境 "${byId}" の成果物はありません（既に捨てられたか、回収していない）。`);
      }
      return { removed, bytesFreed: 0 };
    }

    const cutoff = days === undefined ? undefined : Date.now() - days * 24 * 3600 * 1000;
    for (const name of fs.readdirSync(this.collectRoot)) {
      if (byId !== undefined && name !== byId) continue;
      const target = path.join(this.collectRoot, name);
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        continue;
      }
      if (cutoff !== undefined && stat.mtimeMs > cutoff) continue;

      const bytes = directorySize(target);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        removed.push({ envId: name, bytes });
      } catch (err) {
        // I2: 消せなかったことを「消した」に混ぜない
        console.error(`[env] ${name} の成果物を捨てられませんでした: ${String(err)}`);
      }
    }
    // I2: 名指しで頼まれたのに無いなら、そう言う（消えたつもりにさせない）
    if (byId !== undefined && removed.length === 0) {
      throw new Error(`環境 "${byId}" の成果物はありません（既に捨てられたか、回収していない）。`);
    }
    return { removed, bytesFreed: removed.reduce((sum, r) => sum + r.bytes, 0) };
  }

  /** 回収した成果物の使用量。捨てる前に「どれくらい溜まっているか」を見せるため。 */
  artifactUsage(): { count: number; bytes: number } {
    if (!fs.existsSync(this.collectRoot)) return { count: 0, bytes: 0 };
    const names = fs.readdirSync(this.collectRoot);
    return {
      count: names.length,
      bytes: names.reduce((sum, n) => sum + directorySize(path.join(this.collectRoot, n)), 0),
    };
  }

  /**
   * 溜まったものを捨てる（保存期間を過ぎたもの）。
   *
   * **何も捨てないと際限がない。** 回収した成果物は環境を畳んでも残り、台帳は畳んだ分も
   * 残る。番頭は検証のたびにこれを増やすので、放っておくとディスクが埋まる。
   *
   * I2: 消せなかったことは黙らせない。ただし1件の失敗で残りを止めない。
   */
  private sweep(): void {
    const now = Date.now();

    // 1. 回収した成果物
    try {
      if (fs.existsSync(this.collectRoot)) {
        for (const name of fs.readdirSync(this.collectRoot)) {
          const target = path.join(this.collectRoot, name);
          const stat = fs.statSync(target);
          if (now - stat.mtimeMs <= this.limits.collectedRetentionMs) continue;
          fs.rmSync(target, { recursive: true, force: true });
          console.warn(`[env] 保存期間を過ぎた成果物を捨てました: ${name}`);
        }
      }
    } catch (err) {
      console.error(`[env] 成果物を片付けられませんでした: ${String(err)}`);
    }

    // 2. 台帳の古い記録（**生きているものは期間に関係なく残す**）
    for (const entry of this.ledger.list()) {
      if (!entry.tornDownAt) continue;
      if (now - new Date(entry.tornDownAt).getTime() <= this.limits.ledgerRetentionMs) continue;
      this.ledger.remove(entry.envId);
    }
  }

  /**
   * 衛生の出来事を残す（task-0067）。**同じことは1度だけ**——毎分の tick で
   * 同じ出来事を積み続けない（畳み損ねは畳めるまで毎回検出されるため）。
   *
   * ログへの追記が主で、`onAttention` は同じプロセスで受けたいとき（サービスのログ）の従。
   * **ログは `onAttention` が無くても積む**——番頭は `env.events` を引きに来るので、
   * ここで止めると独立サービスのときに何も残らない。
   */
  private attention(key: string, type: EnvEventType, message: string, event: Omit<EnvEventInput, "type">): void {
    if (this.notified.has(key)) return;
    this.notified.add(key);
    this.eventLog.append({ type, ...event, data: { ...event.data, message } });
    this.onAttention?.(message);
  }

  /**
   * 衛生の出来事を古い順に返す（`afterEventId` より後だけ）。
   *
   * 番頭ホストはこれを引いて会話へ知らせる（`banto-host/src/env-notice.ts`）。
   * **意味を与えるのは引いた側**（D5）——ここは中立な事実を並べるだけ。
   */
  events(afterEventId = 0, limit?: number): EnvEvent[] {
    return this.eventLog.since(afterEventId, limit);
  }

  /** 最後に振ったイベント id。引く側が「ここから先」を決めるのに使う。 */
  get lastEventId(): number {
    return this.eventLog.lastEventId;
  }

  /**
   * 各ドライバの `list` と台帳を突き合わせ、台帳に無い実リソースを見つける（spec §5）。
   *
   * クラッシュ中に生じた孤児がここで出る。**消しはしない**——台帳に無いものを機械が
   * 勝手に消すと、Banto 以外が作ったものまで巻き込む。見えるようにするところまで。
   */
  async reconcile(): Promise<Array<{ driver: string; name: string; created: string }>> {
    /**
     * **突き合わせは名前で**（PO報告 2026-08-11）。
     *
     * もとは `JSON.stringify(handle)` を丸ごと比べていた。だが**ドライバの `list` は
     * provision に渡した handle を復元できない**——docker ドライバの実測：
     *
     * |          | 台帳（provision）      | `list` が返すもの                |
     * |----------|------------------------|----------------------------------|
     * | taskId   | `task-0005`            | `banto-env-task-0005`（接頭辞込み）|
     * | created  | `06:05:14.091Z`        | `06:05:13.000Z`（docker は秒精度）|
     * | workdir  | `.../hiragana-app`     | `.../hiragana-app/docker`         |
     *
     * `list` は docker に聞き直して組み立てるので、これは直しようがない。つまり
     * **立っている環境が1つ残らず「台帳に無い実リソース＝孤児」として上がっていた**
     * ——帳場が孤児の知らせで埋まっていた本当の原因はこれ。
     *
     * 名前は provision が決め、`list` もそれを返す（spec §2）ので、両側で一致する。
     * 名前を持たないドライバのために、丸ごとの比較は残す。
     */
    const identity = (handle: unknown, fallbackName?: string): string => {
      const record = handle as Record<string, unknown> | undefined;
      const name = typeof record?.["name"] === "string" ? record["name"] : fallbackName;
      return name !== undefined && name.length > 0 ? `name:${name}` : JSON.stringify(handle);
    };
    const known = new Set(this.ledger.listLive().map((e) => identity(e.handle)));
    const drivers = new Set(this.ledger.list().map((e) => e.driver));
    const found: Array<{ driver: string; name: string; created: string; handle?: EnvHandle }> = [];

    for (const driver of drivers) {
      let result;
      try {
        result = await runDriverVerb(
          resolveDriverPath(driver),
          "list",
          {},
          this.timeoutMs,
          this.driverEnv
        );
      } catch (err) {
        console.error(`[env] ${driver} の照合に失敗しました: ${String(err)}`);
        continue;
      }
      if (!result.ok || !Array.isArray(result.output)) continue;
      for (const item of result.output as Array<Record<string, unknown>>) {
        const name = typeof item["name"] === "string" ? item["name"] : undefined;
        if (known.has(identity(item["handle"], name))) continue;
        // ドライバが生死を添えているなら、死んだものは実リソースではない。
        // 添えていないドライバでは判断材料が無いので数える（黙って見逃すより良い）
        if (item["alive"] === false) continue;
        found.push({
          driver,
          name: typeof item["name"] === "string" ? item["name"] : "(名前なし)",
          created: typeof item["created"] === "string" ? item["created"] : "",
          ...(item["handle"] !== undefined ? { handle: item["handle"] as EnvHandle } : {}),
        });
      }
    }
    if (found.length > 0) {
      console.warn(`[env] 台帳に無い実リソースが ${found.length} 件あります（照合）`);
    }
    this.orphanList = found;
    return found.map(({ driver, name, created }) => ({ driver, name, created }));
  }

  /**
   * 孤児（台帳に無い実リソース）を**1件だけ、名指しで**畳む（PO裁定 2026-08-08）。
   *
   * **一括で畳む口は作らない。** 孤児の判定は「ドライバが自分のものと言ったもの」に
   * 依っており、そこが間違うと**他人の作業を壊す**——実際、docker ドライバは名前の綴りで
   * 所有を推測していて、無関係な `myapp-docker` を孤児として挙げていた（実測）。
   * 判定を記録ベースに直した上でも、**誤って報告する代償（雑音）と誤って畳む代償
   * （取り返しがつかない）は釣り合わない**。だから畳むのは常に人か番頭の明示の一手にする。
   *
   * I2: 見つからない・複数当たるときは畳まずに断る。「たぶんこれだろう」で消さない。
   */
  async teardownOrphan(name: string): Promise<{ driver: string; name: string }> {
    // 掴んでいる一覧は古いかもしれない。**畳む前に取り直す**
    await this.reconcile();
    const hits = this.orphanList.filter((o) => o.name === name);
    if (hits.length === 0) {
      const known = this.orphanList.map((o) => o.name).join(", ");
      throw new Error(
        `孤児 "${name}" は見つかりません（照合し直した結果）。` +
          `いまの孤児: ${known || "(なし)"}——既に消えているか、名前が違います`
      );
    }
    if (hits.length > 1) {
      throw new Error(`孤児 "${name}" が ${hits.length} 件あります。名前で一意に指せません`);
    }
    const target = hits[0]!;
    if (target.handle === undefined) {
      throw new Error(
        `孤児 "${name}" は handle を持っていないため畳めません（${target.driver} が list で返していない）`
      );
    }
    const result = await runDriverVerb(
      resolveDriverPath(target.driver),
      "teardown",
      { handle: target.handle },
      this.timeoutMs,
      this.driverEnv
    );
    if (!result.ok) throw new Error(`孤児 "${name}" を畳めませんでした: ${result.error}`);

    this.orphanList = this.orphanList.filter((o) => o !== target);
    this.eventLog.append({
      type: "env_orphan_torn_down",
      data: { driver: target.driver, name, created: target.created },
    });
    return { driver: target.driver, name };
  }

  /** いまの sops 鍵ファイル（設定画面に見せる。**鍵の中身は読まない**）。 */
  currentSopsKeyFile(): string | undefined {
    return this.sopsAgeKeyFile;
  }

  /** sops 鍵ファイルを差し替える（決定41）。次の provision から効く。 */
  setSopsKeyFile(file: string | undefined): void {
    this.sopsAgeKeyFile = file && file.trim().length > 0 ? file.trim() : undefined;
  }

  /** 公開の口を持っているか。GUI と番頭に「頼めるかどうか」を伝えるため。 */
  canExpose(): boolean {
    return this.exposers.proxy !== undefined || this.exposers.caddy !== undefined;
  }

  /** いまの上限。GUI と番頭に見せるため（何が効いているか分からないと直せない）。 */
  currentLimits(): EnvLimits {
    return { ...this.limits };
  }

  /**
   * 上限を差し替える（決定41：設定画面から）。
   *
   * **その場で効く。** 上限は呼ぶたびに読んでいるので、次の provision から新しい値になる
   * ——設定したのに次の起動まで効かない、を避けられる箇所はそうする。
   */
  applyLimits(overrides: Partial<EnvLimits>): EnvLimits {
    this.limits = resolveLimits({ ...this.limits, ...overrides });
    return { ...this.limits };
  }

  /** そのリポジトリで使えるプロファイル（上限を超えるものは理由つきで分ける）。 */
  profiles(repoPath: string): ReturnType<typeof listProfiles> {
    return listProfiles(repoPath, this.limits);
  }

  // ── 低位動詞（決定34a）──────────────────────────────────────────────────

  /**
   * 環境を1つ用意する。
   *
   * I2: 上限超過・アドホックの不許可・ドライバ失敗は、いずれも理由つきで投げる。
   *     黙って別の設定に落とすと「頼んだものと違うもので検証された」が起きる。
   */
  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const resolved = this.resolveRequest(request);
    const taskId = request.taskId ?? `env-${shortId()}`;
    const projectTag = request.projectTag ?? "banto";

    // D3: quota は台帳から導出する（別カウンタを持たない）
    this.assertQuota(resolved.profileName, resolved.quotaMax);

    const extraEnv = await this.credentialsFor(resolved.profile, request.repoPath);

    // 環境より長生きする置き場（spec §5.2）。**鍵が作れないときは使わない**——
    // 欠けた鍵は「別のものを同じ鍵で指す」ことになるので、黙って落として毎回 setup する
    const cache = this.resolveCache(resolved.profile, resolved.driver, request);

    const driverPath = resolveDriverPath(resolved.driver);
    const result = await runDriverVerb(
      driverPath,
      "provision",
      {
        config: resolved.config,
        taskId,
        ...(request.workdir ? { workdir: path.resolve(request.workdir) } : {}),
        // task-0074: プロファイルを読んだ場所。ドライバは `config` の中の相対パスを
        // これを基点に解ける（`config` の中身は Pool が解釈しない・spec §2 のまま）
        ...(request.repoPath ? { repoPath: path.resolve(request.repoPath) } : {}),
        // spec §5.2.2: 任意。ドライバが無視すれば `cache` は返らず、今までどおり毎回 setup
        ...(cache ? { cacheKey: cache.key, cachePath: cache.path, cacheRoot: this.cacheRoot } : {}),
      },
      // 立てるのはイメージのビルドを含みうる（task-0075）。他の動詞より長く待つ
      this.provisionTimeoutMs,
      // 所有の記録は置き場ごと。**ここが要**——作ったものを記録するのが provision なので、
      // ここで置き場を教えないと機械に1つの既定へ書かれ、他のプールの list に混ざる
      { ...this.driverEnv, ...extraEnv }
    );
    if (!result.ok) {
      throw new Error(`環境を用意できませんでした（${resolved.driver}）: ${result.error}`);
    }

    const handle = (result.output as { handle?: EnvHandle }).handle;
    // I2: handle が無いのに成功扱いにすると、以降の動詞が指す先を失う
    if (!handle || typeof handle !== "object") {
      throw new Error(`ドライバ ${resolved.driver} が handle を返しませんでした。`);
    }

    const createdAt = new Date();
    const entry: EnvLedgerEntry = {
      envId: `env-${shortId()}`,
      projectTag,
      taskId,
      profileName: resolved.profileName,
      driver: resolved.driver,
      handle,
      createdAt: createdAt.toISOString(),
      ttlDeadline: new Date(createdAt.getTime() + resolved.ttlMs).toISOString(),
      ...(cache ? { cacheKey: cache.key, cachePath: cache.path } : {}),
      ...(request.workdir ? { workdir: path.resolve(request.workdir) } : {}),
    };
    this.ledger.add(entry);

    // 決定59: プロファイルのポートを公開する頼まれ方。**番号は呼び出し側に知らせない**
    // ——「レビューのために人が触れるようにする」という意図だけを受け取る
    let exposePort = request.expose;
    if (exposePort === undefined && request.exposeProfilePort === true) {
      const configured = (resolved.config as { port?: unknown })?.port;
      const port = typeof configured === "number" ? configured : Number(configured);
      if (Number.isFinite(port) && port > 0) {
        exposePort = port;
      } else {
        // **ポートを持たないプロファイルもある**（監査用のテスト環境など、触る面が無いもの）。
        // 環境ごと失敗にはしない——立てること自体は正しいので。ただし「公開したつもり」に
        // ならないよう、公開しなかったことは言う（返り値に url が無いことでも分かる）
        console.warn(
          `[environment-pool] プロファイル "${resolved.profileName}" は config.port を持たないので、` +
            "外から触れるようにはしません（立てること自体は続けます）"
        );
      }
    }

    // I2: 方式だけ指定して公開自体を頼んでいないのを黙って通さない（公開されずに終わる）
    if (exposePort === undefined && request.exposeMode !== undefined) {
      throw new Error("exposeMode は expose（公開するポート）と一緒に指定してください。");
    }

    // 決定39: 頼まれたら外から見えるようにする。**立ってから公開する**——
    // 立たなかった環境のURLを配ると、開いて初めて壊れていると分かる
    if (exposePort !== undefined) {
      try {
        const exposed = await this.resolveExposer(request.exposeMode).expose({
          envId: entry.envId,
          port: exposePort,
          label: entry.taskId,
        });
        this.ledger.setExposure(entry.envId, exposed.url, exposed.port, exposed.exposer);
        entry.url = exposed.url;
        entry.exposedPort = exposed.port;
        entry.exposer = exposed.exposer;
      } catch (err) {
        // I2: 公開できなかったのに環境だけ残すと、畳み忘れの元になる。畳んでから投げる
        await this.teardown(entry.envId).catch(() => undefined);
        throw new Error(`外から見えるようにできませんでした: ${String(err)}`);
      }
    }

    // spec §3.1: 立った直後の疎通も返す。立ったが使えない環境を黙って返して、
    // 次の run の失敗で初めて気づく、という順序にしない
    let healthcheck: { ok: boolean; detail?: string };
    try {
      healthcheck = await this.healthcheck(entry.envId);
    } catch (err) {
      // I2: 疎通が確かめられなかったことを ok:true に丸めない
      healthcheck = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }

    // **プロファイルの `setup` を、立てるうちに済ませる**（task-0080）。
    //
    // 「立った」と「使える」は別。docker のプロファイルは node_modules を名前付き
    // ボリュームに隔離するのが普通で、`compose up -d` が返っても中は空。ここで
    // 用意しないと、受け入れ条件の `verify` が自分で `npm ci` する羽目になる（inc-0034）。
    //
    // **provision の一部にするのが要点**。呼び出し側から見て「provision が成功した」＝
    // 「検証コマンドを走らせられる」になる。段を分けて呼ばせると、呼び忘れた経路
    // （番頭のアドホック・`env.verify`・ゲート）ごとに同じ穴が開く。
    //
    // **置き場に既に中身があるなら飛ばす**（spec §5.2）。飛ばしてよいのは、置き場の中身が
    // 鍵（＝中身を決めるファイルの内容）から一意に決まるものだけ——だから鍵に何を入れるかを
    // プロファイルに書かせている。
    const primed = cache !== undefined && (result.output as CacheProvisionOutput).cache?.primed === true;
    if (cache) {
      this.cacheLedger.touch({ key: cache.key, driver: resolved.driver, profile: resolved.profileName });
    }

    if (resolved.profile?.setup && !primed) {
      const setupCmd = resolved.profile.setup;
      try {
        const outcome = await this.run(
          entry.envId,
          setupCmd,
          DEFAULT_LOG_TAIL_LINES,
          this.limits.defaultSetupTimeoutMs
        );
        if (outcome.exit !== 0) {
          // I2: **用意でこけたことを「検証が落ちた」に見せない。** ここで throw すると
          // 呼び出し側には provision の失敗として届き、ゲートは `verify_env_unavailable`
          // と言う——「確かめていない」と「落ちた」を別の言葉にする（task-0075）
          throw new Error(
            `setup が失敗しました（exit ${outcome.exit}）: ${setupCmd}\n` +
              `ログ: ${outcome.logPath}\n${outcome.logTail}`
          );
        }
        // **成功したときだけ印を書く**（spec §5.2.2）。途中で死んだ半端な置き場を
        // 「入っている」と誤判定させないため——次に来たドライバは印を見て primed を決める
        if (cache) {
          await this.run(
            entry.envId,
            `mkdir -p ${shellQuote(cache.path)} && touch ${shellQuote(`${cache.path}/.banto-primed`)}`,
            DEFAULT_LOG_TAIL_LINES,
            this.timeoutMs
          ).catch(() => undefined);
        }
      } catch (err) {
        // I3: 用意できなかった環境を残さない。畳んでから投げる（expose の失敗と同じ扱い）
        await this.teardown(entry.envId).catch(() => undefined);
        throw new Error(
          `環境は立ちましたが使える状態にできませんでした（profile: ${resolved.profileName}）: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // **掃除は provision のたび**（spec §5.2.3）。別の周期を作らない——置き場が増えるのは
    // ここだけなので、増えた直後に見るのがいちばん漏れない。失敗しても provision は返す
    // （立った環境を掃除の都合で壊さない）が、黙らせはしない（I2）
    if (cache) {
      await this.sweepCache(resolved.driver, driverPath, cache.key, extraEnv).catch(() => undefined);
    }

    return { ...toSummary(entry), healthcheck };
  }

  /**
   * 置き場の鍵を決める（spec §5.2.1）。
   *
   * **使わない条件を先に置く。** 上限が 0（機構を止めてある）／プロファイルが `cache` を
   * 書いていない／鍵の材料が読めない——どれも「置き場を使わず、今までどおり毎回 setup」
   * に落ちる。**黙って中途半端な鍵を作らない**のが要点（I2）。
   */
  private resolveCache(
    profile: EnvProfile | undefined,
    driver: string,
    request: ProvisionRequest
  ): { key: string; path: string } | undefined {
    if (this.limits.cacheMaxEntries <= 0) return undefined;
    const declared = profile?.cache;
    if (!declared) return undefined;

    // 鍵の材料は**そのタスクの作業場所**から読む（workdir が無ければプロファイルの在り処）
    const base = request.workdir ?? request.repoPath;
    if (!base) return undefined;
    const files = declared.key.map((rel) => path.resolve(base, rel));
    const key = computeCacheKey({ driver, profile: profile.name, files });
    if (!key.ok) {
      this.eventLog.append({
        type: "env_cache_unavailable",
        profile: profile.name,
        data: { reason: key.reason },
      });
      return undefined;
    }
    return { key: key.key, path: declared.path };
  }

  /**
   * 上限を超えた置き場を落とす（spec §5.2.3）。
   *
   * **在るかどうかはドライバが真**（`cache-list`）。台帳は最後に使った時刻を添えるだけで、
   * 台帳に無いものは「時刻が分からない」＝最初に落ちる（§5 の照合と同じ向き）。
   */
  private async sweepCache(
    driver: string,
    driverPath: string,
    keepKey: string,
    extraEnv: Record<string, string> | undefined
  ): Promise<void> {
    const listed = await runDriverVerb(
      driverPath,
      "cache-list",
      { cacheRoot: this.cacheRoot },
      this.timeoutMs,
      { ...this.driverEnv, ...(extraEnv ?? {}) }
    );
    // ドライバが `cache-list` を持たないなら掃除もできない。**それ自体は失敗ではない**
    // （置き場を作らないドライバなので増えない）が、作るのに消せないなら片手落ちなので出す
    if (!listed.ok) return;
    const present = ((listed.output as { entries?: DriverCacheEntry[] }).entries ?? []).filter(
      (e): e is DriverCacheEntry => typeof e?.key === "string"
    );

    const plan = planSweep({
      present,
      ledger: this.cacheLedger,
      maxEntries: this.limits.cacheMaxEntries,
      maxAgeMs: this.limits.cacheMaxAgeMs,
      keep: keepKey,
    });
    if (plan.remove.length === 0) return;

    const removed: string[] = [];
    for (const key of plan.remove) {
      const out = await runDriverVerb(
        driverPath,
        "cache-remove",
        { key, cacheRoot: this.cacheRoot },
        this.timeoutMs,
        { ...this.driverEnv, ...(extraEnv ?? {}) }
      );
      if (out.ok) removed.push(key);
      else {
        // I2: 消せなかったことを黙らせない。次の provision でまた試みる
        this.eventLog.append({
          type: "env_cache_sweep_failed",
          data: { key, driver, reason: out.error },
        });
      }
    }
    this.cacheLedger.forget(removed);
    if (removed.length > 0) {
      this.eventLog.append({
        type: "env_cache_swept",
        data: {
          driver,
          removed,
          kept: plan.kept,
          maxEntries: this.limits.cacheMaxEntries,
          note: "落としたぶんは次に使うとき作り直される（正しさは変わらない）",
        },
      });
    }
  }

  /** 成果物を配る。ドライバによっては何もしない。 */
  async deploy(envId: string, artifactPath: string): Promise<void> {
    const entry = this.requireLive(envId);
    await this.verb(entry, "deploy", { handle: entry.handle, artifact_path: artifactPath });
  }

  /** 使える状態か確かめる。 */
  async healthcheck(envId: string): Promise<{ ok: boolean; detail?: string }> {
    const entry = this.requireLive(envId);
    const output = await this.verb(entry, "healthcheck", { handle: entry.handle });
    const shaped = output as { ok?: unknown; detail?: unknown };
    return {
      ok: shaped.ok === true,
      ...(typeof shaped.detail === "string" ? { detail: shaped.detail } : {}),
    };
  }

  /**
   * 環境の中でコマンドを走らせる。
   *
   * **制限時間は他の動詞と別**。provision や healthcheck は「すぐ返るはず」のものだが、
   * `run` は検証コマンドそのもので、テスト一式が何分もかかるのが普通（spec §8 の裁定）。
   */
  async run(
    envId: string,
    cmd: string,
    logTailLines = DEFAULT_LOG_TAIL_LINES,
    timeoutMs?: number
  ): Promise<RunResult> {
    const entry = this.requireLive(envId);
    const output = await this.verb(
      entry,
      "run",
      {
        handle: entry.handle,
        cmd,
        // 決定34d: provision と同じ場所で走らせる（台帳に残してある）
        ...(entry.workdir ? { workdir: entry.workdir } : {}),
      },
      resolveRunTimeout(timeoutMs, this.limits)
    );
    const shaped = output as { exit?: unknown; log_path?: unknown };
    const logPath = typeof shaped.log_path === "string" ? shaped.log_path : "";
    const tail = readLogTail(logPath, logTailLines);
    return {
      envId,
      // I2: exit が返らないのを 0（成功）と読み替えない
      exit: typeof shaped.exit === "number" ? shaped.exit : 1,
      logPath,
      logTail: tail.text,
      truncated: tail.truncated,
    };
  }

  /**
   * 成果物を回収する。**置き場所は Pool が決めて教える**（spec §3.1）。
   *
   * 回収先は読み取り専用の場所として登録されるので（`createCollectedPlaceProvider`）、
   * 番頭は返ってきたパスをそのまま `file.*` で読める。書き込みは開かない。
   */
  async collect(envId: string): Promise<{ dest: string }> {
    const entry = this.requireLive(envId);
    const dest = path.join(this.collectRoot, envId);
    fs.mkdirSync(dest, { recursive: true });
    await this.verb(entry, "collect", { handle: entry.handle, dest });
    return { dest };
  }

  /** 回収先の親。場所として登録するために外へ出す。 */
  collectedRoot(): string {
    return this.collectRoot;
  }

  /**
   * 環境を畳む。**冪等**——既に畳んであるものへの呼び出しは何もせず成功する。
   *
   * I3: 畳めなかったら台帳に印を残す。消し忘れは金銭的実害なので、
   *     「失敗したことが分からない」状態を作らない。
   */
  async teardown(envId: string): Promise<{ alreadyDone: boolean }> {
    const entry = this.ledger.get(envId);
    if (!entry) throw new Error(`環境 "${envId}" は台帳にありません。`);
    if (entry.tornDownAt) return { alreadyDone: true };

    const driverPath = resolveDriverPath(entry.driver);
    const result = await runDriverVerb(
      driverPath,
      "teardown",
      { handle: entry.handle },
      this.timeoutMs,
      this.driverEnv
    );
    // 畳むなら公開も取り下げる。**先に取り下げる**——環境が消えたのにURLだけ生き残ると、
    // 開いた人は「壊れている」としか分からない（決定39）
    for (const exposer of [this.exposers.proxy, this.exposers.caddy]) {
      if (!exposer) continue;
      try {
        await exposer.unexpose(envId);
      } catch (err) {
        // I2: 取り下げに失敗したことは黙らせない。ただし環境を畳む方は続ける
        console.error(`[env] ${envId} の公開を取り下げられませんでした: ${String(err)}`);
      }
    }

    if (!result.ok) {
      this.ledger.markTeardownFailed(envId);
      throw new Error(`環境 "${envId}" を畳めませんでした: ${result.error}`);
    }
    this.ledger.markTornDown(envId);
    return { alreadyDone: false };
  }

  /** 台帳の一覧。既定は生きているものだけ（spec §3.1 の `env.list`）。 */
  list(options: { includeTornDown?: boolean; projectTag?: string; taskId?: string } = {}): EnvSummary[] {
    const entries = options.includeTornDown ? this.ledger.list() : this.ledger.listLive();
    return entries
      .filter((e) => (options.projectTag ? e.projectTag === options.projectTag : true))
      .filter((e) => (options.taskId ? e.taskId === options.taskId : true))
      .map(toSummary);
  }

  // ── 高位（決定34a）──────────────────────────────────────────────────────

  /**
   * 使い捨ての検証を一息で回す。
   *
   * provision →（deploy）→ healthcheck →（run）→（collect）→ teardown。
   * **teardown は finally**——途中で落ちても畳む。番頭が畳み忘れても漏れない。
   */
  async verify(
    request: ProvisionRequest & {
      /** 走らせる検証コマンド。 */
      cmd: string;
      /** 配る成果物。省略すると deploy を飛ばす。 */
      artifactPath?: string;
      /** 成果物を取り出すか。置き場所は Pool が決める（返り値の `collected`）。 */
      collect?: boolean;
      logTailLines?: number;
      /** 検証コマンドの制限時間。既定は能力側の既定、上限まで（厳しくのみ可）。 */
      timeoutMs?: number;
    }
  ): Promise<VerifyResult> {
    const summary = await this.provision(request);
    let healthy = summary.healthcheck.ok;
    const healthDetail = summary.healthcheck.detail;
    let runResult: RunResult | undefined;
    let failure: string | undefined;
    let collected: string | undefined;

    try {
      if (request.artifactPath) await this.deploy(summary.envId, request.artifactPath);

      // provision で一度見ているが、deploy を挟んだなら見直す（配ってから壊れることがある）
      if (request.artifactPath) {
        const health = await this.healthcheck(summary.envId);
        healthy = health.ok;
      }
      // I2: 使えない環境で走らせた結果を「テストが落ちた」と読ませない。分けて止める
      if (!healthy) {
        failure = `healthcheck が通りませんでした${healthDetail ? `: ${healthDetail}` : ""}`;
      } else {
        runResult = await this.run(summary.envId, request.cmd, request.logTailLines, request.timeoutMs);
        // 畳む前に取り出す（環境ごと消えるので、ここを逃すと取れない）
        if (request.collect) collected = (await this.collect(summary.envId)).dest;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }

    // **ここが高位1本を作る一番の理由**（I3）。上でどう抜けても必ず畳む
    let tornDown = false;
    let teardownError: string | undefined;
    try {
      await this.teardown(summary.envId);
      tornDown = true;
    } catch (err) {
      teardownError = err instanceof Error ? err.message : String(err);
    }

    return {
      envId: summary.envId,
      profile: summary.profile,
      // I2: 走らせるところまで行かなかったのを 0（通った）にしない
      exit: runResult ? runResult.exit : 1,
      logPath: runResult?.logPath ?? "",
      logTail: runResult?.logTail ?? "",
      truncated: runResult?.truncated ?? false,
      tornDown,
      ...(teardownError !== undefined ? { teardownError } : {}),
      healthy,
      ...(healthDetail !== undefined ? { healthDetail } : {}),
      ...(collected !== undefined ? { collected } : {}),
      ...(failure !== undefined ? { failure } : {}),
    };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** プロファイル経由かアドホックかを解いて、ドライバ・設定・TTL を決める。 */
  private resolveRequest(request: ProvisionRequest): {
    driver: string;
    config: Record<string, unknown>;
    ttlMs: number;
    profileName: string;
    quotaMax: number | undefined;
    profile: EnvProfile | undefined;
  } {
    const viaProfile = request.profile !== undefined;
    const viaAdhoc = request.driver !== undefined;
    // I2: どちらか分からない指定を勝手に解釈しない
    if (viaProfile && viaAdhoc) {
      throw new Error("profile と driver は同時に指定できません（どちらか一方）。");
    }
    if (!viaProfile && !viaAdhoc) {
      throw new Error("profile（プロファイル経由）か driver（アドホック）のどちらかが要ります。");
    }

    if (viaProfile) {
      if (!request.repoPath) {
        // 決定34c: 在り処は呼び出し側が渡す。ここでは推測しない
        throw new Error("profile を使うときは repoPath（プロファイルの在り処）も要ります。");
      }
      const found = loadProfile(request.repoPath, request.profile!, this.limits);
      if (!found.ok) throw new Error(found.reason);
      const profile = found.profile;
      return {
        driver: profile.driver,
        config: profile.config ?? {},
        ttlMs: profile.ttlMs,
        profileName: profile.name,
        quotaMax: profile.quota?.max_instances,
        profile,
      };
    }

    const driver = request.driver!;
    const allowed = checkAdhocDriver(driver, this.limits);
    if (!allowed.ok) throw new Error(allowed.reason);
    return {
      driver,
      config: request.config ?? {},
      // 決定34e: アドホックにも必ず既定 TTL を付ける。掃除の扱いを経路で変えない
      ttlMs: clampTtl(request.ttlMs, this.limits),
      profileName: `${ADHOC_PROFILE_PREFIX}${driver}`,
      quotaMax: undefined,
      profile: undefined,
    };
  }

  /** 上限の確認。D3: 台帳から数える。 */
  private assertQuota(profileName: string, profileMax: number | undefined): void {
    const live = this.ledger.listLive();
    const total = live.length;
    if (total >= this.limits.maxInstancesTotal) {
      throw new Error(
        `同時に動かせる環境は ${this.limits.maxInstancesTotal} 個までです（いま ${total} 個）。` +
          "使い終わったものを env.teardown で畳んでください"
      );
    }
    const perProfile = Math.min(
      profileMax ?? this.limits.maxInstancesPerProfile,
      this.limits.maxInstancesPerProfile
    );
    const current = countLiveByProfile(live, profileName);
    if (current >= perProfile) {
      throw new Error(
        `"${profileName}" を同時に動かせるのは ${perProfile} 個までです（いま ${current} 個）。`
      );
    }
  }

  /**
   * credentials を復号してドライバの環境変数に渡す（決定32d）。
   *
   * **番頭の文脈に平文を出さない。** 復号した値はここからドライバの spawn env にだけ入り、
   * 戻り値にもログにも載らない。
   */
  private async credentialsFor(
    profile: EnvProfile | undefined,
    repoPath: string | undefined
  ): Promise<Record<string, string> | undefined> {
    if (!profile?.credentials || !repoPath) return undefined;
    const resolvedPath = resolveCredentialsPath(repoPath, profile.credentials);
    if (!resolvedPath.ok) throw new Error(resolvedPath.error);
    const decrypted = await decryptSops(resolvedPath.filePath, this.sopsAgeKeyFile);
    // I2: 復号できないまま環境を立てると、原因の分からない失敗になる
    if (!decrypted.ok) throw new Error(decrypted.error);
    return decrypted.secrets;
  }

  /** I2: 公開の口が無いのに「公開しました」と言わない。 */
  private resolveExposer(mode: ExposeMode | undefined): EnvExposer {
    if (!this.exposers.proxy && !this.exposers.caddy) {
      throw new Error(
        "この Banto は環境を外から見えるようにする口を持っていません（公開の実装が設定されていない）。"
      );
    }
    switch (mode ?? "auto") {
      case "proxy":
        if (!this.exposers.proxy) {
          throw new Error("proxy での公開が設定されていません。");
        }
        return this.exposers.proxy;
      case "caddy":
        if (!this.exposers.caddy) {
          throw new Error(
            "caddy での公開が設定されていません（settings の network に caddyAdmin と envDomain が必要です）。"
          );
        }
        return this.exposers.caddy;
      case "auto":
        // G9 (b): caddy の口が設定されていれば caddy、無ければ proxy
        return this.exposers.caddy ?? this.exposers.proxy!;
    }
  }

  private requireLive(envId: string): EnvLedgerEntry {
    const entry = this.ledger.get(envId);
    if (!entry) throw new Error(`環境 "${envId}" は台帳にありません。`);
    if (entry.tornDownAt) throw new Error(`環境 "${envId}" は既に畳まれています。`);
    return entry;
  }

  private async verb(
    entry: EnvLedgerEntry,
    verb: string,
    input: Record<string, unknown>,
    timeoutMs = this.timeoutMs
  ): Promise<unknown> {
    // 置き場は provision と同じものを見せる（spec §5.2）。docker は compose を読み直すので、
    // 渡さないと `run` だけ既定の場所を掴み、用意したものが見えない
    const withCache =
      entry.cacheKey !== undefined
        ? { ...input, cacheKey: entry.cacheKey, cacheRoot: this.cacheRoot, ...(entry.cachePath !== undefined ? { cachePath: entry.cachePath } : {}) }
        : input;
    const result = await runDriverVerb(
      resolveDriverPath(entry.driver),
      verb,
      withCache,
      timeoutMs,
      this.driverEnv
    );
    // I2: ドライバの失敗を成功に見せない
    if (!result.ok) throw new Error(`${verb} が失敗しました（${entry.envId}）: ${result.error}`);
    return result.output;
  }
}

// ── 小道具 ──────────────────────────────────────────────────────────────────

function toSummary(entry: EnvLedgerEntry): EnvSummary {
  return {
    envId: entry.envId,
    profile: entry.profileName,
    driver: entry.driver,
    taskId: entry.taskId,
    projectTag: entry.projectTag,
    ...(entry.workdir ? { workdir: entry.workdir } : {}),
    createdAt: entry.createdAt,
    ttlDeadline: entry.ttlDeadline,
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.exposedPort !== undefined ? { exposedPort: entry.exposedPort } : {}),
    ...(entry.exposer ? { exposer: entry.exposer } : {}),
    // 畳み損ねを「畳んだ」と同じに見せない（spec §5）
    state: entry.teardownFailed ? "teardown-failed" : entry.tornDownAt ? "torn-down" : "live",
  };
}

/** ディレクトリの大きさ。捨てた効果を見せるために測る。 */
function directorySize(target: string): number {
  let total = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try {
          total += fs.statSync(child).size;
        } catch { /* 消えた */ }
      }
    }
  };
  try {
    if (fs.statSync(target).isDirectory()) walk(target);
    else total = fs.statSync(target).size;
  } catch { /* 無い */ }
  return total;
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

/**
 * ログの末尾を返す。
 *
 * 全文を返すと番頭の文脈を埋め、パスだけでは番頭が結果を判断できない——`worker.attach` と
 * 同じ扱いで、**末尾を上限行数で切り、切ったことを明示する**。
 */
function readLogTail(logPath: string, maxLines: number): { text: string; truncated: boolean } {
  if (!logPath) return { text: "", truncated: false };
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    // I2 の例外ではない: ログが読めなくても exit は返せる。読めなかったことは分かる形にする
    return { text: `（ログを読めませんでした: ${logPath}）`, truncated: false };
  }
  const lines = raw.split("\n");
  if (lines.length <= maxLines) return { text: raw, truncated: false };
  return { text: lines.slice(-maxLines).join("\n"), truncated: true };
}
