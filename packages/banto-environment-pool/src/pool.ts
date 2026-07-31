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
import { runDriverVerb, resolveDriverPath, DEFAULT_DRIVER_TIMEOUT_MS } from "./env-driver-runner.js";
import { decryptSops, resolveCredentialsPath } from "./sops.js";
import {
  checkAdhocDriver,
  clampTtl,
  resolveLimits,
  type EnvLimits,
} from "./limits.js";
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
  /** sops の鍵ファイル（credentials の復号に使う。決定32d）。 */
  sopsAgeKeyFile?: string;
  /**
   * TTL 執行と照合の間隔（既定 60 秒）。`startMaintenance()` を呼んだときだけ回る。
   */
  maintenanceIntervalMs?: number;
  /**
   * 環境を外から見えるようにする口（決定39）。渡さないと `expose` を頼まれても断る。
   * 配置によって手段が変わるので、ここで差し替える。
   */
  exposer?: EnvExposer;
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
  /** コマンドを走らせるまでに落ちた理由（落ちていなければ無い）。 */
  failure?: string;
}

/** アドホック環境の台帳上のプロファイル名。プロファイル経由と区別できるようにする。 */
export const ADHOC_PROFILE_PREFIX = "adhoc:";

export class EnvironmentPool {
  private readonly ledger: EnvLedger;
  private readonly limits: EnvLimits;
  private readonly timeoutMs: number;
  private readonly sopsAgeKeyFile: string | undefined;
  private readonly exposer: EnvExposer | undefined;
  /** 台帳が壊れていた場合の説明。黙って空の台帳で動き出さないため（I2）。 */
  readonly ledgerCorruption: string | null;
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private maintenanceRunning = false;
  private readonly maintenanceIntervalMs: number;
  /** 照合で見つかった孤児（台帳に無い実リソース）。画面と番頭に見せる。 */
  private orphanList: Array<{ driver: string; name: string; created: string }> = [];

