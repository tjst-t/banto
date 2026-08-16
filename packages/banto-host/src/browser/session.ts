/**
 * 共有ブラウザの一実体——**同じブラウザに口が2つ**（ADR-0010 決定25 の一般化）。
 *
 * 人は面（canvas）から見て触り、番頭は Tool から触る。どちらも同じ CDP 接続の先にある
 * 1つのブラウザを相手にする。ここが持つのは「いま起きているか」「誰が見ているか」だけで、
 * 起こし方は `BrowserLauncher`、往復は `CdpConnection`、面の言葉の写しは
 * `viewer-protocol.ts` にある。
 *
 * screencast の作法（実測で判っていること・2026-08-15 §3-1）：
 *   - 静止しているあいだフレームは来ない（帯域はほぼ 0）
 *   - `Page.screencastFrameAck` を返さないと**次のフレームが来ない**。だから
 *     面が1つも繋がっていなくても、受け取ったフレームには必ず ack を返す
 *
 * I2: 起こせなかった・繋げなかったを running のまま放置しない。片付けてから失敗させる。
 */

import type { WebSocket } from "ws";
import { connectCdp, type CdpConnection } from "./cdp.js";
import type { BrowserLauncher, LaunchRequest, LaunchedBrowser } from "./launcher.js";
import {
  parseViewerInput,
  toCdpCalls,
  type ScreencastMetadata,
  type ViewerMessage,
} from "./viewer-protocol.js";

/** screencast の粗さ。面の見え方に直結するので既定はここ1箇所（D3）。 */
export interface ScreencastOptions {
  /** JPEG の品質（1-100）。 */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 何フレームに1枚送るか（CDP の `everyNthFrame`）。 */
  everyNthFrame?: number;
}

const SCREENCAST_DEFAULTS: Required<ScreencastOptions> = {
  quality: 60,
  maxWidth: 1600,
  maxHeight: 1000,
  everyNthFrame: 1,
};

/** 面が0のまま、最後の操作からこの時間が経つと自動で落とす。定数はここ1箇所（D3）。 */
export const BROWSER_IDLE_TTL_MS = 30 * 60_000;

function defaultScheduleIdleTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  // 見張りのために host プロセスを生かし続けない（K2）
  handle.unref?.();
  return handle;
}

function defaultCancelIdleTimer(handle: unknown): void {
  clearTimeout(handle as NodeJS.Timeout);
}

export interface BrowserSessionOptions {
  launcher: BrowserLauncher;
  screencast?: ScreencastOptions;
  /** CDP へ繋ぐ手立て。試験で差し替えられるようにしてあるだけで、既定が本番の経路。 */
  connect?: (url: string) => Promise<CdpConnection>;
  /** 面が0のまま最後の操作から経つと自動で落とすまでの時間。既定 `BROWSER_IDLE_TTL_MS`。 */
  idleTtlMs?: number;
  /** アイドル TTL のタイマーを張る（試験から差し替える）。既定は `setTimeout`。 */
  scheduleIdleTimer?: (callback: () => void, ms: number) => unknown;
  /** 上と対になる解除。既定は `clearTimeout`。 */
  cancelIdleTimer?: (handle: unknown) => void;
}

/** `browser.status` が返す形。面も同じものを見る（D3：状態の真実は1つ）。 */
export interface BrowserStatus {
  state: "running" | "stopped";
  /** 誰が起こしたか。 */
  launcher: string;
  /** CDP の口（起きているときだけ）。 */
  webSocketDebuggerUrl?: string;
  /** いま面を開いている数。 */
  viewers: number;
  /** screencast を流しているか。 */
  streaming: boolean;
}

export interface BrowserSession {
  start(request?: LaunchRequest): Promise<BrowserStatus>;
  stop(): Promise<BrowserStatus>;
  status(): BrowserStatus;
  /** 面の WebSocket を受け取る（`handleUpgrade` から呼ばれる）。 */
  attachViewer(socket: WebSocket): void;
}

function send(socket: WebSocket, message: ViewerMessage): void {
  // ws の readyState 1 = OPEN。閉じかけの相手へ書いて例外にしない
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(message));
}

