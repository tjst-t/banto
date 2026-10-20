// docs/specs/v4-architecture.md §2.5「Module 側がこの中継 tool にどう到達するか」
// の実装（決定・2026-09-03）。host が localhost限定のStreamable HTTP MCP
// エンドポイントを持ち、Moduleプロセスごとのbearer tokenで呼び出し元を識別する。
//
// Module（クライアント）が host（サーバ）のtool `relayCallTool`/
// `relayReadResource`/`relayGetPrompt` を呼ぶ——アーキ仕様§2.5の
// 「tools/call・resources/read・prompts/getそれぞれに対応する薄い転送
// インターフェース」の実体。

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  auditArgsOf,
  batchOfMeta,
  declaresBatchOf,
  BATCH_MAX_ITEMS,
  deliversLater,
  receivesReplies,
  PENDING_REPLY_META_KEY,
  REPLY_ID_META_KEY,
  REPLY_TO_META_KEY,
  waitingOnOf,
  type WaitingOn,
  CALL_ID_META_KEY,
  AUTO_APPROVE_META_KEY,
  CALLER_META_KEY,
  CALLER_MODULE_META_KEY,
  ON_BEHALF_OF_META_KEY,
  callIdOf,
  SOCKET_DIR_META_KEY,
  isValueFree,
  declaresReadEffect,
  EFFECT_META_KEY,
  RESTRICTION_META_KEY,
  isCallerOwned,
  isStatelessTransform,
  isPresentsOwnedSecret,
  visibilityOf,
  RESUME_AFTER_RESTART_TOOL,
  RELAY_EMIT_EVENT_TOOL,
  RELAY_PROJECT_GIT_BUNDLE_TOOL,
  RELAY_PROJECT_GIT_ORIGIN_TOOL,
  RELAY_PROJECT_GIT_UNBUNDLE_TOOL,
  RELAY_PROJECT_GIT_TRACK_TOOL,
  PROJECT_GIT_BUNDLE_MAX_BYTES,
  PROJECT_GIT_META_KEY,
  type ProjectGitOrigin,
  type BantoModuleMeta,
  type Visibility,
} from "@banto/module-contract";
import type { RelayApprovalGate } from "./approval-gate.js";
import { RESTARTING_REFUSAL } from "./module-calls.js";
import { READ_ONLY_REFUSAL, mayCallInReadOnly, mayReadResourcesInReadOnly, mayRelayOwnCredentialInReadOnly, type RestrictionFor } from "./read-only.js";

/**
 * **中継の本文の上限**（追加・2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」）。Module の stdio は1通 10MB まで
 * （MCP SDK 1.30.0 の ReadBuffer）なので、中継も同じにする——それより大きいものは宛先に届けられない
 */
export const RELAY_BODY_MAX_BYTES = 10 * 1024 * 1024;

export interface CallerIdentity {
  /** 宣言の名前（`shell`）。**承認の粒度はこちら**——Project は別に持つ。 */
  moduleName: string;
  /** プロセスの名前（`shell-<projectId>`）。省略時は moduleName と同じ。 */
  connName?: string;
  projectId?: string;
  meta: BantoModuleMeta;
  /**
   * **Project のコンテナの中で動いているか**（追加・2026-09-25）。中では AI が root で、この合言葉も読める
   * ——値を返す口への承認を、何を指していたかごとに分ける（`RelayCallDescriptor.scope`）
   */
  inContainer?: boolean;
  /**
   * **同梱の道具用のコンテナの中で動いているか**（追加・2026-10-15、`docs/specs/v4-modules.md` §2.2「変換役」）。身元を
   * 「道具用のコンテナ」と刻む。中に AI はいないが、コンテナの中なので `inContainer` も立つ——`mayRaiseNotice` 等の
   * 「banto 本体で動く」線には入れない
   */
  toolsContainer?: boolean;
  /**
   * **コンテナの中からも見える、host 側の窓口用フォルダ**（追加・2026-09-27）。呼び出しに
   * `dev.banto/socketDir` として刻む——Vault が鍵の窓口をここに立てる（`SOCKET_DIR_META_KEY`）
   */
  socketDir?: string;
  /**
   * **窓口を中から届くパスにする**（追加・2026-10-11、v4-security.md §1「ソケットの転送」）。別のサーバの呼び元にだけある
   * ——宛先（Vault）が `socketDir` に立てた窓口のパスを返したら、中継が向こうへの転送を張って応答を書き換える
   */
  socketPathInside?: (hostPath: string) => Promise<string>;
}

export interface RelayAuditRecord {
  projectId?: string;
  callerModule: string;
  targetModule: string;
  kind: "tool" | "resource" | "prompt";
  name: string;
  allowed: boolean;
  reason?: string;
  /**
   * **何を指していたか**（追加・2026-09-15）。値そのものではなく識別子だけ
   * （例：Vault の alias 名・置き場）。**宛先の tool が名乗った引数だけ**を拾う
   * （`dev.banto/auditArgs`）——banto が推測すると、いつか秘密の入った引数を
   * 記録する。名乗っていなければ付かない。
   */
  identifiers?: Record<string, string>;
  /**
   * **まとめて呼ぶ口の1件**（追加・2026-10-18、`dev.banto/batchOf`）。まとめた呼び出しは要素1件ごとに1行残し、
   * `identifiers` はその1件ぶん。`size` はまとめた件数
   */
  batch?: { size: number };
  /** 実際に中継した結果。拒否されたときは付かない。 */
  ok?: boolean;
  ts: string;
}

export interface RegisteredModule {
  name: string;
  /** 宣言の名前（Project ごとの Module は接続名が `<これ>-<projectId>`）。無ければ `name` と同じ */
  declaredName?: string;
  client: Client;
  meta: BantoModuleMeta;
  /**
   * **いま何のコードが動いているか**（追加・2026-09-15、レビューで発覚）。
   *
   * 中継の承認は**名前**で引く（`grantKey`）。つまり登録を消して、後日
   * **別のサーバを同じ名前で繋ぐと、前の承認がそのまま効く**——改名は安全側
   * （聞き直し）に倒れるのに、削除→再利用は危険側に倒れていた。
   *
   * 同梱は**コードが既定と一致していることが `bundled` の条件**なので
   * 入れ替わらない。**外から繋いだものだけ**、承認をこの印に縛る。
   */
  codeId?: string;
  /**
   * **Project ごとの Module なら、その Project**（追加・2026-09-26）。無ければ banto 全体に1本。
   * 中継で呼べるのは同じ Project の中だけ（`whyNotAllowed`）
   */
  projectId?: string;
  /**
   * **同梱の道具用のコンテナで動いている**（追加・2026-10-15）。置き場は host が宣言から導いたもの（Module の申告ではない）。
   * `dev.banto/statelessTransform` の口を人に聞かずに通すのは、これが立っている宛先だけ
   */
  toolsContainer?: true;
}

/** 宣言した依存に宛先が無いときの理由（`presentsOwnedSecret` の口だけ、これを外す） */
const NOT_IN_DEPENDENCIES = "宣言された依存に含まれない";

/**
 * **`dev.banto/presentsOwnedSecret` の口を、依存の確かめと承認なしで呼べる組か**（追加・2026-10-18、Backlog #405。アーキ仕様
 * §2.5「持ち主が、自分の置いた秘密から渡す値を作る口」）。
 *
 * - **呼び元は同梱で役割 `vault` を満たし、banto 本体で動く banto 全体の Module だけ**——役割 `vault` は同梱だけが名乗れる。
 *   コンテナの中・道具用のコンテナ・Project ごとの Module は今までどおり（AI が合言葉を読める場所から、持ち主に値を作らせない）
 * - **宛先も同梱の banto 全体の Module だけ**——名乗りを信じるのは同梱の宛先だけ（確かめは宛先がする。`valueFree` と同じ線）。
 *   Project の縛りもここで保つ
 */
function mayPresentOwnedSecret(identity: CallerIdentity, target: RegisteredModule): boolean {
  return (
    target.meta.origin === "bundled" &&
    target.projectId === undefined &&
    identity.meta?.origin === "bundled" &&
    identity.meta.satisfies.includes("vault") &&
    !identity.inContainer &&
    !identity.toolsContainer &&
    identity.projectId === undefined
  );
}

/**
 * 発行済みトークン→呼び出し元識別、Module名→実接続、の2つの台帳を持つ。
 * host が実 Module へ持つ「1本だけの接続」はここに集約する。
 */
export class RelayRegistry {
  private readonly tokens = new Map<string, CallerIdentity>();
  private readonly modules = new Map<string, RegisteredModule>();

  registerModule(mod: RegisteredModule): void {
    this.modules.set(mod.name, mod);
  }

  /** その Module を台帳から外し、**発行済みのトークンも失効させる**
   *  （決定・2026-09-10）。プロセスが居なくなったのに合言葉だけ生き残ると、
   *  台帳が増える一方になるうえ、身元が宙に浮く。 */
  unregisterModule(name: string): void {
    this.modules.delete(name);
    for (const [token, identity] of this.tokens) {
      if ((identity.connName ?? identity.moduleName) === name) this.tokens.delete(token);
    }
  }

  /** いま有効なトークンの数（回収できているかを測るため）。 */
  tokenCount(): number {
    return this.tokens.size;
  }

  getModule(name: string): RegisteredModule | undefined {
    return this.modules.get(name);
  }

  /** Moduleプロセスの起動のたびに発行し直す——使い回さない（決定・2026-09-03）。 */
  issueToken(identity: CallerIdentity): string {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, identity);
    return token;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  resolveToken(token: string): CallerIdentity | undefined {
    return this.tokens.get(token);
  }

  /** 呼び出し元が宣言した依存に照らして許可されているか（アーキ仕様§2.5）。 */
  isAllowed(caller: CallerIdentity, targetModule: string, onBehalfOf?: string): boolean {
    return this.whyNotAllowed(caller, targetModule, onBehalfOf) === undefined;
  }

  /**
   * **呼べない理由**（呼べるなら `undefined`）。見るのは2つ：
   *
   * - 宣言した依存（役割）に、宛先が名乗る役割があるか（アーキ仕様§2.5）
   * - **Project ごとの Module を呼べるのは、同じ Project の Module だけ**（決定・2026-09-26、ユーザー、
   *   `docs/specs/v4-security.md` §3）。以前は役割しか見ておらず、Project ごとの Module（`subagent-<projectId>`）を
   *   別の Project の Module が名前で指せた——許すと、その Project のコンテナで仕事が走る。banto 全体に1本の Module は
   *   Project を選べないので、Project ごとの Module は呼べない
   * - **ただし banto 全体の Module も、ある Project のための呼び出しを処理している間は、その Project の Module を
   *   呼べる**（`onBehalfOf`、追加・2026-09-27、Publish の窓口が Service の登録を引くため——`docs/specs/v4-security.md` §3）。
   *   どの Project のためかは **host の台帳が決める**（`ModuleCallTracker.callerFor`）——Module は選べない。
   *   決められない（走っている呼び出しが無い・複数の Project が混ざっている）なら、今までどおり呼べない
   */
  whyNotAllowed(caller: CallerIdentity, targetModule: string, onBehalfOf?: string): string | undefined {
    const target = this.modules.get(targetModule);
    if (!target || !caller.meta.dependsOn.some((d) => target.meta.satisfies.includes(d.role))) {
      return NOT_IN_DEPENDENCIES;
    }
    // Project ごとの呼び出し元は自分の Project に縛られる（継いだ Project では広げない）
    const project = caller.projectId ?? onBehalfOf;
    if (target.projectId !== undefined && target.projectId !== project) {
      return project === undefined
        ? "banto 全体の Module から、Project ごとの Module は呼べない（その Project のための呼び出しの中でだけ呼べる）"
        : "別の Project の Module は呼べない";
    }
    return undefined;
  }

