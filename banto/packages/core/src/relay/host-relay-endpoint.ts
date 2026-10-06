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
  ON_BEHALF_OF_META_KEY,
  callIdOf,
  SOCKET_DIR_META_KEY,
  isValueFree,
  visibilityOf,
  RESUME_AFTER_RESTART_TOOL,
  type BantoModuleMeta,
  type Visibility,
} from "@banto/module-contract";
import type { RelayApprovalGate } from "./approval-gate.js";
import { RESTARTING_REFUSAL } from "./module-calls.js";

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
   * **コンテナの中からも見える、host 側の窓口用フォルダ**（追加・2026-09-27）。呼び出しに
   * `dev.banto/socketDir` として刻む——Vault が鍵の窓口をここに立てる（`SOCKET_DIR_META_KEY`）
   */
  socketDir?: string;
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
      return "宣言された依存に含まれない";
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
    ): { id: string; end: () => void };
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
  autoApproveFor?(projectId: string): boolean;
  /** 承認待ちの進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**。 */
  approvalProgressIntervalMs?: number;
  /**
   * **host からその Project のコンテナに届くアドレス**（追加・2026-09-27、`docs/specs/v4-modules.md` §4.3 Publish）。
   * コンテナのアドレスは DHCP で変わりうるので、公開の実装は覚えずに引き直す。渡さなければこの口は断る。
   *
   * **断りは2通りに分けて返す**（改訂・2026-09-28、Fable のレビュー）：`{unavailable}` は**確かに届かない**
   * （コンテナが無い・止まっている・この banto のものでない・アドレスがまだ無い）。投げたら**分からない**
   * （Incus が答えない等の一時の失敗）。公開の実装は、前者なら中継をやめ（503）、後者なら写しに触らない
   */
  projectAddress?(projectId: string): Promise<{ address: string } | { unavailable: string }>;
  /**
   * **Project の一覧**（id・名前・根のパス・状態、追加・2026-10-01、`docs/specs/v4-modules.md` §2.4 Repositories）。
   * 引ける相手と場面は `mayListProjects` が決める。渡さなければこの口は断る
   */
  listProjects?(): ProjectSummaryForModule[];
  /**
   * **受信箱に知らせる**（追加・2026-10-02、`docs/specs/v4-modules.md` §2.4 Repositories——GitHub のログインの更新に
   * 失敗したとき）。出せる相手は `mayRaiseNotice` が決める。渡さなければこの口は断る
   */
  raiseNotice?(caller: CallerIdentity, input: { key: string; title: string; detail: string }): Promise<void>;
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
  root: string;
  status: "active" | "closed";
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

/**
 * 宛先の tool が名乗っている可視性。**その Module が名乗っていない名前は
 * `undefined`**——知らないものを `admin` 扱いしない（fail closed）。
 */
async function targetTool(
  client: Client,
  toolName: string,
): Promise<
  | { visibility: Visibility; valueFree: boolean; auditArgs: string[]; deliversLater: boolean; receivesReplies: boolean }
  | undefined
