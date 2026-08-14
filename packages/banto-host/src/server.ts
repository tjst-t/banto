/**
 * 番頭ホストの常駐サーバ（task-0009・task-0035）。
 *
 * **会話スレッドを複数抱え**、その進行を WebSocket で配信する。CLI も WebUI も
 * このサーバの同格クライアントになる（Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * スレッドの帳簿は `ThreadRegistry`（threads.ts）が持ち、ここは配信とプロトコル変換だけ。
 * イベントには常に `threadId` が載るので、1つの接続で複数スレッドを同時に描ける。
 *
 * D5: 判断ロジックを持たない。セッションの組み立ては host-session.ts、記憶・SKILLは
 *     それぞれのモジュールにあり、ここは pub/sub とプロトコル変換だけを行う。
 * D6: ws — Node 20 には WebSocket サーバ実装が無い（banto-daemon と同じ理由で同じ依存）。
 * I2: 不正なメッセージは黙って捨てず、error イベントで返す。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BantoHarness, HarnessEvent, HarnessImage } from "@banto/core";

import type { Inbox, InboxEffect, InboxItem } from "./inbox.js";
import { THEME_URL_BASE, type UserThemes } from "./user-themes.js";
import type { CanvasCatalog } from "./canvas.js";
import { CORE_ORIGIN, type ModuleRegistry } from "./module.js";
import { CORE_TOOL_BASE_URL, createCoreToolHandler, createModuleToolHandler } from "./module-serve.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";
import { createWebAssetHandler } from "./web-assets.js";
import {
  BANTO_DEFAULT_PORT,
  BANTO_WS_PATH,
  type Attachment,
  type ClientMessage,
  type NoticeSource,
  type ServerEvent,
  type TranscriptAttachment,
  type TranscriptEntry,
  type UtsuwaView,
} from "./protocol.js";
import { openUtsuwa } from "./canvas-utsuwa.js";
import { fromWireToolName } from "@banto/core";
import type { Thread, ThreadRegistry } from "./threads.js";
import { workspaceRoot } from "./workspace.js";

/**
 * 同じ面への口が既に立っているか（PO報告 2026-08-10）。
 *
 * 行き先（`view`）と引数が同じなら同じ口。**引数まで見る**のは、同じ面でも
 * 別のファイルを開いたなら別の行き先だから。
 */
/**
 * 同じ口が**このターンで**既に立っているか（PO要望 2026-08-11 で範囲を絞った）。
 *
 * もとは会話の最初から探していた。そのため**一度開いた面は、閉じたあと開き直しても
 * 口が立たない**——最初の口は何百行も上にあり、実際には辿り着けない。PO が求めたのは
 * 「閉じた後に押して開き直せる口」なので、**開くたびに、いまの位置に立つ**必要がある。
 *
 * 一方、番頭が1回の用件で `canvas.open` を数回呼ぶと同じ行が並ぶ問題（PO報告 2026-08-10）は
 * 残っている。だから**このターンの中だけ**を見る：直前の入力（POの発言・外からの知らせ）
 * より後ろに同じ口があれば積まない。
 */
function hasSameOpen(
  transcript: readonly TranscriptEntry[],
  utsuwa: Extract<UtsuwaView, { kind: "open" }>
): boolean {
  const args = JSON.stringify(utsuwa.args ?? {});
  // このターンの始まり＝最後の入力。無ければ会話の頭から
  let from = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const role = transcript[i]!.role;
    // 枝からの相談（決定107）もターンの始まり——知らせと同じく、これで番頭が喋り出す
    if (role === "po" || role === "notice" || role === "branch_note") {
      from = i;
      break;
    }
  }
  return transcript.slice(from).some(
    (e) =>
      e.role === "utsuwa" &&
      e.utsuwa.kind === "open" &&
      e.utsuwa.view === utsuwa.view &&
      JSON.stringify(e.utsuwa.args ?? {}) === args
  );
}

/**
 * 添付（テキストファイル）の保存先。ワークスペースのルート配下の `work/attachments/`。
 * BANTO_PLACES で `work/**` が読み書きできる場所として登録されている想定。
 * プロンプト注釈にもそのまま使うので、区切りは常に `/`。
 */
const ATTACHMENT_DIR_REL = "work/attachments";

/** 保存した添付を UI へ配る入口。vite の開発サーバは `/api` をホストへ中継する。 */
const ATTACHMENT_URL_BASE = "/api/attachments/";

/**
 * ツールの引数・結果として履歴に載せる最大の長さ。
 *
 * **丸ごと載せない**——ファイル読込のように結果が数MBになるツールがあり、そのまま積むと
 * 会話履歴（JSONL）が肥大化し、再読み込みのたびに同じ塊が流れる。切ったことは
 * 隠さず、末尾に印を付けて返す（I1）。
 */
const TOOL_PAYLOAD_MAX_CHARS = 4000;

/**
 * 死活確認（ping）の間隔。この2倍まで pong が返らなければ、その接続は畳む。
 *
 * 30秒にしたのは、間に挟まる NAT・Tailscale の DERP 中継が黙って落とす前に
 * 通しておきたいから——多くの実装で無通信の見切りは60秒前後にある。
 */
const WS_HEARTBEAT_MS = 30_000;

/**
 * ツールの引数・結果を履歴に載せられる大きさへ収める。
 * 長すぎるときは文字列に落として切り詰める（構造を保ったまま部分的に消すと、
 * 何が欠けたのか読み取れなくなる）。
 */
function clampToolPayload(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  // 中身の無いものは「無かった」として扱う。空の `{}` を引数として見せても、
  // 開いた側には何も分からない——行が増えるだけ
  if (typeof value === "string" && value.length === 0) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (typeof value === "object" && Object.keys(value as object).length === 0) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    // 循環参照など JSON にできないもの。捨てずに姿だけ残す（I2）
    return "(表示できない値)";
  }
  if (serialized.length <= TOOL_PAYLOAD_MAX_CHARS) return value;
  return `${serialized.slice(0, TOOL_PAYLOAD_MAX_CHARS)}…（${serialized.length} 文字のうち先頭のみ）`;
}

/** ハーネスが返した数値をそのまま足せる形に。数でなければ 0（推測しない）。 */
function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 添付ファイル名から Content-Type を当てる。分からないものは汎用で返す。 */
function contentTypeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * サーバが必要とするセッションの最小契約。pi の `AgentSession` はこれを構造的に満たす。
 *
 * 具象型ではなくこの契約に依存することで、(a) ハーネスを差し替えても server は無変更
 * （ADR-0010 決定3）、(b) 実プロバイダを呼ばずに配信経路だけを検証できる、という2つを得る。
 */
export interface HostSession {
  readonly sessionId: string;
  readonly isStreaming: boolean;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(
    text: string,
    options?: { streamingBehavior?: "steer" | "followUp"; images?: HarnessImage[] }
  ): Promise<void>;
  abort(): Promise<void>;
  /**
   * 走っているセッションのモデルを差し替える（対応するハーネスだけ）。
   *
   * 型を `unknown` にしているのは、モデルの実体がハーネスのものだから——server は
   * 中身を知らないまま、解決した実体を bin.ts から受け取って渡すだけ（ADR-0010 決定3）。
   */
  setModel?(model: unknown): Promise<void>;
}

