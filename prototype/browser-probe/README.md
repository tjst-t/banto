# browser-probe

これは 2026-08-15 の判定のために書いた**使い捨ての実測スクリプト**であり、製品コードではない・テストとして走らせるものでもない。再現したいときは `NODE_PATH=<リポジトリ>/node_modules node prototype/browser-probe/<ファイル>` で動く。何を測ったかは `docs/proposals/2026-08-15-shared-browser-module-assessment.md` を見よ。

## ファイル一覧

- `01-headless-launch.js` — playwright chromium を headless で起動できるか。バージョン・実行ファイルパス・起動秒数・常駐RSS(MB)を測る
- `02-headful-xvfb.js` — Xvfb :99 を上げ DISPLAY=:99 で headful chromium を起動できるか
- `03-screencast.js` — CDP `Page.startScreencast` で `Page.screencastFrame` が実際に届くか。10秒間のフレーム数・base64バイト数の中央値・静止時とスクロール時の差を測る
- `04-input.js` — `page.click`/`page.fill` を使わず、CDP の `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` だけでクリックと日本語入力ができるか。日本語は `Input.insertText` と `dispatchKeyEvent` の両方を試し、どちらが通ったか比較する
- `05-network.js` — CDP `Network.enable` で HTTPS の URL/メソッド/ヘッダ/POSTボディ、レスポンスのステータス/ヘッダ/本文（`Network.getResponseBody`）が取れるか。外向き通信の可否も見る。あわせて `recordHar({content:"embed"})` の HAR に本文が入るかを確認
- `06-two-sessions.js` — 同じページに CDP セッションを2本張り、片方が screencast・もう片方が Network を同時に購読できるか（人用/AI用のセッション分離が可能か）
- `page.html` — 上記スクリプトが読み込む試験用ページ（クリックボタン・日本語入力欄などを持つ）
- `01-response-body-timing.js` — `Network.getResponseBody` をいつまで呼べるか。(a) loadingFinished直後 (b) 5秒後 (c) 別ページ遷移後 (d) `Page.reload` 後、および `maxResourceBufferSize`/`maxTotalBufferSize` の効果
- `02a-nav-fetch-xhr.js` — 通常のページ遷移 / `fetch()` / `XMLHttpRequest` でレスポンス本文が取れるか
- `02b-websocket.js` — WebSocket の `webSocketCreated`/`webSocketFrameSent`/`webSocketFrameReceived`/`webSocketFrameError`。フレームの `payloadData` が読めるか、バイナリフレームはどう見えるか
- `02c-sse.js` — SSE（text/event-stream）。流れている最中に読めるか、終わるまで読めないか。`Network.streamResourceContent` が使えるかも試す
- `02d-serviceworker.js` — service worker 経由の fetch。ページからの fetch と SW 自身が出す fetch の両方が見えるか。`Network.enable` をメインフレームだけに張った場合と `Target.setAutoAttach` で worker にも張った場合の違い
- `02e-serviceworker-raw-cdp.js` — `Target.setAutoAttach(flatten:true)` + sessionId 付きコマンドで service worker 自身のターゲットに `Network.enable` を張れるかを、生の CDP（`ws` パッケージ）で確定させる。Playwright の `CDPSession` 高レベル API は worker への sessionId ルーティングを公開していないため素の WebSocket で検証
- `03-request-headers.js` — `Authorization`/`Cookie` が `requestWillBeSent` と `requestWillBeSentExtraInfo` でどう違うか。クエリ/POST JSON/multipart の本文、`Network.getRequestPostData`
- `03b-set-cookie.js` — レスポンスの `Set-Cookie` が `responseReceivedExtraInfo` で見えるか
- `04-big-binary.js` — `/api/big`（10MB）が取れるか・切り詰められるか。`/api/image` が `base64Encoded:true` で返るか。取得秒数
- `05-redirect.js` — `/api/redirect`（302 → `/api/echo`）で302側と最終応答の両方が観測できるか。requestId の振られ方
- `06-early-traffic.js` — `Network.enable` を張る前に始まった通信は観測できるか。ページを開いてから CDP を張った場合はどうか
- `07-https-real.js` — `https://example.com/` を1回開き、URL・レスポンスヘッダ・本文が取れることを再確認
- `lib.js` — 共通ヘルパー（ローカル試験サーバの起動/停止、CDP 付きブラウザの起動/停止）。`01-response-body-timing.js` 以降のスクリプトが読み込む
- `server.js` — 試験対象のローカルサーバ（Node標準 + `ws` のみ）
