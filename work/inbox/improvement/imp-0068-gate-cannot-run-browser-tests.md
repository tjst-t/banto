---
id: imp-0068
title: マージ前ゲートの器ではブラウザ試験が1件も走らない（`npm run test:ui` を verify に書くと必ず落ちる）
status: open
severity: P2
origin: 枝 thread-126「取次の導線と一括クローズ」（2026-08-16）。取次の UI 修正を積む際に、受け入れ条件の verify として `npm run test:ui` を書こうとして実測で気づいた
refs:
  - docker/Dockerfile.test（node:24-alpine）
  - meta/environments.yaml（profile: test）
  - inc-0071（ブラウザ試験が恒常的に9件赤い、とされている件）
  - work/tasks/task-0077 / task-0078 / task-0086（過去に `npm run test:ui` を verify に書いて着地している）
---

## 事実（番頭が env.verify で実測・2026-08-16）

`test` プロファイル（`docker/test.yaml` / `docker/Dockerfile.test` = `node:24-alpine`）の中で

```
npx playwright test --reporter=line
```

を回すと **152件すべて失敗**する。理由は中身と無関係で、全件これ：

```
Error: browserType.launch: Executable doesn't exist at
  /root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
```

`Dockerfile.test` が入れているのは `git make g++ python3 docker-cli` だけで、
**ブラウザは入っていない**。さらに土台が **alpine（musl）** なので、
`playwright install` を足しても公式の chromium ビルドは動かない（musl 非対応。
今日の章畳みの件で踏んだのと同じ壁）。

## なぜ問題か

1. **受け入れ条件に `npm run test:ui` と書いたタスクは、実装が正しくても必ずゲートで落ちる。**
   落ち方が「152件全滅」なので、原因を追う人は自分の変更を疑ってしばらく溶かす。
2. **UI の受け入れ条件を機械で守る手段が、いまは無い。**
   画面の変更は職人のワークツリー（ホスト側）で回した結果を報告に貼るしかなく、
   それは「職人の主張」であって機構が返した事実ではない（I1 の線を割っている）。
3. 過去に `npm run test:ui` を verify に書いて着地したタスク（task-0077 / 0078 / 0086）がある。
   **当時は通っていたのか、通らないまま承認されたのかが分からない**——後者だとすると、
   同じ verify を書いた他のタスクの緑も信用できない。**ここは要調査。**

## 直し方の候補（未決）

- (a) **`test-ui` プロファイルを別に立てる**：土台を `mcr.microsoft.com/playwright:*`（Debian 系）にした
      compose を用意し、UI に触るタスクだけ `environment: test-ui` で積む。
      `test` は軽いまま保てる。置き場（cache）の鍵に compose とイメージを入れること。
- (b) `Dockerfile.test` の土台を alpine から Debian 系へ移し、ブラウザを入れる。
      **全タスクのゲートが重くなる**ので、代償が大きい。
- (c) ブラウザ試験はゲートで見ない、と明示に決める（＝職人の報告と PO の確認に委ねる）。
      いまの実態はこれだが、**契約に書けてしまう**のが事故のもと。書けないようにする
      （verify に `test:ui` を含むタスクを enqueue の時点で断る）なら、この案も筋が通る。

**(a) か (c) かは PO 判断。** どちらにしても「書けるのに必ず落ちる」いまの状態は残さないこと。

## いま現場でやっていること（当座の凌ぎ）

`task-0175` / `task-0176`（取次の UI 修正）では、
**verify に `npm run test:ui` を書かず**、機械で見るのは `npm test` と型検査だけにした。
画面の挙動は「Playwright 試験を書き、**ワークツリー（ホスト）で回した出力を報告に貼る**」を
受け入れ条件にしてある。最後は PO が稼働中の banto で触って確かめる。
