# v4 配布——ソースを閉じ、組み立てた物だけを配る（下書き）

> **これは仕様の下書きである。** レビュー前。決まったことだけを書き、決まったらこの文書を更新する。
> 検討の経緯は Fork「クローズドソースでの配布」（2026-10-21）。
>
> 関係する仕様：アーキ仕様 §2.5「画面から banto を更新する」「組み立て済みのものを使う」、セキュリティ仕様 §1「入れ方」・
> §2「banto 本体の Claude ログインは、中継で共有する」「Claude のアカウントを複数持つ」、デスクトップ版の下書き
> `v4-desktop.md`（ブランチ fork/desktop-windows）§5「自己更新」・§7「組み立てと配布」。

## 0. 何を作るか

### ユーザーが決めたこと（2026-10-21）

- **ソースは非公開にする。** 今の公開リポジトリ `tjst-t/banto` を非公開にする。公開サイト banto.tjst-t.dev は残す
- **組み立てた物だけを、一般に無償で配る。** サーバ版とデスクトップ版の両方
- **配る版の Claude は API キーだけ。** サブスク（Claude の Free・Pro・Max のログイン）は配る版に入れない。サブスクで動くのは、
  本人（ソースを持つ人）が自分で組み立てた自分用の版だけ（案A）
- **置き場は公開の配布用リポジトリ `tjst-t/banto-releases` の GitHub Releases。** 利用規約・第三者のライセンス・Issue の窓口もそこ
- **公開版の版はタグで付け、タグを付けたものだけを Release として配る**
- **CI**：release への push ごとの組み立て済み（prebuilt）は banto-dev-vm に置く自分のランナーで回す。GitHub のランナーは
  タグを付けたときの配る版の組み立てだけに使う（非公開のリポジトリの無料枠に収めるため。見積もりは §8）

### なぜ配る版からサブスクを抜くか（規約で確かめたこと、2026-10-21 に読んだ公式の文書）

- Agent SDK の概要：「Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products, including agents built on the Claude Agent SDK.」
- Legal and compliance：開発者は Claude.ai のログインを自分のアプリで出すこと、利用者に代わって Free・Pro・Max の資格で
  通信を流すこと、Claude.ai の資格情報・セッションのトークンを集める・保存する・中継することをしてはいけない
- 同じ文書は、利用者が**手を加えていない Claude Code の本体に自分のサブスクでログインすること**は妨げないとも書く
- 呼び名：「Claude Code」を名乗らない・似せない。「Powered by Claude」等は使える

ここから、配る版は **設定のスイッチで切るのではなく、組み立てでコードごと抜く**（§2）。スイッチなら書き換えれば開き、
「ログインを出している」ことになる。規約の解釈はここに書いた範囲までで、法的な判断はしていない。

### 作らないもの（最初の段）

- 有償の版・ライセンスの鍵
- 難読化（縮めるだけ。§3「ソースの守り」）
- macOS 版・Linux のデスクトップ版
- Windows のコード署名の証明書（お金。デスクトップ版の段2で別に決める）

## 1. 全体の形

| | 自分用の版（self） | 配る版（dist） |
|---|---|---|
| 誰が使う | ソースを持つ本人 | 一般の利用者 |
| ソース | 非公開の `tjst-t/banto` | 持たない |
| Claude | サブスク（今の台帳・中継）と API キー | API キーだけ |
| 版の名前 | release の commit | タグ（`v2026.10.22` の形、§4） |
| 入れ方・更新 | 今の install.sh・update.mjs（取ってくる先が非公開のリポジトリになる） | 署名つきの目録を見て、組み立てた物を落とす（§5・§6） |
| 組み立て済み | 自分のランナーの prebuilt（§7） | GitHub のランナーがタグで組み立てる（§7） |

- 開発の流れ（main・release・毎晩の自動修正・Factory・番頭）は非公開のリポジトリの中でそのまま回る
- **release に入る＝本人の host に入る、タグを付ける＝一般に配る**。タグを付けるのは人（外への公開。番頭の決まりでも人へ回すもの）

## 2. 版を分ける——組み立てで抜く

