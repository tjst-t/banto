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
npm run dev
```

ブラウザで **http://localhost:4200** を開く。

- `npm run dev:host` … 番頭ホスト（:4100）。会話・Tool・モジュールのAPI
- `npm run dev:web` … WebUI（:4200）。`/ws` と `/api` は :4100 へ中継される

**開くのは 4200 だけでよい。** 4100 は WebUI からの中継先で、直接開く必要はない。

### 起動時に指定するもの

設定画面（⚙️）で変えられるものは、初回だけ環境変数で渡せばよい。保存すると次回からは設定が優先される。

| 環境変数 | 既定 | 何を決めるか |
|---|---|---|
| ~~`BANTO_PROVIDER` / `BANTO_MODEL`~~ | — | **廃止（2026-08-04 の裁定・確認済み 2026-08-13）。読まれない。** モデルの出どころは `llm-registry.json` の **`roles.steward`**（`backend`/`provider`/`model`）。**新しい会話の既定**で、会話ごとに画面から上書きできる。Claude Code バックエンドを選ぶには `~/.claude` の認証が要る |
| `BANTO_DATA_DIR` | `./.banto` | 記憶・会話・台帳・設定の置き場。**番頭はここに書けない** |
| `BANTO_PLACES` | `workspace:<cwd>` | 番頭が作業できる場所。`id:/絶対パス` は読み取り専用、`id:/絶対パス:docs/**,work/**` はその範囲だけ書き込み可。`;` 区切りで複数。**`desk`（成果物の置き場所）は指定しなくても必ずある**——既定は `~/banto-desk`（読み取り専用）で、同じ id を書けば場所も書き込み範囲も上書きできる |
| `BANTO_HOST_BIND` | `127.0.0.1` | 待ち受けるアドレス。**広げる前に下の「外に出すとき」を読むこと** |
| `SOPS_AGE_KEY_FILE` | （なし） | 検証環境の credentials を復号する鍵の場所 |
| `BANTO_CHAPTER_THRESHOLD` | `0.6` | 会話を「章」で区切る閾値（文脈長に対する割合）。番頭はここに達したターンの終わりで引き継ぎ資料を書き、文脈を畳む |
| `BANTO_CHAPTER_MODEL` | （会話と同じモデル） | 引き継ぎ資料と記憶の抽出に使うモデル。`provider/model-id`。**安いモデルを指定してよい**——会話とは別の呼び出しなので、本編のキャッシュに触らない |
| `BANTO_ARTIFACT_THRESHOLD` | `2000` | ツール出力を退避に回す大きさ（文字数）。これを超えた出力は文脈に載せず、栞だけ返して `artifact.read` で読ませる |

自分自身（このリポジトリ）を番頭に触らせる例：

```sh
BANTO_DATA_DIR=$PWD/.banto \
BANTO_PLACES="banto:$PWD:docs/**,work/**" \
npm run dev
```

### 何が立ち上がるか

`npm run dev` で**組み込みモジュールは全部立ち上がる**。起動ログの `modules:` 行で確認できる。
個別に起動する手順は無い——登録は1箇所（`bin.ts`）にまとまっている。

| モジュール | 何をする | 追加で要るもの |
|---|---|---|
| `workspace` | ファイル・Git の閲覧、書き込み、場所の一覧 | — |
| `worker-pool` | 職人（worker）への委譲・報告・畳み | LLM認証 |
| `repo-manager` | ghq のリポジトリと gwq のワークツリーを場所として提供 | `ghq` / `gwq`。**無い場合は場所を1つも返さないだけで、起動はする** |
| `environment-pool` | 検証環境の provision / run / teardown | compose を使うなら `docker`、credentials を使うなら `sops` + 鍵 |
| `settings` | 設定画面（⚙️） | — |
| `studio` | 記憶ビューア・SKILLビューア | — |
| `demo` | 動作確認用のGUI（時計とあいさつ） | — |

**Kobo（daemon）は別プロセスで、いまは Banto に配線されていない**（task-0046）。
番頭は Kobo 無しで職人へ委譲し、検証環境を回せる。

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

### 外（localhost 以外）からアクセスする

**Banto は認証を持たない。** 既定では `127.0.0.1` だけを待ち受けるので、そのままなら外からは届かない。開ける前に、何が晒されるかを把握しておくこと——**記憶・書き込み・検証環境の credentials 経路**が同じ面にある。

#### 勧める形：前段に Caddy 等を置き、Banto は localhost のまま

前段で認証を掛け、`127.0.0.1:4100` へ中継する。Banto 側の設定は変えない（＝素通りされる経路が無い）。

```caddyfile
banto.example.com {
    # ここで basic_auth なり forward_auth なりを掛ける
    basic_auth {
        po $2a$...   # caddy hash-password で作る
    }
    reverse_proxy 127.0.0.1:4100
}
```

UI・API・WebSocket・検証環境への中継はすべて 4100 に乗っているので、**中継するのはこの1ポートだけでよい**。

#### 前段を置かずに直接開ける（自己責任）

| | 開発中（vite を使う） | 常駐（ホストが UI を配る） |
|---|---|---|
| 待ち受け | `BANTO_HOST_BIND=0.0.0.0`（:4100） | `BANTO_HOST_BIND=0.0.0.0`（:4100） |
| UI | vite は既定で全インターフェース（:4200） | ホストが同じ 4100 で配る |
| ドメイン経由 | `BANTO_WEB_ALLOWED_HOSTS=.example.com` | 不要 |

```sh
BANTO_HOST_BIND=0.0.0.0 BANTO_WEB_ALLOWED_HOSTS=.example.com npm run dev
```

広げると起動時に警告が出る。**無認証で外に出ることになるので、閉じたネットワークの中だけにすること。**

---

## サービスとして常駐させる（systemd）

常駐では **vite の開発サーバを動かし続けない**。`npm run build:web` でビルドした UI を
ホスト自身が配るので、**1プロセス・1ポート**で済む。

```sh
# 1. 置く
sudo mkdir -p /opt/banto && sudo chown $USER /opt/banto
git clone git@github.com:tjst-t/banto.git /opt/banto
cd /opt/banto && npm install && npm run build:web

# 2. 実行ユーザとデータ置き場
sudo useradd --system --create-home --home-dir /var/lib/banto banto
sudo chown -R banto:banto /var/lib/banto /opt/banto

# 3. LLM認証（banto ユーザのホームに置く）
sudo -u banto mkdir -p /var/lib/banto/.pi/agent
sudo -u banto cp deploy/pi-auth.json.example /var/lib/banto/.pi/agent/auth.json
sudo -u banto chmod 600 /var/lib/banto/.pi/agent/auth.json
sudo -u banto $EDITOR /var/lib/banto/.pi/agent/auth.json   # 実キーに

# 4. サービス登録
sudo cp deploy/banto.service /etc/systemd/system/
sudo $EDITOR /etc/systemd/system/banto.service   # BANTO_PLACES 等を環境に合わせる
sudo systemctl daemon-reload
sudo systemctl enable --now banto
sudo journalctl -fu banto
```

`http://127.0.0.1:4100` で UI が出る。外から見せるなら上の「前段に Caddy」を併せて置く。

設定（LLM・場所・検証環境の上限など）は起動後に画面の ⚙️ からも変えられる。
ユニットの `Environment=` は**保存された設定が無いときの既定**として効く。

更新するとき:

```sh
cd /opt/banto && sudo -u banto git pull && sudo -u banto npm install && sudo -u banto npm run build:web
sudo systemctl restart banto
```

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
