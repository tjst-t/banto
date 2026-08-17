/**
 * Claude Code サブスクリプション（Max 等）の7日枠の残量を監視するモジュール。
 *
 * Claude Agent SDK の**能力**（認証・枠）を1か所に集める `claude-agent/` 単位の一部。
 * 番頭ホストが Agent SDK 経路（会話と章の要約）でサブスクの枠を食い潰すのを止める
 * ために使う。**残りがしきい値（既定 20%）を切ったら `shouldStop()` が真になり**、
 * 呼び出し側は Claude を使うのをやめて pi へフォールバックする。枠がリセットされると
 * 測れた残量が持ち直すので、自動で使える状態へ戻る。
 *
 * ## 計測元
 *
 * `GET {base}/api/oauth/usage`（Anthropic の OAuth usage API）。**実測（2026-08-17）**：
 * Max・`rateLimitTier = default_claude_max_20x` で
 *
 * ```
 * { "seven_day": { "utilization": 98.0, "resets_at": "…" },
 *   "limits": [ { "kind": "weekly_all", "group": "weekly", "percent": 98, "resets_at": "…" } ] }
 * ```
 *
 * という応答が返り、`seven_day.utilization` が「この7日枠の使用率%」を表す。残量は
 * `100 - seven_day.utilization`。`resets_at` は次週の枠リセット時刻で、これを「いつ
 * 戻るか」の目安に出す。**`seven_day` は Max の実測で使えるが、プランで変わらないとは
 * 保証できない**——測れないときは `limits[].weekly_all.percent` で代用し、それも無ければ
 * 残量を「分からない」にする（後述・I2）。
 *
 * ## 認証
 *
 * 前例（`@banto/worker-pool` の `claudeAgentAvailability`）と同じく
 * `~/.claude/.credentials.json`（`CLAUDE_CONFIG_DIR` で差し替え）を読み、
 * `claudeAiOauth.accessToken` を Bearer として使う。アクセストークンは約2時間で切れる
 * ため、切れていたら `refreshToken` での更新を**ベストエフォート**で試みる——更新に
 * 失敗しても握りつぶさない（I2：理由をログに出し、古いトークンのまま続ける）。
 *
 * ## 計測できないときの扱い（I2）
 *
 * ネットワークが無い・認証が無い環境で **「残量が分からない」を「尽きた」と混同しない**。
 * `shouldStop()` は計測できなければ常に `false`（止めない）を返す。
 *
 * D5: 判断は「しきい値と計測値の比較」だけ。どこへ落とすかは呼び出し側が決める。
 * D6: 依存は none。`fetch` は Node のグローバル（v24）を使う。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 残量 % のしきい値の既定。残りがこれを未満になったら Claude を使うのを止める。 */
export const DEFAULT_CLAUDE_STOP_REMAINING_PCT = 20;

/** 定期再計測の間隔（ミリ秒）。枠は数時間〜数日で変わらないので、数分に一度で足りる。 */
export const DEFAULT_CLAUDE_QUOTA_POLL_MS = 5 * 60 * 1000;

/** 認証情報の写し（`.credentials.json` の該当部分）。 */
export interface ClaudeCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** 計測の写し。`shouldStop()` の判定に使う。 */
export interface ClaudeQuotaSnapshot {
  /** 残量パーセント（0〜100）。分からないときは `undefined`（I2）。 */
  remainingPct?: number;
  /** 枠がリセットされる時刻（ISO 文字列）。分からなければ `undefined`。 */
  resetsAt?: string;
  /** 直近の計測時刻（ミリ秒）。 */
  measuredAt?: number;
  /** 計測できなかった理由（直近1回分）。 */
  error?: string;
}

export interface ClaudeQuotaMonitor {
  /** 最新の写し（キャッシュ）。計測がまだなら初期の空状態。 */
  snapshot(): ClaudeQuotaSnapshot;
  /** 残りがしきい値を切った（Claude を使うのを止めるべき）か。 */
  shouldStop(): boolean;
  /** 残量 % のしきい値。 */
  readonly stopRemainingPct: number;
  /**
   * `shouldStop()` が `false → true` に変わったときに呼ぶ（自動フォールバック用）。
   * 戻り値は購読の解除口。**立ち上がっていないスレッドもあり得るので、これは「契機」
   * であり、各スレッドは自ら現在の状態を確認して動くこと。**
   */
  onStopCrossing(handler: (snapshot: ClaudeQuotaSnapshot) => void): () => void;
  /** バックグラウンドの定期再計測を始める。多重起動を防ぐ。 */
  start(): void;
  stop(): void;
  /** 即時再計測（起動時の1回などに使う）。 */
  refresh(): Promise<ClaudeQuotaSnapshot>;
}