  /**
   * **role → 実装の一覧**（アーキ仕様 §2.5「role 依存の解決は Module の仕事だが、
   * 一覧は host が渡す」の実体。追加・2026-09-12）。
   *
   * これが無いと、依存する Module は宛先の名前を**決め打ちする**しかない
   * ——実際 Shell は `vaultModuleName ?? "vault"` と書いていた。同じ role を
   * 複数の実装が名乗れる（§2.5）以上、決め打ちでは2本目に届かない。
   *
   * **判定は `isAllowed` と同じ根拠から導く**（規則3）——別の許可表を作らない。
   */
  allowedTargets(caller: CallerIdentity, onBehalfOf?: string): Array<{ name: string; roles: string[] }> {
    const roles = new Set(caller.meta.dependsOn.map((d) => d.role));
    return Array.from(this.modules.values())
      .filter((m) => this.whyNotAllowed(caller, m.name, onBehalfOf) === undefined)
      .map((m) => ({ name: m.name, roles: m.meta.satisfies.filter((role) => roles.has(role)) }));
  }
}

/**
 * 承認を待っている間、呼び出し元へ進捗を送る間隔。MCP の既定タイムアウト
 * （60秒）より十分短くする——Shell の長時間コマンドと同じ手当て
 * （docs/specs/v4-modules.md §2.3）。AI の代理サーバが Runner へ送るのも同じ間隔（`agent-proxy.ts`）
 */
export const APPROVAL_PROGRESS_INTERVAL_MS = 10_000;

export interface HostRelayServerOptions {
  registry: RelayRegistry;
  /**
   * **呼び出し元の Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2「返信用の札」）。宛先は札でしか指せない
   * ——札の確かめ（生きているか・渡した相手と同じ Module か）は受け手（host）が行う。渡さなければこの口は断る
   */
  deliverToThread?(
    caller: CallerIdentity,
    input: { replyTo: string; title: string; text: string; final: boolean },
  ): Promise<{ ok: true; deliveryId: string; wake?: string } | { ok: false; error: string }>;
  /**
   * **Module 宛ての札**（追加・2026-10-05、アーキ仕様 §4.2「Module 宛ての返事」）。中継で「終わったら届ける」 tool
   * （`dev.banto/deliversLater`）を呼ぶとき、呼んだ Module が受け口（`dev.banto/receivesReplies`）を名乗っていれば札を出して
   * 宛先に渡す。渡さなければ札は出ない（宛先は「届ける先がない」と断る）
   */
  replies?: {
    issueToModule(input: {
      to: { connName: string; moduleName: string };
      projectId?: string;
      connName: string;
      moduleName: string;
    }): { replyTo: string; replyId: string };
    /** 宛先が「あとで届ける」と約束した（`dev.banto/pendingReply`） */
    markAwaiting(replyTo: string, waitingOn?: WaitingOn): Promise<void>;
  };
  /**
   * 宛先が黙ったままのときに諦めるまでの時間（既定は MCP の 60 秒）。宛先の進捗・人を待つ間は数え直す。試験が短くするための穴
   */
  relayIdleTimeoutMs?: number;
  /**
   * 初回だけ人に聞くゲート（アーキ仕様 §2.5・docs/specs/v4-frontend.md
   * 「Module 間中継の承認」）。**渡さなければ宣言された依存だけで通す**
   * ——ゲートの有無で中継そのものの形が変わらないようにしてある（テストと
   * 実運用で同じ経路を通す）。host は必ず渡す（cli.ts）。
   */
  gate?: RelayApprovalGate;
  /**
   * いま走っている呼び出しの台帳（出所と Thread）。
   *
   * **中継は入れ子になる**（追加・2026-09-12、Shell → vault-directory → vault）。
   * host が宛先を呼ぶ間、**宛先にも在籍を立てる**——立てないと、宛先が
   * さらに中継を呼んだとき「どのターンの仕事か」が分からず、承認カードの
   * 出し先が無くて fail closed で止まる。文脈は推測せず、**外側から継ぐ**。
   */
  //
  // **問いはどれも、呼び出しの印（`callId`）を受ける**（追加・2026-09-28）。Module が中継に印を返したら
  // その1件について答え、無ければ接続で走っている全部について答える（`ModuleCallTracker.entriesOf`）
  moduleCalls?: {
    originFor(connName: string, callId?: string): "turn" | "canvas" | "host" | undefined;
    /** いま走っている呼び出しは誰のためか（Project／banto 全体／決められない）。 */
    callerFor?(connName: string, callId?: string): { project: string } | { instance: true } | undefined;
    /** banto 全体のための呼び出しか——宛先へ継ぐ。 */
    instanceFor?(connName: string, callId?: string): boolean;
    threadFor(connName: string, callId?: string): { kind: "thread"; threadId: string } | { kind: string };
    /** その呼び出しが人の答え（中継の承認）を待っているか——待っている間は上限を数えない */
    isWaitingOnHuman?(connName: string, callId: string): boolean;
    /** その Module のどれかの呼び出しが人を待っているか */
    isModuleWaitingOnHuman?(connName: string): boolean;
    projectFor(connName: string, callId?: string): string | undefined;
    begin(
      connName: string,
      threadId: string | undefined,
      origin: "turn" | "canvas" | "host",
      projectId?: string,
      forInstance?: boolean,
    ): () => void;
    /** `begin` と同じで、宛先に渡す呼び出しの印も返す。無ければ印を渡さない（宛先は接続単位で扱われる） */
    beginCall?(
      connName: string,
      threadId: string | undefined,
      origin: "turn" | "canvas" | "host",
      projectId?: string,
      forInstance?: boolean,
      /** 呼び元の呼び出しが持つ Runner の tool_use の id（継ぐ） */
      toolUseId?: string,
      /** 呼び元の呼び出し（人を待つ印を外側へたどるため、追加・2026-10-06） */
      parent?: { connName: string; callId?: string },
      /** その呼び出しに付ける印（宛先の tool が `dev.banto/projectGit` を名乗った、追加・2026-10-20） */
      marks?: { projectGit?: true },
    ): { id: string; end: () => void };
    /** その呼び出し（印が要る）の中で Project の git の口に届くか（`dev.banto/projectGit`、追加・2026-10-20） */
    mayReachProjectGit?(connName: string, callId: string | undefined): boolean;
    /** 呼び元の呼び出しが属する AI の tool 呼び出しの id（Runner の tool_use の id）。1つに決まるときだけ */
    toolUseIdFor?(connName: string, callId?: string): string | undefined;
    /** 起こし直しのために止め始めているか（新しい中継を断る） */
    isStopping?(): boolean;
    /** その呼び出し（印が無ければその接続のどれか）がまだ走っているか */
    isRunning?(connName: string, callId?: string): boolean;
  };
  /** 記録（メタデータだけ）。成否も含め、拒否された呼び出しも渡ってくる。 */
  onAudit?(record: RelayAuditRecord): void | Promise<void>;
  /**
   * **その Project で「承認をすべて自動で許可する」がオンか**（追加・2026-10-05）。オンなら、AI のターンから始まった
   * その Project のための中継の呼び出しに `dev.banto/autoApprove` を刻む。渡されなければ刻まない
   */
  autoApproveFor?(projectId: string, threadId?: string): boolean;
  /**
   * **その会話の制限**（追加・2026-10-20、アーキ仕様 §4.4「読むだけの回の中継」）。呼び元の呼び出しが読むだけの回のターンから
   * 始まったなら、宛先の tool の印を host が見て、読むだけのものでなければ断る（境界を Module 任せにしない）。承認が要るものは
   * 人に聞かずに断る。渡されなければ制限しない
   */
  restrictionFor?: RestrictionFor;
  /** **人が「見回りで使ってよい」と許したもの**（Project の `patrol.allowedTools`）。渡されなければ何も許していない */
  patrolAllowedTools?(projectId: string): string[];
  /** 承認待ちの進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**。 */
  approvalProgressIntervalMs?: number;
  /**
   * **使うときに起こす宛先**（追加・2026-10-15、`v4-modules.md` §2.2「変換役」——入れるのは初めて使うとき）。宛先が
   * 繋がっていなければ、権限を確かめる前にこれを呼ぶ。起こせる宛先（同梱の道具用のコンテナの Module）でなければ何もせず返し、
   * 下の確かめがいつもどおり断る。起こしている途中なら理由つきで投げる（`TOOLS_PREPARING_MARKER` 付き）。渡さなければ起こさない
   */
  connectOnDemand?(caller: CallerIdentity, targetModule: string): Promise<void>;
  /** 使うときに起こせる宛先のうち、その呼び元が呼べるもの（`relayListTargets` に載せる。役割は呼び元の依存と重なるものだけ） */
  onDemandTargets?(caller: CallerIdentity): Array<{ name: string; roles: string[] }>;
  /**
   * **host からその Project のコンテナに届くアドレス**（追加・2026-09-27、`docs/specs/v4-modules.md` §4.3 Publish）。
   * コンテナのアドレスは DHCP で変わりうるので、公開の実装は覚えずに引き直す。渡さなければこの口は断る。
   *
   * **断りは2通りに分けて返す**（改訂・2026-09-28、Fable のレビュー）：`{unavailable}` は**確かに届かない**
   * （コンテナが無い・止まっている・この banto のものでない・アドレスがまだ無い）。投げたら**分からない**
   * （Incus が答えない等の一時の失敗）。公開の実装は、前者なら中継をやめ（503）、後者なら写しに触らない
   */
  projectAddress?(projectId: string, port?: number): Promise<{ address: string; port?: number } | { unavailable: string }>;
  /**
   * **公開をやめたとき、`projectAddress(projectId, port)` が張った道を外す**（追加・2026-10-20、別のサーバの containers——VM のポート
   * からコンテナの中へ繋ぐ proxy device。v4-security.md §1「道」の公開）。張らない実行場所では何もしない。渡さなければこの口は断る
   */
  releaseProjectPort?(projectId: string, port: number): Promise<void>;
  /**
   * **Project の一覧**（id・名前・根のパス・状態、追加・2026-10-01、`docs/specs/v4-modules.md` §2.4 Repositories）。
   * 引ける相手と場面は `mayListProjects` が決める。渡さなければこの口は断る
   */
  listProjects?(): ProjectSummaryForModule[];
  /**
   * **受信箱に知らせる**（追加・2026-10-02、`docs/specs/v4-modules.md` §2.4 Repositories——GitHub のログインの更新に
   * 失敗したとき）。出せる相手は `mayRaiseNotice` が決める。渡さなければこの口は断る
   */
    raiseNotice?(caller: CallerIdentity, input: { key: string; title: string; detail: string; threadId?: string }): Promise<void>;
  /**
   * **出来事を知らせる**（追加・2026-10-16、アーキ仕様 §4.3「段2」の「知らせる口」）。出せる相手は `mayEmitEvent` が決め、
   * どの Project の出来事かは `caller.projectId`（host が接続から決めたもの）。宣言との照合・重複落とし・輪の止め方は
   * 受ける側（`automation/events.ts`）。断ったら `{refused}`——出口の箱はそれを捨てる。渡さなければこの口は断る
   */
  emitEvent?(caller: CallerIdentity & { projectId: string }, input: Record<string, unknown>): Promise<{ accepted: true; duplicate?: true; queued: number } | { refused: string }>;
  /**
   * **エージェントの本体を取ってきて、呼び元の場所から見えるようにする**（追加・2026-10-17、アーキ仕様 §4.1「エージェントの本体を
   * 取ってくる」）。返すのは呼び元の場所から見えるパス。進み具合は `onProgress` に流す（中継が `notifications/progress` にする）。
   * 呼べる相手は `mayEnsureAgentBinary` が決める。渡さなければこの口は断る
   */
  /**
   * **別のサーバの Project の git と、1本のブランチの中身をやり取りする**（追加・2026-10-20、Backlog #466、`docs/specs/v4-modules.md`
   * §2.4「別のサーバの Project」）。Project は host の台帳が呼び出しの印で決める（引数で選べない）。呼べる相手は `mayUseProjectGit`
   * が決める。この機械の Project・Module が起きていない Project は理由つきで投げる。渡さなければこの口は断る
   */
  projectGit?: {
    origin(projectId: string): Promise<ProjectGitOrigin>;
    /** 向こうにそのブランチが無ければ undefined */
    bundle(projectId: string, branch: string): Promise<Buffer | undefined>;
    unbundle(projectId: string, branch: string, bundle: Buffer): Promise<void>;
    /** `refs/remotes/origin/<branch>` を、向こうにもうあるコミットに合わせる */
    track(projectId: string, branch: string, commit: string): Promise<void>;
  };
  ensureAgentBinary?(
    caller: CallerIdentity,
    agent: string,
    onProgress: (message: string) => void,
  ): Promise<{ path: string; version: string; cpu: string; sizeBytes: number }>;
  /** **この機械に本体が置いてあるか**（取らない）。呼べる相手は `mayReadAgentBinaryStatus` が決める。渡さなければこの口は断る */
  agentBinaryStatus?(agent: string): { agent: string; title: string; version: string; cpu: string; present: boolean; sizeBytes?: number; approxBytes: number };
}

