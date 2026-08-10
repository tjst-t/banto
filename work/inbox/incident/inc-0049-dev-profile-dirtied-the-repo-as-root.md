---
id: inc-0049
type: incident
kind: incident
origin: agent
class: environment
status: open
refs: [spec-environment, inc-0048]
---

## 内容

**検証環境の dev プロファイルがリポジトリを root 所有で汚し、ビルドが通らなくなった。**

`packages/banto-web/node_modules/.vite` と `.vite-temp` が root 所有で作られていた
（2026-08-10 09:08）。以後 `npm run build:web` は

```
failed to load config from .../packages/banto-web/vite.config.ts
Error: EACCES: permission denied, open '.../node_modules/.vite-temp/vite.config.ts.timestamp-….mjs'
```

で落ちる。**落ちても気づきにくい**のが一番の害で、`npm run build:web && npx playwright test`
と繋いでいると古い束のまま試験が走り、直したものが直っていないように見える
（inc-0048 を追う途中で実際に踏んだ。直した後の測定が3回ぶん無駄になった）。

## 原因の見当

`meta/environments.yaml` に足した `dev` プロファイル（process ドライバ）は

```
cmd: "mkdir -p .banto && … node --import tsx packages/banto-host/src/bin.ts serve … & … vite packages/banto-web … & wait"
```

を**チェックアウトそのものの上で**走らせる。これが root で起動されると、vite が作る
キャッシュ（`node_modules/.vite*`）が root 所有になる。データは `.banto/` へ隔離してあるが、
**ビルドの副産物は隔離されていない**。

## 直っていないこと

いまは `sudo rm -rf packages/banto-web/node_modules/.vite packages/banto-web/node_modules/.vite-temp`
で消しただけ。**dev プロファイルを起こせばまた同じことが起きる。**

考えられる筋：

1. **root で走らせない**（環境プールの process ドライバが起動ユーザを持つようにする）
2. **vite のキャッシュ置き場を `.banto/` 側へ逃がす**（`cacheDir` を環境変数で振る）
3. **チェックアウトの上で走らせない**（ワークツリーを切ってそこで起こす）

どれもトレードオフがあるので、どれにするかは決めていない。

## 別件として残す理由

inc-0048（末尾追従の貼り直し）とは無関係で、置き場と権限の話。
記憶の区画を幹へ移す作業のスコープ外でもあるため、ここで起票だけしておく（P1）。
