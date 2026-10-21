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
import { Readable, Transform, type TransformCallback } from "node:stream";
import { CredentialRefresher, type CloseWhen, type RefreshOutcome } from "./refresh.js";
import { freshUsage, HOST_ACCOUNT_ID, usageFromUsageApi, type AccountUsage, type ClaudeAccountStore } from "./accounts.js";
import { CacheKeepAlive, usageFromJson, type CacheUsage, type MarginCheck, type WarmOutcome, type WarmRequest } from "./keep-alive.js";
import { blockedBy, chooseAccount, chooseBalanced, earliestRecovery, type Blocked, type Choice } from "./select.js";

const UPSTREAM = "https://api.anthropic.com";
/** アカウントの使用率を読む口（§2 の 7.。#397 で scope `user:inference user:profile` で通るのを確かめた） */
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_READ_TIMEOUT_MS = 15_000;
/**
 * **固定の寿命**（§2「均す」の 2.）：最後の要求から1時間（プロンプトのキャッシュの寿命。上流の寿命は最後にキャッシュを
 * 触った時刻から数えるので、中継が上流へ送った時刻を基準にする）
 */
const PIN_TTL_MS = 60 * 60_000;
/** 均すときに選ぶ前に読み直すのは、台帳の使用率がこれより古いアカウントだけ。試みた時刻からこの間は試み直さない（§2「均す」の 6.） */
const USAGE_STALE_MS = 30 * 60_000;
/** 選ぶ側が読み直しを待つのはここまで。過ぎたら手元の値で選び、読み直しは裏で続ける */
const USAGE_WAIT_MS = 3_000;
/** セッションの印（会話の本体・`claude -p`・claude-agent-acp が要求ごとに付ける。§2「均す」の実測）。上流へもそのまま流す */
export const SESSION_ID_HEADER = "x-claude-code-session-id";
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
/** 推論の要求（温め直しの候補になるもの。`count_tokens` は除く） */
const MESSAGES_PATH = /^\/v1\/messages(\?|$)/;
/** 温め直しは固定のアカウントの使用率が閾値よりこれだけ下のときだけ（温め直しで閾値を越えさせない、§3.1「上限」の (a)） */
const KEEP_ALIVE_MARGIN = 0.15;
/** 率の引き算の丸めの誤差（0.95 - 0.15 は 0.8 より小さくなる） */
const RATE_EPSILON = 1e-9;
/** 温め直し1回の待ちの上限 */
const KEEP_ALIVE_TIMEOUT_MS = 120_000;
/** 応答の usage を読むために見る量の上限（stream の `message_start` は頭に来る。stream でない応答は全体） */
const USAGE_SNIFF_LIMIT = 4 * 1024 * 1024;
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
  /** 並びの全部が閾値を越えていて、一番早くリセットされる `to` で続けている（会話の1行を warn の形にする） */
  allOver?: true;
}

/**
 * **固定の表の1行**（§2「均す」の 2.）。鍵は Project＋セッション。`movedFrom` は、同じ鍵で固定先を移したがまだその
 * アカウントが返事をしていない（切り替えの記録は、移った先が返事をしたときに1件——上限で断られた返事は数えない）
 */
