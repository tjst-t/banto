# 2026-09-09 リポジトリ全体レビュー

v4 リポジトリ全体（banto/packages・banto/apps/frontend・banto/e2e・docs・mock の位置づけ）を
見直した記録。方法：領域別に4本の独立レビュー（core／frontend／E2E とテスト品質／
ドキュメント整合性）を並行で実施し、[高] の指摘は本文のコードを直接開いて裏取りした。
併せてビルド・型検査・テストを自分で実行した（規則1）。

**これはレビューの記録（経緯）であって仕様ではない。** ここに書かれた指摘への対処を
決めたら、決定は specs / tasks.json に書くこと。

---

## 1. 自分で実行して確かめた結果

| 検証 | 結果 |
|---|---|
| `npm run typecheck`（全7ワークスペース） | 通過 |
| `npm run test`（ユニット） | **146件全通過**（core 111・landlock 4・module-contract 11・filesystem 8・shell 7・vault 5）。dist が src より新しいことも確認（古いビルドを試験していない） |
| `next build`（frontend） | 成功 |
| `npm run lint`（frontend） | エラー0・**警告10**（未使用変数・exhaustive-deps。§3.2 の 16 参照） |
| 秘匿情報の混入 | 追跡ファイルに API キー・秘密鍵のパターンなし |
| E2E（Playwright 19 spec） | 1回目は 15 failed / 4 passed だが**無効**——別セッション（工場）が同じワークツリー・同じ固定ポート（4738/4175）で並行して E2E を回しており、途中から core が `ECONNREFUSED`。メモリ「テストの失敗は自分のものとは限らない」の実例。取り直しの結果は §5 |

未コミットの作業が3ファイル残っている（sidebar-preference.ts：サイドバー幅を React の
外に持つ改修＋回帰テスト、frontend と mock の両方）。別セッションの進行中の作業と
みられるため、このレビューでは触っていない。

---

## 2. 最優先で人に上げるもの

規則8（仕様と実態の食い違いは、黙ってどちらかに寄せず記録して人に上げる）に当たるもの。
**[高] の4件はすべてコードを直接開いて事実確認済み。**

### 2.1 [高] 中継トークンが AI 実行のコマンドに継承される（D3 の実質的な破れ）

`banto/packages/modules/shell/src/run-command.ts:37` が `{ ...process.env }` を
子プロセスに渡す。Shell Module の env には host が起動時に注入した
`BANTO_HOST_MCP_TOKEN` / `BANTO_HOST_MCP_URL` が入っている
（`packages/modules/shell/src/server.ts:111-112` で自分が読んでいる）ため、
AI が書いた任意のコマンドがこのトークンで host 中継を叩け、Shell の身元
（dependsOn: vault）で `resolveAlias` を呼べば**秘密の値が stdout 経由で AI の文脈に入る**。
`permissionMode: "auto"` ではゲートが人に上がらないまま通り得る。
別経路として、Landlock 許可リストが `/proc` を読み取り許可しているため
（`packages/landlock/src/derive.ts` 付近）、`/proc/<pid>/environ` からも同じトークンが読める。
**最低限の対処は子プロセス env から `BANTO_*` を剥がすこと。**
該当：`docs/specs/v4-security.md`・v4-modules §2.1 D3。

### 2.2 [高] Landlock の最後の防波堤 `assertRulesetIsSafe` が本番で呼ばれていない

`packages/landlock/src/guard.ts:32` に実装とテストはあるが、呼び出しは guard.test.ts のみ
（grep で確認）。`packages/core/src/cli.ts` は deriveProjectRuleset → writeRulesetFile を
guard を通さず直行する。人が Project root に home を指定すると、home 全体が READ_WRITE の
ルールセットがそのまま書き出される。「有るのに配線されていない」——規則13 の精神の
バックエンド版。

### 2.3 [高] Event Store が仕様の耐久性規律（fsync・torn line 切り詰め）を実装していない

仕様（v4-architecture §2.1）は「fsync は追記ごと」「`\n` で終わらない最終レコードは
切り詰めてから追記する」と明記するが、`packages/core/src/event-store/log.ts` は
`appendFile` のみで fsync 無し・切り詰め処理無し（grep で確認）。書きかけの行が残ると
次回起動の `readFrom` → `JSON.parse` が毎回失敗し、**host が起動できなくなる**。
スナップショットの fsync(dir) 欠落、「State は素の JSON に限る」に反する Map＋独自
replacer（snapshot.ts）も同族。

