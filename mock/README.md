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
  上書き（`CascadeRow`——「instance既定を継承」⇄「この Projectで上書き」）、資格情報の割り当て、
  セキュリティ境界の根。
- **Disable impact dialog**（`DisableImpactDialog`）——役割の実装を無効化する前に、何が断るかを見せてから確定する。階層1・階層2の両方で共有
- **常設の入口**（item17、決定）：Project rail・モバイルの上部バーに設定アイコンを常設。Command Palette だけに頼らない
- Vaultバックエンドが複数あるときの「他バックエンドへ移行」ボタンは、人専用の操作であることが分かるUIだけ置いた（実際の移行ロジックは無い）

### 階層2をSheetから`SettingsShell`共有レイアウトへ（2026-09-02）
- **発端**：`docs/notes/2026-09-02-role-dependency-resolution.md`の議論で、
  「role に複数実装があるとき、どれを使うか」の選択は banto core が持たず、
  依存している Module 自身の設定面（`ui://<id>/config`）に委ねる、と決定
  （§2.5「role 依存の解決は Module の仕事」）。Module の設定面が Project ごとに
  中身を変えうる以上、Project 設定（階層2）でも Module 自身の設定面を埋め込む
  必要が出た——レビュー指摘のとおり、右から出てくる細い`Sheet`では収まる保証が
  無い
- **`SettingsShell`を汎用化**：instance専用に決め打ちしていた`CATEGORIES`・
  `getConfigurableImplementations()`の直接参照をやめ、`categories`・
  `moduleImplementations`・`defaultSection`を呼び出し側から渡す形に変更。
  階層1（`settings-content.tsx`）と階層2（新設`project-settings-content.tsx`）が
  同じ骨格を共有する——「role→実装の一覧＋Moduleの設定面」という形はinstance/
  Projectどちらの粒度でも同じ、という気づきをそのままコンポーネントに落とした
- **`ProjectSettingsOverlay`を`Sheet`から画面いっぱいの`Dialog`へ**：`DialogContent`に
  `inset-0`相当のclassNameを当てて全画面化（`h-dvh`——`h-screen`はiOS Safariの
  100vh問題でcheck-tokens.mjsに機械的に弾かれる、既知のルール）。§6.6の
  Dialog/Sheet基準（one-shotか、背景を参照しながら作業するか）のどちらにも
  綺麗には当てはまらないが、instance設定画面と同じ「独立した画面」という
  扱いのほうが実態に合うと判断
- **`ModuleConfigPane`に`projectId`を追加**：§6.2「設定面へのProjectの文脈」の
  モック実装。渡すと、そのModuleが対応していれば中身を出し分けられる——
  実例としてVault系実装（`roleId === "vault"`）だけが、Projectのalias一覧
  （旧・階層2に直書きしていたセクション）を追加で出す。**instance側
  （`/settings`、projectId無し）で同じModuleを開くと、この節は出ない**——
  Playwrightで確認：instance側は「この Project の alias」を含まない
- **Vault接続の上書き（`vaultImplementationId`のCascadeRow）は階層2から削除**——
  §2.5の決定どおり、Vaultに依存するModule自身の設定面に委ねる。今のmockでは
  Vault自身の`ModuleConfigPane`にProjectのalias一覧を出す形だけを実装した
  （「どのVault実装を使うか」をRepo・Shell自身の設定面で選ばせる詳細UIは未着手）

### instance設定（`/settings`）もEscapeで閉じれるように（2026-09-02）
- `/settings`はProject設定と違ってDialogではなく普通のroute（AppShellの
  子として描画、ProjectRailは表示されたまま）なので、Escapeは自前で拾って
  1つ前の画面へ`router.back()`する必要がある——`hooks/use-escape-navigate-back.ts`
  を新設