export function createBrowserSession(options: BrowserSessionOptions): BrowserSession {
  const connect = options.connect ?? ((url: string) => connectCdp(url));
  const screencast = { ...SCREENCAST_DEFAULTS, ...options.screencast };
  const idleTtlMs = options.idleTtlMs ?? BROWSER_IDLE_TTL_MS;
  const scheduleIdleTimer = options.scheduleIdleTimer ?? defaultScheduleIdleTimer;
  const cancelIdleTimer = options.cancelIdleTimer ?? defaultCancelIdleTimer;

  let launched: LaunchedBrowser | undefined;
  let cdp: CdpConnection | undefined;
  let unsubscribeFrame: (() => void) | undefined;
  let streaming = false;
  /** 最後に見たフレームの metadata。面から来た座標を実座標へ直すのに要る。 */
  let lastMetadata: ScreencastMetadata = {};
  const viewers = new Set<WebSocket>();
  let idleTimerHandle: unknown;

  const status = (): BrowserStatus => ({
    state: cdp && !cdp.closed ? "running" : "stopped",
    launcher: options.launcher.name,
    ...(launched ? { webSocketDebuggerUrl: launched.webSocketDebuggerUrl } : {}),
    viewers: viewers.size,
    streaming,
  });

  /** CDP へ投げっぱなしで良いものを送る（結果は待たないが、失敗は黙らせない・I2）。 */
  const fire = (method: string, params?: Record<string, unknown>): void => {
    const connection = cdp;
    if (!connection || connection.closed) return;
    connection.send(method, params).catch((err: unknown) => {
      console.error(`[browser] ${method} を送れませんでした: ${String(err)}`);
    });
  };

  const onScreencastFrame = (params: Record<string, unknown>): void => {
    const data = typeof params["data"] === "string" ? params["data"] : "";
    const metadata = (params["metadata"] ?? {}) as ScreencastMetadata;
    lastMetadata = metadata;
    for (const socket of viewers) send(socket, { type: "frame", data, metadata });
    // **ack は面の有無に関わらず必ず返す**。返さないと次のフレームが来ない
    const sessionId = params["sessionId"];
    if (sessionId !== undefined) fire("Page.screencastFrameAck", { sessionId });
  };

  const startStreaming = (): void => {
    if (streaming || !cdp || cdp.closed) return;
    streaming = true;
    fire("Page.enable");
    fire("Page.startScreencast", {
      format: "jpeg",
      quality: screencast.quality,
      maxWidth: screencast.maxWidth,
      maxHeight: screencast.maxHeight,
      everyNthFrame: screencast.everyNthFrame,
    });
  };

  const stopStreaming = (): void => {
    if (!streaming) return;
    streaming = false;
    fire("Page.stopScreencast");
  };

  const clearIdleWatch = (): void => {
    if (idleTimerHandle !== undefined) {
      cancelIdleTimer(idleTimerHandle);
      idleTimerHandle = undefined;
    }
  };

  /**
   * アイドル TTL の見張りをかけ直す。**面が0のときだけ**時計を進める——面が1つでも
   * あれば判定しない（K2）。呼ぶたびにいったん解除してから条件を見るので、
   * 「起動した」「最後の面が閉じた」の両方をここ1本に通せる。
   */
  const armIdleWatch = (): void => {
    clearIdleWatch();
    if (!cdp || cdp.closed || viewers.size > 0) return;
    idleTimerHandle = scheduleIdleTimer(() => {
      idleTimerHandle = undefined;
      if (cdp && !cdp.closed && viewers.size === 0) {
        console.log(
          `[browser] アイドル TTL（${idleTtlMs}ms）に達したため、共有ブラウザを自動で落とします`
        );
        void stop();
      }
    }, idleTtlMs);
  };

  const stop = async (): Promise<BrowserStatus> => {
    clearIdleWatch();
    // 接続ごと閉じるので `Page.stopScreencast` は送らない——送っても、閉じたあとに
    // 「送れませんでした」が出るだけで、正常な停止が失敗のように見える
    streaming = false;
    unsubscribeFrame?.();
    unsubscribeFrame = undefined;

    for (const socket of Array.from(viewers)) {
      send(socket, { type: "status", state: "stopped" });
      socket.close();
    }
    viewers.clear();
    lastMetadata = {};

    const connection = cdp;
    cdp = undefined;
    if (connection) await connection.close();

    const browser = launched;
    launched = undefined;
    if (browser) await browser.close();

    return status();
  };

  return {
    status,
    stop,

    async start(request: LaunchRequest = {}): Promise<BrowserStatus> {
      // 既に起きているなら起こし直さない（同時に1つ。冪等に扱う）
      if (cdp && !cdp.closed) return status();

      const browser = await options.launcher.launch(request);
      launched = browser;
      try {
        const connection = await connect(browser.webSocketDebuggerUrl);
        cdp = connection;
        unsubscribeFrame = connection.on("Page.screencastFrame", onScreencastFrame);
      } catch (err) {
        // I2: 繋げなかったブラウザを残さない。起こしたものは自分で片付けてから失敗させる
        launched = undefined;
        await browser.close().catch((closeErr: unknown) => {
          console.error(`[browser] 起こしたブラウザを閉じられませんでした: ${String(closeErr)}`);
        });
        throw err;
      }

      // 既に面が開いていたなら、そのまま流し始める
      if (viewers.size > 0) startStreaming();
      // 面がまだ無ければ、ここからアイドル TTL の時計が進み始める
      armIdleWatch();
      return status();
    },

    attachViewer(socket: WebSocket): void {
      // I2: 起きていない面を黙って開いたままにしない。理由を言って閉じる
      if (!cdp || cdp.closed) {
        send(socket, {
          type: "error",
          message: "ブラウザが起きていません。browser.start で起こしてから開いてください。",
        });
        socket.close();
        return;
      }

      viewers.add(socket);
      // 面が付いた——アイドル判定を止める
      clearIdleWatch();
      send(socket, { type: "status", state: "running" });
      startStreaming();

      socket.on("message", (raw: unknown) => {
        try {
          const input = parseViewerInput(JSON.parse(String(raw)));
          for (const call of toCdpCalls(input, lastMetadata)) fire(call.method, call.params);
        } catch (err) {
          // I2: 読めなかった操作を黙って捨てない。面に理由を返す
          send(socket, { type: "error", message: String(err instanceof Error ? err.message : err) });
        }
      });

      socket.on("close", () => {
        viewers.delete(socket);
        // 誰も見ていないのに送らせ続けない（静止時は来ないが、動いていれば流れ続ける）
        if (viewers.size === 0) {
          stopStreaming();
          // 最後の面が閉じた——ここからアイドル TTL の時計が進み始める
          armIdleWatch();
        }
      });
      socket.on("error", (err: Error) => {
        console.error(`[browser] 面の接続でエラーが起きました: ${err.message}`);
      });
    },
  };
}