### 2.4 [高] 「画面からの tool 呼び出しに承認が要るか」が、仕様書の中で真っ二つ

`docs/specs/v4-frontend.md` の同じ §6.2 内で矛盾している（行番号で確認）：
- 124行:「**banto は、画面が自分の Module を呼ぶときは承認を求めない**（改訂・2026-09-07）」
- 330行:「`POST /api/threads/:id/ui-tool-call` | 画面からの tool 呼び出し。**必ず承認ゲートを通る**」

コードは改訂後の側（`packages/core/src/http/app.ts` の ui-tool-call ハンドラは承認ゲートを
経由しない）。**セキュリティ境界の説明が仕様書内で逆のまま残っている**ので、表側
（330行と 340-343 行の段落）の消し忘れを直す必要がある。さらに frontend 側の
`lib/backend/client.ts:582-583` のコメントも「必ず承認ゲートを通る」のまま
（コメント・実装・仕様の三つ巴。§3.2 の 4 参照）。

### 2.5 [高] §10 item 11「セキュリティ境界——まだ設計していない」が決定済みの実態と正面衝突

`docs/specs/v4-architecture.md` §10 item 11 は「まだ設計していない」と言うが、
§10.2 と `v4-security.md` は「済（2026-09-02〜03）」。この文書自身が「§10 に無いものは
まだ存在しない」と宣言している台帳なので、未決/決定の混線としては最重度。消し込みが要る。

---

## 3. 領域別の発見事項

裏取りしていない項目には元レビューの「要確認」を残している。

### 3.1 core（packages/）

§2 の 1〜3 のほかに：

- **[高] 60秒超のコマンドが MCP 既定タイムアウトで死ぬ**——v4-modules §2.3 が決めた
  「実行中の定期 `notifications/progress` 送出」が未実装（`run-command.ts` は spawn 前の
  秘密解決時しか送らない）。host→Module ホップは SDK 既定 60 秒なので `npm install` 等が
  `-32001` になる。既知の罠（MEMORY.md）の再演。
- **[中] Module 間中継に「初回承認ゲート」が無く、監査が Event Store に残らない**
  （`relay/host-relay-endpoint.ts`・`cli.ts` の onAudit は console.log のみ）。仕様 §2.5 の
  「初回のみ承認 → メタデータを Event Store に記録」が両方欠けており、Vault の
  `resolveAlias` 使用履歴を後から追えない。
- **[中] 代理サーバの健全性検査がターン完了「後」**（`http/turn-runner.ts:214-221`）。
  仕様と health.ts 自身のコメントは「ターンを中断する」。実装はエラーを yield した後も
  resume-point 更新まで続行し、AI は道具なしで完走してしまう。
- **[中] visibility の不正値が最も緩い `"agent"` に黙って落ちる**
  （`module-contract/src/meta.ts:237-240`）。typo した Module 専用 tool が AI に露出する。
  scope・handlesSecrets の不正値も同様に緩い方向へ静かに転落（規則2）。
- **[中] 自己申告に合わせた宣言修復が、Project 上書きを instance 既定へ書き戻す**
  （`cli.ts:290-295`——Project 解決済みの一覧を projectId 無しで保存。規則3。要確認）。
- **[中] 中継まわりのリソースリーク群**：sessions Map が増える一方・`revokeToken` 未使用・
  Module プロセスが Project を畳んでも回収されない・共有 Client の Elicit ハンドラを
  最後の proxy が上書き（コード内 TODO 明記——並行ターン中の Vault elicit が
  別ターンに届く）。
- **[中] Vault `createGroup` にパストラバーサル**（`vault/src/sops-backend.ts:123-125`、
  name 無検証で `../` が通る。Vault は Landlock 対象外なので OS 側の歯止めも無い）。
- **[中] `/api/.../ui-tool-call` が可視性を見ずに全 tool を呼べる**（`http/app.ts:683-`）。
  「他の Module は呼べない」の強制が frontend 頼みで、host API 境界には無い。
  `module` 可視性の `resolveAlias` も authToken さえあれば呼べて秘密がブラウザに返る。
  §2.4 の仕様矛盾を解くときに、この境界をどちらに置くかも一緒に決めるべき。