/**
 * **エージェントの本体を取ってこさせてよい呼び元**（追加・2026-10-17、アーキ仕様 §4.1）。**同梱で `subagent` を名乗る Module だけ**
 * （呼べないなら理由、呼べるなら `undefined`）。
 *
 * - `mayRaiseNotice` の「banto 本体で動く banto 全体の Module だけ」とは別——Subagent は Project のコンテナ・別のサーバで動く
 * - 道具用のコンテナの Module は断る（サブエージェントを走らせない）
 * - **コンテナの中の AI も中継の合言葉を読めるのでこの口を直接呼べる**——できるのは「目録にある本体を取ってこさせる・有無を知る」
 *   だけで、害はそれに限られる（`docs/specs/v4-security.md` §1）。目録に無い名前は store が断る
 */
export function mayEnsureAgentBinary(identity: CallerIdentity): string | undefined {
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが頼める";
  if (!identity.meta.satisfies.includes(SUBAGENT_ROLE)) return `${SUBAGENT_ROLE} 役割を名乗る Module だけが頼める`;
  if (identity.toolsContainer) return "道具用のコンテナの Module は頼めない";
  return undefined;
}

/** **本体の有無を知ってよい呼び元**：取ってこさせてよい相手と、同梱の設定（`subagent-settings`、banto 全体）だけ */
export function mayReadAgentBinaryStatus(identity: CallerIdentity): string | undefined {
  if (identity.meta.origin === "bundled" && identity.meta.satisfies.includes(SUBAGENT_SETTINGS_ROLE) && !identity.toolsContainer) return undefined;
  return mayEnsureAgentBinary(identity);
}
const SUBAGENT_ROLE = "subagent";
const SUBAGENT_SETTINGS_ROLE = "subagent-settings";

/**
 * **出来事を知らせてよい呼び出し元**（追加・2026-10-16、アーキ仕様 §4.3「段2」）。**Project ごとの同梱の Module だけ**
 * （`mayRaiseNotice` とは逆の絞り方）。呼べないなら理由、呼べるなら `undefined`。
 *
 * - Project ごとだけ——どの Project の出来事かを host が接続から決められるのは、identity に `projectId` を刻んだ Module だけ。
 *   banto 全体の Module は、どの Project の出来事かを host が確かめられない（段3で外の出来事と一緒に）
 * - 同梱だけ——最初は同梱だけ（ユーザー・2026-10-16）。外から繋いだ Module は器が固まってから同じ形で開く
 * - コンテナの中の AI もこの口を直接呼べる（合言葉を読める）。だから属性・`text`・`causedBy` は申告として扱う
 */
export function mayEmitEvent(identity: CallerIdentity): string | undefined {
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが出せる";
  if (identity.projectId === undefined || identity.toolsContainer) return "Project ごとの Module だけが出せる";
  return undefined;
}

/** 知らせの大きさの上限（受信箱の1行に出すもの。長すぎるものは断る——黙って切らない） */
const NOTICE_LIMITS = { key: 200, title: 200, detail: 2000 } as const;

/**
 * **受信箱に知らせてよい呼び出し元**（追加・2026-10-02）。**banto 本体で動く、同梱の banto 全体の Module だけ**
 * （呼べないなら理由、呼べるなら `undefined`）。
 *
 * - 同梱だけ——受信箱は人が banto 自身の言葉として読む場所で、第三者のコードが好きな文言を置けると、banto の
 *   知らせを装える（「ここを開いてログインし直してください」）。第三者に開くかは、出所の見せ方と一緒に決める
 * - banto 全体の Module だけ——知らせは Project を持たない（banto 全体）。コンテナの中では AI が合言葉を読める
 * - 出所（人の画面か・AI のターンか）は問わない——知らせたいのは、人が見ていないところで起きた失敗でもある
 */
export function mayRaiseNotice(identity: CallerIdentity): string | undefined {
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが出せる";
  if (identity.inContainer || identity.projectId !== undefined) return "banto 本体で動く、banto 全体の Module だけが出せる";
  return undefined;
}

/** 中継が Module に渡す Project の姿。**根のパスまで**——Memory・会話は渡さない */
export interface ProjectSummaryForModule {
  id: string;
  name: string;
  /** 根（実行場所の側のパス。別のサーバなら向こうのパスで、この機械には無い） */
  root: string;
  status: "active" | "closed";
  /** 実行場所（`host-container` か `remote:<名前>`。無ければこの機械）。この機械のフォルダと突き合わせる Module はこれを見て外す */
  runtime?: string;
  /**
   * core の「clone」のタブ（別のサーバの新しい Project、v4-frontend.md §6.49）で作り終えたときの、clone した URL と選んだ
   * アカウント（Repositories の GitHub の login）。Repositories がその Project のブランチを送るアカウントを決めるのに使う
   */
  clonedFrom?: { url: string; account?: string };
}

/**
 * **Project の一覧を引いてよいか**（追加・2026-10-01）。引けるのは、**banto 本体で動く同梱の banto 全体の Module が、
 * 人の画面からの呼び出しを処理している間だけ**（呼べないなら理由、呼べるなら `undefined`）。
 *
 * - 同梱だけ——Project の名前と根のパスは人の持ち物の地図で、第三者のコードに渡さない（Canvas の `hostContext` に
 *   一覧を載せないのと同じ理由、`docs/specs/v4-frontend.md` §6.2）
 * - banto 本体で動くものだけ——コンテナの中では AI が合言葉を読める
 * - 人の画面からの呼び出しの中だけ（`canvas`＝host が `{admin: true}` を刻んだ呼び出し）——AI のターンから引けると、
 *   AI が別の Project の名前と場所を知る道になる。**どの Module かは名指ししない**（core は Repositories を知らない）
 */
export function mayListProjects(identity: CallerIdentity, origin: "turn" | "canvas" | "host" | undefined): string | undefined {
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが引ける";
  if (identity.inContainer || identity.projectId !== undefined) return "banto 本体で動く、banto 全体の Module だけが引ける";
  if (origin !== "canvas") return "人の画面からの呼び出しを処理している間だけ引ける";
  return undefined;
}

/**
 * **いまの呼び出しの Project を引いてよいか**（追加・2026-10-04）。**banto 本体で動く同梱の banto 全体の Module だけ**。
 * 出所（人の画面か AI のターンか）は問わない——返すのは、その呼び出しが既に「その Project のため」と刻まれている
 * Project 1件で、ほかの Project の名前と場所は出ない（`mayListProjects` が AI のターンで断る理由はそこ）
 */
export function mayReadCallerProject(identity: CallerIdentity): string | undefined {
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが引ける";
  if (identity.inContainer || identity.projectId !== undefined) return "banto 本体で動く、banto 全体の Module だけが引ける";
  return undefined;
}

/**
 * **別のサーバの Project の git に届いてよい呼び出し元**（追加・2026-10-20、Backlog #466）。`repositories` 役割を名乗る、
 * banto 本体で動く同梱の banto 全体の Module だけ——資格情報を持ち、ブランチを送る口（`push_branch`・`fetch_branch`）を
 * 引き受けるもの。コンテナの中の Module（中の AI が合言葉を読める）と第三者のコードには、別の Project の中身を読ませない
 */
export function mayUseProjectGit(identity: CallerIdentity): string | undefined {
  if (!identity.meta.satisfies.includes(REPOSITORIES_ROLE)) return `${REPOSITORIES_ROLE} 役割を名乗る Module だけが届ける`;
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが届ける";
  if (identity.inContainer || identity.projectId !== undefined) return "banto 本体で動く、banto 全体の Module だけが届ける";
  return undefined;
}
const REPOSITORIES_ROLE = "repositories";
/** 別のサーバの Project の git を待つ間、進み具合を送る間隔 */
const PROJECT_GIT_HEARTBEAT_MS = 10_000;

/**
 * **Project のアドレスを引いてよい呼び出し元**（追加・2026-09-27）。公開の実装（`publish` 役割）で、**banto 本体で
 * 動く banto 自身のコード**だけ。コンテナの中の Module（中の AI が合言葉を読める）と第三者のコードには引かせない
 * ——公開の道を張れるのは host で動くものだけ、という線（`docs/specs/v4-security.md` §1）をここでも崩さない
 */
export function mayResolveProjectAddress(identity: CallerIdentity): string | undefined {
  if (!identity.meta.satisfies.includes(PUBLISH_ROLE)) return `${PUBLISH_ROLE} 役割を名乗る Module だけが引ける`;
  if (identity.meta.origin !== "bundled") return "banto 自身のコード（同梱）だけが引ける";
  if (identity.inContainer || identity.projectId !== undefined) return "banto 本体で動く、banto 全体の Module だけが引ける";
  return undefined;
}
const PUBLISH_ROLE = "publish";

/** サービスのポート（1〜65535 の整数でなければ断る） */
function servicePortOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) throw new Error(`port は 1〜65535 の整数で渡してください（${String(v)}）`);
  return v;
}

/** 宛先の tool が名乗った `batchOf` と、`batchOf.tool` の識別子・required（`targetTool`） */
interface TargetBatchOf {
  declared: true;
  tool?: string;
  items?: string;
  member?: { auditArgs: string[]; required: string[] };
}

/**
 * 宛先の tool が名乗っている可視性。**その Module が名乗っていない名前は
 * `undefined`**——知らないものを `admin` 扱いしない（fail closed）。
 */
async function targetTool(
  client: Client,
  toolName: string,
): Promise<
  | {
      visibility: Visibility;
      valueFree: boolean;
      callerOwned: boolean;
      statelessTransform: boolean;
      presentsOwnedSecret: boolean;
      auditArgs: string[];
      deliversLater: boolean;
      receivesReplies: boolean;
      /** `dev.banto/projectGit` を名乗っているか（信じるのは同梱の宛先だけ） */
      projectGit: boolean;
      /** `dev.banto/effect: "read"` を名乗っているか（信じてよいかは宛先の出所で決める） */
      readEffect: boolean;
      /**
       * **まとめて呼ぶ口の名乗り**（追加・2026-10-18）。名乗っていなければ付かない。`declared` だけで中身が無いのは、
       * 形が違うか、`batchOf.tool` が同じ宛先に無いとき（どちらも断る）
       */
      batchOf?: TargetBatchOf;
    }
  | undefined
> {
  const { tools } = await client.listTools().catch(() => ({ tools: [] as unknown[] }));
  const tool = tools.find((t) => (t as { name?: string }).name === toolName);
  if (!tool) return undefined;
  const x = tool as { _meta?: Record<string, unknown> };
  let batchOf: TargetBatchOf | undefined;
  if (declaresBatchOf(x)) {
    const parsed = batchOfMeta(x);
    const memberTool = parsed ? tools.find((t) => (t as { name?: string }).name === parsed.tool) : undefined;
    const member = memberTool as { _meta?: Record<string, unknown>; inputSchema?: { required?: unknown } } | undefined;
    const required = member?.inputSchema?.required;
    batchOf = {
      declared: true,
      ...(parsed ? { tool: parsed.tool, items: parsed.items } : {}),
      ...(member
        ? {
            member: {
              auditArgs: auditArgsOf(member),
              required: Array.isArray(required) ? required.filter((k): k is string => typeof k === "string") : [],
            },
          }
        : {}),
    };
  }
  return {
    ...(batchOf ? { batchOf } : {}),
    visibility: visibilityOf(x),
    valueFree: isValueFree(x),
    callerOwned: isCallerOwned(x),
    statelessTransform: isStatelessTransform(x),
    presentsOwnedSecret: isPresentsOwnedSecret(x),
    auditArgs: auditArgsOf(x),
    deliversLater: deliversLater(x),
    receivesReplies: receivesReplies(x),
    projectGit: x._meta?.[PROJECT_GIT_META_KEY] === true,
    readEffect: declaresReadEffect(x),
  };
}

