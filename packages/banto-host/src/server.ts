/**
 * 番頭ホストの常駐サーバ（task-0009）。
 *
 * pi の AgentSession を1つ抱え、その進行を WebSocket で配信する。CLI も WebUI も
 * このサーバの同格クライアントになる（Kobo と同じ形。CLAUDE.md・ADR-0010 決定6）。
 *
 * D5: 判断ロジックを持たない。セッションの組み立ては host-session.ts、記憶・SKILLは
 *     それぞれのモジュールにあり、ここは pub/sub とプロトコル変換だけを行う。
 * D6: ws — Node 20 には WebSocket サーバ実装が無い（banto-daemon と同じ理由で同じ依存）。
 * I2: 不正なメッセージは黙って捨てず、error イベントで返す。
 */

import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import type { Canvas, CanvasCatalog } from "./canvas.js";
import { CORE_ORIGIN, type ModuleRegistry } from "./module.js";
import { createModuleToolHandler } from "./module-serve.js";
import {
  BANTO_DEFAULT_PORT,
  BANTO_WS_PATH,
  type ClientMessage,
  type ServerEvent,
  type TranscriptEntry,
} from "./protocol.js";
import { fromWireToolName } from "./tool-namespace.js";
import type { NamespacedToolDefinition } from "./tool-registry.js";

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
  prompt(text: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
  abort(): Promise<void>;
}

export interface BantoHostServerOptions {
  /** 配信対象のセッション（createBantoHostSession の戻り値がそのまま渡せる）。 */
  session: HostSession;
  /** セッションに登録した論理名のTool。welcome と wire名→論理名の逆引きに使う。 */
  tools: NamespacedToolDefinition[];
  /** 待ち受けポート。0 を渡すと空きポートが割り当てられる（テスト用）。 */
  port?: number;
  /** キャンバス。渡すと表示状態がクライアントへ配信される。 */
  canvas?: Canvas;
  /** GUIカタログ。welcome でクライアントへ渡し、UIがコンポーネントを解決する。 */
  catalog?: CanvasCatalog;
  /**
   * モジュールの帳簿。渡すと welcome のカタログエントリに、各GUIの提供元モジュールと
   * その接続情報が載る（決定25：UIはコンポーネントに直書きせずここから到達先を得る）。
   */
  modules?: ModuleRegistry;
  /**
   * 直近のターンでプロバイダ側エラーがあれば返す。turn_end に載せる。
   * pi の場合は `() => session.agent.state.errorMessage`。
   */
  getLastError?: () => string | undefined;
  /**
   * 会話履歴を捨てる（new_session）。記憶とキャンバスは触らない。
   * pi の場合は `() => { session.agent.state.messages = []; }`。
   */
  clearHistory?: () => void;
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
  private readonly session: HostSession;
  private readonly toolNames: string[];
  private readonly getLastError: () => string | undefined;
  private readonly clearHistory: () => void;
  /** 会話の真実。接続時にまとめて配り、以後は差分イベントで追随させる（D3）。 */
  private transcript: TranscriptEntry[] = [];
  private readonly canvas: Canvas | undefined;
  private readonly catalog: CanvasCatalog | undefined;
  private readonly modules: ModuleRegistry | undefined;
  private readonly clients = new Set<WebSocket>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCanvas: () => void;
  /**
   * 知らせを1本ずつ順に流すための鎖。
   * 職人が同時に複数報告してくることはあるので、ターンを重ねて割り込ませない。
   */
  private notices: Promise<void> = Promise.resolve();

