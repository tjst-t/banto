// **パスワードの保存・漏洩の確認を出さない**（v4-modules.md §4.1「形」、決定・2026-10-24。
// docs/notes/2026-10-24-browser-password-policy.md に実測の記録）。
//
// kiosk 形（タブの帯・アドレスバーの無い全画面の窓、chrome.ts）では Chrome 本体が描くネイティブの UI（吹き出し・
// ダイアログ）を閉じる操作の手段が無く、人の画面に居座ったまま出続ける。CDP の Page.captureScreenshot にも一切
// 写らない（renderer の外、ブラウザ本体の別レイヤーの UI のため）——実機では X11 全体のキャプチャ（`import -window
// root`）でだけ見える。`--deny-permission-prompts`（chrome.ts）と同じ性質の困りごと。
//
// Chrome の企業向けポリシー（`/etc/opt/chrome/policies/managed/*.json`、起動時にだけ読む）に以下を置くと消える：
// - `PasswordManagerEnabled: false`——パスワードを保存しますか、の吹き出し
// - `PasswordLeakDetectionEnabled: false`——**前者だけでは消えない**漏洩検出の警告（「パスワードを変更してください」
//   の中央モーダル）にはこれも要る（実測・2026-10-24、the-internet.herokuapp.com/login、Chrome 155：
//   PasswordManagerEnabled だけではこの警告が残り、両方揃えると出なくなった）
//
// ポリシーはコンテナの**共有の**ファイルシステム（/etc 以下）に書く——プロファイルごとではなく、Module を初めて
// 起こすときに1回だけ（fonts.ts の ensureCjkFont と同じ sudo のパターン。実の書き込みは install.ts）。
// **Google Chrome（x64）でだけ確かめた**——Playwright 同梱の Chromium（arm64）がこの仕組みを持つかは未確認なので、
// server.ts は BROWSER_NAME が chrome のときだけ呼ぶ

import { readFileSync } from "node:fs";
import { dirname } from "node:path";

/** 書くポリシーの置き場（Google Chrome が起動時に読む） */
export const PASSWORD_POLICY_FILE = "/etc/opt/chrome/policies/managed/banto-password.json";

/** 書く内容（上の説明：保存の吹き出しと漏洩検出の警告の両方を止める） */
export const PASSWORD_POLICY_JSON = `${JSON.stringify({ PasswordManagerEnabled: false, PasswordLeakDetectionEnabled: false }, null, 2)}\n`;

/** もう書けていて内容もそろっているか（PASSWORD_POLICY_FILE を見る。内容を足したときに書き直させる） */
export function hasPasswordPolicy(): boolean {
  try {
    return readFileSync(PASSWORD_POLICY_FILE, "utf8") === PASSWORD_POLICY_JSON;
  } catch {
    return false;
  }
}

const MANUAL = `\`sudo mkdir -p ${dirname(PASSWORD_POLICY_FILE)} && printf '%s' '${PASSWORD_POLICY_JSON}' | sudo tee ${PASSWORD_POLICY_FILE}\``;

/**
 * ポリシーが無ければ書く。**無くてもブラウザは断らない**（吹き出し・警告が出るだけ）——代わりに理由と入れ方を返す
 * （呼ぶ側が Module のログと状態に出す）。sudo しない箱（別のサーバー——`BANTO_NO_SUDO=1`、v4-security.md §1「前提の
 * 確かめ」）では書こうとしない。check は試験の差し替え用（既定は本物の hasPasswordPolicy——audio.ts の ensureAudio と
 * 同じ形）
 */
export async function ensurePasswordPolicy(
  write: (onProgress?: (message: string) => void) => Promise<void>,
  onProgress?: (message: string) => void,
  check: () => boolean = hasPasswordPolicy,
): Promise<string | undefined> {
  if (check()) return undefined;
  if (process.env.BANTO_NO_SUDO === "1") {
    return `この実行場所では、パスワードを保存しますか、の吹き出しと漏洩検出の警告が消せません（banto はこの実行場所で sudo しないので、自動では書きません）。向こうで ${MANUAL} を打ってから、ブラウザを起こし直してください`;
  }
  try {
    await write(onProgress);
  } catch (err) {
    return `パスワードの企業向けポリシーを書けませんでした（${(err as Error).message}）。パスワードを保存しますか、の吹き出しと漏洩検出の警告が出ます。${MANUAL} を打ってから、ブラウザを起こし直してください`;
  }
  if (check()) return undefined;
  return `パスワードの企業向けポリシーを書きましたが、読み直しても内容が揃っていません。パスワードを保存しますか、の吹き出しと漏洩検出の警告が出るかもしれません`;
}