/** 識別子として拾う長さの上限——識別子のつもりの欄に値が入っていたときに、記録へ流し込まないため */
const IDENTIFIER_MAX_LENGTH = 200;

function isIdentifier(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= IDENTIFIER_MAX_LENGTH;
}

/**
 * **まとめて呼ぶ口の要素を、1件ずつの識別子にする**（追加・2026-10-18、`docs/specs/v4-modules.md`「秘密をまとめて引く」の承認）。
 * 拾えない形は**理由を返して中継ごと断る**——黙って飛ばすと、承認の鍵に入らない要素の値が出ていく（fail closed）。
 * 戻り値の `items` は要素ごとの識別子（`batchOf.tool` が識別子を名乗らない口なら、どれも空）
 */
function pickBatchItems(
  batchOf: TargetBatchOf,
  callArgs: Record<string, unknown>,
): { tool: string; items: Record<string, string>[] } | { refused: string } {
  if (batchOf.tool === undefined || batchOf.items === undefined) return { refused: "まとめて呼ぶ口の名乗り（dev.banto/batchOf）の形が違います" };
  if (!batchOf.member) return { refused: `まとめて呼ぶ口が名乗った ${batchOf.tool} が、同じ Module にありません` };
  const itemsKey = batchOf.items;
  const extra = Object.keys(callArgs).filter((k) => k !== itemsKey);
  if (extra.length > 0) return { refused: `まとめて呼ぶ口には ${itemsKey} のほかの引数を渡せません（${extra.join("、")}）` };
  const raw = callArgs[itemsKey];
  if (!Array.isArray(raw)) return { refused: `${itemsKey} が配列ではありません` };
  if (raw.length === 0) return { refused: `${itemsKey} が空です` };
  if (raw.length > BATCH_MAX_ITEMS) return { refused: `${itemsKey} は ${BATCH_MAX_ITEMS} 件までです（${raw.length} 件）` };
  const { auditArgs, required } = batchOf.member;
  const requiredIds = auditArgs.filter((k) => required.includes(k));
  const items: Record<string, string>[] = [];
  for (const [i, el] of raw.entries()) {
    if (typeof el !== "object" || el === null || Array.isArray(el)) return { refused: `${itemsKey} の ${i + 1} 件目がオブジェクトではありません` };
    const picked: Record<string, string> = {};
    for (const key of auditArgs) {
      const v = (el as Record<string, unknown>)[key];
      if (isIdentifier(v)) picked[key] = v;
      else if (requiredIds.includes(key)) {
        return { refused: `${itemsKey} の ${i + 1} 件目から ${key} を拾えません（無い・文字列でない・${IDENTIFIER_MAX_LENGTH} 字を超える）` };
      }
    }
    // 識別子を名乗る口なのに1つも拾えない要素は、鍵が `scope: {}` に潰れる——断る
    if (auditArgs.length > 0 && Object.keys(picked).length === 0) {
      return { refused: `${itemsKey} の ${i + 1} 件目から識別子（${auditArgs.join("・")}）を1つも拾えません` };
    }
    items.push(picked);
  }
  return { tool: batchOf.tool, items };
}

/** その Module が返事の受け口（`dev.banto/receivesReplies`）を名乗っているか */
async function hasReplyReceiver(client: Client | undefined): Promise<boolean> {
  if (!client) return false;
  const { tools } = await client.listTools().catch(() => ({ tools: [] as unknown[] }));
  return tools.some((t) => receivesReplies(t as { _meta?: Record<string, unknown> }));
}

/**
 * **banto 全体の Module が、いまどの Project のための呼び出しを処理しているか**（追加・2026-09-27）。
 * `callerFor` を使う——Project が1つに決まり、banto 全体のための呼び出しが混ざっていないときだけ。
 * Project ごとの Module は自分の Project に縛られているので継がない
 */
function onBehalfOfProject(identity: CallerIdentity, opts: HostRelayServerOptions, callId?: string): string | undefined {
  if (identity.projectId !== undefined) return undefined;
  const ambient = opts.moduleCalls?.callerFor?.(identity.connName ?? identity.moduleName, callId);
  return ambient && "project" in ambient ? ambient.project : undefined;
}

/**
 * **呼び出し元が返した呼び出しの印を信じてよいか**（追加・2026-09-28、`CALL_ID_META_KEY`）。**同梱の Module だけ**。
 * 印があると、同じ接続で同時に走っている呼び出しのうち1件を選べる——第三者に選ばせると、AI のターンの仕事を
 * 人の画面の呼び出しの印で中継して承認を飛ばせる。第三者は今までどおり接続単位（混ざれば厳しいほう）
 */
function trustedCallId(identity: CallerIdentity, meta: Record<string, unknown> | undefined): string | undefined {
  return identity.meta.origin === "bundled" ? callIdOf(meta) : undefined;
}

/**
 * **呼び元の呼び出しが、読むだけの会話のターンから始まったか**（§4.4）。どの会話かは host の台帳（`threadFor`）だけで決める。
 * 候補が複数なら、どれかが読むだけなら読むだけ（fail closed）
 */
function isReadOnlyRun(identity: CallerIdentity, opts: HostRelayServerOptions, callId: string | undefined): boolean {
  if (!opts.restrictionFor || !opts.moduleCalls) return false;
  const connName = identity.connName ?? identity.moduleName;
  const where = opts.moduleCalls.threadFor(connName, callId) as { kind: string; threadId?: string; threadIds?: string[] };
  const threads = where.kind === "thread" && where.threadId ? [where.threadId] : where.kind === "ambiguous" ? (where.threadIds ?? []) : [];
  const project = identity.projectId ?? opts.moduleCalls.projectFor(connName, callId);
  return threads.some((t) => opts.restrictionFor!(project, t) === "read-only");
}

