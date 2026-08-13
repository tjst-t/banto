---
id: task-0104
type: task
kind: improvement
title: "Claude バックエンドの復元と後始末"
status: done
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

## 済んだこと（2026-08-13・決定97）

6点すべて。契約は `restore(record)` ではなく**札**にした（決定97）——復元は
「組み立てるときに渡す」で足り、生きているハーネスへ後から差し込む口は要らなかった。

- `BantoHarness` に `resumeToken()` / `contextWindow()` / `dispose()`（いずれも任意）
- 札は索引の `StoredThread.backendSessionId` に残り、`ThreadFactory` の第5引数で戻る
- **新規は `sessionId`、復元は `resume`**（SDK の型注釈どおり両立しない）
- 差し替えのたびに前のハーネスを畳み、**札は引き継ぐ**（モデルを替えても文脈が続く）
- 章の閾値は `result.modelUsage[*].contextWindow`（自前の表を持たない・D3）
- **エラーで終わったターンを黙って通さない**。読み戻せなかった札は捨てて立て直す（I2）

### 7つめ（起票に無いが、実機で確かめる過程で出た）

**Claude 側だけ `prompt()` がターンを待たずに返っていた。** サーバは `prompt()` の解決を
もって `turn_end` を配る（pi は待って返る）ので、**返事が来る前に画面が「終わった」に
なる**。これが直るまで受け入れ自体が観測できなかったので、併せて直した——
中断・畳み・落ちたときも必ず放す（待ち続けると「回答中」のまま戻らない・I2）。

### 一番効いた発見（起票時には見えていなかった）

**1番と2番は、症状が「番頭が黙る」で同じだった。** 翻訳が `result` を一様に
「ターンの終わり」として扱っていたため、`error_during_execution` は**本文の無いターン**
にしか見えない。そして `roles.steward` は既に `claude-agent-sdk` なので、
**新しく開く会話は全部その形で黙る**状態だった（再起動時の忘却より広い）。

### 確かめたこと（I1）

実機（`@anthropic-ai/claude-agent-sdk` 0.3.229・model `haiku`。機構の確認なので安いモデル）:

| 確かめたこと | 結果 |
|---|---|
| `sessionId: <UUID>` で立てた会話が別プロセスの `resume` で戻るか | 戻る（合言葉を答えた） |
| 実在しない札の `resume` | **`error_during_execution`**・`init` 無し・本文無し |
| 別のハーネスへ札を渡して復元 | 戻る（`resumeToken()` → `dispose()` → 新しい器で `resume`） |
| `dispose()` が子プロセスを畳むか | ハーネス1本＝子1本。3本立てて 2→5、畳んで 5→2 |
| 文脈長 | `modelUsage` から 200,000 |
| 差分配信 | `text_delta` が複数回。全文で二重に出ない |

**番頭ホストを通した往復も確かめた**（別ポート・別データ置き場・外部モジュールから切り離し）:

| | 結果 |
|---|---|
| 新しい会話（Claude 既定）で話しかける | **返事が来る**（直す前は本文0・知らせ0で黙る） |
| 出来事の並び | `turn_start` → 思考の差分 → `reasoning_end` → 本文 → `turn_end` |
| 索引 | `backendSessionId` が保存される |
| **ホストを止めて起こし直し、合言葉を尋ねる** | **「カワセミ」と答えた**（＝番頭が覚えている） |

受け入れ試験は **`query()` を差し替えて**書いた（`spawnQuery`）——世代・待ち行列・
立て直しは「翻訳だけを流し込む」試験では**1件も落ちない**。**直しを1つずつ戻して
落ちることを確認済み**（6か所すべて）。

## 残したもの

- `ChapterKeeper.start()` の購読は**生成時のハーネスに張りっぱなし**で、会話の途中で
  バックエンドを替えると自動の章立てが働かない（`closeChapter` は追随する）。
  今回のスコープ外なので **inc-0062** に積んだ
