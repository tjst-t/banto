// **banto 本体の Claude ログインを、トークンを渡さずに Project のコンテナに使わせる中継**
// （決定・2026-09-24、ユーザー。core に常設・2026-09-27、`docs/specs/v4-security.md` §2「banto 本体の Claude ログインは、
// 中継で共有する」）。
//
// コンテナに入れるのは `ANTHROPIC_BASE_URL`＝この中継と、`CLAUDE_CODE_OAUTH_TOKEN`＝**その Project の合言葉**。
// 中継は合言葉から Project を引き、Authorization を本体の access token に差し替えて api.anthropic.com へ流す。
// **本物のトークン（と refresh token）はコンテナに入らない**——中では AI が root で何でも読めるので、渡さないのが
// 唯一の守り方。
//
// **会話の本体（Runner）もこの中継を通る**（決定・2026-10-18、§2「Claude のアカウントを複数持つ」の 2.）。本体には別の表の
// 合言葉（本体用）を渡し、host の loopback から来たときだけ受ける。コンテナ用と取り違えたら断る。
//
// 合言葉は Project ごとに1つで固定（Service がコンテナの起動で勝手に起きても、古い合言葉にならない）。替わるのは
// Project 設定の「Claude のログインを使わせる」を切ったときだけ（切った時点で消し、次に要るときに新しく出す）。
//
// 待ち受けは複数持てる（`ClaudeLoginListener`）。core の口ではコンテナのアドレスで送り元を縛り、別のサーバ用の
// 専用の待ち受け（`relay-listener.ts`）では、待ち受けそのものが送り元の代わりになる（§2、2026-10-08）。
//
// 資格情報で認証を差し込む中継は既知の形（規則12——サンドボックスの外で鍵を足す egress proxy）。
// 実測（poc/08-subagent-acp/proxy-probe.mjs）：Claude Code が中継に投げたのは `/v1/messages` だけ。

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { CredentialRefresher, type CloseWhen, type RefreshOutcome } from "./refresh.js";
import { HOST_ACCOUNT_ID, type ClaudeAccountStore } from "./accounts.js";
import { blockedBy, chooseAccount, earliestRecovery, type Blocked } from "./select.js";

const UPSTREAM = "https://api.anthropic.com";
/**
 * **試し直すために本文を持つ上限**（API の要求の上限 32 MB）。超えるものは持たずに流し、401 でも送り直さない
 */
const RETRY_BODY_LIMIT = 32 * 1024 * 1024;
/** 同時に抱える本文の合計の上限（要求の数だけ重なるので。超えたら持たずに流す） */
const RETRY_BODY_TOTAL_LIMIT = 64 * 1024 * 1024;
/** core の HTTP サーバの上の口。`ANTHROPIC_BASE_URL` はここまで（CLI が `/v1/messages` を足す） */
export const CLAUDE_LOGIN_PATH = "/claude-login";
/**
 * **この Project に Claude のログインを使わせるか**（Project ごとの設定、決定・2026-09-27、ユーザー）。既定はオン
 * ——その Project の会話の本体（Runner）はすでに同じログインで動いている
 */
export const CLAUDE_LOGIN_ENABLED_KEY = "claudeLogin.enabled";
/**
 * **通すのは推論だけ**。本体のトークンは会話の履歴・claude.ai のコネクタ・ファイルの
 * 送り込みまで触れる広さを持つ——コンテナに要るのは推論だけなので、他は断る
 */
const ALLOWED_PATH = /^\/v1\/messages(\/count_tokens)?(\?|$)/;
/** 上限の見出し（`allowed`・`allowed_warning`・`rejected`）。429 でこれが rejected なら、並びの次へ送り直す */
const RATELIMIT_STATUS_HEADER = "anthropic-ratelimit-unified-status";
/** 全部越えのカードを閉じに行くのは、一番早いリセットの少しあと */
const RECOVERY_CHECK_DELAY_MS = 1_000;
/** どの Thread の要求かの印（本体の CLI が `ANTHROPIC_CUSTOM_HEADERS` で付ける）。中継が読み、上流へは流さない */
export const THREAD_ID_HEADER = "x-banto-thread-id";
const HOP_BY_HOP = ["host", "connection", "content-length", "authorization", "x-api-key", "keep-alive", "transfer-encoding", THREAD_ID_HEADER];
/**
 * **本体用の合言葉を受ける送り元**：host の loopback だけ。core は 0.0.0.0 で待ち受けるので3つとも来うる
 * （§2「Claude のアカウントを複数持つ」の 2.）
 */
const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1", "::1"]);
/**
 * **本体の Runner の env から外す、上流を決める変数**。残すと合言葉より勝つ（`ANTHROPIC_API_KEY` は `x-api-key` で送られ、
 * 401 を 10 回試し直す——#397 の実測）。どちらが勝つかに頼らず外す
 */