/** 呼び出し元1件ごとに、閉じ込めた identity を持つ Server+Transport を作る。 */
function buildRelayServer(identity: CallerIdentity, opts: HostRelayServerOptions): Server {
  const server = new Server(
    { name: "banto-host-relay", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "relayCallTool",
        description: "他Moduleのtoolを呼ぶ（host中継）",
        inputSchema: {
          type: "object",
          properties: {
            targetModule: { type: "string" },
            name: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["targetModule", "name"],
        },
      },
      {
        name: "relayReadResource",
        description: "他Moduleのresourceを読む（host中継）",
        inputSchema: {
          type: "object",
          properties: { targetModule: { type: "string" }, uri: { type: "string" } },
          required: ["targetModule", "uri"],
        },
      },
      {
        // **宛先の名前を決め打ちさせない**（追加・2026-09-12、アーキ仕様 §2.5）。
        // 同じ role を複数の実装が名乗れるので、「vault という名前の Module」を
        // 当てにすると2本目の実装に届かない。ここで返すのは
        // **その呼び出し元が呼んでよい相手だけ**（isAllowed と同じ根拠）
        name: "relayListTargets",
        description: "自分が呼んでよい Module の一覧（role つき）",
        inputSchema: { type: "object", properties: {} },
      },
      {
        // **公開の実装が、Project のコンテナに届くアドレスを引く**（追加・2026-09-27、§4.3 Publish）。
        // 引ける相手は `mayResolveProjectAddress` が決める。返すのはアドレスだけ
        name: "relayProjectAddress",
        description:
          "host からその Project のコンテナに届くアドレス（IPv4）。変わりうるので覚えずに引き直す。port（サービスのポート）を渡すと、" +
          "そのポートに届く道を用意し、別の番号で届くならその番号を port で返す（別のサーバの Project ごとのコンテナ）",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } },
          required: ["projectId"],
        },
      },
      {
        // **公開をやめたとき、道を外す**（追加・2026-10-20）。引ける相手は `relayProjectAddress` と同じ
        name: "relayProjectPortRelease",
        description: "公開をやめたとき、relayProjectAddress が port のために用意した道を外す（用意しない実行場所では何もしない）",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 } },
          required: ["projectId", "port"],
        },
      },
      {
        // **Project の一覧**（追加・2026-10-01、§2.4 Repositories——どの Project がそのフォルダを根にしているか）。
        // 引ける相手と場面は `mayListProjects` が決める
        name: "relayListProjects",
        description: "Project の一覧（id・名前・根のパス・状態）。人の画面からの呼び出しを処理している間だけ引ける",
        inputSchema: { type: "object", properties: {} },
      },
      {
        // **いまの呼び出しが、どの Project のためか**（追加・2026-10-04、§2.4 Repositories——Backlog のブランチを
        // push する口が、呼び出し元の Project の根がそのリポジトリかを確かめる）。返すのはその1件だけ。
        // 引ける相手は `mayReadCallerProject` が決め、Project は host の台帳が決める——Module は選べない
        name: "relayCallerProject",
        description: "いま処理している呼び出しがどの Project のためか（id・名前・根のパス・状態）。決められなければ断る",
        inputSchema: { type: "object", properties: {} },
      },
      {
        // **別のサーバの Project の git**（追加・2026-10-20、§2.4「ブランチを送る口」の「別のサーバの Project」）。4本とも、
        // Project は host の台帳が決める（いまの呼び出しの Project）。呼べる相手は `mayUseProjectGit` が決める
        name: RELAY_PROJECT_GIT_ORIGIN_TOOL,
        description:
          "いまの呼び出しの Project（別のサーバ）の根のリポジトリの origin の設定（リポジトリの段）。答えは {kind:'not-repo'} か {kind:'repo', urls, redirects}",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: RELAY_PROJECT_GIT_BUNDLE_TOOL,
        description: "いまの呼び出しの Project（別のサーバ）の根のリポジトリで、そのブランチだけの bundle を作る。答えは {bundle: base64} か {absent: true}",
        inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] },
      },
      {
        name: RELAY_PROJECT_GIT_UNBUNDLE_TOOL,
        description: "いまの呼び出しの Project（別のサーバ）の根のリポジトリに、bundle のそのブランチを refs/remotes/origin/<branch> として取り込む",
        inputSchema: {
          type: "object",
          properties: { branch: { type: "string" }, bundle: { type: "string", description: "base64" } },
          required: ["branch", "bundle"],
        },
      },
      {
        name: RELAY_PROJECT_GIT_TRACK_TOOL,
        description: "いまの呼び出しの Project（別のサーバ）の根のリポジトリの refs/remotes/origin/<branch> を、そこにもうあるコミットに合わせる（送り終えたあと）",
        inputSchema: {
          type: "object",
          properties: { branch: { type: "string" }, commit: { type: "string" } },
          required: ["branch", "commit"],
        },
      },
      {
        // **受信箱に知らせる**（追加・2026-10-02、§2.4 Repositories——ログインの更新に失敗したとき）。
        // 出せる相手は `mayRaiseNotice` が決める。同じ鍵の知らせが開いている間は積まない
        name: "relayRaiseNotice",
        description: "受信箱にお知らせを1件出す（banto 全体の話）。同じ key のものが開いていれば積まない",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "同じことを何度も積まないための鍵（この Module の中で一意）" },
            title: { type: "string" },
            detail: { type: "string" },
          },
          required: ["key", "title", "detail"],
        },
      },
      {
        // **出来事を知らせる**（追加・2026-10-16、§4.3「段2」）。出せる相手は `mayEmitEvent` が決める。宣言に無い出来事・
        // 型の合わない属性は断る（`{refused}`）。待つ自動化が無くても「受け取った」と返す
        name: RELAY_EMIT_EVENT_TOOL,
        description:
          "名乗った出来事を知らせる（Project ごとの同梱の Module だけ）。同じ eventId は二度受けない。答えは {accepted} か {refused}",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "<この Module の名前>.<出来事の名前>" },
            eventId: { type: "string", description: "重複落としの印（出し直しても同じ値）" },
            occurredAt: { type: "string", description: "起きた時刻（ISO 8601）" },
            fields: { type: "object", description: "名乗った属性の値" },
            text: { type: "string", description: "本文（16KB まで。超えた分は切る）" },
            causedBy: {
              type: "object",
              properties: { callId: { type: "string" } },
              description: "その仕事を始めた呼び出しの印（host が呼び出しに刻んだ dev.banto/callId）",
            },
          },
          required: ["name", "eventId", "occurredAt"],
        },
      },
      {
        // **エージェントの本体を取ってくる**（追加・2026-10-17、アーキ仕様 §4.1）。呼べる相手は `mayEnsureAgentBinary` が決める。
        // 取ってくる・送る間は進み具合を送る（進んでいれば5秒ごと、止まっていても15秒ごと）
        name: "relayEnsureAgentBinary",
        description:
          "目録にあるエージェントの本体を取ってきて、呼び元の場所から見えるようにする（初めてのときは数分かかる）。答えは {path, version, cpu, sizeBytes}",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string", description: "エージェントの id（opencode）" } },
          required: ["agent"],
        },
      },
      {
        // **本体がこの機械に置いてあるか**（取らない）。呼べる相手は `mayReadAgentBinaryStatus` が決める
        name: "relayAgentBinaryStatus",
        description: "目録にあるエージェントの本体が、この機械に置いてあるか（取らない）",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string" } },
          required: ["agent"],
        },
      },
      {
        // **終わったら呼び出し元の Thread に届ける**（追加・2026-09-25、アーキ仕様 §4.2）。宛先は host が渡した
        // 返信用の札（`dev.banto/replyTo`）でしか指せない。届いたらその Thread の AI が起きる
        // **宛先が Module の札も同じ口で届ける**（追加・2026-10-05）——送り手は宛先を知らず、host が札で振り分ける
        name: "relayDeliverToThread",
        description:
          "返信用の札で、呼び出し元に届ける。呼び出し元が Thread ならその Thread の AI が続きをやり、Module ならその Module の受け口に渡る",
        inputSchema: {
          type: "object",
          properties: {
            replyTo: { type: "string", description: "host が tool 呼び出しの _meta で渡した札" },
            title: { type: "string", description: "画面に出す1行" },
            text: { type: "string", description: "AI に渡す本文" },
            final: { type: "boolean", description: "これで最後か（既定 true。最後なら札は使い終わる）" },
          },
          required: ["replyTo", "title", "text"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // **誰にも届けない問い合わせ**——宛先を選ぶ前の相談なので、承認ゲートも
    // 監査も通さない（まだ何も呼んでいない）。返すのは名前と role だけで、
    // 相手の中身（tool 一覧・値）は一切含まない
    // **どの呼び出しを処理している最中か**（呼び出し元が返した印。同梱だけ信じる）
    const callId = trustedCallId(identity, request.params._meta as Record<string, unknown> | undefined);
    // **どの Project のための呼び出しを処理しているか**（host の台帳。banto 全体の Module だけが継ぐ）
    const onBehalfOf = onBehalfOfProject(identity, opts, callId);

    if (request.params.name === "relayListTargets") {
      const listed = opts.registry.allowedTargets(identity, onBehalfOf);
      // **使うときに起こす宛先も載せる**（まだ繋がっていなくても、呼べば起きる——`connectOnDemand`）
      const targets = [
        ...listed,
        ...(opts.onDemandTargets?.(identity) ?? []).filter((t) => !listed.some((l) => l.name === t.name)),
      ];
      // **どの Project として一覧を作ったか**も添える——Project の Module が出ないとき、「その Project に無い」と
      // 「どの Project のための呼び出しか決められない」を呼び出し元が取り違えないため（規則2）
      const project = identity.projectId ?? onBehalfOf;
      return {
        content: [{ type: "text", text: JSON.stringify(targets) }],
        ...(project ? { _meta: { [ON_BEHALF_OF_META_KEY]: project } } : {}),
      };
    }

    // **宛先は host 自身**——アドレスは値ではない（中の AI にも自分のアドレスは見える）ので承認は通さないが、
    // 引ける相手は絞る。コンテナを起こしはしない（動いていなければ理由つきで断る）
    if (request.params.name === "relayProjectAddress") {
      const why = mayResolveProjectAddress(identity);
      if (why) throw new Error(`${identity.moduleName} は Project のアドレスを引けません（${why}）`);
      if (!opts.projectAddress) throw new Error("この banto は Project のアドレスを引く口を持っていません");
      const projectId = typeof args.projectId === "string" ? args.projectId : "";
      if (!projectId) throw new Error("projectId が要ります");
      const port = args.port === undefined ? undefined : servicePortOf(args.port);
      // 確かに届かないときは理由を値で返す（`{unavailable}`）。分からないときは投げる——呼び出し元が区別できるように
      const found = await opts.projectAddress(projectId, port);
      return { content: [{ type: "text", text: JSON.stringify(found) }] };
    }

    if (request.params.name === "relayProjectPortRelease") {
      const why = mayResolveProjectAddress(identity);
      if (why) throw new Error(`${identity.moduleName} は Project の公開の道を外せません（${why}）`);
      if (!opts.releaseProjectPort) throw new Error("この banto は Project の公開の道を外す口を持っていません");
      const projectId = typeof args.projectId === "string" ? args.projectId : "";
      if (!projectId) throw new Error("projectId が要ります");
      await opts.releaseProjectPort(projectId, servicePortOf(args.port));
      return { content: [{ type: "text", text: JSON.stringify({ released: true }) }] };
    }

    // **宛先は host 自身**。返すのは人が作った Project の名前と根のパスだけ（値・秘密は通らない）ので承認は通さず、
    // 引ける相手と場面を絞る。出所は host の台帳が決める——Module は選べない
    if (request.params.name === "relayListProjects") {
      const origin = opts.moduleCalls?.originFor(identity.connName ?? identity.moduleName, callId);
      const why = mayListProjects(identity, origin);
      if (why) throw new Error(`${identity.moduleName} は Project の一覧を引けません（${why}）`);
      if (!opts.listProjects) throw new Error("この banto は Project の一覧を渡す口を持っていません");
      return { content: [{ type: "text", text: JSON.stringify(opts.listProjects()) }] };
    }

    // **宛先は host 自身**。返すのは、いま処理している呼び出しの Project 1件だけ（一覧ではない——ほかの Project の
    // 名前と場所は出ない）ので、AI のターンの中でも引ける。どの Project かは host の台帳が決める
    if (request.params.name === "relayCallerProject") {
      const why = mayReadCallerProject(identity);
      if (why) throw new Error(`${identity.moduleName} は呼び出し元の Project を引けません（${why}）`);
      if (!opts.listProjects) throw new Error("この banto は Project を引く口を持っていません");
      const projectId = opts.moduleCalls?.projectFor(identity.connName ?? identity.moduleName, callId);
      if (!projectId) throw new Error("どの Project のための呼び出しか決められません（Project のための呼び出しを処理している間だけ引けます）");
      const project = opts.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`呼び出し元の Project（${projectId}）が見つかりません`);
      return { content: [{ type: "text", text: JSON.stringify(project) }] };
    }

    // **宛先は host 自身**。別のサーバの Project の中身を運ぶ口——頼んだ Module（Repositories）は承認つきの口（`push_branch`・
    // `fetch_branch`）を処理している最中なので、ここでは承認を重ねず、呼べる相手を絞る。Project は host の台帳が決める
    if (
      request.params.name === RELAY_PROJECT_GIT_ORIGIN_TOOL ||
      request.params.name === RELAY_PROJECT_GIT_BUNDLE_TOOL ||
      request.params.name === RELAY_PROJECT_GIT_UNBUNDLE_TOOL ||
      request.params.name === RELAY_PROJECT_GIT_TRACK_TOOL
    ) {
      const why = mayUseProjectGit(identity);
      if (why) throw new Error(`${identity.moduleName} は Project の git に届けません（${why}）`);
      if (!opts.projectGit) throw new Error("この banto は Project の git に届く口を持っていません");
      const conn = identity.connName ?? identity.moduleName;
      // **Project の git に届くと名乗った tool を処理している呼び出しの中だけ**（レビュー L2）——同じ Module の別の仕事からは届かない
      if (!opts.moduleCalls?.mayReachProjectGit?.(conn, callId)) {
        throw new Error("Project の git に届くのは、それを名乗った tool（dev.banto/projectGit）を処理している呼び出しの中だけです");
      }
      const projectId = opts.moduleCalls.projectFor(conn, callId);
      if (!projectId) throw new Error("どの Project のための呼び出しか決められません（Project のための呼び出しを処理している間だけ届けます）");
      // 遅い線で bundle を運ぶ間、呼び出し元の待ちが切れないように進み具合を送る
      const progressToken = extra._meta?.progressToken;
      let beats = 0;
      const heartbeat =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              void extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++beats } }).catch(() => undefined);
            }, PROJECT_GIT_HEARTBEAT_MS);
      try {
        const git = opts.projectGit;
        if (request.params.name === RELAY_PROJECT_GIT_ORIGIN_TOOL) {
          return { content: [{ type: "text", text: JSON.stringify(await git.origin(projectId)) }] };
        }
        const branch = typeof args.branch === "string" ? args.branch : "";
        if (!branch) throw new Error("branch が要ります");
        if (request.params.name === RELAY_PROJECT_GIT_BUNDLE_TOOL) {
          const bundle = await git.bundle(projectId, branch);
          return { content: [{ type: "text", text: JSON.stringify(bundle ? { bundle: bundle.toString("base64") } : { absent: true }) }] };
        }
        if (request.params.name === RELAY_PROJECT_GIT_TRACK_TOOL) {
          await git.track(projectId, branch, typeof args.commit === "string" ? args.commit : "");
          return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
        }
        const b64 = typeof args.bundle === "string" ? args.bundle : "";
        if (!b64) throw new Error("bundle が要ります");
        if (b64.length > Math.ceil(PROJECT_GIT_BUNDLE_MAX_BYTES / 3) * 4 + 4) throw new Error(`bundle が大きすぎます（${PROJECT_GIT_BUNDLE_MAX_BYTES / 1024 / 1024}MB まで）`);
        await git.unbundle(projectId, branch, Buffer.from(b64, "base64"));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    }

    // **宛先は host 自身**。値は通らない（文言だけ）ので承認は通さず、出せる相手を絞る
    if (request.params.name === "relayRaiseNotice") {
      const why = mayRaiseNotice(identity);
      if (why) throw new Error(`${identity.moduleName} は受信箱に知らせを出せません（${why}）`);
      if (!opts.raiseNotice) throw new Error("この banto は受信箱に知らせを出す口を持っていません");
      const field = (name: keyof typeof NOTICE_LIMITS): string => {
        const v = args[name];
        if (typeof v !== "string" || v.trim() === "") throw new Error(`${name} が要ります`);
        if (v.length > NOTICE_LIMITS[name]) throw new Error(`${name} が長すぎます（${NOTICE_LIMITS[name]} 字まで）`);
        return v;
      };
      // **どの会話で起きたか**（追加・2026-10-15、アーキ仕様 §2.4）——呼び出しの印（`callId`）が付いていて、その呼び出しが
      // 1つの会話のものなら添える。印が無ければ添えない：接続で走っている別の呼び出しの会話を、関係なく拾ってしまう
      const where = callId ? opts.moduleCalls?.threadFor(identity.connName ?? identity.moduleName, callId) : undefined;
      const threadId = where?.kind === "thread" && "threadId" in where && typeof where.threadId === "string" ? where.threadId : undefined;
      await opts.raiseNotice(identity, {
        key: field("key"),
        title: field("title"),
        detail: field("detail"),
        ...(threadId ? { threadId } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    }

    // **宛先は host 自身**。出来事は「起きたこと」で値は通らないので承認は通さず、出せる相手を絞る。断りは値で返す
    // （出口の箱が捨てられるように）——口が無いときだけ投げる（一時の失敗として箱に残る）
    if (request.params.name === RELAY_EMIT_EVENT_TOOL) {
      if (!opts.emitEvent) throw new Error("この banto は出来事を受ける口を持っていません");
      const why = mayEmitEvent(identity);
      const reply =
        why || identity.projectId === undefined
          ? { refused: `${identity.moduleName} は出来事を出せません（${why ?? "Project ごとの Module だけが出せる"}）` }
          : await opts.emitEvent({ ...identity, projectId: identity.projectId }, args);
      return { content: [{ type: "text", text: JSON.stringify(reply) }] };
    }

    // **宛先は host 自身**。目録にある本体を取ってこさせるだけ（値・秘密は通らない）ので承認は通さず、呼べる相手を絞る
    if (request.params.name === "relayEnsureAgentBinary" || request.params.name === "relayAgentBinaryStatus") {
      const ensure = request.params.name === "relayEnsureAgentBinary";
      const why = ensure ? mayEnsureAgentBinary(identity) : mayReadAgentBinaryStatus(identity);
      if (why) throw new Error(`${identity.moduleName} はエージェントの本体を${ensure ? "取ってこさせられません" : "確かめられません"}（${why}）`);
      const agent = typeof args.agent === "string" ? args.agent : "";
      if (!agent) throw new Error("agent が要ります");
      if (!ensure) {
        if (!opts.agentBinaryStatus) throw new Error("この banto はエージェントの本体を確かめる口を持っていません");
        return { content: [{ type: "text", text: JSON.stringify(opts.agentBinaryStatus(agent)) }] };
      }
      if (!opts.ensureAgentBinary) throw new Error("この banto はエージェントの本体を取ってくる口を持っていません");
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const placed = await opts.ensureAgentBinary(identity, agent, (message) => {
        if (progressToken === undefined) return;
        void extra
          .sendNotification({ method: "notifications/progress", params: { progressToken, progress: ++progress, message } })
          .catch(() => undefined);
      });
      return { content: [{ type: "text", text: JSON.stringify(placed) }] };
    }

    // **他の Module ではなく host に届ける**——承認ゲートは通さない：宛先は札が決めていて、札はこの Module が
    // 呼び出し元の AI から受け取ったもの（その AI が頼んだ仕事の返事）。起こしすぎはホップ数と速度で縛る
    if (request.params.name === "relayDeliverToThread") {
      if (!opts.deliverToThread) throw new Error("この banto は Thread に届ける口を持っていません");
      const replyTo = typeof args.replyTo === "string" ? args.replyTo : "";
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const text = typeof args.text === "string" ? args.text : "";
      if (!replyTo || !title) throw new Error("replyTo と title が要ります");
      const r = await opts.deliverToThread(identity, { replyTo, title, text, final: args.final !== false });
      if (!r.ok) throw new Error(r.error);
      return { content: [{ type: "text", text: JSON.stringify({ deliveryId: r.deliveryId, wake: r.wake }) }] };
    }

    const targetModule = String(args.targetModule ?? "");
    const kind: RelayAuditRecord["kind"] = request.params.name === "relayReadResource" ? "resource" : "tool";
    const name = String(args.name ?? args.uri ?? "");
    // **宛先は先に引く**——承認の鍵に「いま何のコードが動いているか」を入れるため（使うときに起こす宛先は、起こした後に下で引き直す）
    const targetBefore = opts.registry.getModule(targetModule);
    const call = {
      projectId: identity.projectId,
      callerModule: identity.moduleName,
      targetModule,
      kind,
      name,
      // **外から繋いだ Module への承認は、そのコードに縛る**（上記 codeId）。使うときに起こすのは同梱だけなので、起こす前に引いた値でよい
      ...(targetBefore?.meta.origin !== "bundled" && targetBefore?.codeId ? { targetCodeId: targetBefore.codeId } : {}),
    };

    // **何を指していたか**は、宛先の tool を読むまで分からない（下で埋まる）
    let identifiers: Record<string, string> | undefined;
    /** **まとめて呼ぶ口なら、要素ごとの識別子**（下で埋まる）。監査はこの1件ごとに1行 */
    let batch: { tool: string; items: Record<string, string>[] } | undefined;
    const audit = async (allowed: boolean, reason?: string, ok?: boolean) => {
      const ts = new Date().toISOString();
      if (batch) {
        const size = batch.items.length;
        for (const item of batch.items) {
          await opts.onAudit?.({
            ...call,
            ...(Object.keys(item).length > 0 ? { identifiers: item } : {}),
            batch: { size },
            allowed,
            reason,
            ok,
            ts,
          });
        }
        return;
      }
      await opts.onAudit?.({
        ...call,
        ...(identifiers ? { identifiers } : {}),
        allowed,
        reason,
        ok,
        ts,
      });
    };

    // **起こし直したときの問いは host だけが呼ぶ**（追加・2026-10-05、Fable のレビュー。`@banto/module-contract` の
    // `resume.ts`）——中継からは断る（宛先の Module も呼び元の印で断るが、ここでも通さない）
    if (kind === "tool" && name === RESUME_AFTER_RESTART_TOOL) {
      await audit(false, "起こし直したときの問いは banto 本体だけが呼べる");
      throw new Error(`${name} は banto 本体だけが呼べます（中継からは呼べません）`);
    }

    if (!opts.registry.getModule(targetModule) && opts.connectOnDemand) {
      try {
        await opts.connectOnDemand(identity, targetModule);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await audit(false, reason);
        throw err;
      }
    }
    // 起こしたなら引き直す（繋がっていなければ undefined のまま——下で断る）
    const target = opts.registry.getModule(targetModule);

    let notAllowed = opts.registry.whyNotAllowed(identity, targetModule, onBehalfOf);
    // **持ち主が、自分の置いた秘密から渡す値を作る口**（追加・2026-10-18、Backlog #405。アーキ仕様 §2.5）。Vault が持ち主でない
    // 呼び元に `oauth-token` を渡す前に、置いた Module に今の値を見せる。どの Module が持ち主かは Vault の台帳が決めるので、Vault は
    // 持ち主を依存に宣言しない——**この口に限って「宣言された依存に含まれない」を外す**。そのために、この形の呼び出しだけは
    // 宛先の tool を依存より先に読む。Project の縛りは外さない（宛先は banto 全体の Module だけ）。名乗っていなければ今までどおり断る
    const targetInfoEarly =
      kind === "tool" && target && notAllowed === NOT_IN_DEPENDENCIES && mayPresentOwnedSecret(identity, target)
        ? await targetTool(target.client, name)
        : undefined;
    const presentsOwnedSecretCall = targetInfoEarly?.presentsOwnedSecret === true;
    if (presentsOwnedSecretCall) notAllowed = undefined;
    if (notAllowed) {
      await audit(false, notAllowed);
      throw new Error(`${identity.moduleName} は ${targetModule} を呼ぶ権限がありません（${notAllowed}）`);
    }

    if (!target) {
      await audit(false, "宛先の Module が繋がっていない");
      throw new Error(`target module "${targetModule}" is not connected`);
    }

    // **初回だけ人に聞く**（アーキ仕様 §2.5）。宣言された依存は「配線として
    // あり得るか」で、こちらは「その配線を実際に使ってよいか」——別の問い。
    //
    // 人はすぐには答えない。**待っている間、呼び出し元に進捗を送り続ける**
    // （docs/specs/v4-frontend.md「Module 間中継の承認」の 2.）——さもないと
    // MCP の既定60秒で呼び出し元が先に諦め、「承認したのに、その回の操作は
    // 失敗している」になる。呼び出し元が progressToken を付けてこないときは
    // 送りようがない（その場合は60秒で切れる、という今までの挙動のまま）
    // **人が管理画面で押した「管理操作」は、聞き直さない**（決定・2026-09-12。
    // docs/specs/v4-modules.md §2.1 C節が「未決」としていた承認ゲートの循環）。
    //
    // 実測で分かったこと：VaultUI のような「依存先を操作するための画面」は、
    // **開いた瞬間の読み取りから**ゲートに掛かる。人は管理画面を開いたのに、
    // 画面は無言で止まり、答えは別の会話に出る——聞いている内容は
    // 「あなたがいま開いた画面が、その画面の目的どおり動いてよいか」でしかない。
    //
    // **ただし緩めるのは `admin`（人の管理操作）だけ。** `module` 可視性
    // ——Vault の `resolveAlias` のような**値を返す部品間専用の口**——は、
    // 出所が画面でも今までどおり聞く。さもないと、悪意ある Module が自分の
    // 画面から admin tool を1つ生やし、その中で他 Module の秘密を引いて
    // ブラウザへ返す道が、人に一度も見られずに開く（2026-09-10 の
    // `docs/specs/v4-security.md` で塞いだ穴と同じ形）。
    //
    // **改訂・2026-09-20（ユーザー決定）：同梱どうしなら `module` も通す。**
    // 上の但し書きが成り立つのは**第三者 Module が絡むとき**だけだった。
    // 実際に詰まったのは Vault をまたぐ移動——窓口が移す元で `resolveAlias` を
    // 呼ぶので、**人が「移す」を押した瞬間にゲートで止まり、画面は無言のまま**
    // 受信箱に承認のお願いだけが積まれていた（2026-09-20、ユーザー報告）。
    // 上の「画面は無言で止まり、答えは別の会話に出る」が、`module` 可視性でも
    // そのまま起きていた。**両側が同梱のときだけ**緩める——悪意ある Module の
    // 画面という筋書きは、そこに第三者が居ることが前提なので、その形は塞がれたまま。
    //
    // **もうひとつ緩めるのは「値を返さない口」だけ**（決定・2026-09-12）。
    // ゲートが守っているのは**値**であって名前ではない——`relayListTargets` を
    // 承認も監査も通さないのと同じ理由（返すのが名前と role だけだから）。
    // 窓口（vault-directory）が金庫を横断して**一覧を組み立てる**のは、
    // その Module のただ1つの仕事であり、値は1バイトも通らない。ここを聞くと、
    // **AI が目録を読むたびに人が止められる**——しかも resource の読み取りは
    // 進捗を送れないので、60秒で切れて「alias が1つも無い」に化けていた。
    //
    // **名乗った Module だけが緩む**（`dev.banto/valueFree`、無指定は「返す」）。
    const origin = opts.moduleCalls?.originFor(identity.connName ?? identity.moduleName, callId);
    const targetInfo = targetInfoEarly ?? (kind === "tool" ? await targetTool(target.client, name) : undefined);
    // **返事の受け口は host だけが呼ぶ**（追加・2026-10-05）——他の Module が呼べると、頼んだ仕事の返事を偽られる
    if (targetInfo?.receivesReplies) {
      await audit(false, "返事の受け口は host だけが呼ぶ");
      throw new Error(`${targetModule} の ${name} は返事の受け口です。中継からは呼べません`);
    }
    // **名乗った引数だけを拾う**（値そのものは拾わない）。長すぎるものも拾わない
    // ——識別子のつもりの欄に値が入っていたときに、記録へ流し込まないため
    const callArgs = (args.arguments ?? {}) as Record<string, unknown>;
    if (targetInfo?.auditArgs.length) {
      const picked: Record<string, string> = {};
      for (const key of targetInfo.auditArgs) {
        const v = callArgs[key];
        if (isIdentifier(v)) picked[key] = v;
      }
      if (Object.keys(picked).length > 0) identifiers = picked;
    }
    // **まとめて呼ぶ口**（追加・2026-10-18、`dev.banto/batchOf`）。要素の1つ1つを `batchOf.tool` の1回ぶんとして承認する。
    // **信じるのは同梱の宛先だけ**（`valueFree` と同じ線）。ただし信じない＝通す、ではない——第三者の口が名乗っていて呼び手が
    // コンテナの中なら断る（普通の tool として扱うと配列から識別子が拾えず、鍵が `scope: {}` の1つに潰れる）
    if (targetInfo?.batchOf) {
      if (target.meta.origin === "bundled") {
        const picked = pickBatchItems(targetInfo.batchOf, callArgs);
        if ("refused" in picked) {
          await audit(false, picked.refused);
          throw new Error(`${targetModule} の ${name} への中継を断りました：${picked.refused}`);
        }
        batch = picked;
      } else if (identity.inContainer) {
        const why = "同梱でない Module のまとめて呼ぶ口は、コンテナの中からは呼べない";
        await audit(false, why);
        throw new Error(`${targetModule} の ${name} への中継を断りました：${why}`);
      }
    }
    // **読むだけの回の中継**（追加・2026-10-20、アーキ仕様 §4.4）。呼び元の呼び出しが読むだけの会話のターンから始まったなら、
    // 宛先も読むだけのものに限る——同梱の宛先が `dev.banto/effect: "read"` を名乗る tool か、人が許したもの。資源は同梱か、人が
    // 「資源を読む」を許した Module だけ。どの会話か1つに決まらないときは、候補のどれかが読むだけなら読むだけとして扱う（fail closed）
    const readOnlyRun = isReadOnlyRun(identity, opts, callId);
    if (readOnlyRun) {
      const targetName = target.declaredName ?? target.name;
      const project = identity.projectId ?? opts.moduleCalls?.projectFor(identity.connName ?? identity.moduleName, callId);
      const allowed = project ? (opts.patrolAllowedTools?.(project) ?? []) : [];
      const bundledTarget = target.meta.origin === "bundled";
      const ok =
        kind === "tool"
          ? targetInfo !== undefined &&
            (mayCallInReadOnly({
              moduleName: targetName,
              bundled: bundledTarget,
              tool: { name, ...(targetInfo.readEffect ? { _meta: { [EFFECT_META_KEY]: "read" } } : {}) },
              allowed,
            }) ||
              // 同梱の banto 全体の Module が、自分の資格情報を Vault から引く・回った組を書き戻す（AI には返らない）
              mayRelayOwnCredentialInReadOnly({
                caller: { bundled: identity.meta?.origin === "bundled", inContainer: identity.inContainer === true, projectScoped: identity.projectId !== undefined },
                target: { bundled: bundledTarget, roles: target.meta.satisfies },
                tool: { name, callerOwned: targetInfo.callerOwned },
              }))
          : mayReadResourcesInReadOnly({ moduleName: targetName, bundled: bundledTarget, allowed });
      if (!ok) {
        await audit(false, "読むだけの回からの、読むだけでない宛先への中継");
        throw new Error(`${targetModule} の ${name} への中継を断りました：${READ_ONLY_REFUSAL}`);
      }
    }
    const humanAdminAction = origin === "canvas" && targetInfo?.visibility === "admin";
    /**
     * **人が画面で押した、同梱どうしの操作**（決定・2026-09-20、ユーザー）。
     *
     * `humanAdminAction` と根拠は同じ（人が押した）だが、**可視性を問わない**
     * ——`module` 可視性の口（値を返す口）も通す。Vault をまたぐ移動のように、
     * 人が押した1つの操作が内部で値を運ぶ経路がある。
     *
     * **第三者が絡んだら今までどおり聞く。** ここを両側同梱に限っているのが、
     * 「悪意ある Module が自分の画面から他 Module の秘密を引く」を塞ぐ線。
     */
    const humanBundledCanvasCall =
      origin === "canvas" && target.meta.origin === "bundled" && identity.meta?.origin === "bundled";
    /**
     * **banto 自身が始めた、同梱どうしの呼び出し**（追加・2026-09-18）。
     *
     * 中継のゲートが人に聞いているのは「**Module A に Module B を呼ばせて
     * よいか**」。ところが `${secret:…}` の解決やログイン情報の保管は、
     * **banto 自身が、自分の同梱 Module に対して**始める——聞く相手も、
     * 聞く会話も無い（背景の接続中に起きるので、出せるターンが無い）。
     *
     * **`canvas` の緩めとは別に置く**。あちらは「人が押した」ことを根拠に
     * するが、これは「banto が自分の部品を使った」ことを根拠にする。
     *
     * **両側が同梱のときだけ。** 第三者が絡んだら今までどおり聞く
     * ——`host` を名乗れるのは banto 自身だけだが、**宛先が第三者なら
     * 話は別**（そこへ引数が流れる）。
     */
    const ownHousekeeping =
      origin === "host" && target.meta.origin === "bundled" && identity.meta?.origin === "bundled";
    // **`valueFree` を信じるのは、同梱の Module だけ**（訂正・2026-09-15、
    // レビューで発覚。`docs/specs/v4-security.md` が「外から Module を
    // 入れられるようにする前に決める」と課していた行の決着）。
    //
    // `valueFree` は**戻り値**が無いことの宣言だが、呼び出しには**引数**があり、
    // 引数は宛先へ流れる。第三者 Module が `valueFree` を名乗る tool を1本持てば、
    // **そこへの中継は承認ゲートを飛ぶ**——承認済みの `resolveAlias` で得た値を
    // 引数に積めば、承認ゼロの持ち出し口になる。
    //
    // 呼び出し側の「無指定は値を返す扱い」は fail closed だが、
    // **宛先の申告を信じる方向は fail open** だった。
    const valueFreeCall = targetInfo?.valueFree === true && target.meta.origin === "bundled";
    /**
     * **呼び元の Module が持ち主のものだけを書き換える口**（追加・2026-10-06、`dev.banto/callerOwned`）。
     *
     * ゲートが聞いているのは「Module A に Module B を呼ばせてよいか」。ところが banto 自身の部品が、自分で置いた
     * ものを置き換えるだけの呼び出し（Repositories が回った GitHub のログインを Vault に書き戻す）は、AI のターンの
     * 中で起きると人を待ち、答えが無いまま切れると、相手が既に無効にした古い鍵だけが Vault に残っていた。
     *
     * - **持ち主の確かめは宛先がする**——host は持ち主を知らない。だから名乗りを信じるのは**同梱の宛先だけ**
     *   （確かめない第三者の口が名乗るだけで緩むと、承認ゼロの書き込み口になる。`valueFree` と同じ線）
     * - **呼び元も同梱で、banto 本体で動く banto 全体の Module だけ**——持ち主は呼び元の Module の刻印（下で host が刻む）で
     *   決まる。外から入れた Module のコードは何を書くか分からず、コンテナの中の Module は AI が合言葉を読めて、
     *   その Module の名で書ける（`mayRaiseNotice` と同じ線）。どちらも今までどおり聞く
     */
    const callerOwnedCall =
      targetInfo?.callerOwned === true &&
      target.meta.origin === "bundled" &&
      identity.meta?.origin === "bundled" &&
      !identity.inContainer &&
      // banto 全体の Module だけ（`mayRaiseNotice` 等と同じ線）——Project の Module はいまコンテナの中でしか動かないが、
      // コンテナ無しの起動形態ができても、その Project の AI の手の届く Module が承認なしで書けないように
      identity.projectId === undefined;
    /**
     * **受けた中身を残さず変換して返すだけの口**（追加・2026-10-15、`dev.banto/statelessTransform`、`docs/specs/v4-modules.md`
     * §2.2「変換役」の承認）。FileSystem（Project のコンテナの中・別のサーバの Project ではそのサーバ）が Office の文書を
     * 変換役に渡すたびに人を待たせない。
     *
     * - **宛先は同梱で、同梱の道具用のコンテナで動くものだけ**——閉じ込め（1件ごとの囲い・中で sudo できない・第三者と
     *   同居しない）が前提。名乗りを信じるのは同梱の宛先だけ（`valueFree` と同じ線）。置き場は host が刻んだもの
     * - **呼び元は同梱なら、コンテナの中でもよい**（`callerOwned` と違う）——Project の AI が FileSystem の合言葉で
     *   なりすましても、得るのは「自分が既に持つバイト列を変換させる」ことだけ
     */
    const statelessTransformCall =
      targetInfo?.statelessTransform === true &&
      target.meta.origin === "bundled" &&
      target.toolsContainer === true &&
      identity.meta?.origin === "bundled";

    // **起こし直しのために止めている間は、新しい中継を断る**（追加・2026-10-05、アーキ仕様 §2.5「いま動いているもの」）。
    // ただし**実行中の呼び出しの中の中継は通す**——止める前に待つのはその呼び出しが終わるまでで、中継を断ると待っている
    // 呼び出しそのものが失敗する。走っている呼び出しに属さない中継（終わった呼び出しの後の仕事・Module が自分で始めた
    // もの）だけ断る。承認を聞く前に断る（止める間に新しいカードを出さない）
    if (opts.moduleCalls?.isStopping?.() && !opts.moduleCalls.isRunning?.(identity.connName ?? identity.moduleName, callId)) {
      await audit(false, "banto を起こし直しているため断った");
      throw new Error(RESTARTING_REFUSAL);
    }
    const progressToken = extra._meta?.progressToken;
    const heartbeat =
      opts.gate &&
      !humanAdminAction &&
      !humanBundledCanvasCall &&
      !ownHousekeeping &&
      !valueFreeCall &&
      !callerOwnedCall &&
      !statelessTransformCall &&
      !presentsOwnedSecretCall &&
      progressToken !== undefined
        ? setInterval(() => {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: 0, message: "人の承認を待っています" },
            });
          }, opts.approvalProgressIntervalMs ?? APPROVAL_PROGRESS_INTERVAL_MS)
        : undefined;
    heartbeat?.unref();
    const decision = await (ownHousekeeping
      ? Promise.resolve({ allowed: true, reason: "banto 自身の同梱 Module どうしの呼び出し" })
      : humanAdminAction
      ? // 記録には**なぜ通したか**を残す（黙って通らない、規則2）
        Promise.resolve({ allowed: true, reason: "人が画面で行った管理操作" })
      : humanBundledCanvasCall
      ? Promise.resolve({ allowed: true, reason: "人が画面で行った、同梱 Module どうしの操作" })
      : valueFreeCall
      ? Promise.resolve({ allowed: true, reason: "値を返さない口" })
      : callerOwnedCall
      ? Promise.resolve({ allowed: true, reason: "呼び元の Module が持ち主のものだけを書き換える口" })
      : statelessTransformCall
      ? Promise.resolve({ allowed: true, reason: "同梱の道具用のコンテナの、受けた中身を残さず変換して返すだけの口" })
      : presentsOwnedSecretCall
      ? Promise.resolve({ allowed: true, reason: "持ち主が、自分の置いた秘密から渡す値を作る口" })
      : opts.gate
        ? opts.gate
            .requestApproval(
              batch
                ? {
                    // **1件ずつを `batchOf.tool` の呼び出しとして聞く**——鍵が1件ずつの口と同じになる
                    ...call,
                    name: batch.tool,
                    callerConnName: identity.connName ?? identity.moduleName,
                    ...(callId ? { callerCallId: callId } : {}),
                    batch: { name, size: batch.items.length, ...(identity.inContainer ? { scopes: batch.items } : {}) },
                    ...(readOnlyRun ? { noAsk: true } : {}),
                  }
                : {
                    ...call,
                    callerConnName: identity.connName ?? identity.moduleName,
                    ...(callId ? { callerCallId: callId } : {}),
                    // コンテナからは、何を指していたかごとに聞く（名乗った識別子。無ければ空——それでも印になる）
                    ...(identity.inContainer ? { scope: identifiers ?? {} } : {}),
                    ...(readOnlyRun ? { noAsk: true } : {}),
                  },
            )
            .finally(() => clearInterval(heartbeat))
        : Promise.resolve({ allowed: true, reason: "ゲート無し" }));
    if (!decision.allowed) {
      await audit(false, decision.reason);
      throw new Error(
        `${identity.moduleName} から ${targetModule} の ${name} への中継は許可されていません：${decision.reason}`,
      );
    }

    // **宛先にも在籍を立てる**——この呼び出しが終わるまで、宛先が出す中継は
    // 同じターン（同じ会話・同じ出所）の仕事として扱われる
    const callerConn = identity.connName ?? identity.moduleName;
    const callerThread = opts.moduleCalls?.threadFor(callerConn, callId);
    // **呼び出し元の Project**（追加・2026-09-13）。Project 単位で起きた Module
    // （Shell）は自分の身元に持っている。instance 単位の Module（窓口）は
    // 持たないので、**外側から継ぐ**——Thread と同じ形（推測しない、規則3）
    const callerProject = identity.projectId ?? opts.moduleCalls?.projectFor(callerConn, callId);
    const targetArgs = [
      targetModule,
      callerThread?.kind === "thread" ? (callerThread as { threadId: string }).threadId : undefined,
      origin ?? "turn",
      callerProject,
      // **banto 全体のための呼び出しも継ぐ**（追加・2026-09-16）——継がないと
      // 窓口→金庫の2段目で「誰のためか分からない」に落ちる
      opts.moduleCalls?.instanceFor?.(callerConn, callId) ?? false,
    ] as const;
    // **AI のどの tool 呼び出しの中の仕事かも継ぐ**（追加・2026-10-05）——宛先の中の承認・質問も、会話のその呼び出しに結びつく
    const callerToolUseId = opts.moduleCalls?.toolUseIdFor?.(callerConn, callId);
    // **宛先にも呼び出しの印を渡す**（追加・2026-09-28）——宛先がさらに中継を呼ぶとき、この1件を名指せる
    const targetCall = opts.moduleCalls?.beginCall
      ? opts.moduleCalls.beginCall(
          ...targetArgs,
          callerToolUseId,
          { connName: callerConn, ...(callId ? { callId } : {}) },
          // Project の git の口に届く印は、同梱の宛先の名乗りだけを信じる
          targetInfo?.projectGit === true && target.meta.origin === "bundled" ? { projectGit: true } : undefined,
        )
      : { id: undefined, end: opts.moduleCalls?.begin(...targetArgs) };
    const endTargetCall = targetCall.end;

    /**
     * **誰のための呼び出しかを host が刻む**（決定・2026-09-13）。
     * 人が管理画面から触っているとき（canvas 由来）は `admin`——Project では
     * ないが、**「決められない」でもない**。刻まないと受け手が止まる。
     */
    //
    // **`{instance:true}`（banto 全体のため）も刻む**（追加・2026-09-16）。
    // `${secret:…}` の解決は窓口→金庫の2段で、2段目は中継を通る。
    //
    // **人が画面で押した呼び出しの中なら、Project が分かっても `admin` を刻む**（改訂・2026-09-28、Fable のレビュー）。
    // Project の画面からの呼び出しは台帳に Project を置くようになった（その Project の Module を呼べるように）ので、
    // 以前の順（Project が分かれば `{project}`）のままだと、人の操作の印が消える——publish-caddy の「人が押したときだけ」
    // が人の承認を断る。**Project は `forProject` に併記する**（名前を `project` にしない理由は `CallerStamp`）。
    // これを使うのは **banto 全体の Module** だけ：Project の Module の画面からの中継は今までどおり `{project}`
    // （自分の Project に縛られている Module に、人の画面だからといって全体を見せない——今までの挙動のまま）
    const ambient = opts.moduleCalls?.callerFor?.(callerConn, callId);
    const humanCanvas = origin === "canvas" && identity.projectId === undefined;
    const callerMeta: Record<string, unknown> = humanCanvas
      ? { [CALLER_META_KEY]: { admin: true, ...(callerProject ? { forProject: callerProject } : {}) } }
      : callerProject
        ? { [CALLER_META_KEY]: { project: callerProject } }
        : ambient
          ? { [CALLER_META_KEY]: ambient }
          : origin === "canvas"
            ? { [CALLER_META_KEY]: { admin: true } }
            : {};
    if (targetCall.id) callerMeta[CALL_ID_META_KEY] = targetCall.id;
    // **頼んだ Module を刻む**（追加・2026-10-06、`CALLER_MODULE_META_KEY`）。呼び元は合言葉で決まる（申告ではない）——
    // 宛先は「頼んだ Module からだけ止められる」（`conn`）・banto が置く秘密の持ち主（`name`、`callerOwned` の口）等の確かめに使う。
    // `callerMeta` は host が組み立てたもので、呼び元が自分で `_meta` に書いた同じ名前の鍵は宛先に渡らない
    callerMeta[CALLER_MODULE_META_KEY] = { name: identity.moduleName, conn: callerConn };
    // **人に聞かずに許可してよいか**（追加・2026-10-05、v4-frontend.md §6.4「承認をすべて自動で許可する」）。AI のターンから
    // 始まった、スイッチがオンの Project のための呼び出しにだけ刻む——Publish の窓口が中で実装の `publishRoute` を呼ぶとき、
    // 実装は人の刻印の代わりにこれを見る。**呼び出し元の申告は使わない**（Project と出所は host の台帳から引いている）
    const callerThreadId = callerThread?.kind === "thread" ? (callerThread as { threadId: string }).threadId : undefined;
    // 読むだけの回では刻まない（人に聞かずに断る回で「聞かずに許可してよい」と伝えない）。代わりに読むだけの回だと刻む
    if (readOnlyRun) callerMeta[RESTRICTION_META_KEY] = "read-only";
    else if (!humanCanvas && origin === "turn" && callerProject && opts.autoApproveFor?.(callerProject, callerThreadId) === true) {
      callerMeta[AUTO_APPROVE_META_KEY] = true;
    }

    // コンテナの中の呼び出し元には、窓口を立てる場所も刻む（呼び出し元の申告は使わない）
    if (identity.socketDir) callerMeta[SOCKET_DIR_META_KEY] = identity.socketDir;

    // **終わったら届ける tool には、呼んだ Module に結びついた札を渡す**（追加・2026-10-05、アーキ仕様 §4.2）。
    // 呼んだ Module が受け口を名乗っていなければ出さない——宛先は「届ける先がない」と断る（規則2）
    const reply =
      request.params.name === "relayCallTool" &&
      targetInfo?.deliversLater &&
      opts.replies &&
      (await hasReplyReceiver(opts.registry.getModule(callerConn)?.client))
        ? opts.replies.issueToModule({
            to: { connName: callerConn, moduleName: identity.moduleName },
            ...(callerProject ? { projectId: callerProject } : {}),
            connName: targetModule,
            moduleName: target.declaredName ?? target.name,
          })
        : undefined;
    if (reply) callerMeta[REPLY_TO_META_KEY] = reply.replyTo;

    try {
      if (request.params.name === "relayCallTool") {
        // 実データは host のプロセスメモリを一過性に通過するだけ——
        // ディスクにもEvent Storeにも記録しない。記録するのは識別子だけ。
        //
        // **上限は host が自分で数え、宛先の進捗を呼び元へ中継する**（追加・2026-10-05、AI の道（`agent-proxy.ts`）と同じ形）。
        // 以前はオプション無しで呼んでいて、宛先が進捗を送っていても MCP の既定 60 秒で切れていた（実測・2026-10-05、
        // 5 秒ごとに進捗を送る 65 秒の宛先が 60.0 秒で -32001）——宛先に progressToken を渡していなかった。
        // 宛先の進捗で数え直し、宛先が人を待つ間（入れ子の中継の承認）は数えない。呼び元が取り消したら宛先へも取り消す
        const watchdog = new AbortController();
        const idleLimit = opts.relayIdleTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
        const targetWaitingOnHuman = () =>
          (targetCall.id !== undefined && opts.moduleCalls?.isWaitingOnHuman?.(targetModule, targetCall.id) === true) ||
          opts.moduleCalls?.isModuleWaitingOnHuman?.(targetModule) === true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (targetWaitingOnHuman()) {
              arm();
              return;
            }
            watchdog.abort(new McpError(ErrorCode.RequestTimeout, "Request timed out", { timeout: idleLimit }));
          }, idleLimit);
        };
        arm();
        const humanWait = setInterval(() => {
          if (!targetWaitingOnHuman()) return;
          arm();
          if (progressToken === undefined) return;
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: 0, message: "人の承認を待っています" },
            })
            .catch(() => undefined);
        }, opts.approvalProgressIntervalMs ?? APPROVAL_PROGRESS_INTERVAL_MS);
        humanWait.unref();
        const onOuterAbort = () => watchdog.abort(extra.signal.reason);
        if (extra.signal.aborted) onOuterAbort();
        else extra.signal.addEventListener("abort", onOuterAbort, { once: true });
        let result: { content: unknown[]; _meta?: Record<string, unknown> };
        try {
          result = (await target.client.callTool(
            {
              name,
              arguments: (args.arguments as Record<string, unknown>) ?? {},
              _meta: callerMeta,
            },
            undefined,
            {
              signal: watchdog.signal,
              // SDK の上限は使わない（上の見張りが数える）。setTimeout に渡せる最大
              timeout: 2 ** 31 - 1,
              onprogress: (progress) => {
                arm();
                if (progressToken !== undefined) {
                  void extra
                    .sendNotification({ method: "notifications/progress", params: { ...progress, progressToken } })
                    .catch(() => undefined);
                }
              },
            },
          )) as { content: unknown[]; _meta?: Record<string, unknown> };
        } finally {
          if (timer) clearTimeout(timer);
          clearInterval(humanWait);
          extra.signal.removeEventListener("abort", onOuterAbort);
        }
        // **別のサーバの呼び元には、窓口を向こうのパスにして返す**（v4-security.md §1「ソケットの転送」）
        if (identity.socketDir && identity.socketPathInside) {
          result = await rewriteSocketPaths(result, identity.socketDir, identity.socketPathInside);
        }
        await audit(true, decision.reason, true);
        // **「あとで届ける」と約束したら、札を返事待ちにし、呼んだ Module に返事の印を見せる**（札そのものは見せない）
        if (reply && result._meta?.[PENDING_REPLY_META_KEY] === true) {
          await opts.replies!.markAwaiting(reply.replyTo, waitingOnOf(result._meta));
          return { ...result, _meta: { ...result._meta, [REPLY_ID_META_KEY]: reply.replyId } };
        }
        return result;
      }

      if (request.params.name === "relayReadResource") {
        const result = await target.client.readResource({ uri: name, _meta: callerMeta });
        await audit(true, decision.reason, true);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
    } catch (err) {
      // **失敗も記録する**——監査で見たいのはむしろこちら（規則2）
      await audit(true, err instanceof Error ? err.message : String(err), false);
      throw err;
    } finally {
      endTargetCall?.();
    }

    throw new Error(`unknown relay tool: ${request.params.name}`);
  });

  return server;
}

