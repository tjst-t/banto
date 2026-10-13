# banto を家の外から使う——Cloudflare Tunnel の検討（2026-10-13）

## 前提（コードと仕様で確かめた今の作り）
- 入口は host の Caddy。`banto.tjstkm.net`（`/api/*`→core 4737、ほか→画面 4175）、`sandbox.banto.tjstkm.net`→4176（Canvas の iframe。sandbox.html/js だけ配る）、`<svc>-<id>.banto.tjstkm.net`（Publish、前に banto のログインと公開先ごとの通行証）。DNS は Cloudflare のゾーン tjstkm.net の A レコード（proxied:false、LAN の 192.168.1.47）。証明書は Caddy が DNS-01 で取る。
- core は 0.0.0.0:4737（コンテナが /relay に来る）。install.sh の環境は nftables で lo と Incus のブリッジ以外から落とす。
- 人のログイン：パスキー（RP ID = banto.tjstkm.net、origin を画面のオリジン1つに固定）、端末を追加、host のコマンドのリンク。Cookie `__Host-banto-session` 30日滑走。Cookie の要求は `X-Banto-Client: 1` 必須。
- 機械の合言葉 `Authorization: Bearer <authToken>` は全 /api に効く。
- 認証の要らない口：/healthz、/api/oauth/callback（state で守る）、/api/auth/*（redeem・パスキー開始と完了・publish-check・publish-start・callback）、画面の静的なもの・manifest・/banto-build、/api/streams（札だけで通す、Origin が sandbox か確かめる）。
- 認証の要らない口の速さの上限は **全体で** 1分30回、溜められる challenge 50（packages/core/src/auth/service.ts の UNAUTH_PER_MINUTE・MAX_PENDING_CHALLENGES）——送り元ごとではない。
- /relay（Module ごとの bearer）・/agent-relay（authToken）・Claude のログインの中継（Project ごとの合言葉＋送り元をコンテナのアドレスに縛る）は core の口にあるが、Caddy は /api/* しか 4737 へ回さないので、Caddy 経由なら届かない。
- SSE は 15秒ごとに keep-alive、流れの中継の WebSocket は 15秒ごとに ping。

## 外の事実（Web で確かめた）
- Cloudflare Tunnel：無料・帯域無制限。WebSocket・SSE は通る。無通信 100 秒で切る（無料〜Business）。応答ヘッダが 100 秒来なければ 524。要求の本文は 100MB まで（無料）。
- Tunnel は Cloudflare の端で TLS を解く——会話・Cookie・Vault に画面から入れた値・Terminal の打鍵・Browser の画面がすべて Cloudflare から平文で見える立場になる。
- Universal SSL（無料の端の証明書）は1段のサブドメインまで。`banto.tjstkm.net` は入るが `sandbox.banto.tjstkm.net`・`*.banto.tjstkm.net` は入らない→Advanced Certificate Manager（月10ドル/ゾーン）＋Total TLS が要る。無いと Canvas（Module の画面全部）と Publish が外で開けない。
- Cloudflare Access：無料で50人まで。入り方はメールの一時コード・GitHub/Google 等の IdP、独立した MFA でパスキー・TOTP。CF_Authorization の Cookie は既定24時間（最大1か月程度）。切れると、インストールした PWA の中の fetch が Access のログインへの転送になり CORS で落ちる、というのがよく知られた困りごと。
- Tailscale：WireGuard で端から端まで暗号化。Funnel（インターネットへ出す）でも TLS は自分の機械で解く。subnet router で家の LAN の IP に外から届く。

## 論点
1. **名前とパスキー**：パスキーは RP ID（banto.tjstkm.net）に結びつくので、外用に別の名前を使うと今のパスキーが使えない（Related Origin Requests で広げられるが手間と対応の差がある）。→ 外も同じ名前にするのが筋。Tunnel で同じ名前にすると、公のDNSは Tunnel への CNAME（proxied）になり、家の中は自前の DNS（ルータ・AdGuard 等）で 192.168.1.47 に上書きする split-horizon が要る。上書きしないと家の中も Cloudflare 経由になる（動くが遅く、Access があれば家でも聞かれる）。install.sh は A レコードを LAN の IP に向けて作るので、Tunnel を使う形と衝突する。
2. **Tunnel の先**：cloudflared は host で動き、送り元は 127.0.0.1 になる。先は必ず Caddy（https://127.0.0.1:443、SNI を合わせる）にし、4737 へ直に向けない（/relay・/agent-relay・Claude の中継の口が外から届く範囲に入る）。
3. **外に出したときに増える危なさ（Access 無しのとき）**：
   - 認証の要らない口をインターネットの誰でも叩ける。速さの上限が全体で1つなので、ボットが叩くだけで持ち主の新しいログイン（パスキー・端末を追加の引き換え）が止まる（入っている端末は Cookie なので影響しない）。
   - 機械の合言葉が外からも効く（漏れたら外から全部できる）。
   - 画面・core の未知の不具合（認証前の処理）がインターネットに晒される。
   - Publish の公開先（AI が作って動かすもの）も外から届く。
4. **Access を前に置くと**：見知らぬ人は banto に一切届かない（認証前の口も守られる）。代わりに二重のログイン（Access→banto）。Access のセッションを1か月にすれば手間は月1回。PWA は Access が切れたときの扱いを banto 側で持つ必要（fetch が転送されたら画面全体を読み直してログインへ）。Access は banto・sandbox・公開先の名前全部に掛ける。機械の口（E2E 等）は外からは使わない前提で、Access の service token は作らない。
5. **Cloudflare に見られる**：会話・秘密・端末の打鍵が通る。許容できるかはユーザーの判断。

## 案
### 案A：Tailscale（外に何も出さない）【おすすめ】
- host（か家のルータ）で Tailscale の subnet router を動かし、192.168.1.47/32（または LAN）を広告。携帯・ノートに Tailscale を入れて常時オン。
- URL・パスキー・証明書・Canvas・Publish・PWA が家の中と全く同じに動く。DNS は今のまま（公の DNS が LAN の IP を返している）。
- インターネットに口を開けない。第三者が平文を見ない。banto 側の変更はほぼ無し。
- 弱み：使う端末ごとにアプリが要る（会社の PC など入れられない端末からは使えない）。携帯の VPN の枠を1つ使う（ほかの VPN と同時に使えない）。
- 入れ方：手順書（runbook）。install.sh に足すのは後で。

### 案B：Cloudflare Tunnel＋Cloudflare Access（どのブラウザからでも）
- 同じ名前で split-horizon。cloudflared は host、先は Caddy。Access を banto・sandbox・公開先に掛ける（入り方：メールの一時コード＋独立した MFA のパスキー、セッション1か月）。
- 必要なもの：ACM（月10ドル）、家の DNS の上書き、install.sh の DNS の作り方の変更、banto 側の直し（Access が切れたときの PWA の扱い、外から来た要求で機械の合言葉を断る、認証の要らない口の上限を送り元（Cf-Connecting-IP、Caddy が付け直す値）ごとにする）。
- 弱み：Cloudflare が中身を全部見られる。二重のログイン。設定する所が多い（Cloudflare・家の DNS・host）。

### 案C：Cloudflare Tunnel だけ（banto のログインに任せる）
- 一番手軽だが、認証前の口と未知の不具合をインターネットに晒す。最低でも案Bの banto 側の直しが要る。おすすめしない。

## 外に出してよい線（案B・C を採るときの最低条件）
1. Tunnel の先は Caddy。4737・4175・4176 へ直に向けない。
2. 機械の合言葉は外から来た要求では断る。
3. 認証の要らない口の上限を送り元ごとにし、持ち主のログインを止められないようにする。
4. 前に Access（案B）。Access を置かないなら、少なくとも 1〜3 と、Publish の公開先は外に出さない。
5. Cloudflare に会話・秘密が見えることを人が承知している。

## 結論（決定・2026-10-13、ユーザー）

**今のまま、別のサーバに立てた Tailscale 経由で入る形を続ける。** Cloudflare Tunnel は採らない。

## Fable のレビュー（2026-10-13）で足したこと

上の案Aをおすすめとする結論は妥当、案Cは勧めない、という評価。案Bを採るなら、最低条件に次を足す必要がある：

- **高**：Tunnel の宛先（ingress）を Cloudflare の管理画面で設定する形だと、Cloudflare のアカウントを握った人が宛先を
  `127.0.0.1:4737` や Caddy の admin API `localhost:2019` に向け直せる。nftables は lo を素通しにする（install.sh）ので、
  「宛先は Caddy」は設定の約束にすぎない。cloudflared の設定を host に置くローカル管理に固定し、アカウントに MFA を付ける。
- **中**：challenge の置き場が login・register・stepup で共有で、login の口を叩くだけで入っている人の本人確認の札が押し出された
  （外に出さなくてもコンテナの AI から叩けた）。→ **Backlog #285 で直した**（置き場を分け、セッションの札はセッションごとに上限）。
- **中**：応答の頭を 100 秒以上待たせる口がある——Canvas の tool 呼び出し（上限10分、終わってから JSON を返す）、registry からの
  Module の追加、Project の初回作成（イメージの取得）。Cloudflare は 524 を返すが host 側は続く。SSE（15秒）と WebSocket の ping（15秒）は問題ない。
- **中**：Access の Cookie を持たない新しい端末で「端末を追加」のリンク（`#banto-login=<札>`）を開くと、Access のログインへ転送されて
  フラグメントが落ちる。先に Access を通してから10分以内にリンクを開く手順が要る。
- **中**：`sandbox.banto.tjstkm.net` の初回読み込みは iframe の中の遷移で、Access の Cookie が無いと iframe の中でログインへ転送され、
  Access のログイン画面は frame に入れないので開かない。Access のアプリを1つにして親と sandbox を同じアプリに入れ、実機で確かめる必要。
- **中**：install.sh は打ち直すたびに `<名前>` の A レコードを LAN の IP（proxied:false）へ戻す。同名に A と CNAME は置けないので、
  打ち直すたびに Tunnel の道が消える。
- **中**：案Aの subnet route は `192.168.1.47/32` に絞る（`/24` は出先の LAN と重なりやすい）。
- **低**：`/api/auth/me` は独自ヘッダ無しでも `hasPasskeys` を返す（「banto がある・パスキー登録済み」が分かる）。
- **低**：送り元ごとの上限を `Cf-Connecting-IP` で作るなら、Caddy は素通しで `trusted_proxies` も無いので LAN から偽れる。Cloudflare の
  rate limiting rule（無料でも1本）で `/api/auth/*` を IP ごとに絞ればコードを変えずに済む。
- **低**：発言の本文の上限は約 134MB（画像 10 枚×10MB）で Cloudflare の 100MB を越える。
- **低**：sandbox は `sandboxPublicUrl` の設定だけで1段の名前（例 `banto-sandbox.tjstkm.net`）へ移せるので、Canvas は ACM 無しで通せる。
  Publish は `.banto.tjstkm.net` の下が必須なので ACM が要るのは変わらない。
- **低**：仕様の「WebSocket は core にも画面にも無い」は `/api/streams` が入って古い。→ #285 と一緒に直した。
- 正しかった点：認証の要らない口の一覧、/relay・/agent-relay・Claude の中継が Caddy を通らないこと、機械の合言葉で人の扱いを変えられないこと、
  X-Forwarded-Host は Caddy が上書きし札・通行証が名前に結びつくので cloudflared 経由でも危なさは増えないこと、DNS rebinding は実害無し。
  Tailscale Funnel は `*.ts.net` の名前しか使えずパスキーの RP ID と合わないので候補にならない。