/** モデル情報。WebUI が画像添付の可否を判定するための最小形。 */
export interface ModelInfo {
  id: string;
  /**
   * **バックエンドが変わったときの新しいハーネス**（PO要望 2026-08-13）。
   *
   * モデルの名前でバックエンドが決まる（職人側の `planModel` と同じ規則）。
   * 返ってきたら会話のハーネスを差し替える——再起動は要らない。
   */
  harness?: BantoHarness;
  /** どのバックエンドで動いているか。画面に出す。 */
  backend?: string;
  /** vision 対応（モデルの input が image を受け付ける）か。 */
  vision: boolean;
  /** 文脈に入る最大トークン数（分かるときだけ）。 */
  contextWindow?: number;
}

/** `notify` の宛先と出所。 */
export interface NotifyOptions {
  /** 宛先のスレッド（決定35a）。省略時は既定スレッド。 */
  threadId?: string;
  /** 誰からの知らせか。省略時は `system`。 */
  source?: NoticeSource;
}

export interface BantoHostServerOptions {
  /**
   * スレッドの帳簿。**既定スレッドを1本開いた状態で渡すこと**——宛先が無いと、
   * `threadId` を省略したメッセージを捌けない。
   */
  threads: ThreadRegistry;
  /** 待ち受けポート。0 を渡すと空きポートが割り当てられる（テスト用）。 */
  port?: number;
  /** GUIカタログ。welcome でクライアントへ渡し、UIがコンポーネントを解決する。 */
  catalog?: CanvasCatalog;
  /**
   * モジュールの帳簿。渡すと welcome のカタログエントリに、各GUIの提供元モジュールと
   * その接続情報が載る（決定25：UIはコンポーネントに直書きせずここから到達先を得る）。
   */
  modules?: ModuleRegistry;
  /**
   * 中核の Tool（`llm.*` 等）。渡すと `/api/core/tools/{名前}` で公開され、
   * 中核由来のキャンバスGUIがここからデータを取れる（ADR-0011 決定42）。
   */
  coreTools?: readonly NamespacedToolDefinition[];
  /**
   * 取次（受け口）。渡すと上段の札と面が動き、番頭は `inbox.*` で積める。
   * 渡さないと画面は取次を出さない（空ではなく、無い）。
   */
  inbox?: Inbox;
  /**
   * 取次の選択肢に付いた処理を実行する口（決定73）。
   *
   * **POが押したことを、その場で効かせるために要る。** 承認のような
   * 「番頭には呼べない口」（決定29e・38c）は、番頭の次のターンに任せられない
   * ——押したのに何も起きず、番頭に頼み直させることになる。
   *
   * 引くのはホストではなくモジュールの帳簿（決定27：Banto をブローカーにしない）。
   * ここは渡された宛先をそのまま呼ぶだけで、何が起きるかは知らない（D5）。
   *
   * @returns 実行結果の一行。番頭への知らせに載る
   */
  runInboxEffect?(effect: InboxEffect): Promise<string>;
  /**
   * 持ち込みのテーマ置き場（spec-design §6.4）。渡すと `/api/themes` で台帳を、
   * `/api/themes/<name>.css` で中身を配る。作り直さずにテーマを足せる。
   */
  userThemes?: UserThemes;
  /**
   * 待ち受けるアドレス（既定 `127.0.0.1`）。
   *
   * **Banto は認証を持たない**（決定40）。守るのは前段（Caddy 等）の役目という裁定だが、
   * ホストが全インターフェースで待っていると**前段を素通りして直に叩ける**——認証が
   * 飾りになる。既定を localhost に閉じることで、「前段に置く」が本当に効く形にする。
   *
   * I1: 運用の心がけではなく機構で担保する。広げるには明示的に指定させ、警告を出す。
   */
  host?: string;
  /**
   * ビルド済み WebUI の置き場（task-0048）。渡すと UI も同じポートで配る。
   *
   * 常駐させるときに要る——開発中は vite が出すが、サービスでは開発サーバを動かし
   * 続けたくない。1プロセス・1ポートにすると、前段で守るのもそのポート1つで済む。
   */
  webDir?: string;
  /**
   * 現在のモデル。WebUI が画像添付の可否を判定するために使う（`GET /api/model`）。
   * 未指定（pi の既定解決に任せている）ときは undefined——画像は受け付けない。
   */
  model?: ModelInfo;
  /**
   * 番頭のモデルを切り替える口。**渡されなければ切替はできない**（UIからは選べない）。
   *
   * 解決（プロバイダ／モデル名 → 実体）も、**その会話のセッションへの適用**も、
   * 保存も、ここを渡す側（bin.ts）の責任。server は結果を配るだけ（D5）。
   * I2: 切り替えられないときは throw すること——黙って前のモデルのまま続けない。
   */
  onSelectModel?: (
    thread: Thread,
    provider: string,
    model: string,
    /** **provider の上位の階層**（PO裁定 2026-08-13）。省略なら会話のいまのバックエンド。 */
    backend?: string
  ) => Promise<ModelInfo>;
  /** いま使っているモデルのプロバイダ。`model_state` に載せる。 */
  modelProvider?: string;
}

/**
 * 番頭ホストサーバ。
 *
 * プロトコルは protocol.ts を参照。1プロセス＝1セッションで、接続した全クライアントが
 * 同じセッションのイベントを受け取る（a3：CLIとWebUIが同時に同じ会話を見られる）。
 */
export class BantoHostServer {
  private readonly httpServer: http.Server;
  private readonly wss: WebSocketServer;
  private readonly threads: ThreadRegistry;
  private readonly catalog: CanvasCatalog | undefined;
  private readonly modules: ModuleRegistry | undefined;
  /** 取次。会話に紐づかない唯一の状態（POを待たせているもの）。 */
  private readonly inbox: Inbox | undefined;
  /** 取次の選択肢に付いた処理を実行する口（決定73）。無ければ記録と知らせだけ。 */
  private readonly runInboxEffect: BantoHostServerOptions["runInboxEffect"];
  private readonly clients = new Set<WebSocket>();
  /**
   * 前回の ping に pong を返した接続。死んだ接続を畳むためだけに持つ（→ `heartbeat`）。
   * 接続そのものが鍵なので、close で clients から外れれば一緒に消える WeakSet でよい。
   */
  private readonly alive = new WeakSet<WebSocket>();
  /** 死活確認のタイマー。close で止める。 */
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly unsubscribeThreads: () => void;
  /** 現在のモデル情報。画像添付の可否判定に使う。切替で入れ替わる。 */
  private modelInfo: ModelInfo | undefined;
  /** 現在のモデルのプロバイダ。切替で入れ替わる。 */
  private modelProvider: string | undefined;
  /** モデルを切り替える口（無ければ切替不可）。 */
  private readonly selectModel: BantoHostServerOptions["onSelectModel"];
  /** 購読を張り終えたスレッド。開くたびに増える。 */
  private readonly attached = new Set<string>();

  /**
   * 番頭の標準モデル（会話がまだ自分のモデルを持たないときに使う）。
   * 起動時に解決されたものをそのまま持つ。
   */
  private hostDefaultModel():
    | { backend?: string; provider: string; id: string; vision: boolean; contextWindow?: number }
    | undefined {
    if (!this.modelInfo) return undefined;
    return {
      provider: this.modelProvider ?? "",
      id: this.modelInfo.id,
      vision: this.modelInfo.vision,
      ...(this.modelInfo.contextWindow ? { contextWindow: this.modelInfo.contextWindow } : {}),
    };
  }
  /** 思考が始まった時刻（スレッド毎）。「X秒間考えました」を測るために持つ。 */
  private readonly thinkingStartedAt = new Map<string, number>();
  /**
   * 直近のターンで運んだトークン数（スレッド毎）。**実行時状態なので保存しない**（D3）
   * ——再起動したら次のターンまで分からない。推定で埋めるより黙るほうがよい（I1）。
   */
  private readonly contextTokens = new Map<string, number>();

