---
id: imp-0051
title: 章畳みが早すぎる——contextTokens がターン中の全 API 呼び出しの累計になっている
status: inbox
kind: improvement
origin: 幹「電卓開発」(thread-85) からの言伝。電卓側の番頭が現物のコードで裏を取り、Agent SDK を直接叩いて実証済み（職人 sessionId 8c1adce6-fef8-4d6c-902e-18b3f96a82e9）
refs:
  - packages/banto-host/src/claude-agent-harness.ts
  - packages/banto-host/src/chapters.ts
created: 2026-08-15
---

## 何が起きているか

`claude-agent-harness.ts` の `result` 処理（696行目付近）が、ターンの文脈長を

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

で出している。しかし **`result.usage` はそのターン中の全 API 呼び出しの累計**である
（SDK を直接叩いた実験で、各呼び出しの列和と `result.usage` が **1トークンの誤差もなく一致**
することを確認）。したがって道具を n 回呼ぶと、**同じキャッシュ済みプレフィクスが n 回
足し込まれる**。

実測の倍率は 4.9倍・3.9倍。thread-85 第9章では

- 畳んだときの算出値: **804,237**（1,000,000 の 80.4%＝閾値超え）
- そのときの実文脈長: **83,168**（8.3%）
- **9.7倍の過大評価**で、畳む必要は全く無かった

章畳みは要約に約30秒かかり、その間 PO を待たせ、文脈の連続性も切る。それが
**本来なら1割しか使っていない時点で**起きている。

## 併せて直す：窓の選び方が後勝ち

同ファイル 658-661 付近。`modelUsage` を `for` で回して `this.window` を**後勝ちで
上書き**している。`modelUsage` には副モデルが混ざる（実測：`haiku` 200,000 と
`opus-5[1m]` 1,000,000 の2つ）。**順序は保証されない**ので、haiku が後に来れば窓が
200,000 になり、閾値が 120,000 に落ちてさらに早く畳む。

## 直す方向

口は2つある。

- **(b) `query.getContextUsage()` を run 中（`result` を受ける直前）に呼ぶ** ——
  `total` が実文脈と **1トークン差**、`maxTokens` も同時に取れる。control request なので
  `query()` が生きている間しか呼べない。**こちらを本命とする。**
- (a) `result.usage.iterations` の最後の要素を採る —— 実文脈と **4トークン差**。ただし
  `iterations` の意味は型定義に記述が無く、常に「最後の1回」である確証が取れていない。
  **(b) が駄目だったときの落とし先。**

窓は **init の `model` に一致する鍵を選ぶ**か、**最大値を採る**。(b) が取れるなら
`maxTokens` をそのまま使うのが素直。

## 完了の条件

**「畳まなくなった」という感想では足りない。** 算出値と実文脈長が一致することを
数で示すこと（道具を複数回呼ぶターンを含めて）。

## 効いてくる先

「知らせは幹のターンを起こさず枝で受ける」方針（枝 thread-93 / T1 の計測）は
文脈消費の数を見て閾値を決める。**その数がいま数倍に膨れている**ので、直った日時を
記録に残し、T1 の計測はそれ以降のものを使うこと。

## 実測（直した結果）

計測スクリプトを `tools/measure-context-tokens.ts` に置いた（コミット済み。あとで
再測できる）。走らせ方はリポジトリ直下で `node --import tsx tools/measure-context-tokens.ts`。
実機・Agent SDK **0.3.229**・モデル `claude-opus-5[1m]`・2026-08-15。

### 1. SDK を直接叩いた回（道具を4回呼ぶ1ターン。API 呼び出しは計6回）

| 測り方 | 値 |
|---|---|
| assistant メッセージごとの usage の列和 | 139,455 |
| **(1) 直す前の式**（`result.usage` の4項の和） | **116,615** |
| **(2) `getContextUsage().totalTokens`** | **23,422** |
| (3) `result.usage.iterations` の最後の1件 | 23,425 |

- **(1) は (2) の 4.98 倍。** 道具を呼ぶ回数ぶんだけキャッシュ済みプレフィクスが
  重複して足し込まれている（起票時の 4.9倍・3.9倍・9.7倍と同じ壊れ方）
- (3) と (2) の差は **3トークン**（起票時の見立て「4トークン差」と一致）
- 窓は `getContextUsage().maxTokens` が **1,000,000**。同じ `result` の `modelUsage` には
  `claude-haiku-4-5-20251001` の **200,000** と `claude-opus-5[1m]` の **1,000,000** が
  **同居**していた——後勝ちの上書きが 200,000 を掴む条件は実在する
- `iterations` の件数は **1**。API 呼び出し6回に対して1件しか無い＝「1回ごとの明細」では
  ないので、意味の確証が無いという起票時の懸念はそのまま残る（→ 本命にしない根拠）

### 2. 本体（`ClaudeAgentHarness`）を通した回

`spawnQuery` で本物の `query()` を包み、同じターンの `result` から直す前の式を横で計算した。

| 測り方 | 値 |
|---|---|
| 直す前の式（`result.usage` の4項の和） | 8,197 |
| **いまの実装 `contextTokens()`** | **1,754** |
| 裏取り（`iterations` の最後） | 1,757（差 3トークン） |
| いまの実装 `contextWindow()` | 1,000,000 |

**4.67 倍のずれが消え、裏取りと 3トークン差で一致した。** 窓も、`modelUsage` に haiku が
混ざっているにもかかわらず 1,000,000 が選ばれている。

### 採ったのは (b)。ただし条件が1つある

**(b)（`query.getContextUsage()`）を本命として採った。** (a) は落とし先として残してある
（`lastIterationTokens`）。

一度目の計測では (b) が **`Query closed before response received`** で落ちた。原因は
`query()` に**文字列のプロンプト**を渡していたこと——文字列だと `result` と同時に
`query()` が畳まれ、control request が通らない。番頭本体は空でも終わらせない待ち行列
（streaming input）を渡しているので、計測スクリプトも同じ形にしたところ通った。

したがって実装上の条件は次の1点で、コードにもコメントで残してある:

- **`result` を処理し切る前に訊く。** `translate` を非同期にし、`for await` の中で
  `await` するようにした。イテレータを畳んだ後・ループを抜けた後では通らない

取れなかったときは (a)（`iterations` の最後）へ、それも無ければ**量を名乗らない**
（0 と偽らない・I1）。試験で3通りとも固定した。

### 直したところ

- `packages/banto-host/src/claude-agent-harness.ts`
  - `measureContext()` を足し、`result` の処理で `await` して実測を採る（足し算を捨てた）
  - `lastIterationTokens()`＝落とし先
  - `pickContextWindow()`＝`init` が名乗ったモデルの鍵を選ぶ。無ければ**最大値**
    （小さい方を掴む事故だけは起こさない）。後勝ちの `for` を消した
  - `translate` が非同期になり、走っている `query` を受け取る（`RunningQuery` 型）
- `tests/acceptance/claude-agent-harness.spec.ts`: 上記を固定する試験を9件

### この日以降の数を使うこと

直した日時: **2026-08-15**（ブランチ `fix/host-context-window`）。起票の「効いてくる先」に
あるとおり、T1 の文脈消費の計測はこれ以降のものを使うこと。
