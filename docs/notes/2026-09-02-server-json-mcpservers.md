# 検討ログ：Module の発見元を `server.json`／`mcpServers` 規約に乗せ直す（2026-09-02）

> ## ⚠ この文書は仕様ではない。**検討のログ**である
>
> **仕様は `docs/specs/v4-architecture.md`。** 決まったことを知りたいなら
> そちらを読む。この文書には検討の経緯・却下した案・訂正の履歴がそのまま残る。

## 発端

item14(a)「instance が新しい実装を知る」を4つの発見元（公式レジストリ・
接続情報直接指定・Git リポジトリ・ローカルパス）でモックまで作ったところ、
ユーザーが自分で調べた結果を持ち込んだ：MCP サーバーのインストールには
`server.json`（公式レジストリのスキーマ）と `mcpServers`（Claude Desktop・
Claude Code・Cursor 等が共通して使う実質標準の設定形式）という、**既に
広く使われている規約がある**。banto が独自の4分類を発明する前に、この
規約にそのまま乗るべきだ、という指摘。

## 事実確認（WebSearch、2026-09-02）

- `server.json`：`modelcontextprotocol/registry` が定める公式スキーマ。
  `name`/`title`/`description`/`version`/`packages[]`（npm 等のパッケージ
  参照）/`remotes[]`（`type`/`url`）/`repository`/`_meta`（逆 DNS 名前空間の
  カスタムメタデータ）を持つ
- `mcpServers`：Claude Desktop・Claude Code・Cursor 等が共通して使う設定
  オブジェクト。`command`/`args`/`env`（stdio）または `url`/`headers`
  （remote、`${VAR}` 構文で環境変数を参照できる）
- `_meta`：`server.json` だけでなく MCP プロトコルの `InitializeResult` を
  含む複数箇所に存在する拡張点。逆 DNS 名前空間、`modelcontextprotocol`/
  `mcp` を第2ラベルに使う接頭辞は予約済み

いずれも実在を確認済み（規則1）。banto が§5.4 で既に決めていた
「banto の逆 DNS 接頭辞を `_meta` キーに使う」方針と、`_meta` の実際の
仕様がそのまま一致していたのも確認できた。

## 訂正した内容

1. **発見元を4つ→3つに整理し直した**：公式レジストリ／`server.json`
   （URL指定またはアップロード）／`mcpServers`直接記入。旧「Gitリポジトリ」
   「ローカルパス」は、どちらも「`server.json`をどこから取得するか」の
   バリエーションに過ぎないと判明したため統合——GitHub上の`server.json`は
   URLで指定すれば済み、ローカルの`server.json`はアップロードすれば済む

2. **banto専用モジュール配布の「専用カタログリポジトリ」案は将来のTODOに
   降格**：これは3つ目の発見元の代替ではなく、**URLを探す手間を減らす
   ショートカット**（中身はGitHub上のserver.jsonのURL一覧だけ）に過ぎない
   と整理——今は作らない（規則7）

3. **role・依存の宣言の置き場を決めた**：`server.json`の`_meta`に静的宣言、
   `initialize`応答の同じ`_meta`キーに動的自己申告。食い違ったら動的を
   正として`mcpServers`側を更新する、という設計。**これはitem2「hostの
   自動役割解決」を解決する**——候補列挙は自動（静的宣言から）、実行時に
   自己申告で正す。規則1「自己申告を信頼しない」と矛盾しない理由：
   静的宣言は「過去の自己申告のキャッシュ」に過ぎず、接続するたびに
   実物（動的自己申告）と照合して食い違いを検出・修正するから——
   信頼して使うのではなく、検証してから使う

4. **mcpServersへの秘密情報の注入もVaultのalias方式に乗せる**：
   `env`/`headers`の値をalias名で参照させ、host が接続直前に解決して
   直接注入する（Shellへの注入と同じ経路）。**例外**：Vault自身の
   バックエンドが必要とする秘密情報（HashiCorp Vaultへの接続トークン等）
   はVaultから注入できない（鶏卵問題）——この1点だけローカルの仕組みに頼る

## 未反映（次にモックを開いたときにやること）

- `AddModuleDialog`は訂正前の4分類（レジストリ／接続情報／Git／ローカル）
  のまま——3タブ（レジストリ／server.json／mcpServers直接記入）に作り直す
  必要がある
