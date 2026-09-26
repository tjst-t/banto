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
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  auditArgsOf,
  CALLER_META_KEY,
  isValueFree,
  visibilityOf,
  type BantoModuleMeta,
  type Visibility,
} from "@banto/module-contract";
import type { RelayApprovalGate } from "./approval-gate.js";

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
  isAllowed(caller: CallerIdentity, targetModule: string): boolean {
    return this.whyNotAllowed(caller, targetModule) === undefined;
  }

  /**
   * **呼べない理由**（呼べるなら `undefined`）。見るのは2つ：
   *
   * - 宣言した依存（役割）に、宛先が名乗る役割があるか（アーキ仕様§2.5）
   * - **Project ごとの Module を呼べるのは、同じ Project の Module だけ**（決定・2026-09-26、ユーザー、
   *   `docs/specs/v4-security.md` §3）。以前は役割しか見ておらず、Project ごとの Module（`subagent-<projectId>`）を
   *   別の Project の Module が名前で指せた——許すと、その Project のコンテナで仕事が走る。banto 全体に1本の Module は
   *   Project を選べないので、Project ごとの Module は呼べない
   */
  whyNotAllowed(caller: CallerIdentity, targetModule: string): string | undefined {
    const target = this.modules.get(targetModule);
    if (!target || !caller.meta.dependsOn.some((d) => target.meta.satisfies.includes(d.role))) {
      return "宣言された依存に含まれない";
    }
    if (target.projectId !== undefined && target.projectId !== caller.projectId) {
      return caller.projectId === undefined
        ? "banto 全体の Module から、Project ごとの Module は呼べない"
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
  allowedTargets(caller: CallerIdentity): Array<{ name: string; roles: string[] }> {
    const roles = new Set(caller.meta.dependsOn.map((d) => d.role));
    return Array.from(this.modules.values())
      .filter((m) => this.whyNotAllowed(caller, m.name) === undefined)
      .map((m) => ({ name: m.name, roles: m.meta.satisfies.filter((role) => roles.has(role)) }));
  }
}

/**
 * 承認を待っている間、呼び出し元へ進捗を送る間隔。MCP の既定タイムアウト
 * （60秒）より十分短くする——Shell の長時間コマンドと同じ手当て
 * （docs/specs/v4-modules.md §2.3）。
 */
const APPROVAL_PROGRESS_INTERVAL_MS = 10_000;

export interface HostRelayServerOptions {
  registry: RelayRegistry;
  /**
   * **呼び出し元の Thread に届ける**（決定・2026-09-25、アーキ仕様 §4.2「返信用の札」）。宛先は札でしか指せない
   * ——札の確かめ（生きているか・渡した相手と同じ Module か）は受け手（host）が行う。渡さなければこの口は断る
   */
  deliverToThread?(
    caller: CallerIdentity,
    input: { replyTo: string; title: string; text: string; final: boolean },
  ): Promise<{ ok: true; deliveryId: string; wake: string } | { ok: false; error: string }>;
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
  moduleCalls?: {
    originFor(connName: string): "turn" | "canvas" | "host" | undefined;
    /** いま走っている呼び出しは誰のためか（Project／banto 全体／決められない）。 */
    callerFor?(connName: string): { project: string } | { instance: true } | undefined;
    /** banto 全体のための呼び出しか——宛先へ継ぐ。 */
    instanceFor?(connName: string): boolean;
    threadFor(connName: string): { kind: "thread"; threadId: string } | { kind: string };
    projectFor(connName: string): string | undefined;
    begin(
      connName: string,
      threadId: string | undefined,
      origin: "turn" | "canvas" | "host",
      projectId?: string,
      forInstance?: boolean,
    ): () => void;
  };
  /** 記録（メタデータだけ）。成否も含め、拒否された呼び出しも渡ってくる。 */
  onAudit?(record: RelayAuditRecord): void | Promise<void>;
  /** 承認待ちの進捗を送る間隔（既定 10 秒）。**試験で短くするための穴**。 */
  approvalProgressIntervalMs?: number;
}

/**
 * 宛先の tool が名乗っている可視性。**その Module が名乗っていない名前は
 * `undefined`**——知らないものを `admin` 扱いしない（fail closed）。
 */
async function targetTool(
  client: Client,
  toolName: string,
): Promise<{ visibility: Visibility; valueFree: boolean; auditArgs: string[] } | undefined> {
  const { tools } = await client.listTools().catch(() => ({ tools: [] as unknown[] }));
  const tool = tools.find((t) => (t as { name?: string }).name === toolName);
  if (!tool) return undefined;
  const x = tool as { _meta?: Record<string, unknown> };
  return { visibility: visibilityOf(x), valueFree: isValueFree(x), auditArgs: auditArgsOf(x) };
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
        // **終わったら呼び出し元の Thread に届ける**（追加・2026-09-25、アーキ仕様 §4.2）。宛先は host が渡した
        // 返信用の札（`dev.banto/replyTo`）でしか指せない。届いたらその Thread の AI が起きる
        name: "relayDeliverToThread",
        description: "返信用の札で、呼び出し元の Thread に届ける（届いたらその Thread の AI が続きをやる）",
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
    if (request.params.name === "relayListTargets") {
      const targets = opts.registry.allowedTargets(identity);
      return { content: [{ type: "text", text: JSON.stringify(targets) }] };
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

    const notAllowed = opts.registry.whyNotAllowed(identity, targetModule);
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
    const origin = opts.moduleCalls?.originFor(identity.connName ?? identity.moduleName);
    const targetInfo = kind === "tool" ? await targetTool(target.client, name) : undefined;
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
    const callerThread = opts.moduleCalls?.threadFor(callerConn);
    // **呼び出し元の Project**（追加・2026-09-13）。Project 単位で起きた Module
    // （Shell）は自分の身元に持っている。instance 単位の Module（窓口）は
    // 持たないので、**外側から継ぐ**——Thread と同じ形（推測しない、規則3）
    const callerProject = identity.projectId ?? opts.moduleCalls?.projectFor(callerConn);
    const endTargetCall = opts.moduleCalls?.begin(
      targetModule,
      callerThread?.kind === "thread" ? (callerThread as { threadId: string }).threadId : undefined,
      origin ?? "turn",
      callerProject,
      // **banto 全体のための呼び出しも継ぐ**（追加・2026-09-16）——継がないと
      // 窓口→金庫の2段目で「誰のためか分からない」に落ちる
      opts.moduleCalls?.instanceFor?.(callerConn) ?? false,
    );

    /**
     * **誰のための呼び出しかを host が刻む**（決定・2026-09-13）。
     * 人が管理画面から触っているとき（canvas 由来）は `admin`——Project では
     * ないが、**「決められない」でもない**。刻まないと受け手が止まる。
     */
    //
    // **`{instance:true}`（banto 全体のため）も刻む**（追加・2026-09-16）。
    // `${secret:…}` の解決は窓口→金庫の2段で、2段目は中継を通る。
    const ambient = opts.moduleCalls?.callerFor?.(callerConn);
    const callerMeta: Record<string, unknown> = callerProject
      ? { [CALLER_META_KEY]: { project: callerProject } }
      : ambient
        ? { [CALLER_META_KEY]: ambient }
        : origin === "canvas"
          ? { [CALLER_META_KEY]: { admin: true } }
          : {};

    try {
      if (request.params.name === "relayCallTool") {
        // 実データは host のプロセスメモリを一過性に通過するだけ——
        // ディスクにもEvent Storeにも記録しない。記録するのは識別子だけ。
        const result = await target.client.callTool({
          name,
          arguments: (args.arguments as Record<string, unknown>) ?? {},
          _meta: callerMeta,
        });
        await audit(true, decision.reason, true);
        return result as { content: unknown[] };
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