const UPSTREAM_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  // 下で入れ直すもの（外の値が残らないように。契約の種類は分からなければ入れない）
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "ANTHROPIC_CUSTOM_HEADERS",
];
/**
 * **付随の通信を止める**（§2「Claude のアカウントを複数持つ」の 1.）。止めないと CLI は `ANTHROPIC_BASE_URL` を無視して
 * api.anthropic.com へ直に出る（機能の旗・利用の記録・bootstrap）——中継の合言葉を banto の外へ送ってしまう。
 * 本体の Runner とコンテナの環境の両方に入れる
 */
export const NONESSENTIAL_TRAFFIC_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } as const;

/**
 * 本体（main の Runner）が使っている資格情報の置き場。CLI と同じ順で決める——
 * `CLAUDE_SECURESTORAGE_CONFIG_DIR`（E2E・疎通確認が本物を指すのに使う）→ `CLAUDE_CONFIG_DIR` → `~/.claude`
 */
export function hostClaudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  // CLI と同じく、CLAUDE_SECURESTORAGE_CONFIG_DIR が空文字なら ~/.claude（CLI の `rw`）
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = secure !== undefined ? secure || join(homedir(), ".claude") : env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, ".credentials.json");
}

export interface HostClaudeAccount {
  /** 契約の種類と上限の段——**トークンではない**。コンテナに渡すと、既定のモデルと文脈の上限が
   *  本体と揃う（env のトークンのとき CLI はここから読む。実測：既定が Opus 5.5・文脈100万になった） */
  subscriptionType?: string;
  rateLimitTier?: string;
}

export type HostLoginStatus = ({ loggedIn: true } & HostClaudeAccount) | { loggedIn: false; reason: string };

export class ClaudeLoginError extends Error {
  override name = "ClaudeLoginError";
}

/** 毎回読み直す——本体の CLI が更新したトークンを、そのまま拾う（写しを持たない・規則3） */
async function readAccessToken(path: string): Promise<{ token: string; account: HostClaudeAccount }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ClaudeLoginError(`banto 本体が Claude にログインしていません（${path} がありません）`);
  }
  const oauth = (
    JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string; rateLimitTier?: string } }
  ).claudeAiOauth;
  if (!oauth?.accessToken) throw new ClaudeLoginError(`banto 本体の Claude ログインにトークンがありません（${path}）`);
  return {
    token: oauth.accessToken,
    account: {
      ...(oauth.subscriptionType ? { subscriptionType: oauth.subscriptionType } : {}),
      ...(oauth.rateLimitTier ? { rateLimitTier: oauth.rateLimitTier } : {}),
    },
  };
}

