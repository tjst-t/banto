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
import type { ImageContent } from "@mariozechner/pi-ai";

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
} from "./protocol.js";
import { fromWireToolName } from "@banto/core";
import type { Thread, ThreadRegistry } from "./threads.js";
import { workspaceRoot } from "./workspace.js";

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
    options?: { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] }
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
  onSelectModel?: (thread: Thread, provider: string, model: string) => Promise<ModelInfo>;
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
  private readonly clients = new Set<WebSocket>();
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
    | { provider: string; id: string; vision: boolean; contextWindow?: number }
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
    this.modelInfo = options.model;
    this.modelProvider = options.modelProvider;
    this.selectModel = options.onSelectModel;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
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

    thread.disposers.push(
      thread.session.subscribe((event) => this.handleSessionEvent(thread, event))
    );
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
    let thread: Thread;
    try {
      thread = this.threads.resolve(options.threadId);
    } catch (err) {
      // I2: 宛先不明の知らせを黙って捨てない
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    thread.notices = thread.notices.then(async () => {
      thread.record({ role: "notice", source, text });
      this.broadcast({ type: "notice", threadId: thread.id, source, text });
      // 職人の報告でも番頭は喋り出す。ここを知らせないと画面から中断する手段が消える
      this.broadcast({ type: "turn_start", threadId: thread.id });
      try {
        await thread.session.prompt(text, {
          ...(thread.session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        });
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

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
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

    this.send(ws, {
      type: "welcome",
      // スレッドを知らないクライアントとの互換。扱えるクライアントは threads を見る
      ...(defaultThread ? { sessionId: defaultThread.session.sessionId } : {}),
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

    // 開いている全スレッドぶん配る。リロードしても会話が消えず、途中から繋いだ
    // クライアントも履歴を見られる——1接続で複数スレッドを描けるのはこのため
    for (const thread of threads) {
      this.send(ws, { type: "history", threadId: thread.id, entries: thread.transcript });
      // その会話が使っているモデル。**会話ごと**なので history と同じく1本ずつ配る（D3）
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

    // スレッドの開閉。開いても既存スレッドは何も変わらない（決定2）
    if (message?.type === "thread_open") {
      try {
        await this.threads.open(message.title);
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }
    if (message?.type === "thread_close") {
      try {
        this.threads.close(message.threadId);
      } catch (err) {
        // I2: 既定スレッド・未知のIDを黙って成功にしない
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

    // 以降は宛先スレッドが要る。threadId 省略時は既定スレッド（互換）
    let thread: Thread;
    try {
      thread = this.threads.resolve((message as { threadId?: string } | null)?.threadId);
    } catch (err) {
      // I2: 知らないIDを既定へ黙って落とさない——別の会話に発話が紛れ込む
      this.send(ws, { type: "error", message: String(err) });
      return;
    }

    // その会話で使うモデルを変える。**会話ごと**なので、他の会話は変わらない
    if (message?.type === "set_model") {
      if (!this.selectModel) {
        this.send(ws, { type: "error", message: "このホストはモデルの切替に対応していません" });
        return;
      }
      try {
        const next = await this.selectModel(thread, message.provider, message.model);
        thread.model = {
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
      await thread.session.abort();
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
          canvas.open(message.kind, message.params ?? {}, message.title, {
            ...(message.newTab === true ? { newTab: true } : {}),
          });
        }
      } catch (err) {
        // I2: 未知のタブID・未知のkindは黙って無視せず理由を返す
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    if (message?.type === "new_session") {
      // いまの会話を畳んで新しく始める。**捨てない**——畳んだ会話は履歴に残り再開できる
      // （PO要望 2026-07-31）。先に開くのは、宛先が一瞬でも無くならないようにするため
      try {
        await this.threads.open();
        this.threads.close(thread.id);
      } catch (err) {
        this.send(ws, { type: "error", message: String(err) });
      }
      return;
    }

    if (message?.type === "prompt") {
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
      const images: ImageContent[] = [];
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
        await thread.session.prompt(text, {
          ...(images.length > 0 ? { images } : {}),
          ...(thread.session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
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

  private handleSessionEvent(thread: Thread, event: unknown): void {
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
   * ハーネスのセッションイベントを Banto のプロトコルへ変換する。
   * 対象外のイベントは undefined（そのまま捨てる）。
   */
  private toServerEvent(thread: Thread, event: unknown): ServerEvent | undefined {
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      args?: unknown;
      result?: unknown;
      assistantMessageEvent?: { type?: string; delta?: string };
    } | null;

    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      return { type: "text_delta", threadId: thread.id, delta: String(e.assistantMessageEvent.delta) };
    }
    // 思考（thinking）。ハーネスは text とは別のイベントで出す
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_start") {
      this.thinkingStartedAt.set(thread.id, Date.now());
      return undefined;
    }
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_delta") {
      return {
        type: "reasoning_delta",
        threadId: thread.id,
        delta: String(e.assistantMessageEvent.delta),
      };
    }
    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "thinking_end") {
      const startedAt = this.thinkingStartedAt.get(thread.id);
      this.thinkingStartedAt.delete(thread.id);
      // 開始を見ていない（途中で繋がった等）ときは 0。時間を推測して名乗らない（I1）
      return {
        type: "reasoning_end",
        threadId: thread.id,
        durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
      };
    }
    /**
     * 文脈のまとめ直し（compaction）。**黙って進めない**——ハーネスは文脈が長くなると
     * 自動で会話を要約して置き換える。話した内容が実際に削られるので、起きたことは
     * 会話に残す（PO要望 2026-08-04：それまで画面には何も出ていなかった）。
     */
    if (e?.type === "compaction_end") {
      const done = e as {
        reason?: string;
        aborted?: boolean;
        errorMessage?: string;
        result?: { tokensBefore?: number };
      };
      if (done.aborted) return undefined;
      // I2: 失敗したことも隠さない（要約できないまま長い文脈で走り続ける）
      if (done.errorMessage) {
        return {
          type: "notice",
          threadId: thread.id,
          source: "system",
          text: `文脈のまとめ直しに失敗しました：${done.errorMessage}`,
        };
      }
      const before = done.result?.tokensBefore;
      const why =
        done.reason === "overflow"
          ? "文脈があふれたため"
          : done.reason === "manual"
            ? "指示により"
            : "文脈が長くなったため";
      return {
        type: "notice",
        threadId: thread.id,
        source: "system",
        text:
          `${why}、ここまでの会話をまとめ直しました` +
          (before ? `（まとめる前 ${before.toLocaleString()} トークン）` : "") +
          "。**古いやり取りは要約に置き換わっています**——番頭が細部を覚えていないときは、" +
          "必要な前提をもう一度伝えてください。",
      };
    }

    // ターンの終わりに、そのターンで運んだトークン数が分かる。
    // **入力＋キャッシュ＋出力**＝次のターンで運ぶ量の目安（文脈の使用量として出す）
    if (e?.type === "turn_end") {
      const usage = (e as { message?: { usage?: Record<string, unknown> } }).message?.usage;
      if (usage) {
        const tokens =
          numberOf(usage["input"]) +
          numberOf(usage["cacheRead"]) +
          numberOf(usage["cacheWrite"]) +
          numberOf(usage["output"]);
        if (tokens > 0) {
          this.contextTokens.set(thread.id, tokens);
          return { type: "context_state", threadId: thread.id, tokens };
        }
      }
      return undefined;
    }
    if (e?.type === "tool_execution_start") {
      const input = clampToolPayload(e.args);
      return {
        type: "tool_start",
        threadId: thread.id,
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
        ...(input !== undefined ? { input } : {}),
      };
    }
    if (e?.type === "tool_execution_end") {
      const output = clampToolPayload(e.result);
      return {
        type: "tool_end",
        threadId: thread.id,
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
        isError: Boolean(e.isError),
        ...(output !== undefined ? { output } : {}),
      };
    }
    return undefined;
  }

  private send(ws: WebSocket, event: ServerEvent): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  private broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }
}