interface SecurityState {
  snapshot: ClaudeQuotaSnapshot;
  stopping: boolean;
  handlers: Array<(snapshot: ClaudeQuotaSnapshot) => void>;
  timer: ReturnType<typeof setInterval> | undefined;
}

export interface ClaudeQuotaOptions {
  /** 残量 % のしきい値。残りがこれを未満なら Claude を止める。 */
  stopRemainingPct?: number;
  /** 定期再計測の間隔（ミリ秒）。 */
  pollIntervalMs?: number;
  /** API のベース URL。既定 `https://api.anthropic.com`。 */
  baseUrl?: string;
  /** 認証情報の読み出し口。既定は `CLAUDE_CONFIG_DIR`/`.credentials.json` を読む。 */
  readCredentials?: () => ClaudeCredentials | undefined;
  /** 試験用の差し替え口。 */
  fetch?: typeof fetch;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

/** `.credentials.json` の既定の置き場所を返す（`claudeAgentAvailability` と同じ流儀）。 */
function defaultCredentialsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, ".credentials.json");
}

/** 認証情報を読む。**無ければ undefined**（読めないことは止める理由にしない）。 */
function readCredentialsFile(
  env: NodeJS.ProcessEnv,
  logger: Pick<Console, "warn">
): ClaudeCredentials | undefined {
  const credPath = defaultCredentialsPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(credPath, "utf8");
  } catch {
    // 無いのは正常（API キー運用などのとき）。ログは出さない
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Partial<ClaudeCredentials> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth) return undefined;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
  } catch (err) {
    logger.warn(`[banto] Claude の認証情報（${credPath}）を読めませんでした: ${String(err)}`);
    return undefined;
  }
}

/**
 * アクセストークンの更新をベストエフォートで試みる。成功したら写しを返す。
 * **失敗しても握りつぶさない**（I2）——理由をログに出し、null を返して古い側で続ける。
 */