- **[中] SOPS の putSecret が平文一時ファイルを書く**（encrypt 中のクラッシュで残留）＋
  同一グループへの並行 put で更新消失。**[中] `startSshAgent` が呼び出しごとに
  ssh-agent を永久に残す**（kill 経路なし。鍵を持ったデーモンが増殖）。
- **[中] FileSystem の実効読み取り範囲が Project の根より広い**（絶対パスをそのまま通し、
  Landlock 許可リストは /etc・/proc・monorepo root を含む）。「根の外へ出さない」
  （v4-modules §3）との食い違い——仕様側に追加決定を上げる案件（規則8）。
- **[低]** `vault://aliases` が resources/list に無く fail closed で AI から読めない（仕様は
  agent 可視）／未使用の `reconcileModuleMeta` が「緩い申告に従う」意味を持ったまま
  export されている／bootstrap config の欠損 authToken が毎回ランダム再生成され
  書き戻されない／`app.ts:324` の「認証しない」コメントが実装と逆／同一 Thread への
  並行 POST /messages を防ぐロックが host に無い（frontend 抑止のみ）。

問題なしと確認された領域：SingleFlight・overlay 差分合成・event-store の fold 構造・
project-thread fold・inbox fold・PushQueue・system-prompt のキャッシュ規律・
sandbox-server の CSP（fail closed）・Rust launcher（fail closed）。
**`any` は全パッケージ0件、独自用語の持ち込みも見当たらず**（規則9・11）。

### 3.2 frontend（apps/frontend）

- **[高] Escape が前面のダイアログと背面のパネル層を同時に閉じる**（要確認・
  `shell/panel-stack.tsx:131-139`。`defaultPrevented` もダイアログ有無も見ない。
  command-palette.tsx が自ら文書化した罠と同型。`/settings` 側は検査しており非対称）。
- **[高] host に到達できないと「/」が永遠に真っ白**（`project/home-content.tsx:25-27`。
  `hydrateRealProjects()` に catch が無く、失敗すると `return null` のまま。規則2）。
- **[中] 規則2違反（無言の失敗）が同型で4箇所**：Project の会話読み込み失敗が
  「読み込んでいます…」のまま（`project-panels.tsx:197-200`）／permissionMode の host
  保存失敗が console.error のみでローカル値も巻き戻らない（`mock/permission-mode.ts:43-47`、
  §6.4 の「見失わない」が崩れる）／Project 終了の失敗が無言（
  `project-settings-content.tsx:102-107`）。toast を出す操作（Clear・fold）と非対称。
- **[中] Canvas の tool 呼び出し二重表示防止が配線されていない**（`canvas/module-canvas.tsx`
  の `beginCanvasToolCall` 等が未使用＝lint 警告とも一致。`adapter.ts` の除外フィルタが恒真。
  §2.4 の三つ巴の一角）。
- **[中] 新規 Project の Advanced 欄が繋がっていないのに出ている**（
  `new-project-dialog.tsx:133-243`。モデル/effort 等はクライアントメモリに入るだけで
  host に送られず、リロードで消える。規則13、CONNECTED_FEATURES に対応旗も無い）。
- **[中] Reload・Edit・BranchPicker が実 Thread で半接続のまま見えている**（要確認・
  `thread.aui.tsx`。分岐はローカルのみで、リロードすると直列に並ぶ。規則13/8）。
- **[中] SandboxFrame が親の再描画のたびに AppBridge を張り直す**（要確認・
  `module-canvas.tsx:215-226`。依存に毎レンダー新規の関数とオブジェクト。再接続後の
  bridge が無反応になる可能性——「出ているが繋がっていない」の形）。
- **[中] 同一文面の再送で 1 本の SSE を 2 つの run が食い合う**（要確認・
  `adapter.ts:450-455`。ガードを「live が居る限り新 run を発行しない」に倒すべき）。
- **[中] Memory 追加の Enter が IME 変換確定を拾う**（`global-memory-panel.tsx:82-84`・
  `project-memory-panel.tsx:77-79`。`isComposing` 未検査。日本語 UI の製品として実害が
  出やすく、Memory は追記オンリーなので取り消し線でしか消せない）。
