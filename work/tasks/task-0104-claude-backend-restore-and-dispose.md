---
id: task-0104
type: task
kind: improvement
title: "Claude バックエンドの復元と後始末"
status: queued
refs: ["adr-0020", "adr-0019"]
scope:
  paths: ["packages/**", "docs/adr/**", "work/**"]
acceptance:
  - { id: a1, text: "npm test / npm run typecheck が通る" }
  - { id: a2, text: "稼働中の banto に反映し、起動ログで確認している" }
review:
  policy: manual
---
## 背景

2026-08-13 のレビューで見つかった、Agent SDK バックエンド固有の穴。

## やること

1. **`restore`（会話の復元）**。ADR-0020 決定89 の契約に挙げたが実装の interface から落ちており、
   `ClaudeAgentHarnessOptions.resume` はどこからも渡っていない。**再起動のたびに番頭だけが全部忘れる**
   （画面には履歴が残るので、POからは「番頭が急に前提を無視し始めた」に見える）。
   決定90 の「`restore` でも思考を含めて組み直す」も同時に満たすこと
2. **`resume` と `sessionId` の使い分け**を実機で確かめる。いまは新規セッションにも
   `resume: randomUUID()` を渡しており、決定93 の実測条件（`resume` を渡さない）と食い違う
3. **`dispose()` を契約に足す**。`harnessSwitchers` の Map は会話を畳んでも消えず、
   `PromptQueue` は「空になっても終わらせない」設計なので、**バックエンドを往復するたびに
   Claude Code の子プロセスが積み上がる**
4. **`startChapter` と走行中の `run` の競走**。古いループの `finally` が新しい `run` を消し、
   2本目の `query()` が立って発話が1つ握り潰されうる（世代を持たせる）
5. Claude 側の**文脈長を章の閾値へ渡す**経路（いまは pi のモデルの文脈長で測っている）
6. `includePartialMessages` を入れて**本文を差分で流す**（いまはターンが終わるまで画面が無音）