interface Pin {
  projectId: string;
  accountId: string;
  /** 最後に上流へ送った時刻（ミリ秒）。ここから1時間で切れる */
  lastAt: number;
  /** 選んでから、まだ上流の返事が来ていない（使用率に映っていない——選ぶときに重みを足す） */
  awaiting: boolean;
  /** その鍵の要求を出した Thread（本体の要求なら分かる。右上のメーターの口が引く） */
  threadId?: string;
  movedFrom?: { from: string; reason: ClaudeAccountSwitchReason };
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
  /** 使用率を読む口（試験・E2E で差し替える。既定は本番の `/api/oauth/usage`） */
  usageUrl?: string;
  /** 均すときに選ぶ側が読み直しを待つ上限（試験だけが縮める。既定は3秒） */
  usageWaitMs?: number;
  /** 中継が取り直すか（既定はする。切れば今までどおり読むだけ） */
  refreshEnabled?: boolean;
  /**
   * **空いた会話の温め直しを送る前に、まだ温めてよいか**（host が持つ。§3.1「止める」）。ターンが走っていない・閉じていない・
   * 眠っていない・スイッチがオン・モデル／effort／Module の集合／resume-point が覚えたときと同じ。渡されなければ確かめない
   */
  keepAliveWarmable?(threadId: string, fingerprint: string): boolean;
  /** 温め直しの時刻の1分（E2E だけが縮める） */
  keepAliveMinuteMs?: number;
  /** その会話の温め直しの様子が変わった（#473 冷める前の要約の予定と画面） */
  keepAliveOnChange?(threadId: string): void;
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
  /** 最後に全部の使用率を読み直した時刻 */
  private usageReadAt: string | undefined;
  /** **固定の表**（均すとき、§2「均す」の 2.）。鍵は `pinKey`。メモリだけ（起こし直したら全部選び直す） */
  private readonly pins = new Map<string, Pin>();
  /** アカウントごとの、使用率の読み直しを試みた時刻（成否によらない——読めないものを選ぶたびに読みに行かない） */
  private readonly usageAttemptAt = new Map<string, number>();
  /** アカウントごとの、走っている読み直し（同時に来た選びは同じものを待つ） */
  private readonly usageReads = new Map<string, Promise<void>>();

  /**
   * **空いた会話の温め直し**（§3.1「温め直し（中継）」）。本体の要求の usage を見て候補を覚え、host がターンの始まり・終わりを
   * 知らせる（`turnStarted`・`turnEnded`）
   */
  readonly keepAlive: CacheKeepAlive;

