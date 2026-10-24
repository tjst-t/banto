# クローズドソースで配る——検討の経緯（2026-10-21〜24）

仕様は `docs/specs/v4-distribution.md`。ここには経緯と実測を残す。

## 規約で読んだこと（2026-10-21）

- Agent SDK の概要（https://code.claude.com/docs/en/agent-sdk/overview）：
  「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their
  products, including agents built on the Claude Agent SDK.」。呼び名は「Claude Code」を名乗らない・似せない、「Powered by Claude」等は可
- Legal and compliance（https://code.claude.com/docs/en/legal-and-compliance）：開発者は Claude.ai のログインを自分のアプリで出すこと、
  利用者に代わって Free・Pro・Max の資格で通信を流すことをしてはいけない。Claude.ai の資格情報・セッションのトークンを集める・保存する・
  中継することもしてはいけない。一方、利用者が手を加えていない Claude Code の本体に自分のサブスクでログインすることは妨げない
- 報道・解説（AlternativeTo 2026-02、Autonomee、The New Stack）：自分のサブスクで自分が Agent SDK を使うことは今も認められている、
  という説明が多い。公式の文書そのものでは確かめていない

ユーザーの決定：案A（公開版は API キーだけ、サブスクは自分で組み立てた自分用の版だけ）。案B（配布元が出す鍵で開ける）・案C（本人の
宣言で開ける）は、どちらも「選んだ人にログインを出す」形で承認が要りそう、として採らなかった。

## 依存のライセンス（2026-10-21、node_modules を歩いて数えた）

MIT 765・Apache-2.0 104・ISC 39・BSD 23 ほか。配布を妨げる GPL は無し。注意するもの：`@img/sharp-libvips`（LGPL-3.0-or-later、
別ファイルのまま同梱）、`axe-core`・`lightningcss`（MPL-2.0、手を加えない）、`jszip`（MIT OR GPL-3.0、MIT を選ぶ）、
`@anthropic-ai/claude-agent-sdk`（Anthropic の規約の下）。

## GitHub Actions の使用量（2026-10-21、ユーザーのログインで API から集計）

- workflow は `prebuilt.yml` だけ（release への push ごとに組み立てと単体テスト）
- 記録がある 10/16〜10/21 の約6日で 82 回・539 分（job ごとに分へ切り上げ、1回約 6.6 分、33 回は失敗）。月に直して約 2,700 分
- 非公開のリポジトリの無料枠は Free で月 2,000 分・Pro で月 3,000 分（第三者のまとめ。公式では確かめていない。Windows の倍率は資料で食い違う）
- 公開版をタグのときだけ組み立てると、週1回で月 300 分ほどの見込み（実測していない）
- ユーザーの決定：組み立て済みは自分のランナーへ、GitHub のランナーはタグの公開版だけ

## 署名の置き場（2026-10-21〜24）

- 最初の下書きは environment `distribute`（人の承認つき）に鍵を置く形だった
- レビュー（サブエージェント、2026-10-22）：GitHub の文書では Free・Pro・Team の非公開のリポジトリで environment の required reviewers も
  environment の secret も使えない。非公開にすると守りが無くなる
- 出した案：手元で毎回署名（ユーザーが却下——毎回は無い）、banto の画面の「配る」ボタンで host の Vault の鍵で署名、署名だけ公開側の
  banto-releases の environment で行う、repository secret で Actions が署名
- ユーザーの決定（2026-10-24）：repository secret に置いて Actions で署名。AI・Factory が push した workflow から鍵を使える弱さは承知
  （このソフトに何かあっても致命的ではない）

## レビューで直したこと（2026-10-22 のレビュー、2026-10-24 に反映）

- 組み立ては tsc で `.map`・`.d.ts` を出していた——公開版には束ねる段を新しく作る
- 中継は `x-api-key` を外し、合言葉を Bearer からだけ読む——合言葉は `ANTHROPIC_AUTH_TOKEN` で渡す
- 抜くものの漏れ：install.sh のその場のログイン、Subagent の `envSecrets` の `CLAUDE_CODE_OAUTH_TOKEN`、キャッシュの温め直し、429 で
  アカウントを替える送り直し、画面の文言
- 文字列の確かめは banto 自身の出力に絞る（同梱の Anthropic の本体は持っている）
- 合言葉が無ければ起こさない（CLI が手元のログインを読むため）
- updater は git に立っている——公開版の版の見分け方を決めた。新しい版だけ入れる・鍵の入れ替え・止められたことに気づく
- install.sh は公開サイトから直に配る（配布用リポジトリに書く鍵で書き換えられないように）
- 自分用の版は鍵つきの API の asset の口で取る、トークンの期限を知らせる
- 順番：自分のランナーは非公開の後、今の利用者への案内、自分用の版の入れ方の入口、Cloudflare Pages の確かめ
- arm64 は最初の段で作らない

## 2026-10-24 API キーのアカウントを作った（Backlog #515）

- **合言葉の変数はアカウントの種類で分けた。** 仕様 §3 の `ANTHROPIC_AUTH_TOKEN` は API キーのときだけにし、サブスクは今の
  `CLAUDE_CODE_OAUTH_TOKEN` のまま。却下：どの種類でも `ANTHROPIC_AUTH_TOKEN` にする案——CLI はサブスクの資格のときに契約の
  種類から既定のモデル・文脈の上限を決めている（`relay.ts` の `HostClaudeAccount` の実測）ので、自分用の版のサブスクの動きが
  変わる。並びに両方があり起こしたあとに中継が種類をまたいで移すときは、中継が `anthropic-beta` を揃えて通す
- **キーの置き場は Vault の「banto が置いたもの」の種別（`putSecret`）。** 窓口の `createAlias`（人が預けた秘密）だと、Module の
  起動の差し込み（`refuseBantoLogin`）で断られず、Project の Module の環境に入れられる道が残る。消すのは金庫が人の管理面に
  しか許さないので、人のセッションの「外す」から core が金庫に直に人の印で頼む
- **キーは要求のたびに Vault から引く**（写しを持たない、規則3）。Vault の往復が要求ごとに増える。遅さが問題になったら測ってから
  短い間覚えることを考える
- 金額の目安の値段は claude-api の参照（2026-06-24 の表）から。出どころと更新の仕方は §10 のまま未決
