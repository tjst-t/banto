# Repositories Module の段階2——GitHub のアカウント（2026-10-02）

仕様は `docs/specs/v4-modules.md` §2.4「アカウント」。段階1は `docs/notes/2026-10-01-repositories-stage1.md`。
ここは**なぜそうしたか・却下した案・確かめたこと**の記録。

## 段階2の範囲

- 設定の面（banto 全体の設定の Repositories）に「GitHub のアカウント」：登録・一覧・確かめる・外す
- API の資格情報は2通り：PAT（貼る→Vault に預ける／Vault の alias を選ぶ）と、ブラウザでログイン（GitHub App の
  デバイスフロー）。GitHub App の client ID は同じ面で人が入れる
- ログインのトークンの自動更新（使う直前・1本ずつ）と、更新に失敗したときの知らせ（受信箱）
- 台帳の「扱うアカウント」（origin の持ち主と login が一致したら覚える）と、一覧・Import の判断への表示
- 段階3以降のための内部の関数 `GithubAccounts.tokenFor(login, callId)`（AI 向けの道具は作らない）
- core：中継に `relayRaiseNotice`、Repositories の宣言に Vault への依存と `handlesSecrets`

## 決めたこと（仕様に書いたもの）とその理由・却下した案

### 名前は打たせない——`GET /user` の login が名前

モック（`settings/github-accounts-section.tsx`）は「名前（GitHub のユーザー名か Organization）」を打たせていた。
打たせると、打った名前と資格情報の持ち主が食い違える（`tjst-t` と打って別の人の PAT を貼る）。どのみち `GET /user` で
確かめるので、確かめた login を名前にした。**確かめられない資格情報は Vault に預けない**（通らない PAT が金庫に残らない）。

却下：別に「呼び名」を持たせる——一覧で区別するのは login で足り、項目を増やすだけ。

**残る穴**：fine-grained PAT は持ち主（resource owner）を Organization にできるが、`GET /user` が返すのは作った人。
台帳との突き合わせは login だけなので、Organization のリポジトリは「読むだけ」のまま（§2.4 の未決に書いた）。

### デバイスフローの待ちは、画面からの呼び出しの中で

最初に考えたのは「始めたら Module が背景で GitHub に聞き続け、許可されたら Vault に置く」。**却下**——背景の
呼び出しは人の画面の外なので、中継（`relayCallTool` → Vault の `putSecret`）が人の承認を求める。聞く会話も無い
（banto 全体の設定画面は Thread を持たない）。

採ったのは「画面が `poll_github_login` を呼び続け、Module は interval より早くは GitHub に聞かない（早く呼ばれたら
その時刻まで待ってから1回聞く）」。こうすると Vault への書き込みは人の画面からの呼び出しの中で起き、同梱どうしの
人の操作としてゲートを通らない（既存の規則のまま）。間隔を守るのは Module なので、画面の書き方で GitHub に
叩きすぎることもない。`device_code` は Module のメモリにだけ置き、画面には user_code と開く URL だけを返す。

### トークンの置き方——MCP の OAuth と同じ

core の OAuth（`core/src/oauth/provider.ts`）は「1つの Module につき1つの alias（`oauth-<名前>`、種別 `oauth-token`）に
JSON でまとめる」。同じ形にした：`oauth-github-<login>` に `{format, accessToken, expiresAt, refreshToken,
refreshTokenExpiresAt}`。人が Vault の一覧で「何にログインしているか」が見え、消せばログアウト。

- **更新したトークンは元の置き場へ直接置く**（金庫本体の `putSecret` を `group` つきで）。窓口の `putSecret` は既定の
  Vault・既定の置き場にしか置かないので、既定が変わったあとに更新すると2つ目ができ、古い refresh token が残る
- **client ID もアカウントに覚える**——GitHub は、そのトークンを出した App の client ID でしか更新を受けない。
  client ID は秘密ではないのでアカウントの記録に書いた
- デバイスフローで得たトークンは **client secret 無しで更新できる**（GitHub の文書「Refreshing user access tokens」の
  `client_secret`：「Required unless the user access token was generated using the device flow」）。だから banto は
  秘密を1つも持たずに済む

### 更新は1本ずつ・失敗は受信箱へ

GitHub の refresh token は1回使うと無効になる。2本が同時に同じ鍵で更新すると片方が `bad_refresh_token` で負け、
置き換えの順によっては**使えない組が Vault に残る**。同じアカウントの仕事（更新・もう一度ログインの置き換え・外す）
を login ごとの列で1本ずつ走らせる。Repositories は banto に1本なので、プロセスの中の列で足りる。