  private constructor(options: BantoHostServerOptions, httpServer: http.Server) {
    this.threads = options.threads;
    this.catalog = options.catalog;
    this.modules = options.modules;
    this.inbox = options.inbox;
    this.runInboxEffect = options.runInboxEffect;
    // 積まれた／答えが出たら全員へ配り直す（D3：真実は Inbox 側の一箇所）
    if (this.inbox) {
      const inbox = this.inbox;
      inbox.onChange(() => this.broadcast({ type: "inbox_state", items: inbox.list() }));
    }
    this.modelInfo = options.model;
    this.modelProvider = options.modelProvider;
    this.selectModel = options.onSelectModel;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({
      noServer: true,
      // 接続時に配る history は全スレッド分で数MBになる（inc: Android/Tailscale から
      // 使えない）。中身は同じ形の JSON の繰り返しなので、deflate が非常によく効く
      // ——実測 9.67MB → 1.43MB（85%減）。
      //
      // **文脈持ち越し（context takeover）は切らない。** 切ると1フレームごとに辞書が
      // 捨てられ、この「同じ形が延々続く」流れでは圧縮率が大きく落ちる。代償は接続ごとの
      // zlib 窓（数百KB）だが、この面に繋ぐのはPOの画面が数枚——常時多接続ではない
      perMessageDeflate: {
        // 小さなフレーム（turn_start 等）は圧縮しても縮まず、往復の CPU だけ増える
        threshold: 1024,
        // level は 6（zlib 既定）。実測 9.67MB に対し level 3 が 1.66MB / 68ms、
        // level 6 が 1.43MB / 132ms、level 9 は 6 と同じ大きさでさらに遅い。
        // 遅い回線ほど 0.23MB の差が効くので、64ms の CPU は払う価値がある
        zlibDeflateOptions: { level: 6 },
        concurrencyLimit: 10,
      },
    });

    this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) =>
      this.handleConnection(ws, req)
    );

    // **死活確認**（inc: Android/Tailscale から使えない）。
    //
    // モバイル回線・Tailscale・NAT の間では、画面消灯やハンドオーバで TCP が
    // **黙って**切れる。FIN が来ないので close が上がらず、番頭側は生きていると思って
    // 配信し続け、画面側は「繋がっているのに何も来ない」まま止まる。
    // ping を投げて pong が返らない接続を畳むと、画面側の onclose が発火して
    // 繋ぎ直しに入れる——切れたことに気づかせるのが目的。
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!this.alive.has(ws)) {
          // 前回の ping に答えていない＝もう居ない。terminate は 'close' を続けて出すので
          // clients からはそちらで外れる
          ws.terminate();
          continue;
        }
        this.alive.delete(ws);
        ws.ping();
      }
    }, WS_HEARTBEAT_MS);
    // 死活確認のためだけにプロセスを起こし続けない（テストが終わらなくなる）
    this.heartbeat.unref?.();
    // upgrade はここで一手に受け、パスで振り分ける（案A：proxy exposer の WS 中継）。
    // ws に server を持たせると /ws 以外の upgrade を全部 400 で蹴るため、noServer にして
    // 自分の面（/ws）とモジュールの面（中継 URL）をここで分ける
    httpServer.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    // スレッドが開くたびに購読を張り、増減を全クライアントへ配る
    for (const thread of this.threads.list()) this.attach(thread);
    this.unsubscribeThreads = this.threads.subscribe((threads) => {
      for (const thread of threads) this.attach(thread);
      this.broadcast({ type: "thread_state", threads: threads.map((t) => t.view()) });
    });
    /**
     * 幹に立つ2つの行（ADR-0017 決定77）を配る。
     *
     * 帳簿は記録を持つが配信は知らない（D5）ので、ここで差し込む——記録して黙ると、
     * 開いている画面には枝の札が出ないまま次の発話が続く。
     */
    this.threads.onTrunkCard = (trunk, branch) =>
      this.broadcast({ type: "branch_card", threadId: trunk.id, branchId: branch.id });
    this.threads.onBranchResult = (trunk, entry) =>
      this.broadcast({ type: "branch_result", threadId: trunk.id, ...entry });
    /**
     * 枝を畳んだことを取次へ知らせる（ADR-0022 決定109）。**求めるのは判断ではない**ので、
     * `notice: true` を付けて判断待ちの数（`inboxPending`）から外す（決定110）。
     * 詳細（調べた・決めた・残った）は幹へ流さないのと同じ理由で本文には出さず、
     * 在ることだけを言う——読むのは押して枝を開いてから。
     */
    this.threads.onBranchMerged = (thread) => {
      if (!this.inbox) return;
      const detailNote = thread.conclusionDetail ? "（詳細は開けば読めます）" : "";
      this.inbox.post({
        source: { id: "banto", label: "番頭" },
        kind: "枝を回収しました",
        notice: true,
        title: `枝「${thread.title}」を幹に回収しました`,
        what: `${thread.conclusion ?? ""}${detailNote}`,
        ask: "確認したら押してください（再開したければ、開いてから話しかけてください）",
        actions: [{ id: "read", label: "読んだ", tone: "plain" }],
        opens: { threadId: thread.id },
      });
    };
    /**
     * 枝から幹への相談・報告（決定107）。**同じ列に並べる**ので、札と結論と同じ扱いで配る
     * ——知らせに混ぜると、幹を読み返したときにどの枝の話か辿れない。
     */
    this.threads.onBranchNote = (trunk, entry) =>
      this.broadcast({
        type: "branch_note",
        threadId: trunk.id,
        branchId: entry.branchId,
        title: entry.title,
        kind: entry.kind,
        text: entry.text,
        at: entry.at,
      });
  }

  /**
   * 1本のスレッドの進行を配信につなぐ。
   *
   * **スレッドごとに購読を張る**のが要点——ここを1本に共有すると、あるスレッドの
   * キャンバス操作が別スレッドの表示として配信される（決定2 が壊れる）。
   */
  private attach(thread: Thread): void {
    if (this.attached.has(thread.id)) return;
    this.attached.add(thread.id);

    // ハーネスの購読は Thread が1箇所で持つ——**差し替えのときに張り直す**ため
    // （`disposers` に混ぜると、ハーネスのぶんだけを外せない）
    thread.listen((event) => this.handleHarnessEvent(thread, event));
    // D3: キャンバスの真実はホスト側。状態が変わるたび全クライアントへ配る
    if (thread.canvas) {
      thread.disposers.push(
        thread.canvas.subscribe((snapshot) =>
          this.broadcast({
            type: "canvas_state",
            threadId: thread.id,
            tabs: snapshot.tabs,
            activeTabId: snapshot.activeTabId,
          })
        )
      );
    }
    thread.disposers.push(() => this.attached.delete(thread.id));
  }

  /** サーバを起動し、待ち受け開始まで待つ。 */
  static async start(options: BantoHostServerOptions): Promise<BantoHostServer> {
    // 組み込みモジュールのデータAPI（決定25：組み込みの提供元は Banto ホスト自身）。
    // UI はここからデータを取る——番頭の Tool 経路は通らない。
    const serveModuleTool = options.modules ? createModuleToolHandler(options.modules) : undefined;
    // 中核のドメイン（`llm.*` 等）も同じ規約で公開する（ADR-0011 決定42）
    const serveCoreTool = options.coreTools ? createCoreToolHandler(options.coreTools) : undefined;
    // ビルド済み資産があれば UI も配る。無ければ何もしない（vite が出す）
    const serveWebAsset = createWebAssetHandler(options.webDir);

    // 現在のモデル情報。WebUI が画像添付の可否を選択時点で判定するために使う。
    // モデル未指定（pi の既定解決に任せている）ときは、対応を名乗れないので
    // 非対応として返す（I1: 知らないことを対応と偽らない）
    const modelInfo = options.model;
    const httpServer = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/health") {
          const body = JSON.stringify({ ok: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        // 持ち込みのテーマ。台帳と CSS を配るだけで、解釈は画面側（D5）
        if (req.method === "GET" && req.url === "/api/themes") {
          const body = JSON.stringify(options.userThemes?.manifest() ?? { families: [] });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        if (req.method === "GET" && req.url?.startsWith(THEME_URL_BASE)) {
          const name = decodeURIComponent(req.url.slice(THEME_URL_BASE.length).split("?")[0] ?? "");
          const css = options.userThemes?.css(name);
          if (css === undefined) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
          res.end(css);
          return;
        }
        if (req.method === "GET" && req.url === "/api/model") {
          const body = JSON.stringify(modelInfo ?? { id: "(未設定)", vision: false });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        // 会話に残っている添付を返す（吹き出しのサムネイル）。
        // **パスはクライアント由来なので信頼しない**——ベース名だけに落として、
        // 保存先の外へ出られないようにする（`..` や絶対パスを弾く）
        if (req.method === "GET" && req.url?.startsWith(ATTACHMENT_URL_BASE)) {
          const requested = decodeURIComponent(req.url.slice(ATTACHMENT_URL_BASE.length).split("?")[0] ?? "");
          const name = path.basename(requested);
          const file = path.join(workspaceRoot(), ATTACHMENT_DIR_REL, name);
          if (name.length === 0 || !fs.existsSync(file)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": contentTypeOf(name) });
          res.end(fs.readFileSync(file));
          return;
        }
        if (serveCoreTool && (await serveCoreTool(req, res))) return;
        if (serveModuleTool && (await serveModuleTool(req, res))) return;
        // 最後に UI。API より後に見るので、/api を資産で覆い隠すことはない
        if (serveWebAsset(req, res)) return;

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      })().catch((err: unknown) => {
        // I2: ハンドラの例外を黙って落とさず 500 で返す
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    const server = new BantoHostServer(options, httpServer);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(options.port ?? BANTO_DEFAULT_PORT, options.host ?? "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  /**
   * **PO の言葉は、番頭が何をしていても届く**（PO報告 2026-08-11）。
   *
   * もとは `isStreaming` を見て、真のときだけ `steer` として積んでいた。ところが
   * `isStreaming` が真なのは**トークンを吐いている間だけ**で、道具を実行している間は
   * 偽になる——番頭が道具を回し続けているとき（＝暴走しているとき）はほぼ常に偽なので、
   * PO の「ちょっとまって」は `Agent is already processing a prompt` で弾かれた。
   * **止めたいときに限って止められない**、いちばん困る形だった（実機・thread-69）。
   *
   * 見るのをやめて**やってみて、駄目なら steer で積み直す**。状態を覗いて分岐するより、
   * 実際の返事で決めるほうが競走に強い（I1：自己申告ではなく結果で判断する）。
   */
  private async promptEvenWhileBusy(
    thread: Thread,
    text: string,
    options: Parameters<HostSession["prompt"]>[1] = {}
  ): Promise<void> {
    try {
      await thread.harness.prompt(text, {
        ...options,
        ...(thread.harness.isStreaming ? { streamingBehavior: "steer" as const } : {}),
      });
    } catch (err) {
      // ターンの最中だと分かったので、積み直す。それ以外の失敗はそのまま上へ
      if (!isBusyError(err)) throw err;
      await thread.harness.prompt(text, { ...options, streamingBehavior: "steer" as const });
    }
  }

  /**
   * 番頭に外から知らせを入れる（決定29）。職人からの報告・質問がここを通る。
   *
   * **宛先はその職人を起こしたスレッド**（決定35a）。`threadId` を省略すると既定スレッド
   * ——スレッドを使っていない起動元との互換。
   *
   * `source` は**誰からの知らせか**。省略すると `system` になる。出所を名乗らないと、
   * 外から入る知らせが全部同じ札で出る（番頭が開いた分身への一言が職人に見えた）。
   *
   * POの発話ではないので `notice` として配り、UIでも見分けられるようにする。
   * 知らせを入れたら番頭のターンを回す——**気づかせるのが目的**なので、
   * ログに積むだけでは足りない。
   *
   * 知らせ同士はスレッドごとに直列化する。同時に3人の職人が報告してきても、
   * そのスレッドのターンは1本ずつ進む。
   */
  notify(text: string, options: NotifyOptions = {}): Promise<void> {
    const source = options.source ?? "system";
    return this.deliverToThread(text, options.threadId, (thread) => {
      thread.record({ role: "notice", source, text });
      this.broadcast({ type: "notice", threadId: thread.id, source, text });
    });
  }

  /**
   * **記録は済んでいる前提で、番頭のターンだけ回す**（決定107）。
   *
   * 枝からの相談は `ThreadRegistry.consult` が既に**札**として幹へ積んでいる。ここで
   * `notify` を使うと同じ一言が知らせとしても積まれ、1つの相談が2行に見える
   * ——記録の形は呼び出し側が決め、ターンを回す仕掛けはここが持つ。
   */
  nudge(threadId: string | undefined, text: string): Promise<void> {
    return this.deliverToThread(text, threadId, () => {});
  }

  /**
   * 知らせをスレッドの列に並べ、番頭のターンを1本回す。
   *
   * **記録の形だけが呼び出しごとに違う**（知らせの行か、枝の札か）ので、そこを渡して
   * もらう。直列化・turn_start/turn_end・失敗の記録はどの経路でも同じでなければ
   * ならない——別々に書くと、片方だけ turn_start を出さない、といった食い違いが出る。
   */
  private deliverToThread(
    text: string,
    threadId: string | undefined,
    record: (thread: Thread) => void
  ): Promise<void> {
    let thread: Thread;
    try {
      thread = this.threads.resolve(threadId);
    } catch (err) {
      // I2: 宛先不明の知らせを黙って捨てない
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    thread.notices = thread.notices.then(async () => {
      record(thread);
      // 職人の報告でも番頭は喋り出す。ここを知らせないと画面から中断する手段が消える
      this.broadcast({ type: "turn_start", threadId: thread.id });
      try {
        await this.promptEvenWhileBusy(thread, text);
      } catch (err) {
        // I2: 知らせが番頭に届かなかったことを黙らせない
        thread.record({ role: "error", text: String(err) });
        this.broadcast({ type: "turn_end", threadId: thread.id, errorMessage: String(err) });
        return;
      }
      const lastError = thread.getLastError();
      if (lastError) thread.record({ role: "error", text: lastError });
      this.broadcast({
        type: "turn_end",
        threadId: thread.id,
        ...(lastError ? { errorMessage: lastError } : {}),
      });
    });
    return thread.notices;
  }

  /**
   * **章を畳んだ印を1本入れる**（提案§3.2・PO要望 2026-08-11）。
   *
   * **ターンは回さない**（`notify` との違い）。知らせとして流していたときは、畳んだ直後の
   * 空の文脈で番頭が独りでに `thread.list`・`inbox.list`・`kobo.list` と調べ始めていた
   * ——POは何も頼んでいないのに会話が進み、畳んで軽くした文脈がその場で埋め直される。
   * 畳んだことは**画面に見えれば足りる**。番頭には章の頭に引き継ぎ資料が入っている。
   *
   * I2: 宛先不明を黙って捨てない。
   */
  markChapter(threadId: string | undefined, chapter: number, topic: string): void {
    const thread = this.threads.resolve(threadId);
    const at = new Date().toISOString();
    thread.record({ role: "chapter", chapter, topic, at });
    this.broadcast({ type: "chapter_closed", threadId: thread.id, chapter, topic, at });
  }

  /**
   * 器を1つ会話へ積んで配る（ADR-0017 決定78・81）。
   *
   * **器は凍る**（決定81(c)）——記録に入ったら書き換えない。ターンは回さない：
   * 器は番頭が自分で出したものなので、自分に知らせる意味が無い（`notify` との違い）。
   *
   * I2: 宛先不明を黙って捨てない。
   */
  showUtsuwa(threadId: string | undefined, utsuwa: UtsuwaView): void {
    const thread = this.threads.resolve(threadId);
    /**
     * **面への口は増やさない**（PO報告 2026-08-10）。
     *
     * 同じ面を開き直すたびに札を積むと、番頭が1回の用件で `canvas.open` を数回呼んだだけで
     * 同じ行が並ぶ（実際に5つ並んだ）。**口は「その面へ行ける」ことを言うもの**なので、
     * 同じ行き先が2つある意味がない。既に同じ口が立っているなら、記録は増やさず配信もしない。
     */
    if (utsuwa.kind === "open" && hasSameOpen(thread.transcript, utsuwa)) return;
    thread.record({ role: "utsuwa", utsuwa });
    this.broadcast({ type: "utsuwa", threadId: thread.id, utsuwa });
  }

  /** 実際に待ち受けているポート（port: 0 のとき割り当てられた値）。 */
  get port(): number {
    const address = this.httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("BantoHostServer is not listening on a TCP port");
    }
    return address.port;
  }

  /** サーバを止める。セッションの後始末は呼び出し側の責務。 */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    this.unsubscribeThreads();
    for (const thread of this.threads.list()) thread.dispose();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  // ── 接続とクライアントメッセージ ───────────────────────────────────────────

  /**
   * HTTP Upgrade（WebSocket）の入口を捌く。
   *
   * - `/ws`（BANTO_WS_PATH）→ wss（Banto 自身の配信）
   * - モジュールの到達先の下 → そのモジュール（proxy exposer の中継 URL）
   * - それ以外 → 拒否して破棄。知らない upgrade を生かし続けない
   */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? "").split("?")[0] ?? "";

    // Banto 自身の配信面。ws の `path` オプションと同じ判定（クエリを外して照合する）
    if (pathname === BANTO_WS_PATH) {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
      return;
    }

    // モジュールが自分の到達先の下で upgrade を捌く（決定27・案A）。
    // HTTP の `serve` と同じく、ホストは経路を渡すだけで中身を解釈しない
    if (this.modules) {
      for (const module of this.modules.list()) {
        if (!module.endpoint.baseUrl.startsWith("/")) continue;
        const base = module.endpoint.baseUrl.replace(/\/$/, "");
        if (!(req.url ?? "").startsWith(base)) continue;
        if (module.handleUpgrade?.(req, socket, head)) return;
      }
    }

    // I2: 誰のものでもない upgrade を黙って生かし続けない。はっきり拒否して破棄する
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }

  private handleConnection(ws: WebSocket, req?: http.IncomingMessage): void {
    this.clients.add(ws);
    // 繋がった直後は生きているとみなす（最初の ping まで畳まれないように）
    this.alive.add(ws);
    ws.on("pong", () => this.alive.add(ws));
    ws.on("close", () => this.clients.delete(ws));
    // I2: 接続エラー（不正フレーム等）を握りつぶさずログに出し、この接続だけ閉じる。
    //     ここで受けないと unhandled 'error' で Node プロセス全体が死ぬ（WS_ERR_EXPECTED_MASK 等）。
    //     terminate() は socket を即破棄し、続けて 'close' が発火して clients から外れる
    ws.on("error", (err) => {
      console.error(`[banto-host] WebSocket connection error: ${String(err)}`, err);
      ws.terminate();
    });
    ws.on("message", (data: Buffer) => void this.handleClientMessage(ws, data));

    const threads = this.threads.list();
    // 全部畳まれていることはありうる（どの会話も畳めるため）。空状態を隠さない
    const defaultThread = threads.find((t) => t.isDefault);

    // 取次は会話に紐づかないので、welcome とは別に1通で配る
    if (this.inbox) this.send(ws, { type: "inbox_state", items: this.inbox.list() });

    this.send(ws, {
      type: "welcome",
      // スレッドを知らないクライアントとの互換。扱えるクライアントは threads を見る
      ...(defaultThread ? { sessionId: defaultThread.harness.sessionId } : {}),
      threads: threads.map((t) => t.view()),
      ...(defaultThread ? { defaultThreadId: defaultThread.id } : {}),
      tools: defaultThread?.toolNames ?? [],
      catalog: (this.catalog?.list() ?? []).map((spec) => {
        const owner = this.modules?.moduleForView(spec.kind);
        return {
          kind: spec.kind,
          title: spec.title,
          description: spec.description,
          component: spec.component,
          ...(spec.category ? { category: spec.category } : {}),
          ...(spec.icon ? { icon: spec.icon } : {}),
          // 決定25: UIはここから到達先を得る。モジュール未登録のGUIは中核由来として扱う
          module: owner?.name ?? CORE_ORIGIN,
          // 中核由来のGUIは中核の Tool 面へ向ける（ADR-0011 決定42）
          endpoint: owner?.endpoint.baseUrl ?? CORE_TOOL_BASE_URL,
        };
      }),
      // GUI を持たないモジュール（設定など）にも UI が到達できるように（決定41）
      modules: (this.modules?.list() ?? []).map((m) => ({
        name: m.name,
        title: m.title,
        description: m.description,
        baseUrl: m.endpoint.baseUrl,
      })),
    });

    // **履歴は見ている会話の分だけ配る**（inc: Android/Tailscale から使えない）。
    //
    // 以前はここで全スレッドの全文を配っており、接続のたびに 9.67MB 流れていた。
    // 会話は畳まない限り増え続けるので、遅い回線では際限なく重くなる形だった。
    // 残りは POがその会話へ移ったときに `history_request` で取りに来る。
    //
    // どの会話を見ているかは `/ws?thread=<id>` で聞く——welcome を待ってから
    // 要求させると往復が1回増え、それは回線が細いほど効いてくる。
    // 知らないID・畳んだ会話を指されたら既定へ落とす（要求は信用しない）。
    const requested = req ? new URL(req.url ?? "/", "http://x").searchParams.get("thread") : null;
    const viewing =
      threads.find((t) => t.id === requested && t.state === "open") ?? defaultThread;
    if (viewing) {
      this.send(ws, { type: "history", threadId: viewing.id, entries: viewing.transcript });
    }

    // モデルとキャンバスは全スレッドぶん配る。**こちらは履歴と違って小さく**
    // （実測で合わせて 8KB 弱）、タブの見た目と復元がこれに依存している
    for (const thread of threads) {
      // その会話が使っているモデル。**会話ごと**なので1本ずつ配る（D3）
      const model = thread.model ?? this.hostDefaultModel();
      if (model) {
        this.send(ws, {
          type: "model_state",
          threadId: thread.id,
          provider: model.provider,
          id: model.id,
          vision: model.vision,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        });
      }
      // 分かっている会話だけ。まだターンが回っていなければ配らない
      const tokens = this.contextTokens.get(thread.id);
      if (tokens !== undefined) {
        this.send(ws, { type: "context_state", threadId: thread.id, tokens });
      }
      // 後から繋いだクライアントも即座に現在の表示状態に追いつく
      if (thread.canvas) {
        const snapshot = thread.canvas.snapshot();
        this.send(ws, {
          type: "canvas_state",
          threadId: thread.id,
          tabs: snapshot.tabs,
          activeTabId: snapshot.activeTabId,
        });
      }
    }
  }

  private async handleClientMessage(ws: WebSocket, data: Buffer): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString("utf-8")) as ClientMessage;
    } catch {
      // I2: 壊れたメッセージは黙って捨てず、理由を返す
      this.send(ws, { type: "error", message: "invalid JSON" });
      return;
    }
    // 既知の type を捌いたあと message は never に絞られるため、先に控えておく
    const receivedType: unknown = (message as { type?: unknown } | null)?.type;

    // 移った先の会話の履歴を配る（接続時に配らなかった分）。
    // **要求した1人にだけ返す**——他のクライアントは別の会話を見ている
    if (message?.type === "history_request") {
      const thread = this.threads.list().find((t) => t.id === message.threadId);
      if (!thread) {
        // I2: 知らない会話を空の履歴で黙って埋めない（画面が「発言なし」と誤って出る）
        this.send(ws, { type: "error", message: `unknown thread: ${message.threadId}` });
        return;
      }
      this.send(ws, { type: "history", threadId: thread.id, entries: thread.transcript });
      return;
    }

    // 枝を開く（ADR-0017 決定77）。開いても幹と他の枝は何も変わらない（決定2）。
    // **還す条件と理由は必須**——帳簿が拒むので、ここで補わない（I2）
    if (message?.type === "thread_open") {
      try {
        await this.threads.open(
          {
            kind: "branch",
            title: message.title,
            returnCondition: message.returnCondition,
            reason: message.reason,
            // POが画面から開いた（決定77：番頭の判断でも PO の指示でも開く）
            openedBy: "po",
          },
          // どの幹の枝かは**POが居た会話**で決まる（幹は複数ある）
          message.threadId
        );
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    // 枝を畳んで幹へ還す。幹は畳めない（帳簿が拒む）
    if (message?.type === "thread_merge") {
      try {
        this.threads.merge(message.threadId, message.conclusion);
      } catch (err) {
        // I2: 幹・未知のID・空の結論を黙って成功にしない
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    if (message?.type === "thread_reopen") {
      try {
        this.threads.reopen(message.threadId);
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    // POがタブから名前を付け直す（決定25 の人側）。番頭の thread.rename と同じ帳簿を通る
    if (message?.type === "thread_rename") {
      try {
        this.threads.rename(message.threadId, message.title);
      } catch (err) {
        // I2: 空の題・未知のIDを黙って成功にしない（画面は変わったつもりのまま残る）
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    // 以降は宛先スレッドが要る。threadId 省略時は既定スレッド（互換）
    let thread: Thread;
    try {
      thread = this.threads.resolve((message as { threadId?: string } | null)?.threadId);
    } catch (err) {
      // I2: 知らないIDを既定へ黙って落とさない——別の会話に発話が紛れ込む
      this.send(ws, { type: "error", message: String(err) });
      return;
    }

    // ── 取次。**会話に紐づかない**ので、スレッドの解決より先に捌く ──────────
    if (message?.type === "inbox_answer" || message?.type === "inbox_open") {
      await this.handleInbox(ws, message, thread);
      return;
    }

    /**
     * **PO がその場で章を畳む**（提案§3.2 の人側・決定25）。
     *
     * 自動で畳むのは文脈の量が閾値に達したときだけだが、**区切りは人にも分かる**
     * ——「この話は終わったので、ここから先は別の前提で進めたい」は量では拾えない。
     * 畳めたことは `onChapterClosed` が知らせとして流す（ここでは返さない）。
     */
    if (message?.type === "chapter_close") {
      // I2: 畳めない理由はその場で言う。押したのに何も起きないのが一番困る
      if (thread.state === "closed") {
        this.send(ws, {
          type: "error",
          message: `「${thread.title}」は畳んだ会話です。開き直してから区切ってください`,
        });
        return;
      }
      if (!thread.closeChapter) {
        this.send(ws, {
          type: "error",
          message:
            "この会話では章立てが働いていません（要約に使えるモデルがありません）。" +
            "設定でモデルを採用するか、BANTO_CHAPTER_MODEL を見直してください",
        });
        return;
      }
      /**
       * **喋っている最中は畳まない。** 道具を呼んでいる途中で文脈が消えると、番頭は
       * 自分が何をしていたか分からなくなる（自動の側が `agent_end` だけを見ているのと
       * 同じ理由）。待たせるのではなく断る——POは終わってから押し直せる。
       */
      if (thread.harness.isStreaming) {
        this.send(ws, {
          type: "error",
          message: "番頭が喋っている最中は区切れません。返事が終わってから押してください",
        });
        return;
      }
      try {
        // I2: **何も起きなかったことを黙らせない**（PO報告 2026-08-11）。まだ溜まって
        //     いない章・既に畳んでいる最中は畳みようがないが、押した側には見えない
        const folded = await thread.closeChapter();
        if (!folded) {
          this.send(ws, {
            type: "error",
            message:
              "畳むものがまだありません（この章にはやり取りが溜まっていないか、いま畳んでいる最中です）",
          });
        }
      } catch (err) {
        // I2: 資料が書けなければ畳まない（ChapterKeeper の決め）。その理由をそのまま出す
        this.send(ws, { type: "error", message: `章を畳めませんでした: ${String(err)}` });
      }
      return;
    }
    // その会話で使うモデルを変える。**会話ごと**なので、他の会話は変わらない
    if (message?.type === "set_model") {
      if (!this.selectModel) {
        this.send(ws, { type: "error", message: "このホストはモデルの切替に対応していません" });
        return;
      }
      try {
        const next = await this.selectModel(thread, message.provider, message.model, message.backend);
        // バックエンドごと変わったなら、会話のハーネスを差し替える（購読も張り直す）
        if (next.harness && next.harness !== thread.harness) {
          thread.replaceHarness(next.harness, (event) => this.handleHarnessEvent(thread, event));
        }
        thread.model = {
          ...(next.backend ? { backend: next.backend } : {}),
          provider: message.provider,
          id: next.id,
          vision: next.vision,
          ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
        };
        this.threads.persistIndex(thread);
        // 選んだ本人だけでなく全員へ。複数の画面で同じ会話を見ている（D3）
        this.broadcast({
          type: "model_state",
          threadId: thread.id,
          ...(next.backend ? { backend: next.backend } : {}),
          provider: message.provider,
          id: next.id,
          vision: next.vision,
          ...(next.contextWindow ? { contextWindow: next.contextWindow } : {}),
        });
      } catch (err) {
        // I2: 切り替わらなかったことを黙らない。画面は前のモデルのままになる
        this.send(ws, { type: "error", message: `モデルを変えられません: ${String(err)}` });
      }
      return;
    }

    if (message?.type === "abort") {
      await thread.harness.abort();
      return;
    }

    // POが直接キャンバスを操作する経路。番頭が canvas.* を呼んだときと同じく Canvas を
    // 通すので、表示状態の真実は一箇所のまま（D3）——UIが独自のタブ状態を持つことはない。
    // 決定25「人がGUIでできることは番頭にもできる。ただし経路が異なる」の人側。
    if (
      message?.type === "canvas_switch" ||
      message?.type === "canvas_close" ||
      message?.type === "canvas_reorder" ||
      message?.type === "canvas_open"
    ) {
      const canvas = thread.canvas;
      if (!canvas) {
        this.send(ws, { type: "error", message: "canvas is not enabled on this host" });
        return;
      }
      try {
        if (message.type === "canvas_switch") canvas.switchTo(message.tabId);
        else if (message.type === "canvas_close") canvas.close(message.tabId);
        else if (message.type === "canvas_reorder") canvas.reorder(message.tabId, message.toIndex);
        else {
          const tab = canvas.open(message.kind, message.params ?? {}, message.title, {
            ...(message.newTab === true ? { newTab: true } : {}),
          });
          // **開いた面は会話に残す**（決定78 の「面への口」）。番頭が開いたときと同じ形
          // ——POが自分で開いた面も、あとから遡って開き直せる（決定25：経路が違うだけ）
          const spec = this.catalog?.get(tab.kind);
          this.showUtsuwa(
            thread.id,
            openUtsuwa({
              view: tab.kind,
              label: tab.title,
              ...(spec?.description ? { meta: spec.description } : {}),
              args: tab.params,
            })
          );
        }
      } catch (err) {
        // I2: 未知のタブID・未知のkindは黙って無視せず理由を返す
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    if (message?.type === "prompt") {
      /**
       * **畳んだ会話には話しかけられない**（PO報告 2026-08-10）。
       *
       * 枝を畳んだのに入力欄が生きていると、還したはずの話が続き、幹に還した結論と
       * 食い違う（実際に踏んだ）。**知らせは届く**（決定35b）ので、そちらは止めない。
       * I2: 黙って捨てず、開き直せることまで言う。
       */
      if (thread.state === "closed") {
        this.send(ws, {
          type: "error",
          message:
            thread.kind === "branch"
              ? `枝「${thread.title}」は畳みました（結論：${thread.conclusion ?? "—"}）。` +
                "続けるなら履歴から開き直してください"
              : `幹「${thread.title}」は終えました。続けるなら履歴から開き直してください`,
        });
        return;
      }
      if (
        typeof message.text !== "string" ||
        (message.text.length === 0 && (!message.attachments || message.attachments.length === 0))
      ) {
        this.send(ws, {
          type: "error",
          message: "prompt requires a non-empty text or an attachment",
        });
        return;
      }

      // 添付の扱い。画像はモデルへ直接渡し、テキストファイルは work/attachments/ に
      // 保存して file.read で読めるようにする（パス注釈をプロンプトに追記）。
      // I2: 非対応モデルへの画像は握りつぶさず、理由を返して prompt 自体を処理しない
      let text = message.text;
      const images: HarnessImage[] = [];
      // 会話に残す添付。**中身ではなく保存先だけ**を持つ（TranscriptAttachment）
      const recorded: TranscriptAttachment[] = [];
      if (message.attachments && message.attachments.length > 0) {
        for (const attachment of message.attachments) {
          if (attachment.kind === "image") {
            // **その会話のモデル**で判定する（会話ごとに違う。未設定なら番頭の標準）
            const active = thread.model ?? this.hostDefaultModel();
            if (!active?.vision) {
              this.send(ws, {
                type: "error",
                message: `${active?.id ?? "現在のモデル"} は画像非対応です`,
              });
              return;
            }
            images.push({
              type: "image",
              data: attachment.dataBase64,
              mimeType: attachment.mimeType,
            });
            // 送った画像は吹き出しに残す。base64 を履歴に積まないよう、ここで保存して参照にする
            const savedName = this.saveAttachment(
              attachment.name,
              Buffer.from(attachment.dataBase64, "base64")
            );
            recorded.push({
              kind: "image",
              name: attachment.name,
              url: ATTACHMENT_URL_BASE + savedName,
              mimeType: attachment.mimeType,
            });
          } else {
            const savedName = this.saveAttachment(attachment.name, attachment.content);
            text += `\n\n[添付] ${ATTACHMENT_DIR_REL}/${savedName}（file.read で参照可）`;
            recorded.push({
              kind: "file",
              name: attachment.name,
              url: ATTACHMENT_URL_BASE + savedName,
            });
          }
        }
      }

      // 発話も履歴の一部。送った本人以外にも配る（複数クライアントで会話が揃う）。
      // 添付のみで本文が空のときは、空バブルでなく何を添付したか分かる文言で載せる
      const displayText =
        message.text.length > 0
          ? message.text
          : `[${message.attachments
              ?.map((a) => (a.kind === "image" ? "画像" : "ファイル"))
              .join("・") ?? "添付"}を添付]`;
      const withAttachments = recorded.length > 0 ? { attachments: recorded } : {};
      thread.record({ role: "po", text: displayText, ...withAttachments });
      this.broadcast({
        type: "po_message",
        threadId: thread.id,
        text: displayText,
        ...withAttachments,
      });
      this.broadcast({ type: "turn_start", threadId: thread.id });

      try {
        // ストリーミング中の追加入力は steer として積む（pi の既定では例外になるため）
        await this.promptEvenWhileBusy(thread, text, {
          ...(images.length > 0 ? { images } : {}),
        });
      } catch (err) {
        // I2: ターンの失敗はクライアントへ伝える。握りつぶすと会話が無応答に見える
        thread.record({ role: "error", text: String(err) });
        this.broadcast({ type: "turn_end", threadId: thread.id, errorMessage: String(err) });
        return;
      }
      const lastError = thread.getLastError();
      if (lastError) thread.record({ role: "error", text: lastError });
      this.broadcast({
        type: "turn_end",
        threadId: thread.id,
        ...(lastError ? { errorMessage: lastError } : {}),
      });
      return;
    }

    this.send(ws, { type: "error", message: `unknown message type: ${String(receivedType)}` });
  }

  /**
   * 添付を `work/attachments/` に保存し、保存名を返す。テキストは文字列、画像は
   * バイト列（base64 を戻したもの）で渡す。
   *
   * **ファイル名はクライアント由来なので信頼しない**——パス区切りや `..` を剥がして
   * ベース名だけにし、タイムスタンプを前置きして衝突を避ける（I1：ずるは不可能にする）。
   * 既存の file.read と同じワークスペースのルート配下に置くので、番頭が読める。
   */
  private saveAttachment(originalName: string, content: string | Buffer): string {
    const base = path
      .basename(originalName)
      .replace(/[^\w.()\-\u3000-\u9fff\uff00-\uffef]/g, "_")
      .slice(0, 120);
    const name = `${Date.now()}-${base.length > 0 ? base : "attachment"}`;
    const dir = path.join(workspaceRoot(), ATTACHMENT_DIR_REL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
    return name;
  }

  /**
   * wire名を論理名へ戻す（決定22）。番頭・クライアント側は常に論理名で扱う。
   * 逆引きできない名前（pi 組み込み等、名前空間規則に従わないもの）はそのまま通す。
   */
  private toLogicalName(wireName: string): string {
    try {
      return fromWireToolName(wireName);
    } catch {
      return wireName;
    }
  }

  /**
   * ハーネスの出来事を受けて、履歴へ積み・配信する（ADR-0020 決定89）。
   *
   * **翻訳はもうここに無い。** 生のイベントを解釈していたのはバックエンド依存の仕事で、
   * ハーネスの内側へ下ろした。ここに残るのは番頭の仕事——宛先（threadId）を付け、
   * 大きすぎる中身を切り詰め（決定81）、履歴に残し、配る。
   */
  private handleHarnessEvent(thread: Thread, event: HarnessEvent): void {
    const translated = this.toServerEvent(thread, event);
    if (!translated) return;

    // 配信すると同時に**そのスレッドの**履歴へ積む（リロード後に同じ内容が再現される）
    if (translated.type === "notice") {
      // まとめ直しの知らせ。**履歴にも残す**——再読み込みしたときに「なぜ番頭が
      // 前の話を覚えていないのか」が分からなくなる
      thread.record({ role: "notice", source: translated.source, text: translated.text });
    } else if (translated.type === "text_delta") {
      thread.record({ role: "banto", text: translated.delta });
    } else if (translated.type === "reasoning_delta") {
      thread.record({ role: "reasoning", text: translated.delta });
    } else if (translated.type === "reasoning_end") {
      // 本文は足さず、考えていた時間だけを最後の思考へ入れる
      thread.record({ role: "reasoning", text: "", durationMs: translated.durationMs });
    } else if (translated.type === "tool_start") {
      thread.record({
        role: "tool",
        name: translated.name,
        state: "running",
        ...(translated.input !== undefined ? { input: translated.input } : {}),
      });
    } else if (translated.type === "tool_end") {
      thread.record({
        role: "tool",
        name: translated.name,
        state: translated.isError ? "failed" : "ok",
        ...(translated.output !== undefined ? { output: translated.output } : {}),
      });
    }
    this.broadcast(translated);
  }

  /**
   * ハーネスの語彙（`HarnessEvent`）を Banto のプロトコル（`ServerEvent`）へ写す。
   *
   * **バックエンド依存の解釈はここに無い**（ADR-0020 決定89）。残っているのは
   * 番頭の仕事だけ——宛先を付ける、中身を切り詰める（決定81 `TOOL_PAYLOAD_MAX_CHARS`）、
   * 文脈の使用量を覚える。対象外は undefined（そのまま捨てる）。
   */
  private toServerEvent(thread: Thread, event: HarnessEvent): ServerEvent | undefined {
    switch (event.type) {
      case "text_delta":
        return { type: "text_delta", threadId: thread.id, delta: event.delta };
      case "reasoning_delta":
        return { type: "reasoning_delta", threadId: thread.id, delta: event.delta };
      case "reasoning_end":
        return { type: "reasoning_end", threadId: thread.id, durationMs: event.durationMs };
      case "notice":
        return { type: "notice", threadId: thread.id, source: event.source, text: event.text };
      case "turn_end": {
        // そのターンで運んだ量＝次に運ぶ量の目安。分かったときだけ画面へ出す
        if (event.contextTokens === undefined || event.contextTokens <= 0) return undefined;
        this.contextTokens.set(thread.id, event.contextTokens);
        return { type: "context_state", threadId: thread.id, tokens: event.contextTokens };
      }
      case "run_end":
        // 章を閉じるかの判定は ChapterKeeper が同じ出来事を購読して行う。画面には出さない
        return undefined;
      case "tool_start": {
        const input = clampToolPayload(event.input);
        return {
          type: "tool_start",
          threadId: thread.id,
          toolCallId: event.toolCallId,
          name: event.name,
          ...(input !== undefined ? { input } : {}),
        };
      }
      case "tool_end": {
        const output = clampToolPayload(event.output);
        return {
          type: "tool_end",
          threadId: thread.id,
          toolCallId: event.toolCallId,
          name: event.name,
          isError: event.isError,
          ...(output !== undefined ? { output } : {}),
        };
      }
    }
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  /**
   * 取次の一通を開く／答える。
   *
   * **会話と面を同時に動かす**のが取次の要点なので、両方ここで動かす——画面が2回に
   * 分けて操作すると、片方だけ動いた状態が一瞬見える。
   *
   * 答えたことは**番頭にも伝える**（会話へ知らせを差し込む）。伝えないと、番頭は
   * 自分が積んだ判断がまだ待っていると思い込んで、同じことをもう一度訊いてくる。
   */
  private async handleInbox(
    ws: WebSocket,
    message: { type: "inbox_answer" | "inbox_open"; itemId: string; actionId?: string },
    fallbackThread: Thread
  ): Promise<void> {
    if (!this.inbox) {
      this.send(ws, { type: "error", message: "このホストは取次を持っていません" });
      return;
    }
    const item = this.inbox.get(message.itemId);
    // I2: 知らない id を黙って捨てない
    if (!item) {
      this.send(ws, { type: "error", message: `取次に "${message.itemId}" という一通はありません` });
      return;
    }

    // 開く先。会話が指定されていればそこへ、面が指定されていればその会話のキャンバスへ
    const target = item.opens?.threadId ? this.threads.get(item.opens.threadId) : undefined;
    const thread = target ?? fallbackThread;
    if (item.opens?.canvas) {
      try {
        thread.canvas?.open(
          item.opens.canvas.kind,
          item.opens.canvas.params ?? {},
          item.opens.canvas.title
        );
      } catch (err) {
        // I2: 面が開けなかったことは伝える。ただし答えそのものは通す
        this.send(ws, { type: "error", message: `面を開けません: ${String(err)}` });
      }
    }

    if (message.type === "inbox_open") return;

    const action = item.actions.find((a) => a.id === message.actionId);
    // I2: 知らない選択肢はここで断る（Inbox.resolve も断るが、先に効果を走らせないため）
    if (!action) {
      this.send(ws, {
        type: "error",
        message:
          `"${message.actionId ?? ""}" は「${item.title}」の選択肢にありません` +
          `（${item.actions.map((a) => a.id).join(" / ")}）`,
      });
      return;
    }

    /**
     * 押されたことを**先に効かせる**（決定73）。
     *
     * I2: 効かせられなかったら畳まない。「許した」と記録が残るのに書けないままなのが
     * 一番たちが悪い——札は判断待ちのまま残り、POはもう一度押せる。
     */
    let effectText: string | undefined;
    if (action.effect) {
      if (!this.runInboxEffect) {
        this.send(ws, {
          type: "error",
          message: `この選択肢は処理を伴いますが、このホストは実行の口を持っていません（${action.effect.module}.${action.effect.tool}）`,
        });
        return;
      }
      try {
        effectText = await this.runInboxEffect(action.effect);
      } catch (err) {
        this.send(ws, { type: "error", message: `「${action.label}」を実行できません: ${String(err)}` });
        return;
      }
    }

    let answered: InboxItem;
    try {
      answered = this.inbox.resolve(item.id, action.id);
    } catch (err) {
      this.send(ws, { type: "error", message: String(err) });
      return;
    }

    /**
     * 番頭へ。**POが決めたという事実**だけを渡し、解釈は番頭に任せる（D5）。
     *
     * `notify` で入れるので、記録に残り**ターンが回る**（決定73）——broadcast だけだと
     * 画面には出るが番頭は何も知らず、POは「押したのに進まない」を見ることになる
     * （実際にそうなっていた）。宛先はその一通が指す会話。
     */
    const text =
      `取次「${answered.title}」に PO が答えました：**${action.label}**\n` +
      `（求めていた判断：${answered.ask}）` +
      (effectText ? `\n結果：${effectText}` : "") +
      "\n\nこの答えを踏まえて、待っていた作業を続けてください。";
    // 待たない：ターンの完走を待つとボタンの反応が返らない。失敗は notify 側が記録する
    void this.notify(text, { threadId: thread.id, source: answered.source.id }).catch((err) => {
      this.send(ws, { type: "error", message: `番頭へ答えを伝えられません: ${String(err)}` });
    });
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}

/**
 * 「まだ前のターンを処理している」という返事か（PO報告 2026-08-11）。
 *
 * ハーネスごとに文面が違いうるので、**言い回しではなく意味で拾う**。取りこぼしても
 * 従来どおり失敗するだけで、余計に拾っても steer として積み直すだけ——どちらに転んでも
 * 「PO の言葉が消える」ことにはならない側へ倒す。
 */
function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already processing|in progress|steer\(\)|busy/iu.test(message);
}
