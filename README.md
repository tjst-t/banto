# banto（番頭）

記憶を持つAI番頭（steward）が主体となり、決定的な統治基盤（Kobo）の上で、POの代理として店を切り盛りする。

設計の全体像は `docs/vision.md` と `docs/adr/adr-0010-pluggable-harness.md`、
判断規則は `docs/principles.md`。作業の現在地は `docs/notes/handoff.md`。

---

## clone してから動かす

### 前提

| | | |
|---|---|---|
| **Node.js 20 以上** | 必須 | `node --version` で確認 |
| **git** | 必須 | |
| **LLMの認証** | 必須 | 下の「LLM認証のセットアップ」。これが無いと番頭が喋れない |
| `ghq` / `gwq` | 任意 | 入れると、手元のリポジトリとワークツリーが自動で「場所」として並ぶ。無くても設定で足せる |
| `docker` | 任意 | 検証環境で compose を使うとき |
| `sops` / `age` | 任意 | 検証環境で credentials を使うとき |

### 手順

```sh
git clone git@github.com:tjst-t/banto.git
cd banto
npm install

# LLMの認証（下の節。これを先に済ませる）

# 番頭ホストと WebUI を起動
BANTO_PROVIDER=opencode BANTO_MODEL=deepseek-v4-flash-free npm run dev
```

ブラウザで **http://localhost:4200** を開く。

- `npm run dev:host` … 番頭ホスト（:4100）。会話・Tool・モジュールのAPI
- `npm run dev:web` … WebUI（:4200）。`/ws` と `/api` は :4100 へ中継される

**開くのは 4200 だけでよい。** 4100 は WebUI からの中継先で、直接開く必要はない。

### 起動時に指定するもの

設定画面（⚙️）で変えられるものは、初回だけ環境変数で渡せばよい。保存すると次回からは設定が優先される。

| 環境変数 | 既定 | 何を決めるか |
|---|---|---|
| `BANTO_PROVIDER` / `BANTO_MODEL` | （pi の既定解決） | 番頭が使うLLM。**明示するのを勧める**——省略すると `auth.json` 側の解決に委ねられ、意図しないプロバイダが選ばれることがある |
| `BANTO_DATA_DIR` | `./.banto` | 記憶・会話・台帳・設定の置き場。**番頭はここに書けない** |
| `BANTO_PLACES` | `workspace:<cwd>` | 番頭が作業できる場所。`id:/絶対パス` は読み取り専用、`id:/絶対パス:docs/**,work/**` はその範囲だけ書き込み可。`;` 区切りで複数 |
| `BANTO_HOST_BIND` | `127.0.0.1` | 待ち受けるアドレス。**広げる前に下の「外に出すとき」を読むこと** |
| `SOPS_AGE_KEY_FILE` | （なし） | 検証環境の credentials を復号する鍵の場所 |

自分自身（このリポジトリ）を番頭に触らせる例：

```sh
BANTO_PROVIDER=opencode BANTO_MODEL=deepseek-v4-flash-free \
BANTO_DATA_DIR=$PWD/.banto \
BANTO_PLACES="banto:$PWD:docs/**,work/**" \
npm run dev
```

### 開いたら

画面は3つの面でできている（ヘッダーは共通）。

- **会話** … 番頭と話す。右がチャット、左がキャンバス（ファイル・Git・記憶・SKILL・職人・リポジトリ・検証環境）
- **履歴**（🕘） … 畳んだ会話。開き直せる
- **設定**（⚙️） … LLM・場所・接続・職人・検証環境。モジュールが増えると区画も増える

番頭に頼めること：

- 「このリポジトリの docs を見て」 … `file.*` / `git.*`（読み取り）
- 「〜を調べて」「〜を直して」 … 職人へ委譲（`worker.delegate`）。番頭は自分で手を動かさない
- 「テストが通るか確かめて」 … 検証環境（`env.verify`）。立てて走らせて必ず畳む
- 「docs に書いておいて」 … 書けるのは**POが場所ごとに許した範囲だけ**。断られたら番頭が許可を求めてくるので、⚙️ か「書き込み許可」の画面で許す

### 外に出すとき

**Banto は認証を持たない。** 既定では `127.0.0.1` だけを待ち受けるので、そのままなら外からは届かない。

外に出すなら **前段（Caddy 等）で守ること**。`BANTO_HOST_BIND` を広げると、前段で守られていない経路から記憶・書き込み・検証環境の credentials 経路に直接届く（広げると起動時に警告が出る）。

---

## LLM認証のセットアップ（pi / OpenCode）

エージェント実行には pi ランタイムのLLM認証が必要。`deploy/pi-auth.json.example` を `~/.pi/agent/auth.json` にコピーし、実際のAPIキーに書き換える（`chmod 600` 必須）:

```sh
mkdir -p ~/.pi/agent
cp deploy/pi-auth.json.example ~/.pi/agent/auth.json
chmod 600 ~/.pi/agent/auth.json
$EDITOR ~/.pi/agent/auth.json   # REPLACE_WITH_... を実キーに
```

- OpenCode **Zen** → プロバイダ名 `opencode`（エンドポイント https://opencode.ai/zen/v1 ）
- OpenCode **Go** → プロバイダ名 `opencode-go`（https://opencode.ai/zen/go/v1 ）
- 使わない方のエントリは削除してよい。auth.json は `OPENCODE_API_KEY` 等の環境変数より優先される
- **実キーをリポジトリにコミットしないこと**（auth.json はホーム配下・リポジトリ外）

検証: `npm run test:e2e`（歩くスケルトンE2E）が認証を使う最初のテスト。

---

## 開発

```sh
npm test           # acceptance テスト
npm run test:e2e   # e2e テスト（LLM認証が要る）
npm run build      # tsc -b
npm run typecheck  # 型検査
npm run typecheck:web
npm run build:web
```

規則の正典は `docs/principles.md`、仕様は `docs/spec/`。
Spec と実態が食い違ったら黙って寄せず incident を積む（P3）。

---

## Kobo（daemon）

決定的な統治基盤。**現状 Banto（番頭ホスト）には配線されていない**——番頭は Kobo 無しで
職人へ委譲し、検証環境を回せる（決定23・27c・32c）。配線は task-0046。

<details>
<summary>daemon 単体の起動と API（配線するまでは使わない）</summary>

### Development

```sh
BANTO_PORT=3000 BANTO_DATA_DIR=./data node --import tsx packages/banto-daemon/src/index.ts
```

### systemd (Ubuntu VM, production)

```sh
sudo cp deploy/banto-daemon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo useradd --system --no-create-home banto
sudo mkdir -p /var/lib/banto/data
sudo chown banto:banto /var/lib/banto/data
sudo systemctl enable --now banto-daemon
sudo journalctl -fu banto-daemon
```

| Environment variable | Default      | Description           |
|---------------------|--------------|-----------------------|
| `BANTO_PORT`        | `3000`       | HTTP/WS listen port   |
| `BANTO_DATA_DIR`    | `./data`     | Event log + registry  |

### API quick-reference

```
GET  /api/v1/health
GET  /api/v1/projects
POST /api/v1/projects                         { id, repoPath, profile? }
GET  /api/v1/projects/:proj/tasks
POST /api/v1/projects/:proj/tasks             { id, title, ... }
GET  /api/v1/projects/:proj/tasks/:id
GET  /api/v1/projects/:proj/tasks/:id/events
POST /api/v1/projects/:proj/tasks/:id/transition  { to, reason? }
GET  /api/v1/tasks/:proj/:id                  (global reference)
WS   /ws                                      subscribe { type:"subscribe", projectTag, after_event_id? }
```

</details>