- 組み立ての印 `BANTO_EDITION`（`self` | `dist`）。esbuild の `define` で定数にし、`dist` の分岐は消える（dead code）
- **dist で抜くもの**：
  - サブスクのログイン（`claude-login/account-login.ts` の口と、設定の画面の「アカウントを足す」）
  - トークンの取り直し（`refresh.ts`）と置き場（`.credentials.json`）を読むこと
  - 使用量の 5時間・週の枠の表示と、枠で選ぶ・切り替える仕組み（`select.ts` の閾値）
  - Subagent・Terminal・Service がコンテナに `CLAUDE_CODE_OAUTH_TOKEN` を渡す道（中継の合言葉は API キーの中継に替える、§3）
- 抜けたことの確かめ：dist の組み立ての最後に、束ねた物に決めた文字列（`claudeAiOauth`・`/v1/oauth/token`・
  `CLAUDE_CODE_OAUTH_TOKEN` 等）が無いことを調べ、あれば落とす
- 利用者がターミナル（Terminal・Shell）で自分で `claude` にログインすることは止めない（手を加えていない本体へのログインは規約が妨げない）。
  banto がそのログインを読んで使うことはしない

## 3. 配る版の Claude——API キー

- **API キーのアカウント**：Claude のアカウントの台帳に種類 `api-key` を足す。キーは Vault に置き、台帳には alias だけ
  （キーは台帳にも Event Store にも書かない）。self でも使える（サブスクと並べて持てる）
- **中継はそのまま使う**：会話の本体（Runner）とコンテナは今どおり合言葉で中継に投げ、中継が上流に出すときに
  `x-api-key` を差し込む（`Authorization` は外す）。**キーはコンテナに入らない**
- **使用量**：API キーには 5時間・週の枠が無い。メーターは使ったトークン（入力・出力・キャッシュ）と金額の目安を出す。
  閾値で切り替える仕組みは使わない（dist では §2 で抜く）。上限は人が月の目安を設定でき、越えたら知らせる（止めはしない）
- 初めて起こしたとき、API キーが無ければ画面がキーを入れるところへ導く（Claude Console の場所へのリンクつき）

## 4. 版とタグ

- タグは `v<年>.<月>.<日>`（同じ日の2つ目からは `.<n>`、例 `v2026.10.22.1`）。release ブランチの commit にだけ付ける
- タグは非公開のリポジトリに付け、そこから GitHub のランナーが組み立てる（§7）。配布用リポジトリには同じ名前の Release を作る
- 画面と `GET /api/admin/update` の「今の版」：dist はタグ、self は今どおり commit

## 5. 配る物と目録

配布用リポジトリ `tjst-t/banto-releases`：

- `README.md`（入れ方・公開サイトへのリンク）・`EULA.md`（利用規約：無償、再配布・逆コンパイルの禁止、無保証）・`SECURITY.md`
- Issue の窓口（テンプレートつき）
- Release `v…` ごとに：
  - `banto-<版>-linux-x64.tar.zst`・`banto-<版>-linux-arm64.tar.zst`（サーバ版）
  - `banto-<版>-win-x64.zip`（デスクトップ版。段はデスクトップ版の仕様に従う）
  - `THIRD_PARTY_NOTICES.txt`（組み立てで依存から作る。LGPL の libvips は別ファイルのまま同梱、MPL は手を加えない）
  - `manifest.json` と `manifest.json.sig`
- **目録 `manifest.json`**：`{ version, publishedAt, minUpdaterVersion, assets: [{ name, platform, size, sha256 }] }`。
  ed25519 で署名し、**公開鍵は install.sh とアプリに埋め込む**。秘密鍵は非公開のリポジトリの Actions の environment
  `distribute`（人の承認つき）の secret
- 最新は GitHub の `releases/latest` から引く（別の latest.json を置かない）

## 6. 入れ方と更新（配る版）

### サーバ版

- 入れ方：`curl -fsSL https://banto.tjst-t.dev/install.sh | bash -s -- …`（公開サイトの `_redirects` の行き先を配布用リポジトリに
  替える。`runtime-setup.sh` も同じ）。install.sh は目録を取り、署名と sha256 を確かめ、tar を `versions/<版>` に展開する。
  git・npm の組み立ては要らない（Node は今どおり版を固定して入れる）
