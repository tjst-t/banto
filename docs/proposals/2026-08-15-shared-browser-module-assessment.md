# 共有ブラウザ Module（AI と人が同時に触れるブラウザ）— 2026-08-08 設計案の妥当性判定と実装計画

## 0. 結論

**判定 (B) 作り直しが要る。** 枠組み（banto の Module として載せる）はそのまま生きているが、中身の2本柱——**noVNC/VNC による画面共有**と**mitmproxy による MITM 復号**——は**両方とも捨てる**。代わりに、**既にあるものだけ**（playwright 同梱の chromium と CDP）で「人が見て触れる＋AI が HTTPS の API を解析できる」を実現する。**追加依存はゼロ**。

## 1. 元の設計は何を作ろうとしていたか

2026-08-08 の `2026-08-08-browser-module-mitm-design.md` は、banto の組み込みモジュール `browser` として、Xvfb 上に headful の Chromium を立て、**人には x11vnc + noVNC で画面を、AI には CDP で操作の口を出して「同じ Chromium を共有」**し（「同じ実体、口が2つ」＝決定25 の一般化）、さらに **mitmproxy を挟んで CA をトラストストアに注入することで HTTPS を復号**し、そのフローを JSONL に落として `browser.requests` / `browser.request` という Tool で AI に読ませ、人には一覧 GUI と HAR で見せる、という設計だった。実装は Step 0（環境確認）〜 Step 6（基盤の差し替え契約）の段階分けで、MITM は既定 OFF・開発時のみ ON、と書かれていた。

## 2. 前提の突き合わせ（現物）

### 2-1. 生きている前提

- **`BantoModule` の枠は実在する**：`packages/banto-host/src/module.ts:43`。tools / internalTools / views(canvas) / skills / serve() / handleUpgrade() / init() を1つの登録単位として持ち、`createModuleRegistry`（module.ts:151-192）が name・tool 名・canvas kind・skill 名の衝突を例外で弾く。
- **モジュールが独自の WebSocket 経路を生やす前例が2件ある**：`packages/banto-environment-pool/src/proxy-exposer.ts:58-79` と `packages/banto-host/src/remote-module.ts:114,164`。ホスト側は `packages/banto-host/src/server.ts:1253-1271` で、自分の ws で拾えなかった upgrade を各モジュールの `handleUpgrade` へ回している。
- **Tool は register するだけで番頭のモデルへ届く**：モジュールの `tools` → `bin.ts:1208` → `bin.ts:1312` → host-session の `assembleStewardContext` → `claude-agent-harness.ts:296-325` の `mcpServer()` が in-process の MCP tool として動的登録（wire 名 `mcp__banto__<name>`）。**新規モジュールを1本 register する1行以外、bin.ts をいじる必要はない。**
- canvas kind を増やすのは**2箇所**：モジュール側の `views` に `{kind, component}` を足すのと、`packages/banto-web/src/views/registry.tsx:84-106` の REGISTRY に import とエントリを足すの対（既存例：worker-pool の `kind: "worker.viewer"` と registry.tsx:94）。

### 2-2. 壊れている前提

