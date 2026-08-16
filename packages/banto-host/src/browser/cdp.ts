/**
 * CDP（Chrome DevTools Protocol）クライアント——**生の WebSocket で書く**。
 *
 * CDP はただの JSON-RPC で、`{id, method, params}` を送ると `{id, result}` か
 * `{id, error}` が返り、`{method, params}` がイベントとして飛んでくる。それだけなので
 * ライブラリは要らない（D6：既存依存の `ws` で足りる）。
 *
 * **playwright の高レベル API に載せないのは意図的**（2026-08-15 の判定 §3-3）。
 * 後続で service worker の通信を覗くのに `Target.setAutoAttach({flatten:true})` して
 * **子ターゲットの sessionId 宛に**コマンドを送る必要があり、高レベル API 越しでは
 * それができないことが実測で判っている。だから `sessionId` を素通しできる形にしてある。
 *
 * D5: ここに判断は無い。往復の帳簿と、イベントの配り先だけ。
 * I2: `{id, error}` は解決しない。接続が落ちたら待っている呼び出しを全部失敗させる。
 */

import { WebSocket } from "ws";

export type CdpParams = Record<string, unknown>;

/** イベントの受け手。`sessionId` は flatten 接続で子ターゲット由来のときだけ付く。 */
export type CdpEventHandler = (params: CdpParams, sessionId?: string) => void;

export interface CdpConnection {
  /**
   * コマンドを送って結果を待つ。
   *
   * @param sessionId 子ターゲット宛に送るとき（`Target.setAutoAttach` の flatten 経路）
   */
  send(method: string, params?: CdpParams, sessionId?: string): Promise<CdpParams>;
  /** イベントを購読する。戻り値を呼ぶと解除。 */
  on(method: string, handler: CdpEventHandler): () => void;
  /** 閉じる。冪等。 */
  close(): Promise<void>;
  readonly closed: boolean;
}

interface Pending {
  resolve(result: CdpParams): void;
  reject(error: Error): void;
  method: string;
}

/** CDP のエラー応答（`{code, message, data?}`）を1行の理由に畳む。 */
function formatCdpError(method: string, error: unknown): Error {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const parts = [`CDP ${method} が失敗しました`];
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.data === "string") parts.push(e.data);
  if (typeof e.code === "number") parts.push(`(code ${e.code})`);
  return new Error(parts.join(": "));
}

/**
 * CDP のエンドポイントへ繋ぐ。
 *
 * @param url `webSocketDebuggerUrl`
 * @param options.timeoutMs 接続を待つ上限（既定 10 秒）。超えたら失敗させる（I2）
 */
export async function connectCdp(
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<CdpConnection> {
  const socket = new WebSocket(url, {
    // screencast のフレームは大きい。既定（1MiB）だと本物のブラウザで千切れる
    maxPayload: 256 * 1024 * 1024,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`CDP へ接続できません（${url}）: ${options.timeoutMs ?? 10_000}ms で応答なし`));
    }, options.timeoutMs ?? 10_000);
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(new Error(`CDP へ接続できません（${url}）: ${err.message}`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
  });

  let nextId = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Set<CdpEventHandler>>();

  /** 待っている呼び出しを全部失敗させる（I2：黙って宙ぶらりんにしない）。 */
  const failPending = (reason: string): void => {
    const waiting = Array.from(pending.entries());
    pending.clear();
    for (const [, p] of waiting) p.reject(new Error(`CDP ${p.method}: ${reason}`));
  };

  socket.on("message", (raw: unknown) => {
    let message: unknown;
    try {
      message = JSON.parse(String(raw));
    } catch (err) {
      // I2: 壊れた行を黙って捨てない。ただし接続は生かす（次のフレームは正しいかもしれない）
      console.error(`[browser] CDP から読めないメッセージが来ました: ${String(err)}`);
      return;
    }
    const msg = (message ?? {}) as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
      method?: unknown;
      params?: unknown;
      sessionId?: unknown;
    };

    if (typeof msg.id === "number") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(formatCdpError(p.method, msg.error));
      else p.resolve((msg.result ?? {}) as CdpParams);
      return;
    }

    if (typeof msg.method !== "string") return;
    const listeners = handlers.get(msg.method);
    if (!listeners) return;
    const params = (msg.params ?? {}) as CdpParams;
    const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
    for (const handler of Array.from(listeners)) {
      try {
        handler(params, sessionId);
      } catch (err) {
        // I2: 受け手1つの失敗で他の受け手と接続を巻き添えにしない。ただし黙らせない
        console.error(`[browser] CDP イベント ${msg.method} の処理が失敗しました: ${String(err)}`);
      }
    }
  });

  socket.on("close", () => {
    closed = true;
    failPending("接続が閉じました");
  });
  socket.on("error", (err: Error) => {
    // close は続けて飛んでくる。ここでは理由を残すだけ
    console.error(`[browser] CDP の接続でエラーが起きました: ${err.message}`);
  });

  return {
    get closed() {
      return closed;
    },

    send(method, params, sessionId) {
      if (closed || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`CDP ${method}: 接続がありません`));
      }
      const id = nextId++;
      return new Promise<CdpParams>((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        const frame: Record<string, unknown> = { id, method };
        if (params) frame["params"] = params;
        if (sessionId) frame["sessionId"] = sessionId;
        socket.send(JSON.stringify(frame), (err) => {
          if (!err) return;
          pending.delete(id);
          reject(new Error(`CDP ${method} を送れませんでした: ${err.message}`));
        });
      });
    },

    on(method, handler) {
      let set = handlers.get(method);
      if (!set) {
        set = new Set();
        handlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(method);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      failPending("こちらから閉じました");
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
        // 相手が close を返さないことがある。掴んだままにしない
        setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
          resolve();
        }, 2_000).unref?.();
      });
    },
  };
}