  private constructor(options: BantoHostServerOptions, httpServer: http.Server) {
    this.session = options.session;
    this.toolNames = options.tools.map((t) => t.name);
    this.getLastError = options.getLastError ?? ((): string | undefined => undefined);
    this.clearHistory = options.clearHistory ?? ((): void => undefined);
    this.canvas = options.canvas;
    this.catalog = options.catalog;
    this.modules = options.modules;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ server: httpServer, path: BANTO_WS_PATH });

    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
    this.unsubscribe = this.session.subscribe((event) => this.handleSessionEvent(event));
    // D3: キャンバスの真実はホスト側。状態が変わるたび全クライアントへ配る
    this.unsubscribeCanvas =
      this.canvas?.subscribe((snapshot) =>
        this.broadcast({ type: "canvas_state", tabs: snapshot.tabs, activeTabId: snapshot.activeTabId })
      ) ?? ((): void => undefined);
  }

  /** サーバを起動し、待ち受け開始まで待つ。 */
  static async start(options: BantoHostServerOptions): Promise<BantoHostServer> {
    // 組み込みモジュールのデータAPI（決定25：組み込みの提供元は Banto ホスト自身）。
    // UI はここからデータを取る——番頭の Tool 経路は通らない。
    const serveModuleTool = options.modules ? createModuleToolHandler(options.modules) : undefined;

    const httpServer = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url === "/health") {
          const body = JSON.stringify({ ok: true });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        if (serveModuleTool && (await serveModuleTool(req, res))) return;

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
      httpServer.listen(options.port ?? BANTO_DEFAULT_PORT, () => {
        httpServer.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  /**
   * 番頭に外から知らせを入れる（決定29）。職人からの報告・質問がここを通る。
   *
   * POの発話ではないので `notice` として配り、UIでも見分けられるようにする。
   * 知らせを入れたら番頭のターンを回す——**気づかせるのが目的**なので、
   * ログに積むだけでは足りない。
   *
   * 知らせ同士は直列化する。同時に3人の職人が報告してきても、ターンは1本ずつ進む。
   */
  notify(text: string): Promise<void> {
    this.notices = this.notices.then(async () => {
      this.record({ role: "notice", text });
      this.broadcast({ type: "notice", text });
      try {
        await this.session.prompt(text, {
          ...(this.session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        });
      } catch (err) {
        // I2: 知らせが番頭に届かなかったことを黙らせない
        this.record({ role: "error", text: String(err) });
        this.broadcast({ type: "turn_end", errorMessage: String(err) });
        return;
      }
      const lastError = this.getLastError();
      if (lastError) this.record({ role: "error", text: lastError });
      this.broadcast({ type: "turn_end", ...(lastError ? { errorMessage: lastError } : {}) });
    });
    return this.notices;
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
    this.unsubscribe();
    this.unsubscribeCanvas();
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  // ── 接続とクライアントメッセージ ───────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("message", (data: Buffer) => void this.handleClientMessage(ws, data));

    this.send(ws, {
      type: "welcome",
      sessionId: this.session.sessionId,
      tools: this.toolNames,
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
          endpoint: owner?.endpoint.baseUrl ?? "",
        };
      }),
    });
    // リロードしても会話が消えず、途中から繋いだクライアントも履歴を見られる
    this.send(ws, { type: "history", entries: this.transcript });

    // 後から繋いだクライアントも即座に現在の表示状態に追いつく
    if (this.canvas) {
      const snapshot = this.canvas.snapshot();
      this.send(ws, { type: "canvas_state", tabs: snapshot.tabs, activeTabId: snapshot.activeTabId });
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

    if (message?.type === "abort") {
      await this.session.abort();
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
      if (!this.canvas) {
        this.send(ws, { type: "error", message: "canvas is not enabled on this host" });
        return;
      }
      try {
        if (message.type === "canvas_switch") this.canvas.switchTo(message.tabId);
        else if (message.type === "canvas_close") this.canvas.close(message.tabId);
        else if (message.type === "canvas_reorder") this.canvas.reorder(message.tabId, message.toIndex);
        else {
          this.canvas.open(message.kind, message.params ?? {}, message.title, {
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
      this.clearHistory();
      this.transcript = [];
      this.broadcast({ type: "history", entries: [] });
      return;
    }

    if (message?.type === "prompt") {
      if (typeof message.text !== "string" || message.text.length === 0) {
        this.send(ws, { type: "error", message: "prompt requires a non-empty text" });
        return;
      }
      // 発話も履歴の一部。送った本人以外にも配る（複数クライアントで会話が揃う）
      this.record({ role: "po", text: message.text });
      this.broadcast({ type: "po_message", text: message.text });

      try {
        // ストリーミング中の追加入力は steer として積む（pi の既定では例外になるため）
        await this.session.prompt(message.text, {
          ...(this.session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        });
      } catch (err) {
        // I2: ターンの失敗はクライアントへ伝える。握りつぶすと会話が無応答に見える
        this.record({ role: "error", text: String(err) });
        this.broadcast({ type: "turn_end", errorMessage: String(err) });
        return;
      }
      const lastError = this.getLastError();
      if (lastError) this.record({ role: "error", text: lastError });
      this.broadcast({ type: "turn_end", ...(lastError ? { errorMessage: lastError } : {}) });
      return;
    }

    this.send(ws, { type: "error", message: `unknown message type: ${String(receivedType)}` });
  }

  // ── 会話履歴 ───────────────────────────────────────────────────────────────

  /**
   * 履歴に1行足す。テキスト差分は直前の番頭発話へ連結し、Tool終了は対応する
   * 実行中の行を更新する——クライアント側の描画と同じ形に揃えておくことで、
   * 再接続時に history をそのまま描けば会話が復元される。
   */
  private record(entry: TranscriptEntry): void {
    const last = this.transcript[this.transcript.length - 1];
    if (entry.role === "banto" && last?.role === "banto") {
      this.transcript[this.transcript.length - 1] = { role: "banto", text: last.text + entry.text };
      return;
    }
    if (entry.role === "tool" && entry.state !== "running") {
      const index = this.transcript.findIndex(
        (e) => e.role === "tool" && e.name === entry.name && e.state === "running"
      );
      if (index !== -1) {
        this.transcript[index] = entry;
        return;
      }
    }
    this.transcript.push(entry);
  }

  // ── セッションイベントの配信 ───────────────────────────────────────────────

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

  private handleSessionEvent(event: unknown): void {
    const translated = this.toServerEvent(event);
    if (!translated) return;

    // 配信すると同時に履歴へも積む（リロード後に同じ内容が再現される）
    if (translated.type === "text_delta") {
      this.record({ role: "banto", text: translated.delta });
    } else if (translated.type === "tool_start") {
      this.record({ role: "tool", name: translated.name, state: "running" });
    } else if (translated.type === "tool_end") {
      this.record({
        role: "tool",
        name: translated.name,
        state: translated.isError ? "failed" : "ok",
      });
    }
    this.broadcast(translated);
  }

  /**
   * ハーネスのセッションイベントを Banto のプロトコルへ変換する。
   * 対象外のイベントは undefined（そのまま捨てる）。
   */
  private toServerEvent(event: unknown): ServerEvent | undefined {
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      assistantMessageEvent?: { type?: string; delta?: string };
    } | null;

    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      return { type: "text_delta", delta: String(e.assistantMessageEvent.delta) };
    }
    if (e?.type === "tool_execution_start") {
      return {
        type: "tool_start",
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
      };
    }
    if (e?.type === "tool_execution_end") {
      return {
        type: "tool_end",
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
        isError: Boolean(e.isError),
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
