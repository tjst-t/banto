# Browser：パスワードを保存しますか、の吹き出しと漏洩検出の警告を止める（2026-10-24）

## 困りごと

ログインフォームに入力すると、Chrome 本体が右上に「パスワードを保存しますか？」の吹き出し（[使用しない]/[利用しない]/[保存]）を出す。banto は Browser Module を `--kiosk` 形（タブの帯・アドレスバーの無い全画面の窓）で動かしているため、これを閉じる UI 上の手段が無く、人の画面に居座り続ける。

## 調べ方——ネイティブの UI は CDP では一切見えない

CDP の `Page.captureScreenshot` は renderer（ページの中身）だけを写し、Chrome 本体が描く吹き出し・ダイアログ（ブラウザ本体の別レイヤーの UI）には一切写らない。何度試しても、吹き出しが実際に画面に出ているときでもスクリーンショットには写らなかった。

実機で見るには X11 の全体キャプチャ（`import -window root`、ImageMagick）を使うしかない——これで初めて吹き出し・ダイアログの実際の見た目を確認できた。

## 直し方——企業向けポリシー

起動の引数（`--deny-permission-prompts` と同じやり方）では止められない。Chrome の企業向けポリシー機構（`/etc/opt/chrome/policies/managed/*.json`、**起動時にだけ読む**）を使う：

```json
{
  "PasswordManagerEnabled": false,
  "PasswordLeakDetectionEnabled": false
}
```

## 両方が要る（実測）

- `PasswordManagerEnabled: false` だけを置くと：保存の吹き出しは消えるが、**漏洩検出の警告（「パスワードを変更してください」の中央モーダル）は残る**。
- 両方を置くと：どちらも出なくなる。

実測環境：Google Chrome 155、`the-internet.herokuapp.com/login`（後に `test-page.ts` の `/login` を自前で用意）、2026-10-24。

## 範囲——Google Chrome（x64）でだけ確かめた

Playwright 同梱の Chromium（arm64 で使う `BROWSER_NAME = "chromium"`）がこの企業向けポリシー機構を持つかは未確認。`server.ts` は `BROWSER_NAME === "chrome"` のときだけ `ensurePasswordPolicy` を呼ぶ。

## 書く場所とタイミング

- ポリシーはコンテナの**共有の**ファイルシステム（`/etc` 以下）に書く——プロファイルごとではなく、Module を初めて起こすときに1回だけ（既存の `fonts.ts` の `ensureCjkFont` と同じ sudo のパターン。実の書き込みは `install.ts` の `installPasswordPolicy`）。
- `sudo` が無い実行場所（`BANTO_NO_SUDO=1`、別のサーバーでの実行など）では自動で書かず、手の入れ方（`sudo mkdir -p ... && ... | sudo tee ...`）を Module のログと `ctx.session.notice` に出す。

## 実装

- `packages/modules/browser/src/policy.ts`（新規）：`hasPasswordPolicy`・`ensurePasswordPolicy`（`audio.ts` の `ensureAudio` と同じ「差し替え可能な check」の形を採用——`fonts.ts` の `ensureCjkFont` より試験しやすい）。
- `packages/modules/browser/src/install.ts`：`Installer.installPasswordPolicy`、`sudoWriteFile` ヘルパー。
- `packages/modules/browser/src/server.ts`：`BROWSER_NAME === "chrome"` のときだけ `ensurePasswordPolicy` を呼び、既存の `fontNotice` と `policyNotice` を1本の `notice` にまとめる（既存の `ctx.session.notice` という単一文字列の API を変えないため）。
- `packages/modules/browser/src/test-page.ts`：`/login`・`/do-login`（本物の `<form method=post>` によるログインフォーム。`fill()` ではなく `keyboard.type`／`browserAct` の type で入力しないと Chrome のパスワードマネージャーが本物の入力と見なさない——実測）。

## 確かめたこと・確かめていないこと

- 単体試験（`pure.test.ts`）・既存の統合試験（`tools.integration.test.ts` 他、計75件）はすべて通過。dev-vm 上での実際の統合試験実行時に、本物の sudo 書き込みが成功したログも確認した。
- 漏洩検出の警告ダイアログは実機で再現・解消を確認した。**保存の吹き出し本体（[使用しない]/[利用しない]/[保存] のもの）は、この回では直接の再現・解消の確認はしていない**——`PasswordManagerEnabled: false` が Chrome の文書・挙動上この吹き出しを止める設定であることに基づく。