> {
  const { tools } = await client.listTools().catch(() => ({ tools: [] as unknown[] }));
  const tool = tools.find((t) => (t as { name?: string }).name === toolName);
  if (!tool) return undefined;
  const x = tool as { _meta?: Record<string, unknown> };
  return {
    visibility: visibilityOf(x),
    valueFree: isValueFree(x),
    auditArgs: auditArgsOf(x),
    deliversLater: deliversLater(x),
    receivesReplies: receivesReplies(x),
  };
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
        description: "host からその Project のコンテナに届くアドレス（IPv4）。変わりうるので覚えずに引き直す",
        inputSchema: {
          type: "object",
          properties: { projectId: { type: "string" } },
          required: ["projectId"],
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
      const targets = opts.registry.allowedTargets(identity, onBehalfOf);
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
      // 確かに届かないときは理由を値で返す（`{unavailable}`）。分からないときは投げる——呼び出し元が区別できるように
      const found = await opts.projectAddress(projectId);
      return { content: [{ type: "text", text: JSON.stringify(found) }] };
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
      await opts.raiseNotice(identity, { key: field("key"), title: field("title"), detail: field("detail") });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
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
    // **宛先は先に引く**——承認の鍵に「いま何のコードが動いているか」を入れるため
    const target = opts.registry.getModule(targetModule);
    const call = {
      projectId: identity.projectId,
      callerModule: identity.moduleName,
      targetModule,
      kind,
      name,
      // **外から繋いだ Module への承認は、そのコードに縛る**（上記 codeId）
      ...(target?.meta.origin !== "bundled" && target?.codeId ? { targetCodeId: target.codeId } : {}),
    };

    // **何を指していたか**は、宛先の tool を読むまで分からない（下で埋まる）
    let identifiers: Record<string, string> | undefined;
    const audit = async (allowed: boolean, reason?: string, ok?: boolean) => {
      await opts.onAudit?.({
        ...call,
        ...(identifiers ? { identifiers } : {}),
        allowed,
        reason,
        ok,
        ts: new Date().toISOString(),
      });
    };

    // **起こし直したときの問いは host だけが呼ぶ**（追加・2026-10-05、Fable のレビュー。`@banto/module-contract` の
    // `resume.ts`）——中継からは断る（宛先の Module も呼び元の印で断るが、ここでも通さない）
    if (kind === "tool" && name === RESUME_AFTER_RESTART_TOOL) {
      await audit(false, "起こし直したときの問いは banto 本体だけが呼べる");
      throw new Error(`${name} は banto 本体だけが呼べます（中継からは呼べません）`);
    }

    const notAllowed = opts.registry.whyNotAllowed(identity, targetModule, onBehalfOf);
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
    const targetInfo = kind === "tool" ? await targetTool(target.client, name) : undefined;
    // **返事の受け口は host だけが呼ぶ**（追加・2026-10-05）——他の Module が呼べると、頼んだ仕事の返事を偽られる
    if (targetInfo?.receivesReplies) {
      await audit(false, "返事の受け口は host だけが呼ぶ");
      throw new Error(`${targetModule} の ${name} は返事の受け口です。中継からは呼べません`);
    }
    // **名乗った引数だけを拾う**（値そのものは拾わない）。長すぎるものも拾わない
    // ——識別子のつもりの欄に値が入っていたときに、記録へ流し込まないため
    if (targetInfo?.auditArgs.length) {
      const callArgs = (args.arguments ?? {}) as Record<string, unknown>;
      const picked: Record<string, string> = {};
      for (const key of targetInfo.auditArgs) {
        const v = callArgs[key];
        if (typeof v === "string" && v.length > 0 && v.length <= 200) picked[key] = v;
      }
      if (Object.keys(picked).length > 0) identifiers = picked;
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
      : opts.gate
        ? opts.gate
            .requestApproval({
              ...call,
              callerConnName: identity.connName ?? identity.moduleName,
              ...(callId ? { callerCallId: callId } : {}),
              // コンテナからは、何を指していたかごとに聞く（名乗った識別子。無ければ空——それでも印になる）
              ...(identity.inContainer ? { scope: identifiers ?? {} } : {}),
            })
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
      ? opts.moduleCalls.beginCall(...targetArgs, callerToolUseId, { connName: callerConn, ...(callId ? { callId } : {}) })
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
    // **人に聞かずに許可してよいか**（追加・2026-10-05、v4-frontend.md §6.4「承認をすべて自動で許可する」）。AI のターンから
    // 始まった、スイッチがオンの Project のための呼び出しにだけ刻む——Publish の窓口が中で実装の `publishRoute` を呼ぶとき、
    // 実装は人の刻印の代わりにこれを見る。**呼び出し元の申告は使わない**（Project と出所は host の台帳から引いている）
    if (!humanCanvas && origin === "turn" && callerProject && opts.autoApproveFor?.(callerProject) === true) {
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
 * Node.js の http.createServer ハンドラの一部として使う。
 * `/relay` パスへのリクエストを、Authorizationヘッダのbearer tokenで
 * 識別してから中継サーバに渡す。
 */
export class HostRelayEndpoint {
  private readonly sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();

  constructor(private readonly opts: HostRelayServerOptions) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let entry = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!entry) {
      const authHeader = req.headers["authorization"];
      const token = typeof authHeader === "string" ? authHeader.replace(/^Bearer /, "") : undefined;
      const identity = token ? this.opts.registry.resolveToken(token) : undefined;
      if (!identity) {
        res.writeHead(401, { "content-type": "application/json" }).end(
          JSON.stringify({ error: "unauthorized" }),
        );
        return;
      }
      const server = buildRelayServer(identity, this.opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString("hex"),
        onsessioninitialized: (newSessionId) => {
          this.sessions.set(newSessionId, { server, transport });
        },
      });
      await server.connect(transport);
      entry = { server, transport };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  }
}