async function tryRefreshAccessToken(
  credentials: ClaudeCredentials,
  baseUrl: string,
  fetchImpl: typeof fetch,
  logger: Pick<Console, "warn">
): Promise<string | undefined> {
  if (!credentials.refreshToken) return undefined;
  try {
    const res = await fetchImpl(`${baseUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: "claude-ai-external-token",
      }),
      // 返らなくてもホストの起動や定期監視を待たせない（I2：計測失敗は「止めない」側）
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(
        `[banto] Claude のトークン更新に失敗しました（${res.status}）。古いトークンのまま続けます: ${body.slice(0, 200)}`
      );
      return undefined;
    }
    const data = (await res.json()) as { access_token?: string };
    return data.access_token;
  } catch (err) {
    logger.warn(`[banto] Claude のトークン更新で例外（古いトークンのまま続けます）: ${String(err)}`);
    return undefined;
  }
}

/** usage API の応答から残量 % とリセット時刻を取り出す。取れなければ undefined。 */
export function parseUsagePayload(payload: unknown): {
  remainingPct?: number;
  resetsAt?: string;
} {
  if (typeof payload !== "object" || payload === null) return {};
  const root = payload as {
    seven_day?: { utilization?: number | null; resets_at?: string | null };
    limits?: Array<{ kind?: string; percent?: number | null; resets_at?: string | null }>;
  };
  // 優先: 7日枠の使用率から残量を出す
  if (
    root.seven_day &&
    typeof root.seven_day.utilization === "number" &&
    Number.isFinite(root.seven_day.utilization)
  ) {
    const remaining = Math.max(0, Math.min(100, 100 - root.seven_day.utilization));
    const resetsAt = root.seven_day.resets_at ?? undefined;
    return { remainingPct: remaining, ...(resetsAt ? { resetsAt } : {}) };
  }
  // 代用: 週の枠の limits から
  const weekly = (root.limits ?? []).find(
    (l) => typeof l.percent === "number" && Number.isFinite(l.percent)
  );
  if (weekly && typeof weekly.percent === "number") {
    const remaining = Math.max(0, Math.min(100, 100 - weekly.percent));
    const resetsAt = weekly.resets_at ?? undefined;
    return { remainingPct: remaining, ...(resetsAt ? { resetsAt } : {}) };
  }
  return {};
}

/** 定期監視を伴う計測器を組み立てる。 */
export function createClaudeQuotaMonitor(
  options: ClaudeQuotaOptions = {}
): ClaudeQuotaMonitor {
  const stopRemainingPct = options.stopRemainingPct ?? DEFAULT_CLAUDE_STOP_REMAINING_PCT;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_CLAUDE_QUOTA_POLL_MS;
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? console;
  const readCredentials =
    options.readCredentials ?? ((env: NodeJS.ProcessEnv) => readCredentialsFile(env, logger));

  // 前回に読み込んだトークン。ログ量を抑えるため毎回再読込はしない
  let tokenCache: string | undefined;

  const state: SecurityState = {
    snapshot: {},
    stopping: false,
    handlers: [],
    timer: undefined,
  };

  const buildStop = (snapshot: ClaudeQuotaSnapshot): boolean =>
    snapshot.remainingPct !== undefined && snapshot.remainingPct < stopRemainingPct;

  const applySnapshot = (snapshot: ClaudeQuotaSnapshot): void => {
    const nextStop = buildStop(snapshot);
    const crossing = nextStop && !state.stopping;
    state.snapshot = snapshot;
    if (crossing) {
      state.stopping = true;
      for (const h of [...state.handlers]) {
        try {
          h(snapshot);
        } catch (err) {
          console.error(`[banto] Claude クオータの止める契機を扱えませんでした: ${String(err)}`);
        }
      }
    } else if (!nextStop) {
      state.stopping = false;
    }
  };

  const refresh = async (): Promise<ClaudeQuotaSnapshot> => {
    const credentials = readCredentials(process.env) ?? {};
    // 前回読んだトークンを維持しつつ、ファイルに更新があれば新しさを優先する
    if (!credentials.accessToken && tokenCache) {
      credentials.accessToken = tokenCache;
    }
    const accessToken = credentials.accessToken;
    if (!accessToken) {
      // 認証が無い（API キー運用等）→ 枠の概念が無いので「止めない」
      applySnapshot({ error: "Claude の認証が見つかりません" });
      return state.snapshot;
    }
    let effectiveToken = accessToken;
    if (credentials.expiresAt && now() > credentials.expiresAt) {
      const refreshed = await tryRefreshAccessToken(credentials, baseUrl, fetchImpl, logger);
      if (refreshed) effectiveToken = tokenCache = refreshed;
    }
    try {
      const res = await fetchImpl(`${baseUrl}/api/oauth/usage?limit=1`, {
        headers: { Authorization: `Bearer ${effectiveToken}` },
        // 返らなくてもホストの起動や定期監視を待たせない（I2：計測失敗は「止めない」側）
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = `Claude usage API が ${res.status} を返しました: ${detail.slice(0, 200)}`;
        applySnapshot({ error: err });
        console.warn(`[banto] ${err}`);
        return state.snapshot;
      }
      const payload = (await res.json()) as unknown;
      const { remainingPct, resetsAt } = parseUsagePayload(payload);
      if (remainingPct === undefined) {
        const err = `Claude usage API に残量がありませんでした（応答は読める形では無かった）`;
        applySnapshot({ error: err });
        console.warn(`[banto] ${err}`);
        return state.snapshot;
      }
      const clean: ClaudeQuotaSnapshot = {
        remainingPct,
        measuredAt: now(),
        ...(resetsAt ? { resetsAt } : {}),
      };
      applySnapshot(clean);
      return state.snapshot;
    } catch (err) {
      const errMsg = `Claude のクオータ取得で例外: ${String(err)}`;
      applySnapshot({ error: errMsg });
      return state.snapshot;
    }
  };

  const start = (): void => {
    if (state.timer) return;
    state.timer = setInterval(() => {
      void refresh();
    }, pollIntervalMs);
    state.timer.unref?.();
  };

  const stop = (): void => {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  };

  return {
    snapshot: () => state.snapshot,
    shouldStop: () => buildStop(state.snapshot),
    stopRemainingPct,
    onStopCrossing: (handler) => {
      state.handlers.push(handler);
      return () => {
        const i = state.handlers.indexOf(handler);
        if (i >= 0) state.handlers.splice(i, 1);
      };
    },
    start,
    stop,
    refresh,
  };
}
