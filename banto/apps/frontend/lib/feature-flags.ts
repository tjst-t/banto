// 「実banto hostの実データに繋がっているか」だけを基準にする——
// Phase 0/1/2.5等の区分とは無関係（CLAUDE.md規則13、決定・2026-09-04）。
// 入口（ボタン・メニュー項目・マウント箇所）だけで分岐する。実装本体は
// 消さない・コメントアウトもしない——繋いだら値をtrueに戻すだけで復活する。
export const CONNECTED_FEATURES = {
  inbox: false, // 受信箱：常に空、listRealInboxが未配線（Stage 4で配線）
  notifications: false, // showBrowserNotificationの呼び出し元が無い（Stage 4）
  contextUsage: true, // Stage 2で実usage.recordedに接続済み
  memory: true, // Stage 3でHTTP経路・remember_decision tool・一覧UIを接続済み
  compaction: false, // Compactマーカーはローカルstateのみ、host側に残らない
  threadCloseReopen: true, // Stage 1で実API接続済み
  projectCloseReopen: true, // Stage 1で実API接続済み
  settings: false, // instance設定（/settings）：Module/Vault/Role/Credential/Runtime既定、mock/settings.ts丸ごと
  // Project設定の入口（gearアイコン）。中の各セクションはproject-settings-content.tsx側で
  // さらに個別に絞る——project-danger（Project終了、Stage 1で実API接続済み）とproject-memory
  // （Stage 3）だけ見せ、まだ実装が無いproject-modules/overrides/securityはnavから外す
  // （決定・2026-09-04、instance設定と同じ`settings`フラグに相乗りしていたため
  // Project終了がgearアイコンの奥に隠れて到達不能になっていた不具合の修正）。
  projectSettings: true,
  canvas: false, // 各ModuleのCanvas（file-explorer/shell-terminal/vault-manage等）は固定データ
  paletteLaunchers: false, // Command Paletteの「Moduleの入口」グループ
  composerModelEffort: false, // 選んでもreal threadには反映されない（streamRealTurnにmodel/effort引数が無い）
} as const;