- **VNC は今の公開の仕組みを通らない。** `proxy-exposer.ts:32-44,89-111` も `caddy-exposer.ts:138`（`handler: "reverse_proxy"`）も **L7（HTTP/WS）として組み直して中継する**実装で、生 TCP の中継路は無い（caddy の layer4 プラグインも入っていない）。RFB（VNC）はここを通れない。＝「caddy の公開 URL で人が noVNC を見る」は**成立しない**。
- **素材が無い。** `x11vnc` / `websockify` / `noVNC` / `mitmdump` / `mitmproxy` / `tshark` は**いずれも未インストール**。`docker images` 378 件に playwright/chromium 系は**0 件**（pull すれば ~2GB の新規依存）。8/8 が「最大の不確実性」と書いた Step 0 は、**外れの側で確定**した。
- **ただし chromium は既にある。** ルートの devDependency に `@playwright/test`、`~/.cache/ms-playwright/` に chromium-1228/1234（**151.0.7922.34**）。`Xvfb` は `/usr/bin/Xvfb` にある。`ws` も既存依存（banto-host/banto-cli/banto-daemon の `^8.21.1`）。node は v24.18.1。
- **統治の向きの食い違い。** 8/8 は「ブラウザ基盤の起動を EnvExposer と同じ抽象化パターンで差し替え可能にする」と書くが、**`EnvExposer` という語は 8/11 の抽象化2本のどちらにも1件も出てこない**（差し替え単位は `driver`）。また 8/11 の `exec-env-contract-elements.md` は H3「エージェントがドライバを直接実行する経路は提供しない」・G6「回すのは依頼者ではない信頼された第三者（Environment Pool）」と書いており、語彙も統治の向きも噛み合っていない。
- **系譜は机上のまま。** 8/8 の土台である `docs/research/browser-module-research.md`（2026-07-30）は palmux2 のソース読解と他プロジェクトの README 比較による**机上比較**で、banto 上で動かした形跡は無い（付録のコードも本人が「スケッチ」と明記）。そのリサーチが前提にした incus は**コードに1件も無い**（リサーチの翌日 7/31 に `packages/banto-environment-pool` が入り、driver は process/docker の2本）。**PO の書斎にある試作らしきもの（`tap-proxy.py` / `read-tap.py` / `reports/tap/`）はブラウザとは無関係**（inc-0055 の LLM API タップ。`reports/*.py` に chromium/mitmproxy/CDP は grep 0件、作成日も 8/12 で設計より後）。**＝この案件は今日まで一度も動かされていない。**

## 3. 実測（この判定のためにこの案件で初めて動かした）

スクリプトは `/tmp/browser-probe/`・`/tmp/browser-probe2/` に残置。リポジトリは無変更（git status で確認）。

### 3-1. 画面と操作（VNC の代わりに CDP で足りるか）→ **足りる**

- `Page.startScreencast` で `Page.screencastFrame` が実際に届く。**静止時はフレームを送らず**、スクロール中は 10秒で 18 フレーム、1フレームの base64 中央値 **約 9.7KB**。
- `Input.dispatchMouseEvent`（mouseMoved→mousePressed→mouseReleased）**だけ**でクリックが成立。**日本語入力は `Input.insertText` でも `Input.dispatchKeyEvent`（text:"あ"）でも通った**＝**fcitx5/mozc の IME 移植は不要**。
- headless 起動 0.10 秒・RSS 74.9MB（実体は chrome-headless-shell）。`Xvfb :99 -screen 0 1280x800x24` + `DISPLAY=:99` の headful 起動 1.38 秒・RSS 133.8MB（関連プロセス合計 508.1MB）。
- 同一ページに CDP セッションを**2本同時**に張り、片方 screencast・片方 Network を成立させられた＝**人用と AI 用の口を分けられる**。

### 3-2. HTTPS の API 解析（mitmproxy の代わりに CDP で足りるか）→ **足りる**

ローカルに試験用サーバ（`/tmp/browser-probe2/server.js`）を立てて確認。**取れたもの**：

- 通常遷移 / `fetch()` / `XMLHttpRequest` のレスポンス本文
- **WebSocket**：`webSocketCreated` / `webSocketFrameSent` / `webSocketFrameReceived` / `webSocketClosed`。テキストは `payloadData` が生文字列、**バイナリフレームは base64**（送った `[1,2,3,4,250,251]` が `"AQIDBPr7"` として一致）
- **SSE**：`eventSourceMessageReceived` が各イベント到着とほぼ同時（実測 1031/2031/3033/4033/5037ms）に発火＝**終わるのを待たずに流れている最中に読める**
- `Authorization: Bearer`、クエリ文字列（日本語は URL エンコード済み）、POST の JSON 本文（`request.postData` と `Network.getRequestPostData` の両方）
- **multipart/form-data**：`request.postData` は null（`hasPostData:true` のみ）だが `Network.getRequestPostData` で境界込みの生バイト列（300 バイト）が完全に取れた
- **10MB の本文**：実測 **9,961,500 バイト**を切り詰めなしで取得（fetch 545ms / getResponseBody 411ms）。画像は `base64Encoded:true`
- **リダイレクト連鎖**：302 と最終応答は**同一 requestId**。302 は最終 URL の `requestWillBeSent.redirectResponse` に埋め込まれる形で観測できる
- `Set-Cookie`：`responseReceivedExtraInfo.headers.set-cookie`（複数値は `\n` 結合の1文字列）
- 実 HTTPS（`https://example.com/`）で URL・ステータス・ヘッダ・本文 559 バイトを再確認

