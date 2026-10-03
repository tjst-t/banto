// 「実banto hostの実データに繋がっているか」だけを基準にする——
// Phase 0/1/2.5等の区分とは無関係（CLAUDE.md規則13、決定・2026-09-04）。
// 入口（ボタン・メニュー項目・マウント箇所）だけで分岐する。実装本体は
// 消さない・コメントアウトもしない——繋いだら値をtrueに戻すだけで復活する。
export const CONNECTED_FEATURES = {
  // 受信箱（§2.4）。Stage 4で実host接続（決定・2026-09-05）。**判断待ちだけ**
  // ——レビュー待ちは生成元がまだ無いので出さない（規則13）
  inbox: true,
  notifications: false, // showBrowserNotificationの呼び出し元が無い（Stage 4）
  contextUsage: true, // Stage 2で実usage.recordedに接続済み
  memory: true, // Stage 3でHTTP経路・remember_decision tool・一覧UIを接続済み
  compaction: false, // Compactマーカーはローカルstateのみ、host側に残らない
  threadCloseReopen: true, // Stage 1で実API接続済み
  projectCloseReopen: true, // Stage 1で実API接続済み
  // **この Project で使う Module を選ぶ**（`phase1-project-modules-ui`、2026-09-11）。
  // host の宣言（instance 既定＋Project 差分）に繋がっている——Phase 2 の入口
  projectModules: true,
  settings: false, // instance設定（/settings）：Vault/Credential/Runtime既定、mock/settings.ts丸ごと
  // **banto 全体の Module**（`instance-modules`、2026-09-15、§10 item 14 (a)）。
  // 宣言を足す・止める・消す口が host に繋がった——**この1節だけ**を出す
  // （同じ画面の他の節はまだモックのままなので、nav から外したまま・規則13）
  instanceModules: true,
  // Global Memory（§2.2、決定・2026-09-05）。/settings の中で**これだけ**が
  // 実bantoホストに繋がっている——projectSettingsで入口を分離したのと同じ手で、
  // 繋がっているセクションだけ見せ、mockのままの他セクションはnavから外す（規則13）
  globalMemory: true,
  // Project設定の入口（gearアイコン）。中の各セクションはproject-settings-content.tsx側で
  // さらに個別に絞る——project-danger（Project終了、Stage 1で実API接続済み）とproject-memory
  // （Stage 3）だけ見せ、まだ実装が無いproject-modules/overrides/securityはnavから外す
  // （決定・2026-09-04、instance設定と同じ`settings`フラグに相乗りしていたため
  // Project終了がgearアイコンの奥に隠れて到達不能になっていた不具合の修正）。
  projectSettings: true,
  // **この2つが指しているのは「モックの面を出すか」**（訂正・2026-09-10）。
  // 実 Module の Canvas は4形態とも本実装で動いている（inline・fullscreen・
  // 設定画面・ランチャー、2026-09-06〜07）——実の入口は旗に関係なく出る
  // （`project-panels.tsx` の `onOpenCanvas`、`palette.ts` の `getRealLaunchers`）。
  // ここに残っているのは**モックの固定データの面**で、それは繋がっていないので
  // false のまま（規則13）。名前が「Canvas 全体」を指すように読めて実態と
  // ずれていたので、名前を「モックの〜」に直した（規則3——旗の意味を1つに）
  mockCanvasSurfaces: false,
  mockPaletteLaunchers: false,
  // **やり直し（分岐）**——Edit・Reload・BranchPicker。実測（2026-09-10）：
  // 実 Thread で Edit すると画面は分岐に見える（古い枝が隠れ、1/2 が出る）が、
  // host には**直列に追記**されるだけで、リロードすると分岐は消えて4件が
  // 並ぶ。人は「前の失敗した指示は無かったことになった」と思うのに、それは
  // 次のターンの文脈に残る——見えているものが繋がっていない（規則13）。
  // 本物の分岐は host 側（会話の切り詰めと resume-point の巻き戻し）が要る
  threadBranching: false,
  // **モデルと reasoning effort を入力欄の下で選ぶ**（決定・2026-09-23、ユーザー要望）。
  // 選んだ値は host が Thread ごとに持ち、次のターンから効く。一覧は host が CLI に聞いたもの
  composerModelEffort: true,
  // **入力欄に画像を添える**（決定・2026-09-26、ユーザー要望）——貼り付け・＋ボタン・ドラッグ。
  // host が中身を置き場に置き、AI に画像として渡し、記録から描き直せる（リロードしても残る）
  composerImages: true,
  // **MCP Registry から入れて、繋ぐ**（`module-registry-install`、2026-09-21、
  // ユーザー要望）。検索・一覧・並び順（提供元を優先）・取得・接続まで host に
  // 繋がっている——remote はそのまま繋ぎ、npm は host が取ってきて（閉じ込めの外）
  // **読み取り専用**で渡して起動する（`npx -y` は閉じ込めの下で自分を
  // 取ってこられない。`$HOME/.npm` が書けないことを実測した・2026-09-21）
  moduleRegistryInstall: true,
  // **どの Skill を効かせるか**（決定・2026-09-23、アーキ仕様 §5.7）。banto 全体の既定と
  // Project ごとの上書きが host の設定層に繋がっていて、会話の始まりに `instructions`
  // として AI に届く
  skills: true,
  // **Shell 専用のホームに写すもの**（決定・2026-09-23、ユーザー）。host が写し、立っている
  // Shell にも写し直す
  shellHome: true,
  // **コンテナの資源の上限**（決定・2026-10-02、ユーザー）。banto 全体は「この機械に残す分」、Project ごとは
  // それより下げる値。host が計算し、動いているコンテナにも効かせる
  containerLimits: true,
  // **人のログイン**（決定・2026-10-03、v4-security.md「人のログイン」）。パスキー・端末を追加・ログイン中の端末が
  // host の `/api/auth/*` に繋がっている
  login: true,
} as const;

/** instance設定（/settings）への入口を出すか。中身が1つでも繋がっていれば出す
 *  ——この判断を各所に書き写さない（規則3）。 */
export const SHOW_INSTANCE_SETTINGS =
  CONNECTED_FEATURES.settings || CONNECTED_FEATURES.globalMemory || CONNECTED_FEATURES.instanceModules;
