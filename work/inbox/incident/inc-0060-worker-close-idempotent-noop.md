---
id: inc-0060
type: incident
kind: bug
origin: claude
class: worker-pool
status: open
refs: [inc-0057, adr-0019]
---

## 内容

**畳み済みの職人を畳んでも「畳みました」と返すので、モデルは効いていないと読んで繰り返す。**

```
packages/banto-worker-pool/src/pool.ts:1179-1181
  if (worker.state === "closed") return;      // ← 黙って成功
```

`worker-tools.ts` の `worker.close` は戻り値を見ずに `畳みました: …` を返す。

## 計測（inc-0057 で判明）

`worker.close` は全道具呼び出しの **48.8%（5,479回）**。うち **5,045回が3セッションに集中**し、
その中に**同一引数で832回連続**という走りがある。実際に畳まれた職人は全期間で 508人。

`turn-budget.ts` の `DEFAULT_REPEAT_LIMIT = 3` が同一引数の4回目を断るのでこの形は塞がっているが、
**導入は暴走の9日後**で、根本（成功を返すこと）は直っていない。

## なぜ起票するか

ADR-0019 の未決4 が「incident として別に扱う（P1）」と明記していたが、起票されていなかった。
`turn-budget.ts:36-41` が別件で書いている教訓（「空の結果は『何も無かった』と読まれ、
もう一度確かめに来る」）と同じ形。**断るときは次に何をすべきかまで書く**（D8）。
