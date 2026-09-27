# Vault の拡張案：鍵を渡さず「中継の合言葉」を渡す（2026-09-27、検討中）

**まだ決まっていない。** 決まったら `docs/specs/v4-modules.md` §2.1（Vault）と §2.3（Shell）を直す。

## 1. 何を解きたいか

- banto で banto を開発すると、E2E が本物の Claude の資格情報（`~/.claude/.credentials.json`）を要求する。
  **本物の資格情報はコンテナに入れない**と決めている（`v4-security.md` §1）ので、中で E2E が回らない
- 同じ問題は Claude に限らない。開発中のアプリが外部の API（OpenAI・決済・メール配信…）を呼ぶとき、
  今の `envSecrets` は**本物の値をコマンドの環境に入れる**。中の AI は root なので、その間は読める

## 2. 既知の形（規則12）

名前がある：**credential injection proxy**（資格情報を差し込む中継）、あるいは **phantom token pattern**
（中には偽の合言葉だけを置き、中継がそれを確かめて本物に差し替える）。エージェントのサンドボックスで
広く使われている——nono・Hermes Agent（iron-proxy）・Cloudflare Sandbox など。Envoy にも同じ役目の
`credential_injector` フィルタがある（Bearer / Basic / OAuth2 を差し込む）。

**banto にもすでにある**：

- `packages/modules/subagent/src/claude-login-proxy.ts`——サブエージェントに `ANTHROPIC_BASE_URL`＝中継と
  `CLAUDE_CODE_OAUTH_TOKEN`＝1回だけの合言葉を渡し、中継が本体のトークンに差し替える。通すのは
  `/v1/messages` だけ。host の `subagent-settings` が開く
- Shell の `sshIdentity`——秘密鍵を渡さず、ssh-agent の口だけを渡す（同じ考え方の SSH 版）

今回の案は、**前者を Claude 専用から Vault の汎用の機能に広げる**もの。

## 3. 案

### 3.1 鍵に「渡し方」を持たせる

Vault の alias（`kind: "secret"`）に、人が登録するときに**渡し方**を選ばせる：

| 渡し方 | コマンドに入るもの |
|---|---|
| 値を渡す（今まで） | 本物の値 |
| **中継で渡す**（新） | 中継の住所と、その回だけの合言葉 |

中継で渡す鍵には、登録のときに次を決めて**鍵に縛りつける**：

- **行き先**（例 `https://api.openai.com`）——**中継はここにしか送らない**。偽の宛先に本物の鍵を
  付けて送らせる攻撃を、構造的に塞ぐ（既知の形の主な利点）
- **差し込み方**（`Authorization: Bearer` か、`x-api-key` のような見出しか）
- **住所を渡す環境変数の名前**（例 `OPENAI_BASE_URL`・`ANTHROPIC_BASE_URL`）——道具ごとに違うので、鍵の側に持つ
- 通してよいパス（任意。Claude なら `/v1/messages` だけ、のように絞れる）

### 3.2 流れ（Shell の場合）

```
AI: runCommand({ command, envSecrets: { OPENAI_API_KEY: "openai" } })
1. Shell → vault-directory.lookupAlias("openai")        → { 実装, 渡し方: 中継, … }
2. Shell → その Vault.openCredentialProxy({ alias, listenHost })
                                                          → { url, token, proxyId }   ※本物の値は返らない
3. 子プロセスの環境：OPENAI_API_KEY=<token>、OPENAI_BASE_URL=<url>
4. コマンドが終わる → Shell → Vault.closeCredentialProxy({ proxyId })   → 合言葉は無効
```

- **中継は Vault のプロセスの中で動く**（host）。本物の値は Vault のプロセスから出ない——
  「秘密鍵は Vault のプロセスから一度も出ない」（D5）を汎用の秘密にも広げる形