**取れないもの（3つだけ）**：①ブラウザ以外のアプリの通信 ②TLS/TCP 層そのもの（再送・ハンドシェイク等のネットワーク層の精査）③`Network.enable` を張る前に始まった通信。

**mitmproxy より強い点**：CDP は**ブラウザが復号した後**を見るので、**証明書ピンニングがあっても中身が見える**（mitmproxy はピンニングされると復号できない）。かつ**全 HTTPS を復号できる CA 秘密鍵をマシンに残さない**。

### 3-3. 実装に効く条件（そのまま受け入れ条件へ落とす）

- `Network.getResponseBody` は**同一ナビゲーション内でしか呼べない**。別ページ遷移後・`Page.reload` 後は `Protocol error (Network.getResponseBody): No resource with given identifier found` で消える → **本文はレスポンス到着直後に都度取得して溜める実装が必須**（後からまとめて取りに行く設計は不可）。
- **`Cookie` は `requestWillBeSent.headers` に出ない**——`requestWillBeSentExtraInfo.headers` にのみ出る → **ExtraInfo 系イベントも必ず購読する**（伏字の対象がここにあるので伏せ忘れが起きやすい）。
- **`Network.enable` 前の通信は完全に不可視** → ページ生成直後・ナビゲーション開始前に張る。
- **service worker が自分で出す fetch は、メインフレームの `Network.enable` では見えない**。Playwright の高レベル API では子ターゲットへコマンドをルーティングできず見えなかったが、**`--remote-debugging-port` への生 CDP 接続で `Target.setAutoAttach({flatten:true})` し、service_worker ターゲットの sessionId 宛に個別に `Network.enable` を送ったところ観測できた**。＝**CDP は生で繋ぐ設計にする**（playwright は chromium バイナリの供給と起動にだけ使う）。
- `Network.enable` の `maxResourceBufferSize` を絞る（例 1000）と大きい本文は `Request content was evicted from inspector cache` で失われる。未指定なら 10MB は通る。

## 4. PO の判断（このレポートに記録として残す）

1. **見え方 → 承認**：VNC によるデスクトップ共有はやめ、**CDP の screencast を banto の面に映し、人の操作は面から CDP へ流す**。共有されるのは**ブラウザの窓の中だけ**（デスクトップ全体やブラウザ外のアプリは映らない）。
2. **秘密情報 → 条件つき**：既定は要約のみ／本文とヘッダは面でだけ／`Cookie`・`Set-Cookie`・`Authorization`・`Proxy-Authorization` は既定で伏字。**本文を AI に渡す口は別 Tool・既定オフ**で用意し、その Tool の説明文に「**戻り値は会話の記録に永続化される**」旨と ADR-0007 との関係を**逃げずに書く**（黙って伏せる／黙って載せるのが一番悪い）。伏字は**機械で担保**する。
3. **MITM をやめる → 承認**（「API 解析に必要なものが CDP で取れる」ことを示せたら、という条件つきだった。3-2 で示せたので**やめる**）。
4. 置き場所は 8/8 案のまま「banto と同じマシンで起動」。ただし起動を1点に閉じ、後から Environment Pool のプロファイルへ移せる形にする（変更ではないので報告のみ）。

## 5. 実装計画（Kobo へ積む粒）

### 5-0. 検証の方針（先に確定させる）

