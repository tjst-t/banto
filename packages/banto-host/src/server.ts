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
import { WebSocketServer, WebSocket } from "ws";

import type { CanvasCatalog } from "./canvas.js";
import { CORE_ORIGIN, type ModuleRegistry } from "./module.js";
import { createModuleToolHandler } from "./module-serve.js";
import {
  BANTO_DEFAULT_PORT,
  BANTO_WS_PATH,
  type ClientMessage,
  type NoticeSource,
  type ServerEvent,
} from "./protocol.js";
import { fromWireToolName } from "@banto/core";
import type { Thread, ThreadRegistry } from "./threads.js";

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
   * 待ち受けるアドレス（既定 `127.0.0.1`）。
   *
   * **Banto は認証を持たない**（決定40）。守るのは前段（Caddy 等）の役目という裁定だが、
   * ホストが全インターフェースで待っていると**前段を素通りして直に叩ける**——認証が
   * 飾りになる。既定を localhost に閉じることで、「前段に置く」が本当に効く形にする。
   *
   * I1: 運用の心がけではなく機構で担保する。広げるには明示的に指定させ、警告を出す。
   */
  host?: string;
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
  /** 購読を張り終えたスレッド。開くたびに増える。 */
  private readonly attached = new Set<string>();

  private constructor(options: BantoHostServerOptions, httpServer: http.Server) {
    this.threads = options.threads;
    this.catalog = options.catalog;
    this.modules = options.modules;
    this.httpServer = httpServer;
    this.wss = new WebSocketServer({ server: httpServer, path: BANTO_WS_PATH });

    this.wss.on("connection", (ws: WebSocket) => this.handleConnection(ws));
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

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
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
          endpoint: owner?.endpoint.baseUrl ?? "",
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
      if (typeof message.text !== "string" || message.text.length === 0) {
        this.send(ws, { type: "error", message: "prompt requires a non-empty text" });
        return;
      }
      // 発話も履歴の一部。送った本人以外にも配る（複数クライアントで会話が揃う）
      thread.record({ role: "po", text: message.text });
      this.broadcast({ type: "po_message", threadId: thread.id, text: message.text });
      this.broadcast({ type: "turn_start", threadId: thread.id });

      try {
        // ストリーミング中の追加入力は steer として積む（pi の既定では例外になるため）
        await thread.session.prompt(message.text, {
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

  private handleSessionEvent(thread: Thread, event: unknown): void {
    const translated = this.toServerEvent(thread, event);
    if (!translated) return;

    // 配信すると同時に**そのスレッドの**履歴へ積む（リロード後に同じ内容が再現される）
    if (translated.type === "text_delta") {
      thread.record({ role: "banto", text: translated.delta });
    } else if (translated.type === "tool_start") {
      thread.record({ role: "tool", name: translated.name, state: "running" });
    } else if (translated.type === "tool_end") {
      thread.record({
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
  private toServerEvent(thread: Thread, event: unknown): ServerEvent | undefined {
    const e = event as {
      type?: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      assistantMessageEvent?: { type?: string; delta?: string };
    } | null;

    if (e?.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
      return { type: "text_delta", threadId: thread.id, delta: String(e.assistantMessageEvent.delta) };
    }
    if (e?.type === "tool_execution_start") {
      return {
        type: "tool_start",
        threadId: thread.id,
        toolCallId: String(e.toolCallId),
        name: this.toLogicalName(String(e.toolName)),
      };
    }
    if (e?.type === "tool_execution_end") {
      return {
        type: "tool_end",
        threadId: thread.id,
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