- **踏んだ罠**：`window.addEventListener("keydown", ...)`をbubbleフェーズ
  （既定）で登録すると、RoleListの無効化確認（`AlertDialog`）が開いている
  状態でEscapeを押したとき、**Radix側が同期的にダイアログを閉じてから**
  このhookのハンドラが走っていた——判定した時点で既にダイアログが消えており、
  「他のダイアログが開いているから何もしない」というガードが手遅れになって
  二重にEscapeが効いてしまう（確認ダイアログを閉じたつもりが/settingsごと
  離脱する）。**captureフェーズ**（`addEventListener`の第3引数`true`）で
  登録すると解決した——captureはbubbleより先に上から下へ効くので、Radix側の
  ハンドラが走る前に「まだダイアログがある」状態で判定できる。Playwrightで
  before/after両方の挙動を実測して確認（規則1）

### モック向けコメントの本文流出を除去（2026-09-02）
- レビュー指摘：`SectionHeading`の`description`・`CascadeRow`の`inheritedLabel`・
  `title`属性・段落テキストなど、**実際に画面に出る文字列**の中に`（§2.7）`
  `（決定・2026-09-01）`のような仕様書の節番号・決定ログの引用がそのまま
  混ざっていた——コード中の`//`コメント（開発者向け、画面に出ない）は問題ないが、
  JSXのテキストノードやprops値として渡される文字列は実際にレンダリングされる
  ので、本実装に流用したときに製品の文言として出てしまう
- 全`.tsx`ファイルを`grep`で洗い出し（`§`・`決定・202`・`レビュー指摘`・
  `item[0-9]`等）、JSXの可視文字列とコード中の`//`/`/* */`コメントを判別して
  前者だけ修正。`lib/mock/settings.ts`の`mockRoles`の`description`フィールド
  （RoleListがそのまま表示する）、`lib/mock/threads.ts`のデモ会話テキストにも
  同じ混入があり、あわせて直した。Playwrightで`/settings`・Project設定の
  画面テキストに`§`が残っていないことを確認

### Command Palette（§6.3、Ctrl-K）
- `CommandPalette`（cmdkベースの`components/ui/command.tsx`を使用）。Ctrl-K/Cmd-Kでどこからでも開く（`AppShell`の`keydown`）ほか、Project rail・モバイル上部バーに検索アイコンを常設（Command Paletteの存在を知らないと辿り着けない、を避ける）
- **自分の索引を持たない**（§6.3の決定どおり）——`lib/mock/palette.ts`が既存のmockデータ（Project・Thread・受信箱・Project単位のModule集合）から都度導出するだけで、パレット専用のデータストアは作っていない
- 範囲もspecどおり：Project/Thread・受信箱は**banto全体**、Moduleの入口（launcher）・資源は**いまのProjectのModule集合に限る**
- **深い検索（§6.3「completion APIに乗せる」）はモックでは固定候補への前方一致に簡略化**——`resources/templates/list`+`completion/complete`の実装は本実装の仕事。クエリが空のときは出さない（「数えきれない資源を既定で全部出さない」という性質だけ再現）
- **検索結果はメニュー項目のようにグループ化**——階層1の検索UIと同じ考え方を流用
- **実装中に踏んだ罠**：`usePanelStack.open()`を同じイベントハンドラの中で2回続けて呼ぶと、2回目が1回目の変更をまだ知らない（間でReactが再レンダーしていない）ので1回目を踏みつぶす——「操作を実行する」と「パレットを閉じる（overlay を消す）」は必ず1回の`open()`呼び出しにまとめる必要がある（`{ fork: "ui", overlay: null }`のように）。href遷移の場合は新しいURL全体で置き換わるので、遷移だけで閉じたことになり追加の呼び出しは不要——ここを誤ると「操作は実行されるがURLが古い状態に巻き戻る」という分かりにくい壊れ方をする