- 「ブラウザを実際に起動する試験は `environment: test-docker`（process ドライバ）で通る」と一度書いたが、**取り消す**。`test-docker` は**名指ししない**——inc-0073 で直しきれていない穴が残っている。
- `test` プロファイルの器は **`node:24-alpine`**（`docker/Dockerfile.test`）で、**chromium は入っていない**うえ、playwright が落としてくる chromium は glibc 版なので **musl の alpine では動かない**。`~/.cache/ms-playwright` も器に載っていない（`docker/test.yaml` の volumes は node_modules の3小部屋と `.git` だけ）。**＝Kobo の受け入れ検証では本物のブラウザを起動できない。**
- そこで**試験は「偽の CDP エンドポイント」に対して行う**。CDP はただの WebSocket + JSON-RPC なので、`ws`（既に依存にある）で偽のブラウザ側を立て、こちらが送ったコマンド列を記録し、任意のイベント（`Page.screencastFrame` / `Network.requestWillBeSent` / `requestWillBeSentExtraInfo` / `webSocketFrameReceived` / `eventSourceMessageReceived` など）を投げ返す。**これで、実装が守るべき作法（購読の順序・到着直後の本文取得・ExtraInfo の合流・伏字・入力の変換）はすべて機械で固定できる。**
- **本物の chromium で動くこと**は Kobo の受け入れでは確かめられないので、**番頭が面で確認する**（だから `review: banto`）。この線引きはここに明記して以後の各タスクでも前提とする。

### 5-1. Kobo へ積むときの決まり

- `environment` は**すべて `test`**（`test-docker` は使わない）
- `review` は**すべて `banto`**（当面は自動着地させない）
- scope は**狭く**列挙する

### 5-2. タスクの粒（K1〜K8）

最初の1本（K1）は「人が面でブラウザを見て操作できる」最小の縦串にする。PO に早く触ってもらう方が判断が早いため。

- **K1 面で見て触れる最小の往復**／scope: `packages/banto-browser/**`, `packages/banto-web/src/views/**`, `packages/banto-host/src/bin.ts`／内容: モジュールの骨格（`createBrowserModule`）、`browser.start`/`stop`/`status`、生 CDP 接続（**起動そのものは差し替え可能な launcher 契約にし、試験では偽 launcher を挿す**）、canvas kind `browser.viewer`、`handleUpgrade` の WS でフレーム配信と入力受け／受け入れ: ①`createModuleRegistry` へ登録して名前・Tool・kind が衝突しない ②偽 CDP に対し start→status が running、stop→stopped ③WS 接続で `Page.startScreencast` が送られ、偽 CDP が投げた `screencastFrame` が WS へ流れ `screencastFrameAck` が返る ④面からの入力が `Input.dispatchMouseEvent` / `Input.insertText` へ変換され、**表示倍率に応じた座標変換が正しい** ⑤`packages/banto-web/src/views/registry.tsx` に `browser.viewer` が載っている／3〜4h
- **K2 本物の chromium を起こすアダプタ**／scope: `packages/banto-browser/**`／内容: chromium の探索（`~/.cache/ms-playwright` 優先）、`--remote-debugging-port` 等の起動引数、`DISPLAY` があれば Xvfb 上で headful・無ければ headless、アイドル TTL、stop でプロセスを残さない／受け入れ: 探索順と起動引数の組み立ての純関数試験＋偽プロセスでの寿命・後始末の試験（**実起動は番頭が面で確認**）／1〜2h
- **K3 AI が操作する Tool**／scope: `packages/banto-browser/**`／内容: `browser.navigate`/`click`/`type`/`snapshot`/`extract_text`/`screenshot`/`wait_for`／受け入れ: 偽 CDP に対し、各 Tool が送る CDP コマンド列と戻り値の形が固定される試験／2〜3h
- **K4 通信を記録する**／scope: `packages/banto-browser/**`／内容: `Network` と **ExtraInfo 系**、WebSocket フレーム、SSE を購読。**本文はレスポンス到着直後に都度取得して溜める**。multipart は `Network.getRequestPostData`。リダイレクトは同一 requestId の連鎖として畳む／受け入れ: ①偽 CDP が `loadingFinished` の後に**別ページへ遷移**し、以後 `getResponseBody` がエラーを返すようにしても**記録された本文が失われない** ②`requestWillBeSentExtraInfo` の Cookie が記録に合流する ③`hasPostData` かつ `postData` 空のとき `getRequestPostData` を呼ぶ ④302 と最終応答が1件の連鎖として記録される ⑤`Network.enable` が最初のナビゲーションより前に送られている／3h
- **K5 service worker の通信も見る**／scope: `packages/banto-browser/**`／内容: `Target.setAutoAttach({flatten:true})` と、worker ターゲットごとの `Network.enable`／受け入れ: 偽 CDP が service_worker ターゲットを attach させたとき、**その sessionId 宛に `Network.enable` が送られる**こと、そのターゲットのイベントが記録に入ることの試験／1〜2h
- **K6 伏字と、2つの口**／scope: `packages/banto-browser/**`／内容: `browser.requests` は要約のみ（URL・メソッド・状態・サイズ・時間）。本文まで返す口は**別 Tool・既定オフ**／受け入れ: ①`Cookie`・`Set-Cookie`・`Authorization`・`Proxy-Authorization` が**要約側の戻り値に絶対に含まれない**（ExtraInfo 由来のものも含めて） ②同じ記録が**面側の payload には出る** ③本文の口は既定オフで、有効化しない限り断る ④その Tool の説明文に決められた文言が含まれる／1〜2h
- **K7 通信を面で見る**／scope: `packages/banto-web/src/views/**`, `packages/banto-browser/**`／内容: 一覧・詳細・フィルタ・HAR 出力／受け入れ: 一覧描画の試験と、HAR 出力が妥当な JSON である試験／2〜3h
- **K8 SKILL と設定**／scope: `packages/banto-browser/**`, `docs/**`／内容: SKILL `browser` と `browser-traffic-analysis`（§3-2 の「取れないもの3つ」と §3-3 の条件をそのまま書く）、既定値（記録は既定 OFF・アイドル TTL・同時1インスタンス）／受け入れ: skills が2本返る試験、既定値の試験／1〜2h

