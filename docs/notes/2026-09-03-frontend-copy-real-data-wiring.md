# apps/frontend は mock/ のコピー＋実データ配線（決定・2026-09-03）

**決定は`docs/specs/v4-frontend.md`側には書かない**——実装配置の話であって、
仕様の決定ではないため。ここに経緯だけ残す。

## 決定

- `mock/`は一切変更しない。撮影済みのデモ動画がこの上で動くため
  （ユーザー指示：「モックはそのままで手を付けず」「かなり動画を作り込んでる
  から、UIとしてはなるべくそのまま使いたい」）
- `apps/frontend`は`mock/`の全ファイルを`node_modules`・`.next`を除いて
  丸ごとコピーしたもの。`lib/mock/*`のデモ4Project（banto/home/hermes/
  old-migration）とその台本は、コピー後もそのまま残っている
- 実データへの配線は**同じ関数を実装の中で分岐させる形**で追加した
  （新しい`lib/api/*`に差し替えて91ファイルの import を書き換える、という
  当初案は採らなかった——量が多すぎて「UIを作り直す」のと大差なくなる）：
  - `MockProject`/`MockThread`に`real?: boolean`を追加
  - `createMockChatModelAdapter(thread)`は`thread.real`なら
    `lib/backend/adapter.ts`の実アダプタに委譲する。デモの台本再生ロジックは
    一切触っていない
  - 新規Project作成（`new-project-dialog.tsx`）だけを実ホストへの
    `createRealProject`に向け替えた——既存4件のデモProjectはこれまでどおり
    `createProject`（台本つき）のまま

## 解けた技術的な問題（本題）

assistant-uiの`ChatModelAdapter`は「`requires-action`で`run()`を`return`し、
`addResult`のあとにランタイムが`run()`を呼び直す」契約——mock自身のコメントに
実測の跡が残っている。一方bantoホストは「SSE接続を1本開いたまま、答えは
`/api/inbox/:id/answer`という別経路で送る」（hold-the-line、§6.0）。

この2つを繋ぐため：
- Thread単位で持続するSSE接続（`AsyncGenerator<RealTurnEvent>`）を
  `lib/backend/adapter.ts`のモジュールレベルMapに保持し、`run()`の
  再呼び出しでは新しい接続を開かず、同じ接続を読み進める
- 承認待ち（`judgment`イベント）が来たら`HUMAN_TOOL_NAME`のtool-callとして
  `requires-action`でyieldしてreturnする——ここまではmockと同じ形
- `human-tool-card.tsx`の`onAnswered`は、real threadなら
  `sendRealAnswer(toolCallId, answer)`（`/api/inbox/:id/answer`への実POST）を
  `addResult`の前に呼ぶ。台本のThreadでは何も起きない（`getRealJudgmentId`が
  見つからないので早期return）

## banto core側で見つかった別の問題（今回の副産物）

上記を実装する過程で、**core側がそもそもリアルタイムにストリーミングして
いなかった**ことが分かった（`runner/adapter.ts`の`runTurn()`がターン全体を
`for await`で消費し切ってから配列を返す実装だった——SSEの見た目はしていたが
実質バッファ＋一括送信）。加えて承認待ちの発生をSSEに一切出していなかった。

`runTurn()`を`PushQueue`を使った真のasync generatorに書き直し（`message`・
`approval_requested`・`elicitation_requested`を起きた順にyield）、
`turn-runner.ts`が`judgment`イベントとして即座にSSE配信するようにした。
実測（curlでタイムスタンプ付きに確認）で、承認待ちが実際にリアルタイムで
届き、`/api/inbox/:id/answer`で答えると同じ開いた接続がそのまま続きを
返すことを確認した。

## 副次的な変更

- host↔frontendが別オリジン（frontend: 4175、host: 4737）になったため、
  hostにCORSを追加した（`access-control-allow-origin: *`、OPTIONS preflight
  対応）
- hostによる静的ファイル配信（旧・最小フロントエンド用）は削除した——
  Next.jsは自分のサーバを要るため、hostが配信する形は成立しない
- 接続先（host URL・token）は`?bantoToken=...&bantoHost=...`をURLに付けて
  一度開けばlocalStorageに覚える（`lib/backend/client.ts`）

## 実ブラウザでの検証（追記・2026-09-03）

`mcp__cloudcli-browser`は使えなかったが、`apps/frontend`の`devDependencies`に
既にPlaywrightが入っており、CLIから直接使えた（node script＋`import { chromium }
from 'playwright'`、`apps/frontend`ディレクトリから実行）。実際にブラウザで：

- 新規Project作成ダイアログの入力・送信 → 実ホストにProject/Base Threadが
  作られ、そのURLへ遷移することを確認
- 会話欄に実プロンプトを打って送信 → 実際にストリーミングで応答が返り、
  画面に表示されることを確認（`Reply with exactly: real-e2e-ok`→`real-e2e-ok`）
- デモの4Project（banto等）は一切変更なくそのまま動作することを確認

見つけて直したバグ2件：
1. **`?bantoToken=...`が`/`→`/p/banto`のredirectで消える**——`app/page.tsx`が
   searchParamsを転送していなかった。転送するよう修正
2. **`lib/mock/projects.ts`の`projects`配列はページの完全な再読み込みごとに
   初期値へ戻る、純粋にクライアント側だけのメモリ状態**——作成した実Projectの
   URLへ直接（ブックマーク・新規タブ等で）来ると、`getProject`が見つからず
   デモの`banto`にフォールバックしていた。アプリ起動時に実Project一覧を
   読み込んで登録する`hydrateRealProjects()`を追加（`components/banto/
   real-projects-bootstrap.tsx`がマウント時に1回呼ぶ）。React 19の
   StrictModeがeffectを2回呼ぶため、素朴に実装すると同時に2回awaitが
   競合して重複登録した（Reactの"duplicate key"警告で発覚）——
   進行中のPromiseを使い回す形にして解消

**既知の残課題**：直接（フルロードで）実ProjectのURLへ来ると、SSRは
実Projectを知らないため一瞬デモの内容でレンダーされ、クライアント側で
`hydrateRealProjects()`完了後に正しい内容へ訂正される。Reactの
hydration-mismatch警告が出るが、**Reactが自動でツリーを作り直すため
最終的な表示は正しい**（実測で確認）。気になるならProjectページ自体を
サーバ側でも実データを引ける形にする必要があるが、今回はデモ動線を
一切変えたくないという方針と衝突するため見送った。

## まだやっていないこと

- 台本Thread以外の`lib/mock/*`（settings・relay-approval・notifications・
  palette等）は未着手——今回はThread作成・会話・承認ゲートだけ
