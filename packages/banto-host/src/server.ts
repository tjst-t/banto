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

import {
  BANTO_DEFAULT_PORT,
  BANTO_WS_PATH,
  type ClientMessage,
  type ServerEvent,
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
  /**
   * 直近のターンでプロバイダ側エラーがあれば返す。turn_end に載せる。
   * pi の場合は `() => session.agent.state.errorMessage`。
   */
  getLastError?: () => string | undefined;
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
  private readonly clients = new Set<WebSocket>();
  private readonly unsubscribe: () => void;

  private constructor(options: BantoHostServerOptions, httpServer: http.Server) {
    this.session = options.session;
    this.toolNames = options.tools.map((t) => t.name);
    this.getLastError = options.getLastError ?? ((): string | undefined => undefined);
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ server: httpServer, path: BANTO_WS_PATH });

    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
    this.unsubscribe = this.session.subscribe((event) => this.handleSessionEvent(event));
  }

  /** サーバを起動し、待ち受け開始まで待つ。 */
  static async start(options: BantoHostServerOptions): Promise<BantoHostServer> {
    const httpServer = http.createServer((req, res) => {
      // 死活確認のみ。番頭との対話はすべて WS 側（プロトコルを1本に保つ）。
      if (req.method === "GET" && req.url === "/health") {
        const body = JSON.stringify({ ok: true });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
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

    this.send(ws, { type: "welcome", sessionId: this.session.sessionId, tools: this.toolNames });
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

    if (message?.type === "prompt") {
      if (typeof message.text !== "string" || message.text.length === 0) {
        this.send(ws, { type: "error", message: "prompt requires a non-empty text" });
        return;
      }
      try {
        // ストリーミング中の追加入力は steer として積む（pi の既定では例外になるため）
        await this.session.prompt(message.text, {
          ...(this.session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        });
      } catch (err) {
        // I2: ターンの失敗はクライアントへ伝える。握りつぶすと会話が無応答に見える
        this.broadcast({ type: "turn_end", errorMessage: String(err) });
        return;
      }
      const lastError = this.getLastError();
      this.broadcast({ type: "turn_end", ...(lastError ? { errorMessage: lastError } : {}) });
      return;
    }

    this.send(ws, { type: "error", message: `unknown message type: ${String(receivedType)}` });
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
    if (translated) this.broadcast(translated);
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
