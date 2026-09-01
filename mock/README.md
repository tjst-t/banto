# banto v4 — モック

**CLAUDE.md の3段（PoC → モック → 本実装）のうち、いまはモック段。**
目的は「機能を網羅した画面を作り、UI を固める」こと——中身（実バックエンド・
実MCP接続）は繋がない。ここで作ったものは**捨てる前提ではない**（PoCとは違う）
が、UIの決定が目的であって、コードの完成度そのものが目的ではない。

決まったことは `../docs/specs/v4-architecture.md` に書く。このREADMEは
**モックの実装がどこまで進んだか**だけを追う——仕様の決定はここに書かない。

## 起動

```bash
npm run dev   # next dev --turbopack -H 0.0.0.0 -p 4173
```

PCは `http://localhost:4173`、携帯は同一LAN内から `http://<LAN IP>:4173`。

## 実装済み

### 骨格・レイアウト
- Project切替（ルート遷移）、Base/Fork Thread・Canvasの3層重ね（`?fork=`・`?canvas=`のsearchParams駆動）
- デスクトップ：react-resizable-panels、Canvas表示は画面の2/3幅
- モバイル：Drawer的なフルスクリーン切替
- サイドバー（Project rail）・受信箱バッジ

### 会話ビュー（assistant-ui組み込み）
- `ChatModelAdapter`が台本（`lib/mock/threads.ts`）を再生するダミー応答
- tool呼び出し表示・Fork Thread切り替え・日本語IME対応

### 受信箱（§2.4）
- 判断待ち／レビュー待ちを1つの入れ物にまとめ、判断待ちを先に表示
- 判断待ちは3状態（生きている／解決済み／タイムアウト済み）を出し分け——「生きている」間は受信箱から答えても元のtool呼び出しを直接解決できる
- 判断待ち・レビュー待ちそれぞれ「Elicitation/Module発」と「Thread自身発（AIの地の文・純粋完了）」の2系統を実装（`lib/mock/types.ts`の`source`判別共用体）
- 会話中のライブElicitationカード（HumanToolCard）——受信箱と見た目の材料を共有

### 承認ゲート（§6.0・§6.4）
- tool呼び出し前に確認を求め、拒否できるUI（`ApprovalToolCard`）
- 機構は`unstable_humanToolNames`+`addResult`（human toolと同じ経路）。assistant-ui独自の`approval`/`respondToApproval`は**モックでは使わない**——理由は`lib/mock/adapter.ts`のコメントと`poc/04-canusetool-hold-the-line/`を参照

### Canvas・MCP Apps display mode（§6.2）
- Canvasの中身（Repo Moduleの差分ビュー・Worker Moduleの診断レポート・テスト結果）——実際の`ui://`iframe/postMessageハンドシェイクは実装していない（本実装の仕事）
- inline表示（tool呼び出しカードに埋め込む）とfullscreen表示（tool呼び出し自身の要求でCanvasを自動起動）の両方を実演——「昇格」の仕組みは無い、独立した2つの描画先

### デモ導線
- 会話のcomposer直上に、デモ用トリガー文言のヒントを常時表示（`DemoHints`）

### 設定2階層（§6.1・§2.10、item14・15・17・19）
- **階層1（instance level、`/settings`）**：ユーザーとの議論（2026-09-01）でレイアウトを1往復やり直した——
  最初は縦積みの role 一覧だったが「メリハリが無い・ずっと縦長」という指摘を受け、
  **左メニュー＋右詳細＋上部検索**（`SettingsShell`、macOS System Settings・VSCode設定・Vivaldi等と同じ、規則12）に変更。
  左メニューは2段：banto自身の固定カテゴリ（役割とModule／既定値／資格情報）＋区切り線＋
  **Module自身の設定面（`ui://<id>/config`）のフラット一覧**（iOSの「設定アプリ下部のインストール済みアプリ一覧」と同じ形、§6.2）。
  無効な実装は下段に出さない。モバイルは「一覧→タップで詳細」の1カラムに畳む