### 文脈内訳・使用量表示（§10 item9、実測§8）
- `ContextUsageMeter`——Base/Fork Thread ヘッダーにコンパクトなメーター（使用率%）を常設、クリックで内訳を開く。dataviz スキルの手順（form→color→validate→marks→interaction）に従って作った：単一比率は**meter**、part-to-wholeは**横向きstacked bar**
- カテゴリ色は dataviz スキルの検証済み既定パレット（`references/palette.md`）のslot 1〜5を採用——banto はまだ独自のカテゴリカルテーマを持たない。`validate_palette.js`でbantoの実サーフェス（light `#ffffff`/dark `#16191f`）に対して確認済み（light modeは3色がcontrast 3:1未満のWARN——legend/tableのrelief必須という判定どおり、凡例に常時トークン数を出して満たしている）
- **Autocompact buffer・Free spaceは中立色**（surface-2/3）——「中身」ではないので categorical色を使わない。カテゴリカル色は実質5系列に絞られ、7系列版よりCVD安全性に余裕が出た
- Skill は名前+出所、MCP tool はサーバ、Memory はファイルごとに内訳をドリルダウンできる（§5.7の要求どおり）
- `deferred`（窓の外にあるtool定義）は明確に別枠——windowTokensの合計に含めない
- **実装中に見つけた既存の不具合**：shadcnスカフォールドが最初から`--chart-1`〜`--chart-5`という**このためにある**CSS変数を用意していたが、`--banto-accent`/`--banto-ok`/`--banto-warn`/`--banto-stop`/`--banto-turn`のエイリアスのまま放置されていた。最初『層A』に別名で新トークンを足したが、後続の`@theme inline`ブロックの既存マッピング（`--color-chart-N: var(--chart-N)`）に踏みつぶされて、系列色が実質「accent/ok/warn/stop/turn」になっていた（Playwrightで実際の`background-color`を読むまで気づかなかった——スクリーンショットの見た目だけでは判別できなかった）。**既存の`--chart-N`を検証済みパレットで置き換える**形に直して解決
- **`npm run lint`（`eslint && check-tokens.mjs`）を通していなかった**——`npx eslint`だけ実行しており、E9（色・字の大きさの段を守る機械検査）を素通りしていた。既存の`text-[10px]`/`text-[11px]`/`text-base`の混入（前回までのセッションで導入）もこの機会に修正——以降は`npm run lint`を使う

### Project / Thread のライフサイクル操作（§6.0 item6・§2.2）
- **共有state基盤を新設**（`lib/mock/store-events.ts` + `projects.ts`/`threads.ts`のミュータブル配列）——
  Project/Threadの作成・終了・畳む・再開はモック全体で反映される必要があるため、
  従来の静的readonly配列からgetter/mutator関数の組に変更した。`useSyncExternalStore`で
  購読するコンポーネント（rail・パネル）だけが再描画される
- **新規Project**：Project rail・モバイル上部バーの「+」ボタン→`NewProjectDialog`。
  既定表示はProject名・Baseパス、Advancedで既定モデル/effortの上書き（値は保存のみ、
  Project設定画面へは反映していない——モックの割り切り）
- **右上「Canvasを表示」を削除**——モックのデモ用途以上の意義が無いボタンだったため。
  Canvasを開く経路はlauncher・tool呼び出し（inline/fullscreen自動起動）・Command Paletteの
  「Canvas を開く」操作に残る
- **「Forkを開く」をアイコンのみに。Fork Threadヘッダーに畳むアイコン（GitMerge）を追加**——
  押すと`closeThread()`で畳み、Base Threadに戻る。削除ではない
- **Projectを終了するUI**（Project設定画面の「危険な操作」セクション）——確認ダイアログ経由。
  削除ではなく終了——閉じたThreadは畳まれた状態のまま保存される
- **Thread の Clear / Compaction**（Base/Fork Threadヘッダーの「…」メニュー）——
  ラベルはClaude Code自身のコマンド名に統一（Clear／Compaction）。「畳む」という訳語は
  Fork Threadを丸ごと閉じる操作（GitMergeアイコン）だけで使い、同じ語が2つの意味を持つ状態を
  解消。結果はヘッダーに出さず、チャット欄（composerHint、Composerのすぐ上）に横線として残す

### 履歴（レビュー反映：閉じたFork一覧とProject一覧のUIを統合）
- 当初は別々（Sheet×2）で作ったが、**「削除ではなく終わっただけ、読み返して再度開ける」という
  性質が同じ**なので、1つのモーダルダイアログ（`ArchiveDialog`）にセクション分けして統合した——
  Chromeの「最近閉じたタブ」がタブとウィンドウを1つのリストに混在させアイコンで区別している
  のと同じ発想（規則12）。入口はBase Threadヘッダーの時計アイコン・サイドバー下部の時計アイコン
  の両方から、同じダイアログを開く（`use-panel-stack.ts`の`"archive"`overlay）