- **[低]** Ctrl-K リスナーが毎レンダー付け替わる／リサイズドラッグ中 unmount の後始末漏れ
  ／撤去済み MobileTopBar へのコメント参照が残る／`as` キャストに理由が無い箇所
  （`use-panel-stack.ts:107`・`client.ts:38`）／lint 警告10件／SSE パーサが単一行 `data:` 前提
  ／畳んだサイドバーが初回に一瞬開いて見える。

良い知らせ：**`CONNECTED_FEATURES` で true の8項目はすべて実接続を確認**
（「true なのに未接続」は無し）。false 側の入口隠しも palette・settings nav まで一貫。

### 3.3 E2E・テスト品質

- **[高] worker 並走と共有 inbox**（`e2e/playwright.config.ts`——`fullyParallel: false` は
  ファイル内の順序しか固定せず、**ファイル単位では複数 worker が並走**して全 spec が
  同じ core（4738）と同じ受信箱を共有する。判断待ちを起こす spec が5本あり、他 spec の
  判断待ちを掴んだり件数アサーションが間欠で落ちたりする構造。global-memory.spec.ts:8 の
  コメントが並走の実在を自ら証言している。`workers: 1` の明示か projectId での絞り込みが筋。
  規則6）。
- **[高] Clear の検証が「押したボタンの文字がまだ見えている」で通る**（
  `project-thread-fork.spec.ts:65-67`。会話が消えたこと・resume-point が切れたことを
  見ていない。Clear が no-op になっても緑。規則14の正反対）。
- **[高] Fork 再オープンの「読み返せる」が背面 Base パネルの同じ文字列で通る**（
  `thread-lifecycle.spec.ts:75-76`。`toBeVisible` は覆いを見ない。再オープンした Fork が
  空でも緑。**規則14の由来になった実例とまったく同型の穴が現存**）。
- **[中] Shell 閉じ込めの「外は読めない」が、AI がコマンドを実行しなくても通る**（
  `shell-confinement.spec.ts:82-110`。runCommand が実際に呼ばれ失敗したことを見ていない）。
- **[中] 試験対象ビルドの鮮度を機械が検証しない**（`e2e/config.ts`——4175 は
  「本番ビルド前提」だが `reuseExistingServer: true` で何が立っていても信用し、
  フォールバックは `npm run dev` で前提と矛盾。**今回の E2E 汚染もこの構造の上で起きた**。
  ビルド時刻/コミットを画面が返して E2E 冒頭で照合するのが根本対処）。
- **[中] 否定形の証明が最初の poll で即通る**（`module-canvas-inline.spec.ts:142-151`。
  「承認が出ない」ことの検証は操作完了後にもう一度見る必要がある）。
- **[中] frontend のユニットテストがゼロ**。特に `lib/backend/adapter.ts`（LiveTurn の
  生死管理——過去に不具合4件の現場）が E2E の1経路でしか守られていない。
- **[中] core の `http/turn-runner.ts`・`runner/adapter.ts` に単体テストが無い**（ターン実行・
  SSE・判断待ち起票の中核が E2E 頼み。エラー分岐・SSE 途中断はどの試験も通らない）。
- **[中] done タスクの検証の穴**：`review-block-send-while-pending`（実際に送信を試みる
  spec が無い）・`review-error-path-status`（doneWhen そのものを起こすテストが無い）・
  `review-sse-error-after-headers`・`ui-codeblock-cjk`（回帰テスト無し）・
  `review-use-tooluseid`。次に同じ場所を触ったとき無言で再発する。
- **[低]** mobile-layout.spec.ts の固定 sleep 11箇所／LLM の逐語出力を合否条件にする箇所
  （global-memory・judgment-deny——落ちたとき機構の壊れとモデルの気まぐれを区別する
  記録が無い）／`/tmp/banto-e2e-*` の後始末漏れ／AI 側 `remember_decision` 経路が未検証。

総評：E2E の質は総じて高く、過去に踏んだ穴への対策がコメント付きで織り込まれている。
ストア層のユニットテストも良質。上記は「良い規律の中に残った穴」。

### 3.4 ドキュメント整合性

§2 の 4・5 のほかに：

- **[中] Phase 1 の完了条件がすべて満たされて見えるのに閉じられていない**（tasks.json は
  `currentPhase: "1"` のまま。phase0 と同様に閉鎖記録を書いて 2 へ進めるか、閉じない理由を
  書くか——**人の判断が要る**）。