/**
 * 応答の中の窓口のパス（`{"socketPath": …}` の text）が呼び元の `socketDir` の直下なら、`inside` で中から届くパスにする
 * （転送を張るのも `inside`）。`socketDir` の外のパス・ほかの形の応答には触らない
 */
export async function rewriteSocketPaths<T extends { content: unknown[]; isError?: unknown }>(
  result: T,
  socketDir: string,
  inside: (hostPath: string) => Promise<string>,
): Promise<T> {
  if (result.isError === true || !Array.isArray(result.content)) return result;
  const dir = socketDir.replace(/\/+$/, "");
  const content = await Promise.all(
    result.content.map(async (item) => {
      const c = item as { type?: unknown; text?: unknown };
      if (c.type !== "text" || typeof c.text !== "string") return item;
      let body: unknown;
      try {
        body = JSON.parse(c.text);
      } catch {
        return item;
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) return item;
      const socketPath = (body as { socketPath?: unknown }).socketPath;
      if (typeof socketPath !== "string" || !socketPath.startsWith(`${dir}/`) || socketPath.slice(dir.length + 1).includes("/")) return item;
      return { ...c, text: JSON.stringify({ ...body, socketPath: await inside(socketPath) }) };
    }),
  );
  return { ...result, content };
}

/**
 * Node.js の http.createServer ハンドラの一部として使う。
 * `/relay` パスへのリクエストを、Authorizationヘッダのbearer tokenで
 * 識別してから中継サーバに渡す。
 */
export class HostRelayEndpoint {
  private readonly sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport; identity: CallerIdentity }
  >();

  constructor(private readonly opts: HostRelayServerOptions) {}

  /**
   * `accepts`：その待ち受けで受けてよい呼び元か（別のサーバ用の専用の待ち受けは、その実行場所の Project の合言葉だけを
   * 受ける——`relay-listener.ts`）。続きの要求（`mcp-session-id`）も、始めた呼び元で確かめ直す——別の口で始めた
   * セッションを、この口から続けさせない
   */
  async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
    accepts?: (identity: CallerIdentity) => boolean,
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const unauthorized = () => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));

    let entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (entry && accepts && !accepts(entry.identity)) {
      unauthorized();
      return;
    }
    if (!entry) {
      const authHeader = req.headers["authorization"];
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer /, "") : undefined;
      const identity = token ? this.opts.registry.resolveToken(token) : undefined;
      if (!identity || (accepts && !accepts(identity))) {
        unauthorized();
        return;
      }
      const server = buildRelayServer(identity, this.opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { server, transport, identity });
        },
      });
      await server.connect(transport);
      entry = { server, transport, identity };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }
}
