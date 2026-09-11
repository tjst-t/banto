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
  settings: false, // instance設定（/settings）：Module/Vault/Role/Credential/Runtime既定、mock/settings.ts丸ごと
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
  composerModelEffort: false, // 選んでもreal threadには反映されない（streamRealTurnにmodel/effort引数が無い）
} as const;

/** instance設定（/settings）への入口を出すか。中身が1つでも繋がっていれば出す
 *  ——この判断を各所に書き写さない（規則3）。 */
export const SHOW_INSTANCE_SETTINGS = CONNECTED_FEATURES.settings || CONNECTED_FEATURES.globalMemory;