  constructor(options: EnvironmentPoolOptions) {
    const opened = EnvLedger.open(options.dataDir);
    this.ledger = opened.ledger;
    this.ledgerCorruption = opened.corruptionError;
    this.limits = resolveLimits(options.limits);
    this.timeoutMs = options.driverTimeoutMs ?? DEFAULT_DRIVER_TIMEOUT_MS;
    this.sopsAgeKeyFile = options.sopsAgeKeyFile;
    this.exposer = options.exposer;
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000;
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
    return [...this.orphanList];
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
        try {
          await this.teardown(entry.envId);
          tornDown.push(entry.envId);
          console.warn(`[env] 期限切れのため畳みました: ${entry.envId}（${entry.profileName}）`);
        } catch (err) {
          // I2: 畳み損ねを黙らせない。台帳には teardown-failed が残る
          failed.push(entry.envId);
          console.error(`[env] 期限切れの ${entry.envId} を畳めませんでした: ${String(err)}`);
        }
      }
      await this.reconcile();
    } finally {
      this.maintenanceRunning = false;
    }
    return { tornDown, failed, orphans: this.orphanList.length };
  }

  /**
   * 各ドライバの `list` と台帳を突き合わせ、台帳に無い実リソースを見つける（spec §5）。
   *
   * クラッシュ中に生じた孤児がここで出る。**消しはしない**——台帳に無いものを機械が
   * 勝手に消すと、Banto 以外が作ったものまで巻き込む。見えるようにするところまで。
   */
  async reconcile(): Promise<Array<{ driver: string; name: string; created: string }>> {
    const known = new Set(this.ledger.listLive().map((e) => JSON.stringify(e.handle)));
    const drivers = new Set(this.ledger.list().map((e) => e.driver));
    const found: Array<{ driver: string; name: string; created: string }> = [];

    for (const driver of drivers) {
      let result;
      try {
        result = await runDriverVerb(resolveDriverPath(driver), "list", {}, this.timeoutMs);
      } catch (err) {
        console.error(`[env] ${driver} の照合に失敗しました: ${String(err)}`);
        continue;
      }
      if (!result.ok || !Array.isArray(result.output)) continue;
      for (const item of result.output as Array<Record<string, unknown>>) {
        if (known.has(JSON.stringify(item["handle"]))) continue;
        found.push({
          driver,
          name: typeof item["name"] === "string" ? item["name"] : "(名前なし)",
          created: typeof item["created"] === "string" ? item["created"] : "",
        });
      }
    }
    if (found.length > 0) {
      console.warn(`[env] 台帳に無い実リソースが ${found.length} 件あります（照合）`);
    }
    this.orphanList = found;
    return found;
  }

  /** 公開の口を持っているか。GUI と番頭に「頼めるかどうか」を伝えるため。 */
  canExpose(): boolean {
    return this.exposer !== undefined;
  }

  /** いまの上限。GUI と番頭に見せるため（何が効いているか分からないと直せない）。 */
  currentLimits(): EnvLimits {
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

    const driverPath = resolveDriverPath(resolved.driver);
    const result = await runDriverVerb(
      driverPath,
      "provision",
      {
        config: resolved.config,
        taskId,
        ...(request.workdir ? { workdir: path.resolve(request.workdir) } : {}),
      },
      this.timeoutMs,
      extraEnv
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
      ...(request.workdir ? { workdir: path.resolve(request.workdir) } : {}),
    };
    this.ledger.add(entry);

    // 決定39: 頼まれたら外から見えるようにする。**立ってから公開する**——
    // 立たなかった環境のURLを配ると、開いて初めて壊れていると分かる
    if (request.expose !== undefined) {
      try {
        const exposed = await this.requireExposer().expose({
          envId: entry.envId,
          port: request.expose,
          label: entry.taskId,
        });
        this.ledger.setExposure(entry.envId, exposed.url, exposed.port);
        entry.url = exposed.url;
        entry.exposedPort = exposed.port;
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
    return { ...toSummary(entry), healthcheck };
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

  /** 環境の中でコマンドを走らせる。 */
  async run(envId: string, cmd: string, logTailLines = DEFAULT_LOG_TAIL_LINES): Promise<RunResult> {
    const entry = this.requireLive(envId);
    const output = await this.verb(entry, "run", {
      handle: entry.handle,
      cmd,
      // 決定34d: provision と同じ場所で走らせる（台帳に残してある）
      ...(entry.workdir ? { workdir: entry.workdir } : {}),
    });
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

  /** 成果物を回収する。 */
  async collect(envId: string, dest: string): Promise<void> {
    const entry = this.requireLive(envId);
    await this.verb(entry, "collect", { handle: entry.handle, dest });
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
      this.timeoutMs
    );
    // 畳むなら公開も取り下げる。**先に取り下げる**——環境が消えたのにURLだけ生き残ると、
    // 開いた人は「壊れている」としか分からない（決定39）
    if (this.exposer) {
      try {
        await this.exposer.unexpose(envId);
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
      /** 回収先。省略すると collect を飛ばす。 */
      collectTo?: string;
      logTailLines?: number;
    }
  ): Promise<VerifyResult> {
    const summary = await this.provision(request);
    let healthy = summary.healthcheck.ok;
    const healthDetail = summary.healthcheck.detail;
    let runResult: RunResult | undefined;
    let failure: string | undefined;

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
        runResult = await this.run(summary.envId, request.cmd, request.logTailLines);
        if (request.collectTo) await this.collect(summary.envId, request.collectTo);
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
  private requireExposer(): EnvExposer {
    if (!this.exposer) {
      throw new Error(
        "この Banto は環境を外から見えるようにする口を持っていません（公開の実装が設定されていない）。"
      );
    }
    return this.exposer;
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
    input: Record<string, unknown>
  ): Promise<unknown> {
    const result = await runDriverVerb(resolveDriverPath(entry.driver), verb, input, this.timeoutMs);
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
    // 畳み損ねを「畳んだ」と同じに見せない（spec §5）
    state: entry.teardownFailed ? "teardown-failed" : entry.tornDownAt ? "torn-down" : "live",
  };
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
