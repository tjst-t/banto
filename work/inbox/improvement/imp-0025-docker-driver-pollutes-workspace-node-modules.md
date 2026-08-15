---
id: imp-0025
kind: improvement
status: open
created: 2026-08-14
refs: [imp-0023, inc-0067]
---

# 検証環境の setup が、bind mount 越しに本番ツリーの `packages/*/node_modules` を書き換える

## 何が起きたか

2026-08-14、番頭が **PO にレビューしてもらうため** `dev` プロファイルの環境を
**本番の作業ツリー**（`/home/ubuntu/ghq/github.com/tjst-t/banto`）に対して立てた。
その直後から、稼働中の banto が章（会話）を畳めなくなった。

```
Claude Code native binary at
packages/banto-host/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude
exists but failed to launch. ... spawning a musl-linked binary on a glibc Linux host
```

`packages/banto-host/node_modules/@anthropic-ai/` の中身は
`claude-agent-sdk` / `claude-agent-sdk-linux-x64-musl` / `sdk` の3つで、
**glibc 版が消えていた**。

## なぜ起きたか

`dev` は `driver: docker` で、docker ドライバは**リポジトリを bind mount する**。
その中で `setup: "npm ci --include=dev"` が走る。器の土台は Alpine（musl）なので、
npm は **musl 用の optional dependency** を選ぶ。

ルートの `node_modules` は cache の置き場（`/app/node_modules`）に逃がしてあるので
守られていた。**しかしワークスペースのサブパッケージ `packages/*/node_modules` は
逃がしていない**——bind mount そのままなので、器の中の `npm ci` の結果が
**ホストの本番ツリーに書き戻る**。

`meta/environments.yaml` の `dev`:

```yaml
    setup: "npm ci --include=dev"
    cache:
      key:  [package-lock.json, docker/Dockerfile.test]
      path: /app/node_modules      # ← ルートだけ
```

## なぜ問題か

- **人が触るための環境を立てる操作が、稼働中の本体を壊す。** レビュー用に環境を
  立てるたびに再発する。今回は「PO に UI を見てもらう」ためだけの操作だった。
- **2026-08-13 の事故と同じ形**（`driver: process` の `npm ci` が本番ツリーの
  devDependencies を落とし、tsx / typescript が消えた）。あのときは
  `driverSpawnEnv` と設定の二重で「process ドライバ」を塞いだが、
  **docker ドライバでも bind mount 経由で同じことが起きる**——塞ぎ方が足りていない。
- 症状が出るのが**別の場所**（章の要約器）なので、原因に辿り着きにくい。
  実際、番頭は最初「章のモデル解決の不具合」を疑った。

## どう直すか（案。実装は要検討）

1. **`packages/*/node_modules` も器の中に閉じ込める。** cache の `path` を
   ルートだけでなくワークスペース各所に広げるか、compose 側で anonymous volume を
   当てて bind mount を上書きする。いちばん素直。
2. **`setup` を本番ツリーに対して走らせない。** 「人が触る環境」は
   worktree のコピーに対して立てる、という運用に倒す（決定59 の環境は長命なので、
   コピーの寿命も長くなる点に注意）。
3. **本番ツリーを bind mount する環境の `setup` を禁じる。**
   機構として断る（I2。黙って走らせない）。

少なくとも「**稼働中のサービスが読んでいるツリーに、器の中の書き込みが漏れない**」
ことを、機構と設定の両方で担保すること——2026-08-13 の教訓（片方に頼らない）と同じ。

## 確かめたこと（2026-08-14、復旧作業での実地調査）

- **bind mount の該当行は `docker/dev.yaml`。** リポジトリを丸ごと mount した上で、
  ルートの `node_modules` だけを volume で覆っている:

  ```yaml
      volumes:
        - ..:/app                                                      # ← リポジトリ丸ごと
        - ${BANTO_CACHE_DIR:-./.banto-node-modules}:/app/node_modules  # ← ルートだけ覆う
  ```

  土台は `docker/Dockerfile.test` ＝ **`FROM node:24-alpine`**（musl）。よって器の中の
  `npm ci` は musl 用 optional dependency を選び、volume に覆われていない
  `packages/*/node_modules` へ bind mount 経由でそのまま書き戻る。
  （なお `docker/dev.yaml` 冒頭のコメントは「土台は test と同じ **node:22**-alpine」と
  書いているが、実物は node:24-alpine。コメントが実態とずれている——P3。）

- **書き戻り先は `node_modules` に留まらない。** `skills/audit-system.md` /
  `skills/audit-checklist.md` / `skills/executor-system.md` の3つ——いずれも
  **git 追跡下のファイル**——が root 所有になっていた（mtime 15:12。`npm ci` の 15:15 より前）。
  内容は git 上は無変更だったが、**器の書き込みが追跡下のファイルにまで届く**実例である。
  「`packages/*/node_modules` を閉じ込める」だけでは塞ぎきれない。

- **他のワークツリーは無事だった。** `/home/ubuntu/worktrees/**` には `-musl` を含む
  ディレクトリが **0件**、root 所有のものも **0件**（ディレクトリ名の一致で確認）。
  今回の `dev` が本番ツリーだけを mount していたため。

- **root 所有が残ると、将来の `npm ci` が EACCES で落ちうる。** root 所有ディレクトリの
  中身は ubuntu では unlink できないので、npm がツリーを作り直せずに失敗する。実際、
  復旧時に musl 版の残骸を ubuntu の `rm -rf` で消せず、root で走るコンテナからの削除が要った
  （この VM では `sudo` 自体が `no new privileges` で動かない）。
  **汚染は「musl バイナリが混じる」形だけでなく「所有者が root になる」形でも残る。**