K6 で本文まで返す Tool の説明文に載せる文言は一字一句このとおりとする：

> この Tool の戻り値は会話の記録に永続化される。ADR-0007 は秘密をエージェントの文脈に出さないと定めており、これは承知の上で開ける例外の口である

### 5-3. 実測スクリプトの置き場所

この判定のために動かした実測スクリプトは `prototype/browser-probe/` にそのまま残してある（使い捨てで製品コードではない。詳細は同ディレクトリの README.md を参照）。

## 6. 捨てたものと、それによって失うもの

- **mitmproxy + CA 注入を捨てる** → 失うのは「ブラウザ以外のアプリの通信」「TLS/TCP 層の精査」「リクエストの書き換え（addon による改変）」。得るのは CA 秘密鍵を置かないこと・依存ゼロ・**ピンニング下でも中身が見えること**。
- **VNC/noVNC/x11vnc/websockify を捨てる** → 失うのは「デスクトップ全体の共有」「ブラウザ外のアプリを人が触ること」。得るのは追加依存ゼロと、公開の仕組み（L7 のみ）に手を入れずに済むこと。
- **fcitx5/mozc を捨てる** → `Input.insertText` で日本語が入るため。失うのは「ブラウザ内の IME 変換候補を人が使う」体験（面から送るのは確定済みテキストになる）。**ここは実装後に人が触って確かめるべき点**として明記する。

## 7. 未確認と残るリスク

- `Network.enable` の `maxResourceBufferSize` の**既定値の実数**は未計測（10MB が通った、という事実のみ）。
- SSE で `Network.streamResourceContent` を呼ぶと `bufferedData` が空文字だった（`dataReceived` 側で配信済みのためと推測。**深掘りしていない**）。
- 拡張機能経由の通信は未検証（service worker と同じくターゲットが別なので、同じ対処が要ると見込まれるが**未確認**）。
- 面での体感（フレーム転送の粗さ・遅延）は人が見るまで分からない。T3/T4 の後に PO が実際に触って確かめる段を置く。

## 8. 追記（2026-08-16、K2 実装時に判明）

### 8-1. 3-1 の実測は、実はサンドボックス無効の上で取られていた

3-1 の headless/headful の起動時間・RSS は playwright の `chromium.launch()` を使って測っていたが、**このレポートは playwright が実際にどんな引数で chromium を起こしていたかに触れていなかった**。K2 実装時に `child_process.spawn` をフックして実引数を採取したところ、playwright は明示的に `--no-sandbox` を渡していた（末尾近くに `"--no-sandbox"` が含まれる）。**つまり 3-1 の数字はサンドボックス無効の上で取られたもので、有効時の起動時間・RSS は未計測。**