- **[中] CLAUDE.md「Module GUI・設定画面はまだモック段」が古い**（MCP Apps 4要素は
  2026-09-06〜07 に本実装で完了済み。まだモックなのは instance 設定の一部セクションのみ）。
- **[中] 「CONNECTED_FEATURES が唯一の真実」が Canvas 系で成り立っていない**（
  `feature-flags.ts` の `canvas`/`paletteLaunchers` は実装上「モック面を出すか」の旗に
  意味がすり替わっており、コメントは「inline だけが実接続」のまま古い。規則3）。
- **[中] §10.1① と item 9 の内部矛盾**（マウントの記録先は決定済みなのに「残る」と
  書かれている等）・**item 16・21 も実装で実質決着済み**なのに未決のまま。
- **[中] §5.1 の「公式レジストリからインストール」（2026-09-02決定）と「レジストリからの
  取得は入れない」（2026-09-06決定）の関係が未整理**——撤回か将来形かを明記すべき
  （**人の判断が要る**）。
- **[中] 受信箱の「その場で答える」（frontend §6.3）が「答える口は Thread カード1箇所」
  （architecture §2.4.1・2026-09-06決定・実装済み）と食い違う**——§6.3 の更新漏れ。
- **[中] §6.4 の `defaultPermissionMode`（既定 auto）が core に存在しない**。frontend は
  auto を undefined に写して送るため、未選択 Thread は SDK 既定で走る——意図的なら仕様に
  書き戻す、そうでなければ規則8（**人の判断が要る**）。
- **[中] specs の「最終更新」ヘッダが軒並み古い**（architecture/modules/security が
  2026-09-02 のまま。本文には 09-05〜09-07 の決定を含む）。
- **[低]** tasks.json のスキーマ逸脱（`status: "todo"`・completedAt/doneWhen 欠落・
  id 接頭辞と phase の不一致）／§10.0 の「29件」が実数と不一致／§5.4-0・§5.4-a が §9 の
  後ろに物理配置され §5 から見えない／受信箱の第3種「お知らせ」が frontend 仕様に未反映
  ／mock/README.md のサイドバー節が「まだ決定ではない」のまま（実際は決定・実装済み）。

問題なしと確認された項目：tasks.json の依存関係（破れなし）・Phase 0 の閉鎖記録・
直近 notes（09-05〜09-09）の決定はすべて specs に反映済み（「ノートに書いただけ」違反なし）・
仕様が参照する成果物パスはすべて実在・bootstrap config／system prompt／受信箱3状態は
仕様とコードが一致。

---

## 4. 横断的な観察

1. **「書いたのに配線されていない」が最大のパターン**——guard（2.2）、progress 送出（3.1）、
   Canvas の二重表示防止（3.2）、承認ゲート・監査の Event Store 記録（3.1）。実装とテストが
   ある部品でも、呼び出し側に繋がっているかは別に確かめる必要がある。規則13 の
   「見えているものは、繋がっている」はバックエンドにも要る。
2. **規則2（エラー握りつぶし）の違反が frontend に同型で5箇所以上**。catch 無し・
   console.error のみ・ロールバック無し。「失敗したら toast＋状態巻き戻し」の共通の型を
   1つ作って寄せるのが早い。
3. **セキュリティ境界は骨格（Landlock fail-closed・可視性・代理サーバ）は仕様に忠実**だが、
   境界の「へり」（子プロセス env・/proc・ui-tool-call の可視性・パストラバーサル）が
   詰まっていない。§2.1 と §2.2 を先に塞ぐべき。
4. **共有ワークツリー＋固定ポートで、E2E 実行が別セッションと衝突する**。今回それで
   1回分の E2E 結果が無効になった。ポート/dataDir を実行ごとに割り当てるか、
   実行の相互排他（ロックファイル等）が要る。
5. ドキュメントの規律（specs 更新・notes 追記）自体はよく守られている。残っているのは
   「決定の消し込み漏れ」で、特に §10 の台帳と v4-frontend §6.2/6.3 の古い記述は
   セキュリティの説明が逆になるので早めに。

## 5. E2E の取り直し

（1回目は別セッションとのポート衝突で無効。ポート解放を待って取り直した結果をここに記す）

- 結果：（実行後に追記）