- **`ModuleConfigPane`**——Module自身が持ち込む設定面のモック。banto自身のUIとは明確に質感を変え
  （破線枠・「sandboxed iframe」のラベル）、「これは他人のコードが描いている」ことを示す（§6.2の
  「設定面は常にsandboxed」を見た目でも崩さない）
- **色の使い方**——「組み込み」バッジは当初 accent色の塗りバッジで目立ちすぎていたため、isolation
  バッジと同じ`outline`に揃えた。強い色（accent青）はトグルのON状態・選択中のナビ項目だけに絞り、
  「無効化中」の警告は`turn`色（既存のturn/turn-soft、受信箱と共有）に寄せた
- **「無効化中——N件が断る」は何を指すか不明だった**（レビュー指摘）——件数だけでなく
  `breaksIfDisabled`の中身をその場に展開し、「無効化中——「〈具体名〉」が使えなくなります」という
  自然な文に修正
- **検索は左メニューの項目名だけでなく、右側の中身（role名・実装名・既定値の各項目・資格情報・
  Module設定面のフィールド）も対象にした**（レビュー指摘）。検索結果はフラットではなく、
  **メニュー項目を見出しにして中身を一段下げる**階層表示に修正（フラットだと「どこに属すか」が
  分からなかった、レビュー指摘）
- **開いているセクションの中身をクリックしても、該当箇所までスクロール＋一瞬ハイライトする**
  （レビュー指摘——同じセクションが既にアクティブだと何も起きないように見えた）。各設定項目に
  `anchor-*` のDOM idを振り、検索索引の`anchorId`と対応させた。役割を手動で畳んでいる場合、
  その中の実装への直接ジャンプは効かない（初期状態は全展開なので通常は問題にならない）——既知の制限
- **階層2（Project、`?overlay=settings-project`）**：繋がっているModule一覧、runtime configのカスケード
  上書き（`CascadeRow`——「instance既定を継承」⇄「この Projectで上書き」）、資格情報の割り当て、Vault
  接続の上書き、セキュリティ境界の根、この ProjectのVault alias一覧（§2.5「alias方式」——値は出さない）。
  色は元から乱れが無かったため構造・配色とも変更していない（Sheetのまま）
- **Disable impact dialog**（`DisableImpactDialog`）——役割の実装を無効化する前に、何が断るかを見せてから確定する。階層1・階層2の両方で共有
- **常設の入口**（item17、決定）：Project rail・モバイルの上部バーに設定アイコンを常設。Command Palette（未実装）だけに頼らない
- Vaultバックエンドが複数あるときの「他バックエンドへ移行」ボタンは、人専用の操作であることが分かるUIだけ置いた（実際の移行ロジックは無い）

## まだ実装していない

§10.0のD群（プロトタイプが要る項目）のうち、以下は未着手：

- **Command Palette**
- **文脈内訳・使用量表示**（§2.8）
- **ライブ配信（SSE）**——複数クライアントが同じThreadを同時に見る場面
- **通知**（item28、§10）——受信箱のバッジ止まり。実際のトースト/プッシュ通知は無い

## モック段の締めに残っていること

- §10.0のD群を「決定」として`docs/specs/v4-architecture.md`に書き戻す
- `§6.4`のassistant-ui対応表を、実装で確かめた最新版として確認し直す
- 字の段（7段ルール）が実際のブラウザで守れているかの自動計測（Playwright）

## 実装上、次のセッションが踏みやすい罠

- **`ChatModelAdapter`の`run()`は、`addResult`/`respondToApproval`のたびに
  「新しく呼び直される」。** 既存の`content`を再yieldすると重複キーで壊れる
  ——`lib/mock/adapter.ts`の`findAnsweredTool`パターンを参照
- **`unstable_getMessage()`と`messages`は別物。** 進行中（`requires-action`）の
  メッセージは`messages`配列には現れない
- **assistant-ui独自の`approval`は「provider（バックエンド）が結果を出す」
  前提。** クライアント側で結果を合成する設計とは根本的に相性が悪い
  （実測で確認、`poc/04-canusetool-hold-the-line/README.md`）
- **`ToolGroup`の既定は畳んだ状態。** `requires-action`やinline表示を
  デフォルトで見せたいときは`HumanAwareToolGroup`のように自動展開ロジックが要る