### 8-2. このホストではサンドボックスを有効にできない——壁は2つある

K2（本物の chromium を起こすアダプタ）で既定をサンドボックス有効のまま起動しようとしたところ、**独立した2つの壁**で塞がれていることが実機で分かった。

**壁1：`NoNewPrivileges=true`。** banto を動かす systemd unit（`banto.service`、およびこの検証を走らせた `banto-worker-pool.service`）はどちらも `NoNewPrivileges=true`（`deploy/banto.service` 参照）。これは `prctl(PR_SET_NO_NEW_PRIVS)` を立て、**setuid ビットを問答無用で無効化する**。だから同梱の `chrome_sandbox` を setuid root にしても（`chown root:root` + `chmod 4755` を PO が実施・`-rwsr-xr-x root root` になったことを確認済み）、これらの unit 配下では使えない。

**壁2：AppArmor の非特権 user namespace 制限。** setuid が仮に効いたとしても、chromium は次に namespace ベースのサンドボックスへ落ちる。このホストは `apparmor_restrict_unprivileged_userns=1` で、非特権プロセスの user namespace 作成を塞いでいる。

実機で確認した stderr の全文（`BANTO_BROWSER_ALLOW_NO_SANDBOX` を立てず、`CHROME_DEVEL_SANDBOX` で setuid root の `chrome_sandbox` を指した状態で起動を試みたとき）：

```
The setuid sandbox is not running as root. Common causes:
  * An unprivileged process using ptrace on it, like a debugger.
  * A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)
Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
[...] FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:207] Check failed: . : No such file or directory (2)
```

このメッセージ自体が「壁1」の指紋を含んでいる（`A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)` を common causes の1つとして挙げている）。setuid が機能していないため chromium は namespace サンドボックスへフォールバックし、そちらが「壁2」（AppArmor）の `Operation not permitted` で止まる——**最初の切り分けでは「AppArmor だけが原因」と誤認したが、実際は壁1（NoNewPrivileges）が先に効いていて、壁2（AppArmor）はそのフォールバック経路で踏んだもの。両方が独立に効いている。**

**どちらの壁も「banto 側またはホスト側のハードニングを緩めないと外せない」：**
- 壁1を外すには `banto.service`（および `banto-worker-pool.service`）の `NoNewPrivileges=true` を外す必要がある
- 壁2を外すには、ホストの AppArmor 設定（`apparmor_restrict_unprivileged_userns`）を緩める必要がある

**どちらも今回は緩めない**、というのが PO の判断（2026-08-16）。

### 8-3. PO の判断とその結果

まず setuid root 化を試す（サンドボックス維持を優先）→ 上記の理由で効かず → その場で粘らず、明示的な opt-in `BANTO_BROWSER_ALLOW_NO_SANDBOX=1` へ切り替え、そちらで実機検証（`/devtools/page/` の CDP 接続・screencast・入力・後始末）を通した（2026-08-16）。既定では `--no-sandbox` を付けない。開いていることは①起動時のログ1行、②`browser.status` の `sandbox` フィールド（`"enabled" | "disabled"`）の両方に出る。`deploy/banto.service` にも、なぜこの変数が要るかをコメントで残してある。

### 8-4. 次の人へ

- **`chrome_sandbox` を実行ファイルの隣に置くだけでは chromium は使わない。** chromium が見るのは環境変数 `CHROME_DEVEL_SANDBOX` か、ビルド時の既定パス（`/usr/local/sbin/chrome-devel-sandbox`）だけ。K2 の実装（`resolveSandboxEnv()`、`packages/banto-host/src/browser/chromium-launcher.ts`）は、隣の `chrome_sandbox` が root 所有かつ setuid ビット持ちのときだけ `CHROME_DEVEL_SANDBOX` を子プロセスの環境に足す。
- **setuid を試す前に、まず自分が動いている systemd unit の `NoNewPrivileges` を確認すること。** `true` なら setuid はどう頑張っても効かない——AppArmor やその他の要因を疑う前に、まずここを見る。
- 将来別の環境（`NoNewPrivileges` の無い unit、あるいは unit の外）でサンドボックス有効化を再検討する場合も、壁は2つあるので**両方**確認すること。