- 更新：update.mjs の段のうち「取ってくる・組み立てる」を「目録を見る・落とす・確かめる・展開する」に替える。待つ・起こし直す・
  確かめる・戻す（`previous`）は今のまま。今の組み立て済みを取ってくる処理（`prebuilt.mjs`）の展開と確かめを使い回す
- 画面の「更新」：新しい版があれば版の名前と Release の説明を出す。`minUpdaterVersion` より古い updater なら、install.sh の
  打ち直しを案内する

### デスクトップ版

- 同じ目録を、起きたときと1日1回見る。zip を落として署名と sha256 を確かめ、今のフォルダの隣に展開して「更新して再起動」で入れ替える
  （`v4-desktop.md` §7 の案。今のフォルダに書けないときの扱いはそちらの未決のまま）

## 7. 組み立て（CI）

| workflow | きっかけ | ランナー | すること |
|---|---|---|---|
| `prebuilt.yml`（今のもの） | release への push | **banto-dev-vm の自分のランナー**（`runs-on: [self-hosted, banto-prebuilt]`） | self の組み立て済みを作り、非公開のリポジトリの Release `build-<頭12>` に置く（今どおり） |
| `distribute.yml`（新しい） | `v*` のタグの push | GitHub のランナー（ubuntu x64・ubuntu arm64・windows） | dist を組み立て、単体テスト、§2 の抜けたことの確かめ、THIRD_PARTY_NOTICES、目録の署名、配布用リポジトリに Release を作る |

- 自分のランナー：banto-dev-vm に専用のユーザーで置き、ラベル `banto-prebuilt` だけを受ける。リポジトリは非公開なので、外の人の PR で
  動くことはない。ほかの workflow は自分のランナーを使わない
- 配布用リポジトリへ書く鍵：`banto-releases` の Contents の書き込みだけを持つ fine-grained トークンを、environment `distribute` の secret に置く
- 署名の秘密鍵と書く鍵は environment `distribute` に置き、**人の承認（required reviewers）を通った回だけ**使える
- **self の更新が組み立て済みを取ってくる道**：今の `prebuilt.mjs` は鍵なしで GitHub の API と Release を読む。非公開になると読めないので、
  host は読むだけの fine-grained トークン（`tjst-t/banto` の Contents・Actions の読み取り）を `/etc/banto` に置いて使う（install.sh が聞く）。
  git の fetch は読むだけの deploy key（SSH）

## 8. 使用量の見積もり（2026-10-21）

- 今の workflow は `prebuilt.yml` だけ。10/16〜10/21 の約6日で 82 回・539 分（job ごとに分へ切り上げ）、月に直して約 2,700 分
- 非公開のリポジトリの無料枠は Free で月 2,000 分・Pro で月 3,000 分（第三者のまとめ。公式の文書では確かめていない）
- prebuilt を自分のランナーに移せば、GitHub のランナーはタグのときだけ。1回 60〜80 分（Windows を2倍で数えたとき）の見込みで、週1回なら月 300 分ほど

## 9. 非公開に切り替える順番

1. **API キーと版の分け**（§2・§3）を main で作り、release に入れる。本人の host は self のまま動く
2. **配る版の組み立てと配り方**（§4〜§7）。配布用リポジトリを作り、タグで試しの版（pre-release）を出し、新しい VM に入れて API キーで会話できる・
   次の版に更新できる・戻せることを確かめる
3. **自分のランナー**を banto-dev-vm に置き、`prebuilt.yml` を移す
4. **本人の host を非公開のリポジトリから取る形にする**（deploy key と読むだけのトークン）。ここまでは公開のまま
5. **外に見えるものを替える**：公開サイトの GitHub へのリンク（ヘッダ・「このページを編集」・トップのリンク）を配布用リポジトリへ、
   `_redirects` の install.sh・runtime-setup.sh を配布用リポジトリへ、README を配布用リポジトリへ移す。サイトの「Claude Code」の表記を呼び名の決まりで見直す
6. **リポジトリを非公開にする**（人がする。取り消せるが、それまでの clone は残る）

## 10. まだ決まっていないこと

- API キーの使用量の上限と知らせ方の細部（月の目安・越えたときの出し方）
- EULA の文面（法的な確かめは人）
- 配布用リポジトリの Issue に、利用者がログを貼るときの秘密の扱いの案内
- self で API キーとサブスクを並べたとき、どちらを先に使うか