更新に失敗したら：アカウントに `refreshFailure`（時刻と理由）を残し（画面の行に出す。次に通るか、もう一度ログイン
すれば消える）、受信箱に1件。**受信箱に Module が知らせる口が無かった**ので、中継に `relayRaiseNotice` を足した
（`docs/specs/v4-security.md` §3 の表）——出せるのは banto 本体で動く同梱の banto 全体の Module だけ。鍵は
`module:<Module>:github-refresh:<login>`（`inbox.raiseNotice` が開いている同じ鍵を積まない）。

却下：
- 背景で定期的に更新する——refresh token は6か月もつので、使う直前の更新で足りる。背景の更新は上と同じく
  人の画面の外の Vault 書き込みになる
- 受信箱の代わりに画面だけで言う——「更新に失敗した」は人が設定画面を開いていないときにも起きる（段階3の clone 等）

**更新が通ったのに Vault に置けなかった**とき：GitHub は前の鍵をもう無効にしているので、Vault に残るのは使えない組。
新しい組をメモリに持って次で置き直す案もあったが、写しを持つことになる（規則3）。理由をそのまま言い（「もう一度
ログインしてください」）、受信箱にも出す。

### 台帳の「扱うアカウント」

段階1で「書かれない項目を先に置かない」として外した項目を足した。書くのは「覚えていなくて、origin の持ち主と
登録 login が一致したとき」（Import・一覧）。**覚えるのは login**（アカウントの内部の id ではない）——登録を外して
入れ直しても、同じ login ならまた繋がる。外しても台帳からは消さない（どのアカウントで扱っていたかの記録）。

段階2だけを見ると「一致から導ける値を写している」ように見える。それでも書くのは、§2.4 が「どのリポジトリに
どのアカウントを使ったかは台帳が覚える」と決めていて、段階3（clone・公開で選んだアカウント）では導けない値に
なるため。origin が別の持ち主に変わっても書き換えない。

### 外す

ブラウザでログインしたものは Vault のログイン情報も消す（banto が置いた秘密）。PAT は消さない——人が預けた秘密で、
ほかでも使っているかもしれない（画面で「PAT は Vault に残ります」と言う）。先に Vault の画面で消してあっても
止まらないよう、消す前に目録で在るかを見る（無いものの削除を Vault は断る）。

### Repositories の宣言

`dependsOn` に `vault-directory`・`vault` を `required: false` で（台帳だけなら Vault 無しで動く）。人が貼った PAT が
この Module を通るので `handlesSecrets: true`（要件 C8c、subagent-settings と同じ）。

### GitHub に繋ぐ口は1枚・行き先だけ差し替える

`src/github.ts` が GitHub を知る唯一の場所。行き先（`https://github.com`・`https://api.github.com`）だけを替えられ、
E2E は env（`BANTO_REPOSITORIES_GITHUB_URL`・`BANTO_REPOSITORIES_GITHUB_API_URL`。skills の
`BANTO_SKILLS_GITHUB_API_URL` と同じ形、片方だけは起動で断る）で偽物に向ける。偽の GitHub は
`src/test-fakes.ts` の1つを単体試験と E2E（`e2e/github-login-fixture.ts` が読み込む）で共有した——同じ偽物を
2つ書かない。

## 人がやる準備：GitHub App（まだ無い。本物の GitHub では動かしていない）

1. GitHub の Settings → Developer settings → GitHub Apps → **New GitHub App**
   - GitHub App name：任意（例 `banto-<自分の名前>`）。Homepage URL：任意（banto の URL でも GitHub のプロフィールでも）
   - Callback URL：空でよい。「Request user authorization (OAuth) during installation」：外す
   - **「Enable Device Flow」に印**
   - 「Expire user authorization tokens」：**入れたまま**（8時間で切れ、banto が更新する。外すと無期限のトークンになる
     ——banto はそれも読めるが、GitHub App にした理由の半分が消える）
   - Webhook：**Active を外す**（banto は受けない）
   - Where can this GitHub App be installed：Only on this account（自分だけで使うなら）
2. **権限の案**（Repository permissions。§2.4 の未決——本物で確かめてから決める）
   - Metadata：Read-only（必須）
   - Contents：Read and write（HTTPS の clone・push、段階3）
   - Administration：Read and write（「GitHub に公開」でリポジトリを作る、段階4）
   - Workflows：Read and write（`.github/workflows` を含むものを push するなら。無いと push が断られる）
   - Pull requests・Issues：要らない（AI は Shell の `gh` で、渡したトークンの範囲でやる——使わせるなら Read and write）
   - Account permissions：要らない（`GET /user` は権限なしで引ける）
3. 作った App の設定ページの **Client ID**（`Iv` で始まる。App ID の数字ではない）を写す
4. App を**自分のアカウントに Install**（使う Organization にも）。新しく作るリポジトリにも届くよう、Repository access
   は **All repositories** を勧める（GitHub App のトークンは、App を入れたリポジトリにしか届かない）
