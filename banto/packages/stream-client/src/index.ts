// **画面と Module の間の流れ——画面の側の共通部品**（決定・2026-10-08、アーキ仕様 §5.8「共通の部品」）。
//
// `openStream(bridge, { name, params })` が、MCP Apps の橋の上で親（banto の画面）に `dev.banto/stream/open` を頼んで
// 札をもらい、WebSocket を開いて最初の1通で札を送る。あとは文字と2進をそのまま流す。
//
// **切れるのは普通のこと**（banto の起こし直し・Module の起こし直し・携帯で裏に回したタブ）。切れたら札を取り直して
// 繋ぎ直す：1・2・4・8・15 秒（以後 15 秒ごと）。タブが前に戻った・回線が戻ったときはすぐ試す。止めるのは
// 画面が `close()` したときと、Module が「もう無い」（4404）で閉じたときだけ。
//
// Module の画面は1枚の HTML に書いた素の JavaScript のことが多い——そのまま埋め込めるように、同じ関数を文字列でも
// 渡す（`STREAM_CLIENT_SCRIPT`）。**だから `openStream` は外の名前を使わない**（中で閉じている）

/** 親に頼む口。MCP Apps の橋の上の request（JSON-RPC）を投げて、結果を返すもの */
export interface StreamBridge {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** 繋いでいる・繋ぎ直している・終わった */
export type StreamState = "connecting" | "open" | "reconnecting" | "ended";

export interface StreamStateDetail {
  /** 切れた・断られた理由（あれば） */
  reason?: string;
  /** 閉じたときの番号（あれば） */
  code?: number;
  /** 次に試すまでの長さ（繋ぎ直しているとき） */
  retryInMs?: number;
}

export interface StreamOptions {
  /** 流れの名前（画面の資源が `dev.banto/streams` で名乗ったもの） */
  name: string;
  /** Module に渡す引数（JSON、4KiB まで） */
  params?: Record<string, unknown>;
  /** Module から届いた1通（文字は string、2進は ArrayBuffer） */
  onMessage?: (data: string | ArrayBuffer) => void;
  /** 状態が変わった */
  onState?: (state: StreamState, detail: StreamStateDetail) => void;
}

export interface StreamHandle {
  /** 送る。繋がっていなければ送らずに false（溜めない——繋ぎ直したあとの続きは Module との約束で決める） */
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): boolean;
  /** 閉じて、繋ぎ直しをやめる */
  close(): void;
  readonly state: StreamState;
  /** 送ったが、まだ回線に出ていない量（流量を絞るときに見る） */
  readonly bufferedAmount: number;
}

/** 親に頼む request の名前（banto の拡張） */
export const STREAM_OPEN_METHOD = "dev.banto/stream/open";

export function openStream(bridge: StreamBridge, options: StreamOptions): StreamHandle {
  const OPEN_METHOD = "dev.banto/stream/open";
  const DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
  /** これより長く開いていたら、次に切れたときは 1 秒から数え直す */
  const STABLE_MS = 10000;
  /** Module が「もう無い」と言って閉じる番号 */
  const GONE = 4404;

  let state: StreamState = "connecting";
  let ws: WebSocket | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** いま札を頼んでいる・開いている最中か（すぐ試すときに二重にしない） */
  let connecting = false;

  const setState = (next: StreamState, detail: StreamStateDetail = {}) => {
    state = next;
    options.onState?.(next, detail);
  };

  const cleanup = () => {
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.removeEventListener("online", retryNow);
  };

  const scheduleRetry = (detail: StreamStateDetail) => {
    if (stopped) return;
    const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)]!;
    attempt += 1;
    setState("reconnecting", { ...detail, retryInMs: delay });
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  };

  function retryNow() {
    // 待っている間だけ（繋がっている・試している最中は何もしない）
    if (stopped || timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    void connect();
  }

  function onVisible() {
    if (document.visibilityState === "visible") retryNow();
  }

  async function connect(): Promise<void> {
    if (stopped || connecting) return;
    connecting = true;
    if (state !== "reconnecting") setState("connecting");
    let grant: { url?: unknown; ticket?: unknown };
    try {
      grant = ((await bridge.request(OPEN_METHOD, { name: options.name, params: options.params ?? {} })) ?? {}) as {
        url?: unknown;
        ticket?: unknown;
      };
    } catch (err) {
      connecting = false;
      scheduleRetry({ reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (stopped) {
      connecting = false;
      return;
    }
    if (typeof grant.url !== "string" || typeof grant.ticket !== "string") {
      connecting = false;
      scheduleRetry({ reason: "banto の画面が流れの札を返しませんでした" });
      return;
    }
    const ticket = grant.ticket;
    let socket: WebSocket;
    try {
      socket = new WebSocket(grant.url);
    } catch (err) {
      connecting = false;
      scheduleRetry({ reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    socket.binaryType = "arraybuffer";
    ws = socket;
    let openedAt: number | undefined;
    socket.onopen = () => {
      // 札は URL に載せず、最初の1通で送る（URL はアクセスログに残る）
      socket.send(JSON.stringify({ ticket }));
      openedAt = Date.now();
      connecting = false;
      setState("open");
    };
    socket.onmessage = (event) => {
      // 届いたなら、Module まで繋がっている——次に切れたら 1 秒から
      attempt = 0;
      options.onMessage?.(event.data as string | ArrayBuffer);
    };
    socket.onclose = (event) => {
      if (ws === socket) ws = undefined;
      connecting = false;
      if (stopped) return;
      if (openedAt !== undefined && Date.now() - openedAt >= STABLE_MS) attempt = 0;
      if (event.code === GONE) {
        stopped = true;
        cleanup();
        setState("ended", { code: event.code, reason: event.reason || "流れの相手がもうありません" });
        return;
      }
      scheduleRetry({ code: event.code, ...(event.reason ? { reason: event.reason } : {}) });
    };
  }

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  if (typeof window !== "undefined") window.addEventListener("online", retryNow);
  void connect();

  return {
    send(data) {
      if (!ws || ws.readyState !== 1 || state !== "open") return false;
      ws.send(data);
      return true;
    },
    close() {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      ws?.close(1000);
      ws = undefined;
      setState("ended", { reason: "画面が閉じました" });
    },
    get state() {
      return state;
    },
    get bufferedAmount() {
      return ws?.bufferedAmount ?? 0;
    },
  };
}

/**
 * **素の JavaScript の画面に埋め込む形**。`<script>` に入れると、`openStream(bridge, options)` が使えるようになる
 * （型は無い。中身は上の `openStream` と同じもの——写しを書かない）
 */
export const STREAM_CLIENT_SCRIPT = `const openStream = ${openStream.toString()};`;