/** 設定画面に出す、本体のログインの様子（トークンは読むが返さない） */
export async function readHostClaudeAccount(path: string): Promise<HostLoginStatus> {
  try {
    const { account } = await readAccessToken(path);
    return { loggedIn: true, ...account };
  } catch (err) {
    // 読めなかった理由をそのまま出す（壊れたファイルを「未ログイン」に丸めない）
    return { loggedIn: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * **待ち受け1つ分の決まり**。中継の口は複数の待ち受けに載る（core の口・別のサーバ用の専用の待ち受け）
 */
export interface ClaudeLoginListener {
  /** この待ち受けで受けてよい Project か（専用の待ち受けは、その実行場所の Project だけ） */
  acceptsProject(projectId: string): boolean;
  /**
   * **本体用の合言葉を受ける待ち受けか**（core の口だけ。別のサーバの専用の待ち受けは受けない）。受ける口でも、
   * 送り元が host の loopback でなければ断る
   */
  acceptsRunner: boolean;
  /**
   * 送り元のアドレスを、その Project のコンテナのアドレスに縛るか。別のサーバからは SSH のトンネルで来るので、
   * 送り元は全部 127.0.0.1——そこでは待ち受けが送り元の代わりになるので縛らない
   */
  bindSource: boolean;
}

/** 合言葉の種類。本体用（host の Runner）とコンテナ用は別の表に持ち、取り違えたら断る */
export type ClaudeLoginSecretKind = "runner" | "container";

/** Project ごとの観測（Project 設定に出す。Event Store には要求ごとに残さない——多すぎる） */
export interface ClaudeLoginStats {
  /** 上流へ流した要求の数（banto を起こしてから） */
  requests: number;
  lastRequestAt?: string;
  /** 上流が 401 を返した最後の時刻（本体のログインの期限切れ） */
  lastUnauthorizedAt?: string;
}

/**
 * **なぜ切り替えたか**（§2「Claude のアカウントを複数持つ」の 6.）。前のアカウントが閾値を越えた・上限で断った（`Blocked`）、
 * 前のアカウントがリセットされて並びの前へ戻った（`recovered`）、並びが変わった（`order`）、前のアカウントが使えなかった
 * （ログインしていない等、`unavailable`）
 */
export type ClaudeAccountSwitchReason = Blocked | { kind: "recovered" } | { kind: "order" } | { kind: "unavailable" };

/** 切り替えの1件（Event Store に1件、Thread が分かればその会話に1行） */
export interface ClaudeAccountSwitch {
  projectId: string;
  /** 本体の要求なら `x-banto-thread-id` の Thread（コンテナからの要求では読まない） */
  threadId?: string;
  from: string;
  to: string;
  reason: ClaudeAccountSwitchReason;
}

/** 並びの全部が閾値を越えた（受信箱に1枚。鍵は並びの中身——Project の並びごとに1枚） */
export interface ClaudeAccountsAllOver {
  key: string;
  projectId: string;
  order: string[];
  /** 続けているアカウント（一番早くリセットされるもの） */
  using: string;
}

export interface ClaudeLoginRelayDeps {
  /**
   * **アカウントの台帳と置き場**（§2「Claude のアカウントを複数持つ」の 3.）。アカウント1つ＝置き場1つ＝取り直し役1つ＝
   * 知らせ1つ。どれを使うかは要求ごとに、その Project の並びと使用率・閾値から選ぶ（`select.ts`）
   */
  accounts: ClaudeAccountStore;
  /** 合言葉の置き場（host のデータの置き場。0600） */
  secretsPath: string;
  /** Project 設定のスイッチ。聞くたびに引く */
  enabled(projectId: string): boolean;
  /**
   * 送り元が、その Project のコンテナか。**分からない（Incus が答えない）は投げる**——黙って通さない・
   * 黙って「違う」にしない
   */
  sourceMatches?(projectId: string, remoteAddress: string): Promise<boolean>;
  /**
   * **本体のログインを中継では直せなかった**（受信箱に1件出すため。改訂・2026-10-16）——取り直して試し直しても上流が
   * 401、または取り直しが断られた・書き戻せなかった。一時的な失敗（通信・5xx・鍵の取り合い）だけでは呼ばない
   */
  onUpstreamUnauthorized?(projectId: string, reason: string, accountId: string): void;
  /**
   * そのアカウントで上流が通った（2xx）——そのアカウントのカードを閉じるため。直前に直せなかったことがあるときだけ呼ぶ。
   * **別のアカウントが通っても呼ばない**
   */
  onUpstreamAuthorized?(accountId: string): void;
  /** **その Project で使うアカウントが替わった**（§2 の 6.）。記録の失敗で推論を止めない——呼ぶ側が受けて知らせる */
  onAccountSwitched?(change: ClaudeAccountSwitch): void;
  /** 並びの全部が閾値を越えた（同じ並びで開いている間は呼ばない） */
  onAllOverThreshold?(info: ClaudeAccountsAllOver): void;
  /**
   * その並びのどれかが閾値の下に戻った——カードを閉じるため。**まだ見ていない並びは開いている扱い**（起こし直す前に
   * 出したカードも、その並びで最初に選んだときに閉じる）
   */
  onBackUnderThreshold?(key: string): void;
  upstream?: string;
  /** 取り直しの口（試験・E2E で差し替える。既定は本番） */
  tokenUrl?: string;
  /** 中継が取り直すか（既定はする。切れば今までどおり読むだけ） */
  refreshEnabled?: boolean;
  now?: () => Date;
}

export class ClaudeLoginRelay {
  /** コンテナ用の合言葉（Project ごと。置き場に書く——Service がコンテナの起動で勝手に起きても替わらない） */
  private readonly secrets: Map<string, string>;
  /**
   * **本体用の合言葉**（Project ごと、別の表——§2「Claude のアカウントを複数持つ」の 2.）。スイッチ（`enabled`）と revoke の
   * 対象外。置き場には書かない——使うのは core の子の CLI だけで、core と寿命が同じ（起こし直せば CLI も起こし直る）
   */
  private readonly runnerSecrets = new Map<string, string>();
  /** 観測はコンテナからの要求だけ（Project 設定の今の表示の意味を変えない）。本体の要求は `runnerStats` に別に数える */
  private readonly stats = new Map<string, ClaudeLoginStats>();
  private readonly runnerStats = new Map<string, ClaudeLoginStats>();
  /** 送り元を確かめ済みの接続と、その接続で確かめた Project */
  private readonly verifiedSockets = new WeakMap<Socket, Set<string>>();
  private readonly upstream: string;
  private readonly now: () => Date;
  /** アカウントごとの取り直し役（置き場ごとに1つ。同時に来た要求の待ち合わせ・401 の間引きも置き場ごと） */
  private readonly refreshers = new Map<string, CredentialRefresher>();
  /**
   * アカウントごとの、知らせたカードを閉じる条件（`undefined`＝開いていない）。**まだ載っていないアカウントは開いている
   * 扱い**——起こし直す前に出したカードも、そのアカウントで最初に通ったときに閉じる
   */
  private readonly openTrouble = new Map<string, { closeWhen: CloseWhen; refreshToken?: string } | undefined>();
  /** いま試し直し用に抱えている本文の合計 */
  private bufferedBytes = 0;
  /** Project ごとの、最後に返事を返したアカウント（切り替えを見分けるため。起こしてからのもの） */
  private readonly current = new Map<string, string>();
  /** 並び（の鍵）ごとの、全部越えのカードが開いているか。無い鍵は開いている扱い */
  private readonly allOverOpen = new Map<string, boolean>();
  /** 全部越えのカードを閉じに行く時計（並びの鍵ごと） */
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: ClaudeLoginRelayDeps) {
    this.upstream = deps.upstream ?? UPSTREAM;
    this.now = deps.now ?? (() => new Date());
    this.secrets = new Map(Object.entries(loadSecrets(deps.secretsPath)));
  }

  /**
   * **その Project のコンテナに入れる環境**。スイッチが切れていれば undefined（入れない）。合言葉が無ければ
   * ここで出し、置き場に書く——以後は切られるまで同じもの
   */
  async envFor(projectId: string, baseUrl: string): Promise<Record<string, string> | undefined> {
    if (!this.deps.enabled(projectId)) {
      this.revoke(projectId);
      return undefined;
    }
    let secret = this.secrets.get(projectId);
    if (!secret) {
      secret = `banto-${randomBytes(32).toString("base64url")}`;
      this.secrets.set(projectId, secret);
      this.save();
    }
    return {
      ANTHROPIC_BASE_URL: `${baseUrl}${CLAUDE_LOGIN_PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      ...(await this.accountEnv(projectId)),
    };
  }

  /**
   * **会話の本体（Runner）の `query()` に渡す環境**（§2「Claude のアカウントを複数持つ」の 2.）。SDK の `env` は process.env を
   * 置き換えるので、process.env から上流を決める変数を外したものに、中継の住所（host の loopback）・本体用の合言葉・
   * 契約の種類・付随の通信を止める印・Thread の印を足す。`CLAUDE_CONFIG_DIR`（会話の記録の置き場）は今のまま。
   *
   * **中継が取り直せない banto では中継を通さない**：合言葉を渡された CLI は `~/.claude` を読まず自分では取り直さないので、
   * 誰も取り直さず約8時間で本体の会話まで 401 になる。そのときは今の形（`~/.claude` を自分で読む）に付随の通信を止める
   * 印だけを足す
   */
  async runnerEnvFor(projectId: string, threadId: string, baseUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string | undefined>> {
    if (this.deps.refreshEnabled === false) return { ...env, ...NONESSENTIAL_TRAFFIC_ENV };
    let secret = this.runnerSecrets.get(projectId);
    if (!secret) {
      secret = `banto-runner-${randomBytes(32).toString("base64url")}`;
      this.runnerSecrets.set(projectId, secret);
    }
    const base = { ...env };
    for (const name of UPSTREAM_ENV) delete base[name];
    return {
      ...base,
      ANTHROPIC_BASE_URL: `${baseUrl}${CLAUDE_LOGIN_PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      ...(await this.accountEnv(projectId)),
      ...NONESSENTIAL_TRAFFIC_ENV,
      ANTHROPIC_CUSTOM_HEADERS: `${THREAD_ID_HEADER}: ${threadId}`,
    };
  }

  /** 契約の種類（秘密ではない）。いまその Project で選ばれるアカウントのもの。ログインしていなければ入れない（中継に来たときに理由を返す） */
  private async accountEnv(projectId: string): Promise<Record<string, string>> {
    const accountId = this.accountFor(projectId);
    const status: HostLoginStatus = accountId
      ? await readHostClaudeAccount(this.deps.accounts.credentialsPathOf(accountId))
      : { loggedIn: false, reason: "使える Claude のアカウントがありません" };
    return {
      ...(status.loggedIn && status.subscriptionType ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: status.subscriptionType } : {}),
      ...(status.loggedIn && status.rateLimitTier ? { CLAUDE_CODE_RATE_LIMIT_TIER: status.rateLimitTier } : {}),
    };
  }

  /** スイッチを切った——その時点で合言葉を無効にする。入れ直すと次の `envFor` で新しいものが出る */
  revoke(projectId: string): void {
    if (this.secrets.delete(projectId)) this.save();
  }

  /** コンテナからの要求の観測 */
  statsFor(projectId: string): ClaudeLoginStats {
    return { ...(this.stats.get(projectId) ?? { requests: 0 }) };
  }

  /** 会話の本体（Runner）からの要求の観測（コンテナのものとは別に数える） */
  runnerStatsFor(projectId: string): ClaudeLoginStats {
    return { ...(this.runnerStats.get(projectId) ?? { requests: 0 }) };
  }

  /** 最初の1つ（このマシンの Claude Code のログイン）の様子 */
  hostLogin(): Promise<HostLoginStatus> {
    return readHostClaudeAccount(this.deps.accounts.credentialsPathOf(HOST_ACCOUNT_ID));
  }

  /**
   * **その Project の要求にいま使うアカウント**（§2 の 5.・6.）：その Project の並び（無ければ既定の並び）の先頭から、
   * 閾値の下で上限に断られていない最初のもの。全部越えていれば一番早くリセットされるもの。並びが空なら undefined
   */
  private accountFor(projectId: string): string | undefined {
    return this.choose(projectId)?.accountId;
  }

  private choose(projectId: string, skip?: ReadonlySet<string>) {
    const store = this.deps.accounts;
    return chooseAccount(store.orderFor(projectId), (id) => store.usageOf(id), store.thresholds(), this.now(), skip);
  }

  /** その Project が最後に使ったアカウント（Project 設定の観測。起こしてから1度も使っていなければ undefined） */
  currentAccountOf(projectId: string): string | undefined {
    return this.current.get(projectId);
  }

  /** 止めるとき：全部越えのカードを閉じに行く時計を止める */
  close(): void {
    for (const t of this.recoveryTimers.values()) clearTimeout(t);
    this.recoveryTimers.clear();
  }

  /**
   * **その Project の並びで一番早いリセットの時刻**（ミリ秒、§2 の 9.——上限で止まったターンを続ける時刻）。断っている
   * （status が rejected の）アカウントの、断りが効く時刻（`-reset`）のうち一番早いもの。中継が持っていなければ undefined
   * ——本体が中継を通らない banto（取り直せない）では、ここに本体の返事は来ないので持っていない扱い
   */
  earliestResetFor(projectId: string): number | undefined {
    if (this.deps.refreshEnabled === false) return undefined;
    let earliest: number | undefined;
    for (const id of this.deps.accounts.orderFor(projectId)) {
      const usage = this.deps.accounts.get(id)?.usage;
      if (usage?.status !== "rejected" || usage.statusResetsAt === undefined) continue;
      const at = Date.parse(usage.statusResetsAt);
      if (Number.isFinite(at) && (earliest === undefined || at < earliest)) earliest = at;
    }
    return earliest;
  }

  /** **アカウントを外した**：その取り直し役と開いている知らせを忘れる（同じ id が戻ることは無い） */
  forgetAccount(accountId: string): void {
    this.refreshers.delete(accountId);
    this.openTrouble.delete(accountId);
  }

  private refresherFor(accountId: string): CredentialRefresher {
    let r = this.refreshers.get(accountId);
    if (!r) {
      r = new CredentialRefresher({
        credentialsPath: this.deps.accounts.credentialsPathOf(accountId),
        ...(this.deps.tokenUrl ? { tokenUrl: this.deps.tokenUrl } : {}),
        ...(this.deps.refreshEnabled !== undefined ? { enabled: this.deps.refreshEnabled } : {}),
        now: () => this.now().getTime(),
      });
      this.refreshers.set(accountId, r);
    }
    return r;
  }

  /** `CLAUDE_LOGIN_PATH` の下に来た要求を受ける。どの待ち受けから来たかで、受ける Project と送り元の縛りが変わる */
  async handle(req: IncomingMessage, res: ServerResponse, listener: ClaudeLoginListener): Promise<void> {
    try {
      await this.forward(req, res, listener);
    } catch (err) {
      if (!res.headersSent) refuse(res, 502, `中継できませんでした: ${err instanceof Error ? err.message : String(err)}`);
      else res.destroy();
    }
  }

  private async forward(req: IncomingMessage, res: ServerResponse, listener: ClaudeLoginListener): Promise<void> {
    const path = (req.url ?? "").slice(CLAUDE_LOGIN_PATH.length);
    const caller = this.callerOf(req.headers.authorization);
    const projectId = caller?.projectId;
    const remoteAddress = req.socket.remoteAddress ?? "";
    if (caller?.kind === "runner") {
      // **本体用の合言葉は core の口に host の loopback から来たときだけ**。コンテナの口（ブリッジのアドレス）・別のサーバの
      // 専用の待ち受けに来たら断る。Incus には聞かない。スイッチ（`enabled`）は見ない——それはコンテナの中だけを決める
      if (!listener.acceptsRunner || !LOOPBACK.has(remoteAddress)) {
        refuse(res, 403, `この合言葉は banto 本体の会話からしか使えません（送り元 ${normalizeAddress(remoteAddress)}）`);
        return;
      }
    } else {
      // 合言葉が違う・その待ち受けで受けない Project・切られた Project は、どれも同じ 401（どれに当たったかを外に言わない）
      if (!projectId || !listener.acceptsProject(projectId) || !this.deps.enabled(projectId)) {
        if (projectId && !this.deps.enabled(projectId)) this.revoke(projectId);
        refuse(res, 401, "合言葉が違います");
        return;
      }
      if (listener.bindSource && !this.verifiedSockets.get(req.socket)?.has(projectId)) {
        const remote = normalizeAddress(remoteAddress);
        // host の loopback から来たコンテナ用の合言葉（取り違え）も、コンテナのアドレスと合わないのでここで断られる
        if (!this.deps.sourceMatches || !(await this.deps.sourceMatches(projectId, remote))) {
          refuse(res, 403, `この合言葉は、その Project のコンテナからしか使えません（送り元 ${remote}）`);
          return;
        }
        // 同じ接続の送り元は変わらない（コンテナが止まれば接続も切れる）——keep-alive の続きでは Incus に聞き直さない
        const verified = this.verifiedSockets.get(req.socket) ?? new Set<string>();
        verified.add(projectId);
        this.verifiedSockets.set(req.socket, verified);
      }
    }
    if (!caller || !projectId) throw new Error("unreachable: 合言葉から Project が決まっていない");
    if (!ALLOWED_PATH.test(path)) {
      refuse(res, 403, `banto の中継は推論（/v1/messages）だけを通します: ${req.method} ${path}`);
      return;
    }
    const order = this.deps.accounts.orderFor(projectId);
    const first = this.choose(projectId);
    if (!first) {
      refuse(res, 500, "使える Claude のアカウントがありません（並びが空です）");
      return;
    }
    this.noteAllOver(projectId, order, first.allOver, first.accountId);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    // 試し直すために本文を読み切って持つ（上限を超えたら、読んだ分と残りをつないで流す）
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const room = Math.min(RETRY_BODY_LIMIT, Math.max(0, RETRY_BODY_TOTAL_LIMIT - this.bufferedBytes));
    const body: { buffered?: Buffer; stream?: Readable } = hasBody ? await readBodyUpTo(req, room) : {};
    const held = body.buffered?.length ?? 0;
    this.bufferedBytes += held;
    /** 本文を持てた（または本文が無い）——401 の試し直し・429 の送り直しができる */
    const resendable = !hasBody || body.buffered !== undefined;
    const send = (bearer: string) =>
      fetch(`${this.upstream}${path}`, {
        method: req.method ?? "POST",
        headers: { ...forwardedHeaders(req), authorization: `Bearer ${bearer}` },
        ...(hasBody
          ? body.buffered !== undefined
            ? { body: body.buffered }
            : // Node の fetch で本文を流しながら送るには duplex が要る
              { body: Readable.toWeb(body.stream!) as ReadableStream<Uint8Array>, duplex: "half" }
          : {}),
        signal: abort.signal,
      } as RequestInit);
    let upstreamRes: Response | undefined;
    let accountId = first.accountId;
    /** 並びの全部が上限で断った（送り直しを尽くした） */
    let exhausted = false;
    try {
      // **上限で断られたら（429・rejected）、並びの次のアカウントへ、使えるものが無くなるまで順に送り直す**（§2 の 6.）
      const tried = new Set<string>();
      for (let candidate: string | undefined = first.accountId; candidate !== undefined; ) {
        tried.add(candidate);
        const attempt = await this.sendAs(candidate, projectId, send, resendable);
        if (attempt.kind === "refused") {
          // そのアカウントはログインしていない：並びに次があればそれへ。無ければ、前に断られた 429 があればそれを、
          // 無ければ理由を返す
          const next = resendable ? this.choose(projectId, tried) : undefined;
          if (next) {
            candidate = next.accountId;
            continue;
          }
          if (!upstreamRes) {
            refuse(res, 500, attempt.reason);
            return;
          }
          exhausted = true;
          break;
        }
        if (upstreamRes) await upstreamRes.body?.cancel().catch(() => {});
        upstreamRes = attempt.res;
        accountId = candidate;
        if (!rejectedByLimit(upstreamRes) || !resendable) break;
        const next = this.choose(projectId, tried);
        if (!next) {
          exhausted = true;
          break;
        }
        candidate = next.accountId;
      }
    } finally {
      this.bufferedBytes -= held;
    }
    if (!upstreamRes) throw new Error("unreachable: 上流の返事が無い");
    const at = this.now().toISOString();
    const table = caller.kind === "runner" ? this.runnerStats : this.stats;
    const s = table.get(projectId) ?? { requests: 0 };
    s.requests++;
    s.lastRequestAt = at;
    if (upstreamRes.status === 401) s.lastUnauthorizedAt = at;
    table.set(projectId, s);
    if (!rejectedByLimit(upstreamRes)) {
      // Thread の印は本体用の合言葉で来たときだけ読む（コンテナから来たものは無視する）
      const threadHeader = caller.kind === "runner" ? req.headers[THREAD_ID_HEADER] : undefined;
      this.noteServed(projectId, accountId, order, typeof threadHeader === "string" && threadHeader ? threadHeader : undefined);
    }
    const headers: Record<string, string> = {};
    // fetch は圧縮を解いて渡すので、長さと符号化の見出しは付け直さない
    upstreamRes.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
    });
    // **並びの全部が断ったら、上流の 429 を見出しごと返し、試し直さない旗も付ける**（見出しの無い 429 で CLI の試し直しの
    // たびに並びの全部へ送り直して、要求が倍々になるのを防ぐ）。本文を持てず送り直さなかったときは付けない
    if (exhausted && upstreamRes.status === 429) headers["x-should-retry"] = "false";
    res.writeHead(upstreamRes.status, headers);
    if (upstreamRes.body) Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream).pipe(res);
    else res.end();
  }

  /**
   * **そのアカウントで1回送る**：切れかけていれば取り直し、401 なら置き場を読み直して（替わっていなければ取り直して）
   * 1回だけ送り直す。使用率を覚え、人が直すことが残ればそのアカウントのカードを出し、通ればそのアカウントのカードを
   * 閉じる。トークンも無い（ログインしていない）なら送らずに理由を返す
   */
  private async sendAs(
    accountId: string,
    projectId: string,
    send: (bearer: string) => Promise<Response>,
    resendable: boolean,
  ): Promise<{ kind: "response"; res: Response } | { kind: "refused"; reason: string }> {
    const refresher = this.refresherFor(accountId);
    // 切れかけていれば取り直す（§2「中継も、切れかけたら取り直す」）。トークンも無い＝ログインしていない——理由を返す
    const first = await refresher.ensureFresh();
    if (first.kind === "failed" && !first.accessToken) return { kind: "refused", reason: first.reason };
    let token = first.accessToken!;
    /** 流せても人が直すことが残った（例：取り直したのに書き戻せなかった） */
    let trouble = troubleOf(first);
    let upstreamRes = await send(token);
    // 401：置き場を読み直し（替わっていなければ線を見ずに取り直して）、1回だけ送り直す
    if (upstreamRes.status === 401 && resendable) {
      const second = await refresher.ensureFresh({ force: true, seenAccessToken: token });
      if (second.accessToken && second.accessToken !== token) {
        await upstreamRes.body?.cancel().catch(() => {});
        token = second.accessToken;
        upstreamRes = await send(token);
        trouble = troubleOf(second) ?? trouble;
        if (upstreamRes.status === 401) trouble ??= { reason: "取り直したトークンでも断られました（401）", closeWhen: "authorized" };
      } else if (second.kind === "failed" && second.needsHuman) {
        trouble = troubleOf(second);
      } else if (second.kind === "failed") {
        // 一時的（取り直しの口に届かない・鍵の取り合い）：知らせず、次の要求でまた試す
        console.warn(`[claude-login] 401 のあと取り直せませんでした（一時的）: ${second.reason}`);
      }
    } else if (upstreamRes.status === 401) {
      console.warn("[claude-login] 上流が 401 を返しました（本文が大きく、試し直しませんでした）");
    }
    // 使用率はアカウントごとに覚える（見出しの無い返事では変えない）
    this.deps.accounts.recordUsage(accountId, upstreamRes.headers);
    if (trouble) {
      this.openTrouble.set(accountId, {
        closeWhen: trouble.closeWhen,
        ...(trouble.closeWhen === "refresh-token-changed" ? { refreshToken: await refresher.currentRefreshToken() } : {}),
      });
      this.deps.onUpstreamUnauthorized?.(projectId, trouble.reason, accountId);
    } else if (upstreamRes.ok) {
      // 閉じるのはそのアカウントのカードだけ。ログインが壊れた知らせは、置き場の refresh token が替わるまで閉じない
      // （手元の access token でたまたま通っただけ）
      const open = this.openTrouble.has(accountId) ? this.openTrouble.get(accountId) : { closeWhen: "authorized" as const };
      if (open && (open.closeWhen === "authorized" || (await refresher.currentRefreshToken()) !== open.refreshToken)) {
        this.openTrouble.set(accountId, undefined);
        this.deps.onUpstreamAuthorized?.(accountId);
      }
    }
    return { kind: "response", res: upstreamRes };
  }

  /** **返事を返したアカウントを覚え、替わっていたら切り替えを知らせる**（起こしてから最初の1回は比べる相手が無い） */
  private noteServed(projectId: string, accountId: string, order: readonly string[], threadId: string | undefined): void {
    const prev = this.current.get(projectId);
    this.current.set(projectId, accountId);
    if (prev === undefined || prev === accountId) return;
    const blocked = blockedBy(this.deps.accounts.usageOf(prev), this.deps.accounts.thresholds(), this.now());
    const reason: ClaudeAccountSwitchReason =
      blocked ??
      (!order.includes(prev)
        ? { kind: "order" }
        : order.indexOf(accountId) < order.indexOf(prev)
          ? { kind: "recovered" }
          : { kind: "unavailable" });
    this.deps.onAccountSwitched?.({ projectId, ...(threadId ? { threadId } : {}), from: prev, to: accountId, reason });
  }

  /**
   * **全部越えのカード**（§2 の 6.）：並びの全部が閾値を越えたら1枚出し（同じ並びで開いている間は出さない）、どれかが
   * 下に戻ったら閉じる。要求が来なくても戻ったら閉じられるよう、一番早いリセットの少しあとに見直す
   */
  private noteAllOver(projectId: string, order: readonly string[], allOver: boolean, using: string): void {
    const key = order.join(",");
    const open = this.allOverOpen.get(key);
    if (allOver) {
      if (open === true) return;
      this.allOverOpen.set(key, true);
      this.deps.onAllOverThreshold?.({ key, projectId, order: [...order], using });
      this.scheduleRecoveryCheck(projectId, order);
    } else if (open !== false) {
      this.allOverOpen.set(key, false);
      const timer = this.recoveryTimers.get(key);
      if (timer) clearTimeout(timer);
      this.recoveryTimers.delete(key);
      this.deps.onBackUnderThreshold?.(key);
    }
  }

  private scheduleRecoveryCheck(projectId: string, order: readonly string[]): void {
    const key = order.join(",");
    const store = this.deps.accounts;
    const at = earliestRecovery(order, (id) => store.usageOf(id), store.thresholds(), this.now());
    const old = this.recoveryTimers.get(key);
    if (old) clearTimeout(old);
    this.recoveryTimers.delete(key);
    // いつ戻るか分からない：次の要求で見直す
    if (at === undefined) return;
    const timer = setTimeout(
      () => {
        this.recoveryTimers.delete(key);
        if (this.allOverOpen.get(key) !== true) return;
        const choice = chooseAccount(order, (id) => store.usageOf(id), store.thresholds(), this.now());
        if (choice && !choice.allOver) this.noteAllOver(projectId, order, false, choice.accountId);
        else this.scheduleRecoveryCheck(projectId, order);
      },
      // setTimeout の上限（約 24.8 日）を超えないように。週の窓でも足りる
      Math.min(Math.max(0, at - this.now().getTime()) + RECOVERY_CHECK_DELAY_MS, 2 ** 31 - 1),
    );
    timer.unref();
    this.recoveryTimers.set(key, timer);
  }

  /** 合言葉から、どの Project の・どちらの表のものかを引く */
  private callerOf(authorization: string | undefined): { projectId: string; kind: ClaudeLoginSecretKind } | undefined {
    const m = /^Bearer (.+)$/.exec(authorization ?? "");
    if (!m) return undefined;
    for (const [projectId, secret] of this.secrets) if (secret === m[1]) return { projectId, kind: "container" };
    for (const [projectId, secret] of this.runnerSecrets) if (secret === m[1]) return { projectId, kind: "runner" };
    return undefined;
  }

  private save(): void {
    // 書きかけを読ませない（別名に書いて置き換える）。値は記録（Event Store）には残さない
    const tmp = `${this.deps.secretsPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.secrets)), { mode: 0o600 });
    renameSync(tmp, this.deps.secretsPath);
  }
}

function loadSecrets(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  // 壊れていたら止まる（規則2）——黙って空にすると、動いている Service の合言葉が全部替わる
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Object.values(parsed).some((v) => typeof v !== "string")) {
    throw new Error(`Claude のログインの中継の合言葉の置き場が壊れています：${path}`);
  }
  return parsed as Record<string, string>;
}

/** IPv4 を IPv6 の形で受けた待ち受け（`::ffff:10.0.0.2`）でも、コンテナのアドレスと比べられる形に */
function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/** 上流が上限で断った（429 で、全体の status が rejected） */
function rejectedByLimit(res: Response): boolean {
  return res.status === 429 && res.headers.get(RATELIMIT_STATUS_HEADER) === "rejected";
}

/** 人が直すことが残った取り直しの結果ならその理由と閉じ方（一時的な失敗は数えない） */
function troubleOf(outcome: RefreshOutcome): { reason: string; closeWhen: CloseWhen } | undefined {
  return outcome.kind === "failed" && outcome.needsHuman ? { reason: outcome.reason, closeWhen: outcome.closeWhen ?? "authorized" } : undefined;
}

/**
 * 本文を上限まで読み切る。収まれば `buffered`、超えたら読んだ分と残りをつないだ `stream`（試し直せない）
 */
async function readBodyUpTo(req: IncomingMessage, limit: number): Promise<{ buffered: Buffer; stream?: undefined } | { buffered: undefined; stream: Readable }> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return { buffered: Buffer.concat(chunks) };
    chunks.push(next.value);
    size += next.value.length;
    if (size > limit) {
      const rest = async function* () {
        yield* chunks;
        for (;;) {
          const more = await iterator.next();
          if (more.done) return;
          yield more.value;
        }
      };
      return { buffered: undefined, stream: Readable.from(rest()) };
    }
  }
}

function refuse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
}

function forwardedHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