5. banto 全体の設定 → Repositories → 「ブラウザでログインに使う GitHub App の client ID」に貼って保存 →
   「アカウントを登録」→「ブラウザでログイン」→ 出たコードを github.com/login/device に入れて許可

## 確かめたこと

- 単体（Module 39本、うち段階2で足したもの20本）：
  - `github.test.ts`（4）：偽の GitHub に HTTP で——デバイスコード・`authorization_pending`・`slow_down`・
    `expired_token`・`access_denied`・許可・`device_flow_disabled`・client ID 違い・401・`bad_refresh_token`・更新は
    client secret を送らない・期限を切っていない App
  - `accounts.test.ts`（13）：PAT（確かめてから預ける・通らなければ預けない・既存の alias を写さない・SSH 鍵の種別）・
    デバイスフロー（interval を守る・slow_down で延ばす・期限・断り・device_code を返さない）・もう一度ログイン・
    期限が近いときだけ更新・**同時3本で更新1回**・失敗で記録と受信箱・受信箱／Vault の失敗も言う・外す・確かめる・
    **元の置き場に戻す**。全部の試験で**返り値・台帳の置き場の全ファイル・console に秘密が出ない**ことを照らす
  - `repositories.test.ts`（+2）：扱うアカウントの突き合わせ・覚えたまま・設定の項目ごとの書き換え・壊れたアカウントの
    一覧を空と読まない
  - `server.test.ts`（+1）：画面の口から PAT・ログイン・一覧・確かめる・外す。返す値に秘密が無い・Vault に呼び出しの
    印を渡す・AI のターンからは呼べない
- core：`relayRaiseNotice` の試験1本（出せる相手・空・長すぎ）。core 全体 364 本、宣言・自己申告の突き合わせも通る
- **壊して落ちることを確かめた**：直列化を外す・interval を待たない・slow_down で延ばさない・受信箱に出さない・
  トークンを返り値に混ぜる・期限を見ずに毎回更新・**更新で元の置き場を使わない**（最初は落ちなかった——偽の Vault の
  既定と元の置き場が同じだった。置き場が既定と違う試験を足して落ちるようにした）・Vault に印を渡さない・
  突き合わせをやめる・設定を丸ごと書く・PAT を確かめない・失敗の印を消さない（以上 Module）、`mayRaiseNotice` の
  同梱の条件を外す（core）、**cli の `raiseNotice` を何もしないようにする**（E2E が「更新の失敗が受信箱に出ていない」で落ちる）
- E2E（`e2e/specs/repositories.spec.ts` の3本目）：別のデータディレクトリの core・本物の Vault（vault-local）・中継・
  受信箱・偽の GitHub。PAT の失敗と登録、Import の判断に「〜で扱います」、一覧のアカウント列、client ID の断りと保存、
  ブラウザでログイン（コード・開く先は `ui/open-link` で別タブ・許可で登録）、確かめる（更新が1回走る）、更新の失敗が
  行と受信箱に出る、もう一度ログインで印が消える、外す（ログインは Vault から消え PAT は残る）、Vault の一覧、
  どのフレームにも PAT・トークンが出ていない。Repositories の spec の3本で通した（フル E2E は回していない）
- 画面は `/tmp` の小さなプローブ（Module を偽物で立てて素のページに埋める）でも撮って見た

## 踏んだこと

- **E2E の「開く」で本物の github.com に行っていた**——偽の GitHub が返す `verification_uri` は本物と同じ
  `https://github.com/login/device`で、`ui/open-link` が別タブで開いた。spec で `https://github.com/**` を差し止めて、
  開いた先の URL だけを見るようにした（規則6）
- 一覧のアカウント列の頭文字（飾り）が `textContent` に混ざり、「ee2e-pat-user」になった。login だけの要素に印を付けた
- **段階1の試験が1回落ちた（間欠）**：`repositories.spec.ts` の1本目、Import のダイアログを開いた直後に `fill` すると、
  開いたときの読み込み（`go("~")`）が後から返って入力欄を作り直し、打った字の後ろに「~」が残る
  （`…/used-repo~`）。5回中1回。画面の側の競合（`renderDialog` が入力欄を毎回作り直す）で、段階2の変更とは別。
  **直していない**（規則7）——直すなら、ダイアログの入力欄を作り直さないか、読み込みが返った時点で人が打ち始めて
  いたら値を上書きしない
- この環境の E2E：`sg incus -c "CLAUDE_SECURESTORAGE_CONFIG_DIR=<'{}' を置いた空の置き場> npx playwright test
  specs/repositories.spec.ts"`（Repositories の spec は AI を使わない）