- セクションは「このProjectの閉じたFork Thread」（Project外では非表示）と「終了したProject」
  ——スコープの違い（Fork＝Projectの中、Project＝banto全体）はCommand Paletteの
  「Moduleの入口はいまのProjectに限る」と同じ非対称として扱う
- 検索は名前の前方一致のみ。**全文検索をやるなら索引が要る**（HermesAgentのような形）——
  今回は手を出さず、§10に検討事項として残す価値がある
- 「概要」はAI要約ではなく、件数＋最初/最後の発言（Thread）／Baseパス＋Thread数（Project）
  という安く決定的に出せるものだけ——Memoryの自動要約を採らなかったのと同じ理由
  （§2.2「決まったことの意味を静かに歪めるリスク」）
- **実装中に踏んだ罠（再発）**：再度開くボタンで`onOpenChange(false)`と遷移を同じハンドラで
  両方呼ぶと、Command Paletteで踏んだのと同じ`usePanelStack.open()`の競合を再び踏む。
  Fork再オープンは呼び出し側がoverlayのクリアを1回のopen()にまとめ、Project再オープンは
  新しいURL全体への遷移だけで済ませる（`onOpenChange(false)`を呼ばない）

### キーボードナビゲーション
- まず計測（規則1）：Playwrightで実際にTab順・Escape・矢印キーを測った。Escapeは
  既に全オーバーレイ（Inbox・Command Palette・Archive・NewProjectDialog・
  ProjectSettingsOverlay）で機能済み——Radixの既定動作、Escape一発では閉じないように
  見えたのは検証スクリプトの待ち時間が短すぎただけ（router.pushの往復に実際は1秒近く
  掛かる場合がある）だった
- 実際のギャップは**矢印キーでの一覧移動**——Command Paletteはcmdkが内蔵しているが、
  banto自身で組んだ縦並びのbuttonリスト（Archive・Settings左メニュー・役割一覧・受信箱）は
  Tabで1つずつしか移動できず、ArrowUp/Downが効かなかった
- `hooks/use-roving-focus.ts`を新設（roving tabindexパターン、規則12）——リストの
  コンテナに`ref`+`onKeyDown`、各行に`data-roving-item`を付けるだけで
  ArrowUp/Down/Home/Endの移動が付く。適用先：`ArchiveDialog`（Fork・Project
  両セクションを1つの連続したリストとして移動）・`SettingsShell`左メニュー
  （カテゴリ・Module設定・検索結果）・`RoleList`（role見出し行）・`InboxOverlay`
  （受信箱の項目）
- 同じ`data-roving-item`属性を複数の独立したコンテナで使っても、各フックは
  自分の`containerRef`配下だけを`querySelectorAll`するので混線しない
  （実測で確認——`SettingsShell`の左メニューと`RoleList`のrole見出しは同じ
  ページに同居するが、矢印キーの移動先はそれぞれ自分のリスト内に閉じる）

### Dialog / Sheet の使い分け（決定・2026-09-02、§6.6に記録）
- レビューで「受信箱・Project設定もDialogに寄せられるか」と聞かれ、技術的には可能
  （shadcnの`Sheet`は`Dialog`と同じRadixプリミティブが土台）と答えた上で、
  「一度きりの操作か、読みながら長く滞在するか」という基準を明文化した
  （`docs/specs/v4-architecture.md` §6.6）
- 既存の実装はこの基準にすでに沿っていた（見直しは不要だった）：
  Dialog＝Command Palette・履歴（Archive）・新規Project作成・確認ダイアログ、
  Sheet＝受信箱・Project設定

## まだ実装していない

§10.0のD群（プロトタイプが要る項目）のうち、以下は未着手：

- **ライブ配信（SSE）**——複数クライアントが同じThreadを同時に見る場面
- **通知**（item28、§10）——受信箱のバッジ止まり。実際のトースト/プッシュ通知は無い
- **Threadの全文検索の索引**——閉じたFork Threadの検索は今のところタイトル前方一致のみ。
  本文まで検索するならHermesAgentのような索引の仕組みが要る（要検討、§10未決候補）

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
