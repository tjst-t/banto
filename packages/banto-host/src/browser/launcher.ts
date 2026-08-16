/**
 * ブラウザの起こし方（差し替え可能な契約）。
 *
 * モジュールは**この契約越しにしかブラウザを知らない**。起動の仕方（playwright 同梱の
 * chromium を探す／`--remote-debugging-port` を渡す／`DISPLAY` があれば Xvfb の上で
 * headful にする、等）は全部この裏側にあり、モジュール本体は
 * 「CDP の口（`webSocketDebuggerUrl`）と、閉じ方」しか受け取らない。
 *
 * こうしてあるのは、**検証の器で本物の chromium を起こせない**ため
 * （`docker/Dockerfile.test` は node:24-alpine で chromium が無く、playwright が
 * 落としてくる chromium は glibc 版なので musl では動かない）。試験では偽の launcher を
 * 挿し、偽の CDP エンドポイント（ただの WebSocket + JSON-RPC）へ向ける。
 *
 * D5: ここに判断は無い。契約と、「まだ無い」と分かる既定だけ。
 */

/** 起きているブラウザ1つ分。 */
export interface LaunchedBrowser {
  /**
   * **page ターゲットの CDP の口**（`ws://127.0.0.1:<port>/devtools/page/<id>` のような URL）。
   * ブラウザ級のエンドポイント（`/devtools/browser/<id>`）ではない——`session.ts` は繋いだ
   * 接続に `sessionId` を付けず `Page.*` を送るため、page ターゲットでなければ通らず
   * 面が真っ黒のままになる（K2 実測）。
   */
  webSocketDebuggerUrl: string;
  /** 落とす。冪等（既に落ちていても成功する）ように実装すること。 */
  close(): Promise<void>;
}

/** 起こすときの注文。ブラウザ側で解釈できないものは無視してよい。 */
export interface LaunchRequest {
  /** 画面の幅（CSS px）。 */
  width?: number;
  /** 画面の高さ（CSS px）。 */
  height?: number;
  /** 最初に開く URL。 */
  url?: string;
}

/** ブラウザを起こす人。 */
export interface BrowserLauncher {
  /** 誰が起こしたかを status に出すための名前。 */
  readonly name: string;
  launch(request: LaunchRequest): Promise<LaunchedBrowser>;
}

/**
 * 既定の launcher。**まだ本物の chromium は起こさない**（K2 で入る）。
 *
 * I2: 「起きたつもりで止まっている」を作らない。呼ばれたら、何が足りないかを言って失敗する。
 */
export function createUnimplementedLauncher(): BrowserLauncher {
  return {
    name: "unimplemented",
    async launch(): Promise<LaunchedBrowser> {
      throw new Error(
        "本物のブラウザを起こす実装はまだありません。" +
          "createBrowserModule({ launcher }) で起こし手を渡してください" +
          "（chromium を起こすアダプタは後続の作業で入ります）。"
      );
    },
  };
}