  constructor(private readonly deps: ClaudeLoginRelayDeps) {
    this.upstream = deps.upstream ?? UPSTREAM;
    this.now = deps.now ?? (() => new Date());
    this.secrets = new Map(Object.entries(loadSecrets(deps.secretsPath)));
    this.keepAlive = new CacheKeepAlive({
      send: (req) => this.sendWarm(req),
      margin: (accountId) => this.warmMargin(accountId),
      ...(deps.keepAliveWarmable ? { stillWarmable: (threadId, fp) => deps.keepAliveWarmable!(threadId, fp) } : {}),
      now: () => this.now().getTime(),
      ...(deps.keepAliveMinuteMs !== undefined ? { minuteMs: deps.keepAliveMinuteMs } : {}),
      ...(deps.keepAliveOnChange ? { onChange: (threadId) => deps.keepAliveOnChange!(threadId) } : {}),
    });
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
   *
   * `threadId` が無いのは Thread に属さない1回の呼び出し（小さいモデルで題を作る、`runner/one-shot.ts`）。Thread の印を付けない
   * ——中継は温め直しの候補（§3.1）に数えない
   */
  async runnerEnvFor(
    projectId: string,
    threadId: string | undefined,
    session: RunnerSession,
    baseUrl: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Record<string, string | undefined>> {
    if (this.deps.refreshEnabled === false) return { ...env, ...NONESSENTIAL_TRAFFIC_ENV };
    let secret = this.runnerSecrets.get(projectId);
    if (!secret) {
      secret = `banto-runner-${randomBytes(32).toString("base64url")}`;
      this.runnerSecrets.set(projectId, secret);
    }
    const base = { ...env };
    for (const name of UPSTREAM_ENV) delete base[name];
    // **均すときは、ターンの始めにそのセッションを固定する**（§2「均す」の 3.）。契約の種類はその固定先のもの
    // ——`accountFor(projectId)`（上から順に）は均すでは固定先と食い違う
    const accountId =
      this.deps.accounts.modeFor(projectId) === "balance"
        ? (await this.pinFor(projectId, pinKey(projectId, session.sessionId), threadId, session.inheritFrom !== undefined ? pinKey(projectId, session.inheritFrom) : undefined))
            ?.accountId
        : this.accountFor(projectId);
    return {
      ...base,
      ANTHROPIC_BASE_URL: `${baseUrl}${CLAUDE_LOGIN_PATH}`,
      CLAUDE_CODE_OAUTH_TOKEN: secret,
      ...(await this.accountEnvOf(accountId)),
      ...NONESSENTIAL_TRAFFIC_ENV,
      ...(threadId !== undefined ? { ANTHROPIC_CUSTOM_HEADERS: `${THREAD_ID_HEADER}: ${threadId}` } : {}),
    };
  }

  /**
   * 契約の種類（秘密ではない）。コンテナの環境はいまその Project で上から順に選ばれるもの（起こすときに決まる——
   * 中のセッションごとの固定はまだ無い）。ログインしていなければ入れない（中継に来たときに理由を返す）
   */
  private accountEnv(projectId: string): Promise<Record<string, string>> {
    return this.accountEnvOf(this.accountFor(projectId));
  }

  private async accountEnvOf(accountId: string | undefined): Promise<Record<string, string>> {
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

  /**
   * **その Project の並びの Claude のアカウントが全部閾値を越えているか**（追加・2026-10-20、アーキ仕様 §4.4「見回り」——見回りの回を
   * 飛ばすのに使う）。並びが空（banto がアカウントを持っていない）なら false
   */
  allAccountsOver(projectId: string): boolean {
    return this.choose(projectId)?.allOver === true;
  }

  /**
   * その Project が最後に使ったアカウント（上から順にの Project 設定の観測。起こしてから1度も使っていなければ undefined）。
   * 均すの Project では持たない（隣の Thread のものが出る——`pinnedAccountsOf` を使う）
   */
  currentAccountOf(projectId: string): string | undefined {
    return this.deps.accounts.modeFor(projectId) === "ordered" ? this.current.get(projectId) : undefined;
  }

  /** **均すの Project の、生きている固定先**（直近1時間に使ったアカウント。並びの順、重ねない） */
  pinnedAccountsOf(projectId: string): string[] {
    const used = new Set<string>();
    for (const [key, pin] of this.pins) if (pin.projectId === projectId && this.livePin(key)) used.add(pin.accountId);
    const order = this.deps.accounts.orderFor(projectId);
    return [...used].sort((a, b) => rank(order, a) - rank(order, b));
  }

  /**
   * **いま各 Project が使っているアカウント**（設定の「いま使っている Project」、§2「均す」の 9.）。上から順にの Project は
   * 最後に返事をしたもの、均すの Project は生きている固定先の全部（1つの Project が複数のアカウントの下に出てよい）
   */
  currentAccounts(): Array<{ projectId: string; accountId: string }> {
    const out: Array<{ projectId: string; accountId: string }> = [];
    for (const [projectId, accountId] of this.current) {
      if (this.deps.accounts.modeFor(projectId) === "ordered") out.push({ projectId, accountId });
    }
    const balanced = new Set<string>();
    for (const pin of this.pins.values()) balanced.add(pin.projectId);
    for (const projectId of balanced) {
      if (this.deps.accounts.modeFor(projectId) !== "balance") continue;
      for (const accountId of this.pinnedAccountsOf(projectId)) out.push({ projectId, accountId });
    }
    return out;
  }

  /**
   * **その Thread の生きている固定先**（右上のメーター、`GET /api/threads/:id/claude-account`。§2「均す」の 9.）。
   * 無ければ undefined。同じ Thread に鍵が複数あれば（Clear のあと等）最後に送ったもの
   */
  pinnedAccountOfThread(threadId: string): string | undefined {
    let best: Pin | undefined;
    for (const [key, pin] of this.pins) {
      if (pin.threadId !== threadId || !this.livePin(key)) continue;
      if (!best || pin.lastAt >= best.lastAt) best = pin;
    }
    return best?.accountId;
  }

  /**
   * **全部のアカウントの使用率を読み直す**（§2 の 7.——使っていないアカウントも、設定を開いたときに）。中継は通さず core が
   * 直に、そのアカウントのトークンで `/api/oauth/usage` を呼び、台帳に覚える。読めなかったものは理由を返す（黙って
   * 前の値のままにしない）。ログインし直しが要るかどうかは中継の道（取り直し役）に任せ、ここではカードを出さない
   */
  async readUsage(): Promise<{ readAt: string; failures: Array<{ accountId: string; reason: string }> }> {
    const store = this.deps.accounts;
    const failures: Array<{ accountId: string; reason: string }> = [];
    await Promise.all(
      store.list().map(async ({ id }) => {
        try {
          await this.readUsageOf(id);
        } catch (err) {
          failures.push({ accountId: id, reason: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    this.usageReadAt = this.now().toISOString();
    return { readAt: this.usageReadAt, failures };
  }

  /** 1つのアカウントの使用率を `/api/oauth/usage` で読み、台帳に覚える。読めなければ投げる */
  private async readUsageOf(id: string): Promise<void> {
    this.usageAttemptAt.set(id, this.now().getTime());
    const outcome = await this.refresherFor(id).ensureFresh();
    const token = outcome.accessToken;
    if (!token) throw new Error(outcome.kind === "failed" ? outcome.reason : "トークンがありません");
    const res = await fetch(this.deps.usageUrl ?? CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(USAGE_READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`使用率の口が ${res.status} を返しました`);
    this.deps.accounts.recordUsageRead(id, usageFromUsageApi(await res.json()));
  }

  /**
   * **選ぶ前に、古い使用率だけを読み直す**（§2「均す」の 6.——`host` のアカウントは人の `claude` も使い、その分は中継を
   * 通らない）。候補のうち台帳の使用率が30分より古い（一度も読んでいない）ものだけ。試みた時刻から30分は試み直さない。
   * 待つのは3秒まで（過ぎたら手元の値で選び、読み直しは裏で続けて台帳に書く）。同時に来た選びは同じ読み直しを待つ。
   * 読めなくても選択は止めない。候補が1つなら選ぶ余地が無いので読まない
   */
  private async refreshStaleUsage(candidates: readonly string[]): Promise<void> {
    if (candidates.length < 2) return;
    const now = this.now().getTime();
    const waits: Promise<void>[] = [];
    for (const id of candidates) {
      const running = this.usageReads.get(id);
      if (running) {
        waits.push(running);
        continue;
      }
      const readAt = this.deps.accounts.usageOf(id)?.readAt;
      if (readAt !== undefined && now - Date.parse(readAt) < USAGE_STALE_MS) continue;
      const tried = this.usageAttemptAt.get(id);
      if (tried !== undefined && now - tried < USAGE_STALE_MS) continue;
      const read = this.readUsageOf(id)
        .catch((err: unknown) => console.warn(`[claude-login] ${id} の使用率を読み直せませんでした（手元の値で選びます）: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.usageReads.delete(id));
      this.usageReads.set(id, read);
      waits.push(read);
    }
    if (waits.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(waits),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.usageWaitMs ?? USAGE_WAIT_MS);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  /** 生きている固定（寿命の切れたものは捨てて undefined） */
  private livePin(key: string): Pin | undefined {
    const pin = this.pins.get(key);
    if (!pin) return undefined;
    if (this.now().getTime() - pin.lastAt >= PIN_TTL_MS) {
      this.pins.delete(key);
      return undefined;
    }
    return pin;
  }

  /** 固定先から離れる理由：閾値越え・上限で断った（`Blocked`）、並びに無い（`order`）、どれでもなければ使えなかった */
  private leaveReason(accountId: string, order: readonly string[]): ClaudeAccountSwitchReason {
    if (!order.includes(accountId)) return { kind: "order" };
    return blockedBy(this.deps.accounts.usageOf(accountId), this.deps.accounts.thresholds(), this.now()) ?? { kind: "unavailable" };
  }

  /** 固定先がいま使えないなら、その理由（使えるなら undefined）。ログインが壊れているかは送るまで分からない */
  private pinProblem(pin: Pin, order: readonly string[]): ClaudeAccountSwitchReason | undefined {
    if (!order.includes(pin.accountId)) return { kind: "order" };
    return blockedBy(this.deps.accounts.usageOf(pin.accountId), this.deps.accounts.thresholds(), this.now());
  }

  /** 均すときの選び（まだ返事の来ていない固定の数を重みにする） */
  private chooseBalanced(order: readonly string[], skip?: ReadonlySet<string>): Choice | undefined {
    const store = this.deps.accounts;
    const pending = new Map<string, number>();
    for (const [key, pin] of this.pins) if (pin.awaiting && this.livePin(key)) pending.set(pin.accountId, (pending.get(pin.accountId) ?? 0) + 1);
    return chooseBalanced(order, (id) => store.usageOf(id), store.thresholds(), this.now(), (id) => pending.get(id) ?? 0, skip);
  }

  /**
   * **固定先を移す・作る**。前の固定があれば（同じ鍵で先が変わった）切り替えの記録の種を持たせる——記録するのは移った先が
   * 返事をしたとき。最初の選び・寿命切れのあとの選び直しは記録しない（前が無い）
   */
  private setPin(key: string, projectId: string, accountId: string, prev: Pin | undefined, reason?: ClaudeAccountSwitchReason, threadId?: string): Pin {
    const order = this.deps.accounts.orderFor(projectId);
    const from = prev?.movedFrom?.from ?? prev?.accountId;
    const movedFrom =
      prev && from !== undefined && from !== accountId
        ? { from, reason: prev.movedFrom?.reason ?? reason ?? this.leaveReason(prev.accountId, order) }
        : undefined;
    const pin: Pin = {
      projectId,
      accountId,
      lastAt: this.now().getTime(),
      awaiting: prev?.accountId === accountId ? prev.awaiting : true,
      ...((threadId ?? prev?.threadId) ? { threadId: threadId ?? prev?.threadId } : {}),
      ...(movedFrom ? { movedFrom } : {}),
    };
    this.pins.set(key, pin);
    return pin;
  }

  /**
   * **その鍵の固定先**（均すとき、§2「均す」の 2.〜5.）：生きていて使える固定があればそれ。無ければ（最初・寿命切れ）
   * 継ぐ元（Fork の親）の生きていて使える固定を継ぎ、それも無ければ選ぶ。固定先が閾値を越えた・上限で断られた・並びに
   * 無いときも選び直す。**選んだらすぐ表に入れる**（同じセッションの要求が2つ同時に来ても別々に選ばない——読み直しの
   * `await` のあとで表を見直す）
   */
  private async pinFor(projectId: string, key: string, threadId: string | undefined, inheritKey?: string): Promise<(Choice & { pin: Pin }) | undefined> {
    const order = this.deps.accounts.orderFor(projectId);
    const reuse = (): (Choice & { pin: Pin }) | undefined => {
      const own = this.livePin(key);
      if (own) {
        if (this.pinProblem(own, order)) return undefined;
        if (threadId) own.threadId = threadId;
        return { accountId: own.accountId, allOver: false, pin: own };
      }
      const parent = inheritKey !== undefined ? this.livePin(inheritKey) : undefined;
      if (parent && !this.pinProblem(parent, order)) {
        const pin = this.setPin(key, projectId, parent.accountId, undefined, undefined, threadId);
        pin.awaiting = parent.awaiting;
        return { accountId: pin.accountId, allOver: false, pin };
      }
      return undefined;
    };
    const quick = reuse();
    if (quick) return quick;
    await this.refreshStaleUsage(order);
    const again = reuse();
    if (again) return again;
    const prev = this.livePin(key);
    const choice = this.chooseBalanced(order);
    if (!choice) return undefined;
    // 全部越えで、固定先が一番早く戻るものなら、そのまま（移らない）
    if (prev && prev.accountId === choice.accountId) {
      if (threadId) prev.threadId = threadId;
      return { ...choice, pin: prev };
    }
    return { ...choice, pin: this.setPin(key, projectId, choice.accountId, prev, prev ? this.pinProblem(prev, order) : undefined, threadId) };
  }

  /** 最後に全部を読み直した時刻（起こしてから。設定の「n分前に読みました」） */
  lastUsageReadAt(): string | undefined {
    return this.usageReadAt;
  }

  /** 止めるとき：全部越えのカードを閉じに行く時計を止める */
  close(): void {
    for (const t of this.recoveryTimers.values()) clearTimeout(t);
    this.recoveryTimers.clear();
    this.keepAlive.close();
  }

  /**
   * **温め直しを1回送る**（§3.1「送り直さない」）。覚えたアカウントへだけ、取り直しが要れば取り直して1回。429・401・5xx・
   * 通信の失敗のどれでも送り直さず、固定を移さず、切り替えの記録の種にもしない。使用率は台帳に覚える（次の選びが古い値に
   * ならないように）。通ったら固定の寿命を延ばす（「上流へ送った」に数える）
   */
  private async sendWarm(req: WarmRequest): Promise<WarmOutcome> {
    const fresh = await this.refresherFor(req.accountId).ensureFresh();
    if (!fresh.accessToken) return { kind: "failed", reason: fresh.kind === "failed" ? fresh.reason : "トークンがありません" };
    let res: Response;
    try {
      res = await fetch(`${this.upstream}${req.path}`, {
        method: "POST",
        // 長さは fetch が本文から付け直す。Thread の印は覚えた見出しに入っていない（上流へ付けない）
        headers: { ...req.headers, authorization: `Bearer ${fresh.accessToken}` },
        body: req.body,
        signal: AbortSignal.timeout(KEEP_ALIVE_TIMEOUT_MS),
      } as RequestInit);
    } catch (err) {
      return { kind: "failed", reason: `上流に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
    }
    this.deps.accounts.recordUsage(req.accountId, res.headers);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: "failed", reason: `上流が ${res.status} を返しました` };
    }
    let usage: CacheUsage | undefined;
    try {
      usage = usageFromJson(((await res.json()) as { usage?: unknown }).usage);
    } catch {
      usage = undefined;
    }
    if (!usage) return { kind: "failed", reason: "応答の usage が読めません" };
    const pin = this.livePin(req.key);
    if (pin && pin.accountId === req.accountId) pin.lastAt = this.now().getTime();
    return { kind: "ok", usage, utilization: utilizationText(this.deps.accounts.usageOf(req.accountId), this.now()) };
  }

  /**
   * **余白**（§3.1「上限」の (a)）：固定のアカウントの5時間・週の使用率が、それぞれの閾値より 15 ポイント以上下で、上限で
   * 断られていない。分からない窓（読んでいない・リセットを過ぎた）は余白がある扱い（`select.ts` と同じ——使えば見出しで分かる）
   */
  private warmMargin(accountId: string): MarginCheck {
    const u = this.deps.accounts.usageOf(accountId);
    const fresh = u ? freshUsage(u, this.now()) : undefined;
    const th = this.deps.accounts.thresholds();
    if (fresh?.status === "rejected") return { ok: false, reason: "上限で断られています" };
    if (fresh?.fiveHour && fresh.fiveHour.utilization > th.fiveHour - KEEP_ALIVE_MARGIN + RATE_EPSILON) {
      return { ok: false, reason: `5時間 ${Math.round(fresh.fiveHour.utilization * 100)}%` };
    }
    if (fresh?.sevenDay && fresh.sevenDay.utilization > th.sevenDay - KEEP_ALIVE_MARGIN + RATE_EPSILON) {
      return { ok: false, reason: `週 ${Math.round(fresh.sevenDay.utilization * 100)}%` };
    }
    return { ok: true };
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

  /** **アカウントを外した**：その取り直し役と開いている知らせ・そのアカウントの固定を全部忘れる（同じ id が戻ることは無い） */
  forgetAccount(accountId: string): void {
    this.refreshers.delete(accountId);
    this.openTrouble.delete(accountId);
    this.usageAttemptAt.delete(accountId);
    for (const [key, pin] of this.pins) if (pin.accountId === accountId) this.pins.delete(key);
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
    // Thread の印は本体用の合言葉で来たときだけ読む（コンテナから来たものは無視する）
    const threadHeader = caller.kind === "runner" ? req.headers[THREAD_ID_HEADER] : undefined;
    const threadId = typeof threadHeader === "string" && threadHeader ? threadHeader : undefined;
    // **均すときは固定の表を引く**（§2「均す」の 2.・3.）。鍵は Project＋セッションの印（無ければ Project ごとに1つ）
    const balance = this.deps.accounts.modeFor(projectId) === "balance";
    const sessionHeader = req.headers[SESSION_ID_HEADER];
    const key = pinKey(projectId, typeof sessionHeader === "string" && sessionHeader ? sessionHeader : undefined);
    /** この要求の前の固定（全部に断られたら戻す——固定は動かさない） */
    const pinBefore = balance ? this.livePin(key) : undefined;
    const pinSnapshot = pinBefore ? { ...pinBefore } : undefined;
    const pinned = balance ? await this.pinFor(projectId, key, threadId) : undefined;
    // 上から順にの「最後に返事をしたアカウント」は均すでは持たない（使い方を戻したとき、古い値と比べて切り替えにしない）
    if (balance) this.current.delete(projectId);
    const first = balance ? pinned : this.choose(projectId);
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
    // 上流へ送る時刻が、固定の寿命の基準
    const startedAt = this.now().getTime();
    if (pinned) pinned.pin.lastAt = startedAt;
    /** 送り直しの次の候補：使い方に従う（均すなら残りから余裕の比の小さい順） */
    const nextCandidate = (tried: ReadonlySet<string>) => (balance ? this.chooseBalanced(order, tried) : this.choose(projectId, tried));
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
    /** 返事をしたアカウントを選んだとき、並びの全部が閾値を越えていたか */
    let allOver = first.allOver;
    let candidateAllOver = first.allOver;
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
          const next = resendable ? nextCandidate(tried) : undefined;
          if (next) {
            candidate = next.accountId;
            candidateAllOver = next.allOver;
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
        allOver = candidateAllOver;
        if (!rejectedByLimit(upstreamRes) || !resendable) break;
        const next = nextCandidate(tried);
        if (!next) {
          exhausted = true;
          break;
        }
        candidate = next.accountId;
        candidateAllOver = next.allOver;
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
    if (pinned) this.notePinServed(key, pinned.pin, pinSnapshot, accountId, order, threadId, allOver, rejectedByLimit(upstreamRes));
    else if (!rejectedByLimit(upstreamRes)) this.noteServed(projectId, accountId, order, threadId, allOver);
    const headers: Record<string, string> = {};
    // fetch は圧縮を解いて渡すので、長さと符号化の見出しは付け直さない
    upstreamRes.headers.forEach((v, k) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) headers[k] = v;
    });
    // **並びの全部が断ったら、上流の 429 を見出しごと返し、試し直さない旗も付ける**（見出しの無い 429 で CLI の試し直しの
    // たびに並びの全部へ送り直して、要求が倍々になるのを防ぐ）。本文を持てず送り直さなかったときは付けない
    if (exhausted && upstreamRes.status === 429) headers["x-should-retry"] = "false";
    res.writeHead(upstreamRes.status, headers);
    // **本体の推論の要求は、温め直しのために usage を読む**（§3.1「覚えるもの」）。Thread の分かる要求だけ
    const observe =
      caller.kind === "runner" && threadId && MESSAGES_PATH.test(path)
        ? (usage: CacheUsage | undefined) =>
            this.keepAlive.observe({
              projectId,
              threadId,
              key,
              sessionId: typeof sessionHeader === "string" && sessionHeader ? sessionHeader : undefined,
              path,
              accountId,
              startedAt,
              ...(usage ? { usage } : {}),
              ...(body.buffered !== undefined ? { body: body.buffered, headers: forwardedHeaders(req) } : {}),
            })
        : undefined;
    if (observe && (!upstreamRes.ok || !upstreamRes.body)) observe(undefined);
    if (upstreamRes.body) {
      const piped = Readable.fromWeb(upstreamRes.body as import("node:stream/web").ReadableStream);
      if (observe && upstreamRes.ok) piped.pipe(new UsageTap((upstreamRes.headers.get("content-type") ?? "").includes("text/event-stream"), observe)).pipe(res);
      else piped.pipe(res);
    } else res.end();
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

  /**
   * **均すときの返事のあと**（§2「均す」の 7.・8.）：送り直して通ったら、その要求の固定をそのアカウントへ移す。全部に
   * 断られたら固定は動かさない（この要求の前のものに戻す）。**同じ固定の鍵で固定先が変わり、移った先が返事をしたときだけ**
   * 切り替えを知らせる（上限で断られた返事は数えない。最初の選び・寿命切れのあとの選び直しは記録しない）
   */
  private notePinServed(
    key: string,
    pin: Pin,
    before: Pin | undefined,
    accountId: string,
    order: readonly string[],
    threadId: string | undefined,
    allOver: boolean,
    rejected: boolean,
  ): void {
    // その鍵の固定がこの要求の間に替わっていれば（外した・別の要求が移した）、そちらを正とする
    if (this.pins.get(key) !== pin) return;
    if (rejected) {
      if (before) this.pins.set(key, { ...before, lastAt: pin.lastAt, ...(pin.threadId ? { threadId: pin.threadId } : {}) });
      else pin.awaiting = false;
      return;
    }
    const current = pin.accountId === accountId ? pin : this.setPin(key, pin.projectId, accountId, pin, this.leaveReason(pin.accountId, order), threadId);
    current.awaiting = false;
    const moved = current.movedFrom;
    if (!moved) return;
    delete current.movedFrom;
    if (moved.from === accountId) return;
    this.deps.onAccountSwitched?.({
      projectId: current.projectId,
      ...(threadId ? { threadId } : {}),
      from: moved.from,
      to: accountId,
      reason: moved.reason,
      ...(allOver ? { allOver: true as const } : {}),
    });
  }

  /** **返事を返したアカウントを覚え、替わっていたら切り替えを知らせる**（起こしてから最初の1回は比べる相手が無い） */
  private noteServed(projectId: string, accountId: string, order: readonly string[], threadId: string | undefined, allOver: boolean): void {
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
    this.deps.onAccountSwitched?.({ projectId, ...(threadId ? { threadId } : {}), from: prev, to: accountId, reason, ...(allOver ? { allOver: true as const } : {}) });
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

/** 会話の本体のセッション（core が先に知っている id。Fork の最初のターンは親のセッションの固定を継ぐ） */
export interface RunnerSession {
  sessionId: string;
  /** Fork の最初のターン：継ぐ親のセッションの id */
  inheritFrom?: string;
}

/** 固定の表の鍵：Project＋セッション。印の無い要求は Project ごとに1つ */
function pinKey(projectId: string, sessionId: string | undefined): string {
  return `${projectId}\u0000${sessionId ?? ""}`;
}

/** 並びの中の位置（無ければ後ろ） */
function rank(order: readonly string[], id: string): number {
  const i = order.indexOf(id);
  return i === -1 ? order.length : i;
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

/** 台帳の使用率をログの1行に（率だけ。分からない窓は「?」） */
function utilizationText(usage: AccountUsage | undefined, now: Date): string {
  const fresh = usage ? freshUsage(usage, now) : undefined;
  const pct = (w: { utilization: number } | undefined) => (w ? `${Math.round(w.utilization * 100)}%` : "?");
  return `5h=${pct(fresh?.fiveHour)} 7d=${pct(fresh?.sevenDay)}`;
}

/**
 * **流しながら応答の usage を読む**（中身は変えずにそのまま通す）。stream なら最初の `message_start` の `message.usage`、
 * stream でなければ全体の `usage`。見る量には上限があり、読めなければ usage 無しで1回だけ知らせる
 */
class UsageTap extends Transform {
  private text = "";
  private done = false;

  constructor(
    private readonly sse: boolean,
    private readonly report: (usage: CacheUsage | undefined) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    if (!this.done) {
      this.text += chunk.toString("utf8");
      if (this.sse) this.scanEvents();
      if (!this.done && this.text.length > USAGE_SNIFF_LIMIT) this.finish(undefined);
    }
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback): void {
    if (!this.done) {
      if (this.sse) this.finish(undefined);
      else {
        let usage: CacheUsage | undefined;
        try {
          usage = usageFromJson((JSON.parse(this.text) as { usage?: unknown }).usage);
        } catch {
          usage = undefined;
        }
        this.finish(usage);
      }
    }
    cb();
  }

  /** 揃った行から `message_start` を探す（最初の出来事なので、見つからないまま別の出来事が来たら諦める） */
  private scanEvents(): void {
    for (;;) {
      const nl = this.text.indexOf("\n");
      if (nl === -1) return;
      const line = this.text.slice(0, nl).trim();
      this.text = this.text.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      let data: { type?: string; message?: { usage?: unknown } };
      try {
        data = JSON.parse(line.slice("data:".length)) as typeof data;
      } catch {
        continue;
      }
      if (data.type === "message_start") return this.finish(usageFromJson(data.message?.usage));
      if (data.type !== "ping") return this.finish(undefined);
    }
  }

  private finish(usage: CacheUsage | undefined): void {
    this.done = true;
    this.text = "";
    try {
      this.report(usage);
    } catch (err) {
      console.warn("[claude-login] 温め直しの候補を覚えられませんでした:", err);
    }
  }
}
