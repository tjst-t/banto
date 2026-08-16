---
id: imp-0046
type: improvement
kind: correctness
origin: banto
status: in-progress
resolution: "task-0188 として工場へ積んだ（2026-08-16）"
refs: [imp-0041, inc-0070, task-0188, task-0159]
---

# 全量テストの負荷が高いとき、pi-rpc の子プロセスへの write が EPIPE で落ちる

## 内容

`npm test` の全量実行で、**負荷が高いときだけ** 2本が落ちることがある。

- `tests/acceptance/pi-rpc-system-prompt-tools.spec.ts [imp-0004]`
- `tests/acceptance/spawn-args.spec.ts [AC-S254276-5-1]`

どちらも同じ場所で落ちる：**`packages/banto-worker-pool/src/pi-rpc-driver.ts:495` の子プロセスへの write が EPIPE**。

## 計測（imp-0041 の職人・2026-08-15）

| 条件 | 回数 | 発生 |
|---|---|---|
| 差分あり・全量 | 2 | 1 |
| 差分なし（素の main）・全量 | 1 | 0 |
| 当該2本だけ単独実行 | 3 | 0 |

＝ **特定の差分に依存せず、全量実行の負荷に依存する間欠**。

## 実例（2026-08-16・マージ前ゲートで踏んだ）

`task-0159` のマージ前ゲートが `verify_failed:a1(exit=1)` で落ちた。赤くなったのは決定番号の試験ではなく
`pi-rpc-system-prompt-tools.spec.ts` の「[imp-0004] tools は --tools のカンマ区切りとして渡る」で、
中身は `Error: write EPIPE`。**同じゲートの a3 が同じ全量 2420件を fail 0 で通している**——
つまり**同一実行の中で「中身ではなく間欠」であることが示された**。

**タスクは理由なく落ち、reverify で回し直す羽目になった。**間欠は「無関係だから無視してよい」と
読み替える癖をつけるので、本物の失敗を見落とす側に倒れる。

### 負荷を下げた状態での観測（2026-08-16・進行中）

`task-0159` の契約は verify が `npm test -- <file>` の形で、**これは絞り込みにならない**
（`package.json:20` の `test` が `$(ls tests/acceptance/*.spec.ts | …)` で一覧を渡し切っているため、
`--` の後ろは追加引数になるだけ）。つまり**同じ全量2420件をゲートが3回走らせていた**。
verify を1本名指しの形へ訂正して reverify を回しており、**全量の実行が3回→1回に減った状態で
まだ EPIPE が出るか**を観測中。出なければ「負荷が引き金」の裏づけになる。
（この件は `task-0187` で `npm run test:one` を用意して構造的に直す。）

## なぜ直すか

間欠は「無関係だから無視してよい」と何度も読み替えることになり、
**本物の失敗を見落とす側に倒れる**（実際、この2本は既に3回「無関係」として読み飛ばされている）。
また、マージ前ゲートは全量テストを回すので、**この間欠は誰かのタスクを理由なく落とす**。

## 原因（2026-08-16・コードで確認）

`packages/banto-worker-pool/src/pi-rpc-driver.ts` は、起動から **200ms 待ってから** `get_state` を
子の stdin へ書く。**穴は2つ。**

1. **子の生存を見ずに書いている。** 負荷が高いと子は 200ms を待たずに死ぬことがあり、
   死んだ子の stdin へ書けば EPIPE になる。**EPIPE は結果であって原因ではない**のに、
   いまの文言は `Failed to write to pi stdin: write EPIPE` にしかならず、
   **子が何で死んだのか（exit code・signal・stderr）がどこにも出ない**。
2. **`proc.stdin` に `error` ハンドラが無い。** write のコールバックで受けても stdin（Socket）側の
   `error` イベントは別に上がり、**listener が無い `error` は uncaughtException になって親ごと落ちる**。
   試験ではこれがそのまま `Error: write EPIPE` として出ている。
   **これは試験の都合ではなく製品コードの脆さで、稼働中の Worker Pool でも同じことが起きうる。**

同じ形の write は `pi-rpc-driver.ts:495 / 587 / 654` と
`claude-agent-driver.ts:324 / 395 / 425` にある（`:654` と `:425` は**コールバックすら渡していない**）。

## 直す筋

- 書く前に子の生存を見て、死んでいれば **exit code・signal・stderr の末尾を添えて失敗させる**
- `proc.stdin` に `error` ハンドラを付け、EPIPE を uncaughtException にしない（**握り潰さず**記録して失敗させる）
- 対症（リトライ・sleep・待ち時間の延長）で隠さないこと。200ms を伸ばす直しは
  「たまに通る」を「もう少し通る」に変えるだけで、**子が死んでいる事実を隠す**

## 経緯

- 2026-08-15、imp-0041（依存の解決状態）の職人が全量テスト中に踏み、計測つきで報告。
  触ってよいパス外だったため職人は手を出さず、番頭が起票した。
- 2026-08-16、枝「緑が信用できない」で task-0159 のゲート落ちとして再発。原因をコードで特定し、
  **`task-0188` として工場へ積んだ**（PO 方針「間欠は起票で済ませず直す」）。
