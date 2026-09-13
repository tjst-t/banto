# 開発用の Infisical（自前ホスト）

**行き先は Infisical Cloud**（確認・2026-09-12、ユーザー）。ここで立てるのは
**開発と試験の相手**であって、運用先ではない。backend の実装は自前ホスト固有の
前提を持たない——違いは `siteUrl` と資格情報だけに閉じ込める。

## 立てる

```sh
docker compose up -d
curl -s http://127.0.0.1:8088/api/status     # {"message":"Ok",...} が返れば起動
```

初回だけ、**bootstrap**（自前ホスト専用の口。Cloud には無い）で管理者・組織・
管理 identity を作る。**1回しか通らない**ので、返ってきた JSON は必ず保存する：

```sh
ADMIN_PW=$(openssl rand -base64 24); echo "$ADMIN_PW" > .admin-password; chmod 600 .admin-password
curl -s -X POST http://127.0.0.1:8088/api/v1/admin/bootstrap \
  -H 'content-type: application/json' \
  -d "{\"email\":\"banto-dev@example.com\",\"password\":\"${ADMIN_PW}\",\"organization\":\"banto-dev\"}" \
  > .bootstrap.json && chmod 600 .bootstrap.json
```

メールは**ドメインが必要**（`@localhost` は 422 で弾かれる）。

## banto が使う資格情報を作る

`.bootstrap.json` の `identity.credentials.token` を使って、Project と
**Machine Identity（Universal Auth）**を作り、`.identity.json` に落とす。

1. `POST /api/v2/workspace` … Project を作る
2. `POST /api/v1/identities` … Machine Identity を作る（org の admin）
3. `POST /api/v1/auth/universal-auth/identities/{id}` … Universal Auth を付ける
4. `POST /api/v1/auth/universal-auth/identities/{id}/client-secrets` … clientSecret を発行
5. `POST /api/v2/workspace/{projectId}/identity-memberships/{identityId}` … Project に参加させる

できあがる `.identity.json`：

```json
{ "siteUrl": "http://127.0.0.1:8088", "clientId": "…", "clientSecret": "…",
  "projectId": "…", "environment": "dev" }
```

## 秘密の置き場（**金庫を開ける鍵は金庫に入れられない**）

`clientId`/`clientSecret` は **Infisical backend の資格情報**なので、Infisical には
入れられない。組み込み Vault の `identity.txt`（age の秘密鍵）と**まったく同じ
category**——仕様が「alias 解決の対象ではない、唯一、本当に特別な1点」と
呼んでいるもの。設定として持つ（`.identity.json` / 運用では banto の設定）。

**`.env`・`.admin-password`・`.bootstrap.json`・`.identity.json` は gitignore 対象。**

## 畳む

```sh
docker compose down       # 残す
docker compose down -v    # 中身ごと消す（bootstrap からやり直しになる）
```