- **本物の値は要求のたびに読み直す**（今の Claude の中継と同じ）——Vault 側で鍵を替えれば、使う側は何もしなくてよい
- 待ち受けは、今の Claude の中継と同じく **Project のネットワークの host 側のアドレス**（コンテナから 127.0.0.1 には届かない）
- 各 backend に作らせず、共通ライブラリ（`vault-kit`）に置く——backend は値を出すだけ
- **閉じ忘れの上限**を持つ（今の Claude の中継の `PROXY_MAX_LIFETIME_MS` と同じ）
- Service（§4.2）で使うときは、合言葉の寿命＝そのサービスが動いている間

### 3.3 記録

中継を必ず通るので、**要求ごとに**「いつ・どの Project の・どの鍵で・どのパスに・結果」を記録できる
（値は記録しない）。今の「どの Module が resolveAlias を呼んだか」より細かく追える。

## 4. E2E に当てはめると

1. 人が Claude の鍵を Vault に「中継で渡す」で登録する（行き先 `https://api.anthropic.com`、住所の変数
   `ANTHROPIC_BASE_URL`、パスは `/v1/messages` だけ）
2. AI が `runCommand({ command: "npx playwright test …", envSecrets: { CLAUDE_CODE_OAUTH_TOKEN: "claude" } })`
3. E2E の中の banto は、中継の住所と合言葉で Claude を使う

**E2E の側の手直しも要る**：準備処理（`e2e/global-setup.ts`）は資格情報のファイルが無いと止まる。
環境変数（`CLAUDE_CODE_OAUTH_TOKEN`＋`ANTHROPIC_BASE_URL`）でも通すようにする。中の banto が、この
2つを自分の Runner（Agent SDK が起こす CLI）まで渡すかは未確認。

**Claude の鍵をどこから持ってくるか**が別の問題としてある（§5 の B）。今の中継は Vault ではなく、host の
CLI が更新し続ける `~/.claude/.credentials.json` を毎回読んでいる。

## 5. 決めること

- **A. 行き先を鍵に縛る**——縛らないと、中の AI が合言葉を好きな宛先に向けられ、中継が本物の鍵を付けて送ってしまう。
  **縛るのが前提**（案としては選択肢にしない）
- **B. Claude の鍵の出どころ**
  - B1：`claude setup-token` で作る長期トークン（1年）を Vault に入れる。Vault の汎用の仕組みだけで閉じる
  - B2：今の「host の Claude ログインを共有する」中継を、Vault の中継の**出どころの1つ**として取り込む
    （ファイルを読む出どころ）。ログインが1本で済む
  - 勧め：**B1 で始める**（汎用の仕組みだけで E2E が回る）。B2 はサブエージェントの中継を Vault に寄せるときに考える
- **C. 住所を差し替えられない道具**（`gh`・https の `git`・`npm` の一部）
  - C1：後回し（今回は住所を差し替えられるものだけ）
  - C2：透過型にする——`HTTPS_PROXY` で全部を中継に通し、コンテナごとの使い捨ての認証局で TLS を開いて
    差し込む（Cloudflare Sandbox・nono の形）。どの道具にも効くが、コンテナに認証局を入れる・中継が全通信を見る
  - 勧め：**C1**。まず一番単純な形で E2E を回す
- **D. 人への確認**——今は「コンテナから値を返す口は、鍵の名前ごとに人に聞く」（`v4-security.md` §1）。
  中継で渡す鍵は**値を返さない**ので、同じ厳しさが要るか
  - 勧め：**鍵ごとの確認は残す**。値は漏れなくても、その鍵で**使える**ことは同じなので（行き先で縛ってはいる）

## 6. 出典

- [Scoped Credentials via Proxy Outside the Agent Sandbox — AgentPatterns.ai](https://agentpatterns.ai/security/scoped-credentials-proxy/)
- [Network Proxy and Credential Injection — nono（DeepWiki）](https://deepwiki.com/nolabs-ai/nono/5-network-proxy-and-credential-injection)
- [Egress credential-injection proxy (iron-proxy) — Hermes Agent](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy)
- [Secure credential injection and dynamic egress policies for Sandboxes — Cloudflare](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/)
- [Credential injector filter — Envoy](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter)
