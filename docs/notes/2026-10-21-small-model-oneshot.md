# 小さいモデルを1回呼ぶ口（Backlog #497）——#490 と1つにできるか

2026-10-21。仕様（v4-architecture.md §2.2「題は AI が付ける」）が「#490 と host の側の処理を1つにまとめられるか作るときに確かめる」としていた件。

## 作ったもの

- `banto/packages/core/src/runner/one-shot.ts` の `askSmallModel`：Agent SDK の `query()` を道具なし（`tools: []`）・`maxTurns: 1`・
  記録なし（`persistSession: false`）・人の設定を混ぜない形で1回。答えの最初の空でない行を返し、失敗は投げる（代わりの値は呼び元）
- モデルは `SMALL_MODEL`（`claude-haiku-4-5-20251001`）に固定
- 本体のログインは、会話の本体と同じ `ClaudeLoginRelay.runnerEnvFor` で環境を組んで渡す。**Thread の印を付けない**
  （`threadId` を `undefined` にできるようにした）——付けると中継が温め直しの候補（§3.1）として覚えてしまう。
  均すときの固定の鍵は、呼び元が `sessionId` を決めて `runnerEnvFor` と `askSmallModel` の両方に同じものを渡す

## #490 と1つにできるか：関数は1つにできない。中継は共用できる

- #490 の仕様（fork/bg-visibility の v4-architecture.md「いまの様子を要約」）では、Subagent Module が **Project のコンテナ（か別のサーバ）の
  中から**中継へ `/v1/messages` を直に送る。core の関数を呼べる場所ではない
- host の側で #490 のために新しく作る処理は無い——既存の中継（`claude-login/relay.ts`）がそのまま受ける。#497 の呼び出しも同じ中継を
  本体用の合言葉で通るので、**host の側で共用しているのは中継とアカウントの選び方**で、それ以上まとめるものは無い
- まとめるなら「#490 も host の口（relay の新しい tool）で core の `askSmallModel` を呼ぶ」形がありうるが、それは #490 の仕様を変える
  ことになるので、ここでは決めない（人に上げる）

## 確かめたこと・できなかったこと

- 単体（偽の Runner）：入力→1行・道具なし・1ターン・記録なし・失敗で例外。`runnerEnvFor` の Thread の印なし
- **実機での1回は、この作業場所では通せなかった**：この worktree はサブエージェントのコンテナで動いていて、Claude のログインを
  持たない（推論は banto の中継越しで、合言葉はシェルに渡されない）。`npm run check:one-shot -w @banto/core` は
  「Not logged in」で止まった。ログインのある機械で1回回す必要がある
- SDK は error の result を受けると、流す前に `query()` の中で投げる（実測）。`askSmallModel` はそれをそのまま投げる
